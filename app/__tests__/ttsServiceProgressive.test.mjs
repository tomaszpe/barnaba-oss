import { afterEach, describe, it, expect, vi } from 'vitest';
import { emitChunksInOrder, splitForProgressiveTTS, synthesizeSpeech } from '../ttsService.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

/**
 * Tests for the core progressive emission helper (Option H, Phase 3a.2).
 *
 * emitChunksInOrder is the pure logic behind synthesizeSpeechProgressive:
 * it takes a generator(sentence) -> Promise<base64|null>, fires all
 * sentences in parallel, awaits results in order, calls onChunk per sentence.
 *
 * synthesizeSpeechProgressive itself is a thin wiring function (splitForTTS +
 * synthesizeSpeech) — covered indirectly and via integration.
 */

function createMockGenerator(config) {
    // config: { [sentence]: { delay: ms, result: base64|null, error: Error } }
    return async (sentence) => {
        const cfg = config[sentence] || { delay: 0, result: `audio_${sentence.slice(0, 10)}` };
        if (cfg.delay) await new Promise(r => setTimeout(r, cfg.delay));
        if (cfg.error) throw cfg.error;
        return cfg.result;
    };
}

function createCollector() {
    const calls = [];
    return {
        fn: (audioBase64, idx, total, isLast, sentence) => {
            calls.push({ audioBase64, idx, total, isLast, sentence, ts: Date.now() });
        },
        calls,
    };
}

describe('emitChunksInOrder', () => {
    it('returns zero-everything for empty sentences array', async () => {
        const collector = createCollector();
        const result = await emitChunksInOrder([], async () => 'nope', collector.fn);
        expect(result).toEqual({ total: 0, emitted: 0, nullCount: 0 });
        expect(collector.calls).toHaveLength(0);
    });

    it('emits single chunk with isLast=true for one-sentence input', async () => {
        const collector = createCollector();
        const gen = createMockGenerator({ 'Hello.': { result: 'audio_hello' } });
        const result = await emitChunksInOrder(['Hello.'], gen, collector.fn);

        expect(result).toEqual({ total: 1, emitted: 1, nullCount: 0 });
        expect(collector.calls).toHaveLength(1);
        expect(collector.calls[0]).toMatchObject({
            audioBase64: 'audio_hello',
            idx: 0,
            total: 1,
            isLast: true,
        });
    });

    it('emits chunks in index order (0, 1, 2) for 3-sentence input', async () => {
        const collector = createCollector();
        const gen = createMockGenerator({
            'A.': { result: 'audA' },
            'B.': { result: 'audB' },
            'C.': { result: 'audC' },
        });
        const result = await emitChunksInOrder(['A.', 'B.', 'C.'], gen, collector.fn);

        expect(result.total).toBe(3);
        expect(result.emitted).toBe(3);
        expect(collector.calls.map(c => c.idx)).toEqual([0, 1, 2]);
        expect(collector.calls.map(c => c.audioBase64)).toEqual(['audA', 'audB', 'audC']);
        expect(collector.calls.map(c => c.isLast)).toEqual([false, false, true]);
        expect(collector.calls.map(c => c.sentence)).toEqual(['A.', 'B.', 'C.']);
        expect(collector.calls.every(c => c.total === 3)).toBe(true);
    });

    it('holds fast sentence until slow earlier sentence completes (in-order contract)', async () => {
        // sentence 0 is slow (80ms), sentence 1 is fast (10ms), sentence 2 medium (30ms)
        // Expected: all fire in parallel; emission still 0 -> 1 -> 2 in order.
        const collector = createCollector();
        const gen = createMockGenerator({
            'Slow.': { delay: 80, result: 'audSlow' },
            'Fast.': { delay: 10, result: 'audFast' },
            'Med.': { delay: 30, result: 'audMed' },
        });

        const started = Date.now();
        const result = await emitChunksInOrder(['Slow.', 'Fast.', 'Med.'], gen, collector.fn);
        const elapsed = Date.now() - started;

        expect(result.total).toBe(3);
        expect(collector.calls.map(c => c.idx)).toEqual([0, 1, 2]);
        expect(collector.calls.map(c => c.audioBase64)).toEqual(['audSlow', 'audFast', 'audMed']);
        // Parallel execution: should complete in roughly max(delays) = ~80ms,
        // not sum = 120ms. Generous upper bound to avoid flakiness on slow CI.
        expect(elapsed).toBeLessThan(200);
    });

    it('emits null for failed sentence but continues to next, preserves is_last', async () => {
        const collector = createCollector();
        const gen = createMockGenerator({
            'A.': { result: 'audA' },
            'B.': { error: new Error('synthesize failed') },
            'C.': { result: 'audC' },
        });
        const result = await emitChunksInOrder(['A.', 'B.', 'C.'], gen, collector.fn);

        expect(result).toEqual({ total: 3, emitted: 3, nullCount: 1 });
        expect(collector.calls.map(c => c.audioBase64)).toEqual(['audA', null, 'audC']);
        expect(collector.calls.map(c => c.isLast)).toEqual([false, false, true]);
    });

    it('emits null for sentence that returns null (soft-fail of synthesizeSpeech)', async () => {
        const collector = createCollector();
        const gen = createMockGenerator({
            'A.': { result: 'audA' },
            'B.': { result: null },
        });
        const result = await emitChunksInOrder(['A.', 'B.'], gen, collector.fn);

        expect(result.nullCount).toBe(1);
        expect(collector.calls[1].audioBase64).toBe(null);
        expect(collector.calls[1].isLast).toBe(true);
    });

    it('isLast=true on final chunk even if final sentence fails', async () => {
        // Regression: PWA relies on is_last=true to finalize queue; must fire
        // even when the last sentence returns null.
        const collector = createCollector();
        const gen = createMockGenerator({
            'A.': { result: 'audA' },
            'B.': { error: new Error('last-fail') },
        });
        await emitChunksInOrder(['A.', 'B.'], gen, collector.fn);

        const last = collector.calls[collector.calls.length - 1];
        expect(last.isLast).toBe(true);
        expect(last.audioBase64).toBe(null);
    });

    it('all sentences fail — still emits N chunks with isLast on final', async () => {
        const collector = createCollector();
        const gen = () => Promise.resolve(null);
        const result = await emitChunksInOrder(['A.', 'B.', 'C.'], gen, collector.fn);

        expect(result).toEqual({ total: 3, emitted: 3, nullCount: 3 });
        expect(collector.calls.every(c => c.audioBase64 === null)).toBe(true);
        expect(collector.calls[2].isLast).toBe(true);
    });

    it('generator is called exactly once per sentence (no retries)', async () => {
        const gen = vi.fn(async (s) => `audio_${s}`);
        const collector = createCollector();
        await emitChunksInOrder(['X.', 'Y.', 'Z.'], gen, collector.fn);

        expect(gen).toHaveBeenCalledTimes(3);
    });

    it('passes the sentence index to every parallel generator call', async () => {
        const gen = vi.fn(async (sentence, index) => `audio_${index}_${sentence}`);
        const collector = createCollector();
        await emitChunksInOrder(['X.', 'Y.', 'Z.'], gen, collector.fn);

        expect(gen.mock.calls.map(([, index]) => index)).toEqual([0, 1, 2]);
    });

    it('onChunk is called exactly once per sentence', async () => {
        const onChunk = vi.fn();
        const gen = async (s) => `audio_${s}`;
        await emitChunksInOrder(['X.', 'Y.', 'Z.'], gen, onChunk);

        expect(onChunk).toHaveBeenCalledTimes(3);
    });
});

