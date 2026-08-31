import { describe, it, expect } from 'vitest';
import { emitChunksInOrder } from '../ttsService.js';

/**
 * Integration tests for TTS_PROGRESSIVE_ENABLED dispatch path (Option H, Phase 3a.2).
 *
 * Follows the "reimplementation" pattern from parallelBroadcast.test.mjs —
 * reimplements the job-body logic from server.js here, injecting mocks for
 * TTS synthesis + broadcast + evalLog. Verifies:
 *
 *  - Flag=false → emits one legacy 'translation' message with audioBase64
 *  - Flag=true, single-sentence text → 'translation' (progressive:true) + 1 'tts_chunk'
 *  - Flag=true, multi-sentence text → 'translation' + N 'tts_chunk' in index order
 *  - Flag=true with failures → still emits all chunks (null audioBase64 for fails),
 *    is_last still set on final chunk
 *  - evalLog stage='tts' shape differs by mode
 */

// ============================================================
// Test helpers
// ============================================================

function createMockBroadcast() {
    const calls = [];
    return {
        fn: (churchId, lang, gender, msg) => {
            calls.push({ churchId, lang, gender, msg, ts: Date.now() });
            return 1; // sentCount
        },
        calls,
    };
}

function createMockEvalLog() {
    const records = [];
    return {
        fn: (entry) => records.push({ ...entry }),
        records,
    };
}

function createMockLogTTSError() {
    const calls = [];
    return {
        fn: (entry) => calls.push(entry),
        calls,
    };
}

function createMockLogBroadcastStage() {
    const calls = [];
    return {
        fn: (entry) => calls.push(entry),
        calls,
    };
}

// Helper: mock per-sentence TTS generator.
// config keyed by full sentence text.
function createMockSynthesizeSpeech(config) {
    return async (text, lang, gender) => {
        const c = config[text] || { result: `audio_${lang}_${gender}_${text.length}` };
        if (c.delay) await new Promise(r => setTimeout(r, c.delay));
        if (c.error) throw c.error;
        return c.result; // null = soft fail
    };
}

// Progressive helper that mirrors synthesizeSpeechProgressive() but uses
// injectable `synthesizeSpeech` + `splitForTTS`. Keeps test pure.
async function runProgressiveHelper(sentences, synthesizeSpeech, lang, gender, onChunk) {
    return emitChunksInOrder(
        sentences,
        (sentence) => synthesizeSpeech(sentence, lang, gender),
        onChunk,
    );
}

// ============================================================
// Reimplementation of server.js per-(lang,gender) dispatch body
// for PROGRESSIVE and LEGACY modes.
// Kept close to server.js structure (lines 3297-3388 post-patch).
// ============================================================

