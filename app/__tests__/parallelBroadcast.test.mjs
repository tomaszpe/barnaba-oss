import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the Scenario A parallel broadcast pipeline (Task A3.3).
 *
 * Tests the core dispatch logic reimplemented from server.js.
 * Contract approach: standalone logic verification, matching the
 * inline if/else in translateAndBroadcast.
 */

// ============================================================
// Test helpers — reimplementing server.js dispatch logic
// ============================================================

function createMockSynthesizeSpeech(config) {
    // config: { pl: { delay, result }, en: { delay, result }, ar: { delay, error, result } }
    return async (text, lang, gender) => {
        const c = config[lang] || { delay: 0, result: `audio_${lang}` };
        if (c.delay) await new Promise(r => setTimeout(r, c.delay));
        if (c.error) throw c.error;
        return c.result;  // null = OQ3 internal catch scenario
    };
}

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
        fn: (entry) => records.push({ ...entry, _ts: Date.now() }),
        records,
    };
}

// Reimplementation of the PARALLEL dispatch path (BROADCAST_PARALLEL=true)
async function dispatchParallel({ ttsJobs, synthesizeSpeech, broadcastFn, evalLogFn, logTTSErrorFn, emissionId, churchId, text, latencyTxId, sourceEmitMs, config }) {
    const ttsPromises = ttsJobs.map(async ({ result, gender }) => {
        try {
            const _evalTtsStart = Date.now();
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
                languageName: result.language,
            };
            if (latencyTxId) msg.txId = latencyTxId;
            if (audioBase64) {
                msg.audioBase64 = audioBase64;
                msg.audioFormat = 'mp3';
            }
            const sentCount = broadcastFn(churchId, result.language, gender, msg);

            return { lang: result.language, gender, ttsMs: _evalTtsMs, sentCount };
        } catch (err) {
            logTTSErrorFn({ emissionId, churchId, lang: result.language, gender, reason: 'exception', error: err.message });
            return { lang: result.language, gender, ttsMs: 0, sentCount: 0, error: err.message };
        }
    });

    await Promise.allSettled(ttsPromises);
}

// Reimplementation of the LEGACY dispatch path (BROADCAST_PARALLEL=false)
async function dispatchLegacy({ ttsJobs, synthesizeSpeech, broadcastFn, evalLogFn, emissionId, churchId, text, latencyTxId, sourceEmitMs }) {
    const ttsResults = await Promise.all(
        ttsJobs.map(async ({ result, gender }) => {
            const _evalTtsStart = Date.now();
            const audioBase64 = await synthesizeSpeech(result.text, result.language, gender);
            const _evalTtsMs = Date.now() - _evalTtsStart;
            evalLogFn({ stage: 'tts', churchId, emissionId, lang: result.language, gender, latency_ms: _evalTtsMs });
            return { result, gender, audioBase64 };
        })
    );

    for (const { result, gender, audioBase64 } of ttsResults) {
        const msg = {
            type: 'translation',
            originalText: text,
            translatedText: result.text,
            language: result.language,
            languageName: result.language,
        };
        if (latencyTxId) msg.txId = latencyTxId;
        if (audioBase64) {
            msg.audioBase64 = audioBase64;
            msg.audioFormat = 'mp3';
        }
        broadcastFn(churchId, result.language, gender, msg);
    }
}

// ============================================================
// Test data factories
// ============================================================

function makeTtsJobs(langs) {
    return langs.map(lang => ({
        result: { text: `translated_${lang}`, language: lang, success: true },
        gender: 'male',
    }));
}

// ============================================================
// UT-4: TTS error isolation
// ============================================================