describe('Azure TTS request telemetry', () => {
    it('records the request start after the limiter releases and before fetch', async () => {
        vi.stubEnv('USE_SERVER_TTS', 'true');
        vi.stubEnv('AZURE_SPEECH_KEY', 'test-key');
        vi.stubEnv('AZURE_SPEECH_REGION', 'test-region');
        const order = [];
        vi.stubGlobal('fetch', vi.fn(async () => {
            order.push('fetch');
            return {
                ok: true,
                arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
            };
        }));

        const events = [];
        await synthesizeSpeech('Hello.', 'en', 'male', {
            sentenceIndex: 2,
            onRequestStart: (event) => {
                order.push('telemetry');
                events.push(event);
            },
        });

        expect(order).toEqual(['telemetry', 'fetch']);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ language: 'en', gender: 'male', sentenceIndex: 2 });
        expect(Number.isFinite(events[0].startedAtMs)).toBe(true);
    });

    it('holds a limiter slot until the audio body is fully downloaded', async () => {
        vi.stubEnv('USE_SERVER_TTS', 'true');
        vi.stubEnv('AZURE_SPEECH_KEY', 'test-key');
        vi.stubEnv('AZURE_SPEECH_REGION', 'test-region');
        const bodyResolvers = [];
        const fetchMock = vi.fn(async () => ({
            ok: true,
            arrayBuffer: () => new Promise((resolve) => bodyResolvers.push(resolve)),
        }));
        vi.stubGlobal('fetch', fetchMock);

        const syntheses = Array.from({ length: 7 }, (_, index) => (
            synthesizeSpeech(`Sentence ${index}.`, 'en', 'male')
        ));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
        expect(bodyResolvers).toHaveLength(6);

        bodyResolvers[0](Uint8Array.from([1]).buffer);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
        expect(bodyResolvers).toHaveLength(7);

        for (const resolve of bodyResolvers.slice(1)) {
            resolve(Uint8Array.from([1]).buffer);
        }
        await expect(Promise.all(syntheses)).resolves.toHaveLength(7);
    });
});

describe('splitForProgressiveTTS batch policy', () => {
    it('keeps short emissions as one chunk when batch policy is enabled', () => {
        const chunks = splitForProgressiveTTS(
            'Pierwsze zdanie. Drugie zdanie.',
            { batchShortEmissions: true, batchMaxChars: 220 },
        );

        expect(chunks).toEqual(['Pierwsze zdanie. Drugie zdanie.']);
    });

    it('falls back to sentence chunks when emission exceeds batch max chars', () => {
        const chunks = splitForProgressiveTTS(
            'Pierwsze dluzsze zdanie zawiera wystarczajaco duzo slow do osobnego chunku. Drugie dluzsze zdanie rowniez zawiera wystarczajaco duzo slow do osobnego chunku.',
            { batchShortEmissions: true, batchMaxChars: 10 },
        );

        expect(chunks.length).toBeGreaterThan(1);
    });
});