async function dispatchOneJob({
    result,
    gender,
    flagProgressive,
    churchId,
    emissionId,
    text,
    latencyTxId,
    sourceEmitMs,
    languageNames,
    // Injected dependencies
    synthesizeSpeech,
    splitForTTS,
    broadcastFn,
    evalLogFn,
    logTTSErrorFn,
    logBroadcastStageFn,
}) {
    try {
        const _evalTtsStart = Date.now();

        if (flagProgressive) {
            // Text intro (no audio, progressive: true)
            const textMsg = {
                type: 'translation',
                originalText: text,
                translatedText: result.text,
                language: result.language,
                languageName: languageNames[result.language] || result.language,
                progressive: true,
            };
            if (latencyTxId) textMsg.txId = latencyTxId;
            const _textSentCount = broadcastFn(churchId, result.language, gender, textMsg);

            let firstChunkMs = null;
            let chunkCount = 0;
            let nullCount = 0;
            let totalSentencesSeen = 0;

            const onChunk = (audioBase64, sentenceIdx, totalSentences, isLast) => {
                totalSentencesSeen = totalSentences;
                if (audioBase64 === null || audioBase64 === undefined) nullCount++;
                if (firstChunkMs === null) firstChunkMs = Date.now() - _evalTtsStart;
                const chunkMsg = {
                    type: 'tts_chunk',
                    emissionId,
                    language: result.language,
                    gender,
                    sentence_index: sentenceIdx,
                    total_sentences: totalSentences,
                    audioBase64: audioBase64 || null,
                    audioFormat: 'mp3',
                    is_last: isLast,
                };
                if (latencyTxId) chunkMsg.txId = latencyTxId;
                broadcastFn(churchId, result.language, gender, chunkMsg);
                chunkCount++;
            };

            const sentences = splitForTTS(result.text);
            await runProgressiveHelper(sentences, synthesizeSpeech, result.language, gender, onChunk);

            const _evalTtsMs = Date.now() - _evalTtsStart;
            evalLogFn({
                stage: 'tts',
                churchId,
                emissionId,
                lang: result.language,
                gender,
                latency_ms: _evalTtsMs,
                mode: 'progressive',
                chunks: chunkCount,
                null_chunks: nullCount,
                total_sentences: totalSentencesSeen,
                first_chunk_ms: firstChunkMs,
            });

            if (nullCount > 0) {
                logTTSErrorFn({ emissionId, churchId, lang: result.language, gender, reason: `null_chunks_${nullCount}_of_${totalSentencesSeen}` });
            }

            logBroadcastStageFn({ emissionId, churchId, lang: result.language, gender, listenersServed: _textSentCount, sourceEmitMs });

            return { lang: result.language, gender, ttsMs: _evalTtsMs, sentCount: _textSentCount, progressive: true, chunks: chunkCount };
        }

        // Legacy (non-progressive) path — one synthesizeSpeech for full text.
        const audioBase64 = await synthesizeSpeech(result.text, result.language, gender);
        const _evalTtsMs = Date.now() - _evalTtsStart;
        evalLogFn({ stage: 'tts', churchId, emissionId, lang: result.language, gender, latency_ms: _evalTtsMs });

        if (audioBase64 === null) {
            logTTSErrorFn({ emissionId, churchId, lang: result.language, gender, reason: 'null_audio' });
        }

        const msg = {
            type: 'translation',
            originalText: text,
            translatedText: result.text,
            language: result.language,
            languageName: languageNames[result.language] || result.language,
        };
        if (latencyTxId) msg.txId = latencyTxId;
        if (audioBase64) {
            msg.audioBase64 = audioBase64;
            msg.audioFormat = 'mp3';
        }
        const _sentCount = broadcastFn(churchId, result.language, gender, msg);
        logBroadcastStageFn({ emissionId, churchId, lang: result.language, gender, listenersServed: _sentCount, sourceEmitMs });

        return { lang: result.language, gender, ttsMs: _evalTtsMs, sentCount: _sentCount };
    } catch (err) {
        logTTSErrorFn({ emissionId, churchId, lang: result.language, gender, reason: 'exception', error: err.message });
        return { lang: result.language, gender, ttsMs: 0, sentCount: 0, error: err.message };
    }
}

// ============================================================
// Tests
// ============================================================