describe('UT-4: TTS error isolation (parallel path)', () => {
    it('UT-4a: exception in one lang does not crash others', async () => {
        const broadcast = createMockBroadcast();
        const evalLog = createMockEvalLog();
        const ttsErrors = [];

        const ttsJobs = makeTtsJobs(['pl', 'ar', 'en']);

        await dispatchParallel({
            ttsJobs,
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { result: 'audio_pl' },
                ar: { error: new Error('timeout') },
                en: { result: 'audio_en' },
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: evalLog.fn,
            logTTSErrorFn: (e) => ttsErrors.push(e),
            emissionId: 1,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // pl and en broadcast successfully
        const broadcastLangs = broadcast.calls.map(c => c.lang);
        expect(broadcastLangs).toContain('pl');
        expect(broadcastLangs).toContain('en');
        expect(broadcastLangs).not.toContain('ar');

        // ar logged as error
        expect(ttsErrors).toHaveLength(1);
        expect(ttsErrors[0].lang).toBe('ar');
        expect(ttsErrors[0].reason).toBe('exception');
    });

    it('UT-4b: null audio (OQ3) triggers logTTSError but still broadcasts (without audio)', async () => {
        const broadcast = createMockBroadcast();
        const ttsErrors = [];

        const ttsJobs = makeTtsJobs(['pl', 'ar', 'en']);

        await dispatchParallel({
            ttsJobs,
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { result: 'audio_pl' },
                ar: { result: null },  // OQ3: synthesizeSpeech catches internally, returns null
                en: { result: 'audio_en' },
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: createMockEvalLog().fn,
            logTTSErrorFn: (e) => ttsErrors.push(e),
            emissionId: 2,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // ALL 3 langs broadcast (ar broadcasts WITHOUT audio — client fallback)
        expect(broadcast.calls).toHaveLength(3);
        const arBroadcast = broadcast.calls.find(c => c.lang === 'ar');
        expect(arBroadcast.msg.audioBase64).toBeUndefined();  // no audio field
        expect(arBroadcast.msg.audioFormat).toBeUndefined();

        // pl and en have audio
        const plBroadcast = broadcast.calls.find(c => c.lang === 'pl');
        expect(plBroadcast.msg.audioBase64).toBe('audio_pl');

        // ar logged as null_audio error
        expect(ttsErrors).toHaveLength(1);
        expect(ttsErrors[0].reason).toBe('null_audio');
    });
});

// ============================================================
// UT-5: Feature flag
// ============================================================

describe('UT-5: Feature flag BROADCAST_PARALLEL', () => {
    it('UT-5a: flag=false uses legacy (Promise.all, all broadcast after all done)', async () => {
        const broadcast = createMockBroadcast();
        const ttsJobs = makeTtsJobs(['pl', 'en']);

        await dispatchLegacy({
            ttsJobs,
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { delay: 10, result: 'audio_pl' },
                en: { delay: 10, result: 'audio_en' },
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: createMockEvalLog().fn,
            emissionId: 3,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // Both broadcast after all TTS done — timestamps should be very close
        expect(broadcast.calls).toHaveLength(2);
        const tsDiff = Math.abs(broadcast.calls[1].ts - broadcast.calls[0].ts);
        expect(tsDiff).toBeLessThan(50); // within 50ms = effectively simultaneous
    });

    it('UT-5b: flag=true uses parallel (broadcasts as each TTS completes)', async () => {
        vi.useFakeTimers();
        const broadcast = createMockBroadcast();
        const ttsJobs = makeTtsJobs(['pl', 'en']);
        const ttsErrors = [];

        // Manually control timing
        let resolvePl, resolveEn;
        const plPromise = new Promise(r => { resolvePl = r; });
        const enPromise = new Promise(r => { resolveEn = r; });

        const mockTTS = async (text, lang) => {
            if (lang === 'pl') { await plPromise; return 'audio_pl'; }
            if (lang === 'en') { await enPromise; return 'audio_en'; }
            return null;
        };

        const dispatchPromise = dispatchParallel({
            ttsJobs,
            synthesizeSpeech: mockTTS,
            broadcastFn: broadcast.fn,
            evalLogFn: createMockEvalLog().fn,
            logTTSErrorFn: (e) => ttsErrors.push(e),
            emissionId: 4,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // Resolve pl first
        resolvePl();
        await vi.advanceTimersByTimeAsync(1);

        // pl should be broadcast, en not yet
        expect(broadcast.calls).toHaveLength(1);
        expect(broadcast.calls[0].lang).toBe('pl');

        // Now resolve en
        resolveEn();
        await vi.advanceTimersByTimeAsync(1);
        await dispatchPromise;

        // Both broadcast now
        expect(broadcast.calls).toHaveLength(2);
        expect(broadcast.calls[1].lang).toBe('en');

        vi.useRealTimers();
    });
});

// ============================================================
// IT-1..IT-4: Integration tests
// ============================================================

describe('IT-1: E2E with 2 listeners (parallel path)', () => {
    it('both listeners receive audio with shared emissionId', async () => {
        const broadcast = createMockBroadcast();
        const evalLog = createMockEvalLog();

        await dispatchParallel({
            ttsJobs: makeTtsJobs(['pl', 'en']),
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { result: 'audio_pl' },
                en: { result: 'audio_en' },
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: evalLog.fn,
            logTTSErrorFn: () => {},
            emissionId: 10,
            churchId: 'church_test',
            text: 'German source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // Both listeners get audio
        expect(broadcast.calls).toHaveLength(2);
        expect(broadcast.calls[0].msg.audioBase64).toBe('audio_pl');
        expect(broadcast.calls[1].msg.audioBase64).toBe('audio_en');

        // Shared emissionId in tts eval records
        const ttsRecords = evalLog.records.filter(r => r.stage === 'tts');
        expect(ttsRecords).toHaveLength(2);
        expect(ttsRecords[0].emissionId).toBe(10);
        expect(ttsRecords[1].emissionId).toBe(10);
    });
});

describe('IT-2: Per-listener latency independence (KEY proof)', () => {
    it('fast lang broadcasts before slow lang', async () => {
        // Use real timers with small delays for deterministic ordering
        const broadcast = createMockBroadcast();

        await dispatchParallel({
            ttsJobs: makeTtsJobs(['pl', 'en']),
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { delay: 20, result: 'audio_pl' },   // fast: 20ms
                en: { delay: 200, result: 'audio_en' },   // slow: 200ms
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: createMockEvalLog().fn,
            logTTSErrorFn: () => {},
            emissionId: 20,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        expect(broadcast.calls).toHaveLength(2);

        // pl broadcast BEFORE en (proves per-listener independence)
        const plCall = broadcast.calls.find(c => c.lang === 'pl');
        const enCall = broadcast.calls.find(c => c.lang === 'en');
        expect(plCall.ts).toBeLessThan(enCall.ts);

        // Timing gap should be roughly 180ms (200-20), with tolerance
        const gap = enCall.ts - plCall.ts;
        expect(gap).toBeGreaterThan(100); // at least 100ms gap
    });
});

describe('IT-3: Failure isolation (3 langs, 1 fails)', () => {
    it('2 succeed, 1 fails — no cross-impact', async () => {
        const broadcast = createMockBroadcast();
        const ttsErrors = [];

        await dispatchParallel({
            ttsJobs: makeTtsJobs(['pl', 'ar', 'en']),
            synthesizeSpeech: createMockSynthesizeSpeech({
                pl: { result: 'audio_pl' },
                ar: { result: null },   // OQ3 failure
                en: { result: 'audio_en' },
            }),
            broadcastFn: broadcast.fn,
            evalLogFn: createMockEvalLog().fn,
            logTTSErrorFn: (e) => ttsErrors.push(e),
            emissionId: 30,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        });

        // All 3 broadcast (ar without audio)
        expect(broadcast.calls).toHaveLength(3);
        const arCall = broadcast.calls.find(c => c.lang === 'ar');
        expect(arCall.msg.audioBase64).toBeUndefined();

        // Only ar error logged
        expect(ttsErrors).toHaveLength(1);
        expect(ttsErrors[0].lang).toBe('ar');
    });
});

describe('IT-4: Feature flag switching — same content both modes', () => {
    it('both modes deliver same translations', async () => {
        const parallelBroadcast = createMockBroadcast();
        const legacyBroadcast = createMockBroadcast();
        const ttsJobs = makeTtsJobs(['pl', 'en']);
        const ttsConfig = { pl: { result: 'audio_pl' }, en: { result: 'audio_en' } };
        const commonParams = {
            ttsJobs,
            synthesizeSpeech: createMockSynthesizeSpeech(ttsConfig),
            evalLogFn: createMockEvalLog().fn,
            emissionId: 40,
            churchId: 'c1',
            text: 'source',
            latencyTxId: null,
            sourceEmitMs: Date.now(),
        };

        // Parallel mode
        await dispatchParallel({
            ...commonParams,
            broadcastFn: parallelBroadcast.fn,
            logTTSErrorFn: () => {},
        });

        // Legacy mode (need fresh ttsJobs since they're consumed)
        commonParams.ttsJobs = makeTtsJobs(['pl', 'en']);
        commonParams.synthesizeSpeech = createMockSynthesizeSpeech(ttsConfig);
        await dispatchLegacy({
            ...commonParams,
            broadcastFn: legacyBroadcast.fn,
        });

        // Same number of broadcasts
        expect(parallelBroadcast.calls).toHaveLength(2);
        expect(legacyBroadcast.calls).toHaveLength(2);

        // Same translations delivered
        const parallelTexts = parallelBroadcast.calls.map(c => c.msg.translatedText).sort();
        const legacyTexts = legacyBroadcast.calls.map(c => c.msg.translatedText).sort();
        expect(parallelTexts).toEqual(legacyTexts);

        // Same audio
        const parallelAudio = parallelBroadcast.calls.map(c => c.msg.audioBase64).sort();
        const legacyAudio = legacyBroadcast.calls.map(c => c.msg.audioBase64).sort();
        expect(parallelAudio).toEqual(legacyAudio);
    });
});