describe('TTS_PROGRESSIVE_ENABLED dispatch — integration', () => {
    const churchId = 'testChurch';
    const emissionId = 42;
    const text = 'source text';
    const languageNames = { pl: 'Polish', en: 'English' };
    const sourceEmitMs = Date.now();

    describe('Flag=false (legacy, backward compat)', () => {
        it('emits one translation message with audioBase64 for full text', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const synthesizeSpeech = createMockSynthesizeSpeech({
                'To jest jakiś dłuższy tekst tłumaczenia dla pełnej emisji testowej.': { result: 'FULL_AUDIO_BASE64' },
            });

            const result = await dispatchOneJob({
                result: { text: 'To jest jakiś dłuższy tekst tłumaczenia dla pełnej emisji testowej.', language: 'pl' },
                gender: 'male',
                flagProgressive: false,
                churchId, emissionId, text, latencyTxId: 'tx1', sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS: () => { throw new Error('should not be called in legacy path'); },
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            expect(broadcast.calls).toHaveLength(1);
            const msg = broadcast.calls[0].msg;
            expect(msg.type).toBe('translation');
            expect(msg.audioBase64).toBe('FULL_AUDIO_BASE64');
            expect(msg.audioFormat).toBe('mp3');
            expect(msg.progressive).toBeUndefined();
            expect(msg.txId).toBe('tx1');

            expect(evalLog.records).toHaveLength(1);
            expect(evalLog.records[0].stage).toBe('tts');
            expect(evalLog.records[0].mode).toBeUndefined();

            expect(ttsError.calls).toHaveLength(0);
            expect(result.progressive).toBeUndefined();
        });

        it('logs ttsError but still emits translation msg without audio when synth returns null', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const synthesizeSpeech = async () => null; // soft fail

            await dispatchOneJob({
                result: { text: 'short', language: 'pl' },
                gender: 'male',
                flagProgressive: false,
                churchId, emissionId, text, latencyTxId: null, sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS: () => [],
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            expect(broadcast.calls).toHaveLength(1);
            expect(broadcast.calls[0].msg.audioBase64).toBeUndefined();
            expect(ttsError.calls).toHaveLength(1);
            expect(ttsError.calls[0].reason).toBe('null_audio');
        });
    });

    describe('Flag=true, single-sentence text', () => {
        it('emits translation (progressive:true) + 1 tts_chunk with is_last=true', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const fullText = 'Krótkie zdanie.';
            const synthesizeSpeech = createMockSynthesizeSpeech({
                [fullText]: { result: 'AUD_SHORT' },
            });

            // Single-sentence → splitForTTS returns [fullText]
            const splitForTTS = () => [fullText];

            await dispatchOneJob({
                result: { text: fullText, language: 'pl' },
                gender: 'male',
                flagProgressive: true,
                churchId, emissionId, text, latencyTxId: 'tx1', sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS,
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            // 1× translation (text intro) + 1× tts_chunk
            expect(broadcast.calls).toHaveLength(2);

            const introMsg = broadcast.calls[0].msg;
            expect(introMsg.type).toBe('translation');
            expect(introMsg.progressive).toBe(true);
            expect(introMsg.audioBase64).toBeUndefined();
            expect(introMsg.translatedText).toBe(fullText);

            const chunkMsg = broadcast.calls[1].msg;
            expect(chunkMsg.type).toBe('tts_chunk');
            expect(chunkMsg.emissionId).toBe(emissionId);
            expect(chunkMsg.sentence_index).toBe(0);
            expect(chunkMsg.total_sentences).toBe(1);
            expect(chunkMsg.audioBase64).toBe('AUD_SHORT');
            expect(chunkMsg.is_last).toBe(true);
            expect(chunkMsg.audioFormat).toBe('mp3');

            // evalLog has progressive-specific fields
            expect(evalLog.records).toHaveLength(1);
            const log = evalLog.records[0];
            expect(log.mode).toBe('progressive');
            expect(log.chunks).toBe(1);
            expect(log.null_chunks).toBe(0);
            expect(log.total_sentences).toBe(1);
            expect(typeof log.first_chunk_ms).toBe('number');

            expect(ttsError.calls).toHaveLength(0);
        });
    });

    describe('Flag=true, multi-sentence text', () => {
        it('emits translation + 3 tts_chunk in index order (0, 1, 2)', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const s0 = 'Pierwsze zdanie pełne.';
            const s1 = 'Drugie zdanie średnie.';
            const s2 = 'Trzecie zdanie krótsze.';
            const fullText = `${s0} ${s1} ${s2}`;

            const synthesizeSpeech = createMockSynthesizeSpeech({
                [s0]: { delay: 50, result: 'A0' },
                [s1]: { delay: 10, result: 'A1' }, // fast — would finish first
                [s2]: { delay: 30, result: 'A2' },
            });
            const splitForTTS = () => [s0, s1, s2];

            await dispatchOneJob({
                result: { text: fullText, language: 'en' },
                gender: 'female',
                flagProgressive: true,
                churchId, emissionId, text, latencyTxId: null, sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS,
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            // 1× text intro + 3× tts_chunk
            expect(broadcast.calls).toHaveLength(4);

            const [intro, c0, c1, c2] = broadcast.calls.map(call => call.msg);

            expect(intro.type).toBe('translation');
            expect(intro.progressive).toBe(true);

            expect(c0.type).toBe('tts_chunk');
            expect(c0.sentence_index).toBe(0);
            expect(c0.audioBase64).toBe('A0');
            expect(c0.is_last).toBe(false);

            expect(c1.sentence_index).toBe(1);
            expect(c1.audioBase64).toBe('A1');
            expect(c1.is_last).toBe(false);

            expect(c2.sentence_index).toBe(2);
            expect(c2.audioBase64).toBe('A2');
            expect(c2.is_last).toBe(true);

            expect(evalLog.records[0].chunks).toBe(3);
            expect(evalLog.records[0].total_sentences).toBe(3);
            expect(evalLog.records[0].null_chunks).toBe(0);
        });

        it('emits null audioBase64 for mid-sentence failure, still sends all chunks, last chunk is_last=true', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const s0 = 'OK zdanie zero.';
            const s1 = 'FAIL zdanie jeden.';
            const s2 = 'OK zdanie dwa.';
            const fullText = `${s0} ${s1} ${s2}`;

            const synthesizeSpeech = createMockSynthesizeSpeech({
                [s0]: { result: 'A0' },
                [s1]: { result: null },  // soft fail
                [s2]: { result: 'A2' },
            });
            const splitForTTS = () => [s0, s1, s2];

            await dispatchOneJob({
                result: { text: fullText, language: 'pl' },
                gender: 'male',
                flagProgressive: true,
                churchId, emissionId, text, latencyTxId: null, sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS,
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            expect(broadcast.calls).toHaveLength(4); // intro + 3 chunks
            const chunks = broadcast.calls.slice(1).map(c => c.msg);
            expect(chunks.map(c => c.audioBase64)).toEqual(['A0', null, 'A2']);
            expect(chunks.map(c => c.is_last)).toEqual([false, false, true]);

            // evalLog captures nullCount
            expect(evalLog.records[0].null_chunks).toBe(1);
            expect(evalLog.records[0].chunks).toBe(3);

            // ttsError fired once for partial failure
            expect(ttsError.calls).toHaveLength(1);
            expect(ttsError.calls[0].reason).toContain('null_chunks_1_of_3');
        });
    });

    describe('Flag=true, all sentences fail', () => {
        it('still emits intro + 2 null chunks with is_last on last', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            const s0 = 'A.';
            const s1 = 'B.';
            const synthesizeSpeech = async () => null;
            const splitForTTS = () => [s0, s1];

            await dispatchOneJob({
                result: { text: 'A. B.', language: 'pl' },
                gender: 'male',
                flagProgressive: true,
                churchId, emissionId, text, latencyTxId: null, sourceEmitMs, languageNames,
                synthesizeSpeech,
                splitForTTS,
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            expect(broadcast.calls).toHaveLength(3); // intro + 2 chunks
            const chunks = broadcast.calls.slice(1).map(c => c.msg);
            expect(chunks.map(c => c.audioBase64)).toEqual([null, null]);
            expect(chunks[1].is_last).toBe(true);

            expect(evalLog.records[0].null_chunks).toBe(2);
            expect(ttsError.calls[0].reason).toContain('null_chunks_2_of_2');
        });
    });

    describe('WebSocket message schema contract', () => {
        it('progressive translation intro schema matches spec', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            await dispatchOneJob({
                result: { text: 'Test.', language: 'en' },
                gender: 'male',
                flagProgressive: true,
                churchId, emissionId, text: 'src', latencyTxId: 'tx-abc', sourceEmitMs, languageNames,
                synthesizeSpeech: async () => 'A',
                splitForTTS: () => ['Test.'],
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            const intro = broadcast.calls[0].msg;
            // Required fields per design doc
            expect(intro).toMatchObject({
                type: 'translation',
                originalText: 'src',
                translatedText: 'Test.',
                language: 'en',
                languageName: 'English',
                progressive: true,
                txId: 'tx-abc',
            });
            expect(intro.audioBase64).toBeUndefined();
            expect(intro.audioFormat).toBeUndefined();
        });

        it('tts_chunk schema matches spec', async () => {
            const broadcast = createMockBroadcast();
            const evalLog = createMockEvalLog();
            const ttsError = createMockLogTTSError();
            const broadcastStage = createMockLogBroadcastStage();

            await dispatchOneJob({
                result: { text: 'A. B.', language: 'pl' },
                gender: 'female',
                flagProgressive: true,
                churchId, emissionId, text: 'src', latencyTxId: 'tx-xyz', sourceEmitMs, languageNames,
                synthesizeSpeech: async (s) => `aud_${s}`,
                splitForTTS: () => ['A.', 'B.'],
                broadcastFn: broadcast.fn,
                evalLogFn: evalLog.fn,
                logTTSErrorFn: ttsError.fn,
                logBroadcastStageFn: broadcastStage.fn,
            });

            const chunk0 = broadcast.calls[1].msg;
            expect(chunk0).toMatchObject({
                type: 'tts_chunk',
                emissionId,
                language: 'pl',
                gender: 'female',
                sentence_index: 0,
                total_sentences: 2,
                audioBase64: 'aud_A.',
                audioFormat: 'mp3',
                is_last: false,
                txId: 'tx-xyz',
            });

            const chunk1 = broadcast.calls[2].msg;
            expect(chunk1.sentence_index).toBe(1);
            expect(chunk1.is_last).toBe(true);
        });
    });
});
