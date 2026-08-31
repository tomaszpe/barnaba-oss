import { describe, it, expect } from 'vitest';
import { runDisconnectDrain, withTimeout } from '../disconnectDrain.js';

function makeDeps(over = {}) {
    const order = [];
    const events = [];
    const emits = [];
    let counter = 0;
    const deps = {
        now: () => 0,
        hash: (t) => 'h' + String(t).length,
        newTailItemId: () => `tail-${++counter}`,
        evalLog: (e) => { events.push(e); },
        snapshot: () => ({ smoothSentences: 0, smoothChars: 0, holdnChars: 0, queueDepth: 0, inFlight: 0 }),
        finalTranscribe: async () => null,
        flushSmooth: () => null,
        flushHoldN: () => '',
        emit: async (text, meta) => { order.push('emit'); emits.push({ text, meta }); },
        drainQueue: async () => { order.push('drainQueue'); },
        flushSummary: () => { order.push('flushSummary'); },
        cleanup: () => { order.push('cleanup'); },
        ...over,
    };
    return { deps, order, events, emits };
}
const CTX = { churchId: 'c', drainId: 'd1', timeouts: { finalTranscribeMs: 50, queueDrainMs: 50 } };

describe('runDisconnectDrain (P-B core)', () => {
    it('orders: emit -> drainQueue -> flushSummary -> cleanup (summary never before drain)', async () => {
        const { deps, order } = makeDeps({ finalTranscribe: async () => 'Letzter Satz.' });
        await runDisconnectDrain(CTX, deps);
        expect(order.indexOf('emit')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('emit')).toBeLessThan(order.indexOf('drainQueue'));
        expect(order.indexOf('drainQueue')).toBeLessThan(order.indexOf('flushSummary'));
        expect(order.indexOf('flushSummary')).toBeLessThan(order.indexOf('cleanup'));
    });

    it('emits final transcription and tags drainId/tailItemId (guard bypass is the dep concern)', async () => {
        const { deps, emits, events } = makeDeps({ finalTranscribe: async () => 'Final.' });
        await runDisconnectDrain(CTX, deps);
        expect(emits.length).toBe(1);
        expect(emits[0].text).toBe('Final.');
        expect(emits[0].meta.drainId).toBe('d1');
        expect(emits[0].meta.tailItemId).toBeTruthy();
        const ftr = events.find(e => e.stage === 'disconnect_final_transcribe_result');
        expect(ftr.accepted).toBe(true);
        expect(ftr.tailItemId).toBe(emits[0].meta.tailItemId);
    });

    it('flushes sub-threshold smooth accumulator (the prime tail-loss)', async () => {
        const { deps, emits, events } = makeDeps({
            flushSmooth: () => ({ text: 'Eine kurze Zeile.', sentenceCount: 1, charCount: 17 }),
        });
        await runDisconnectDrain(CTX, deps);
        expect(emits.some(e => e.text === 'Eine kurze Zeile.')).toBe(true);
        const sf = events.find(e => e.stage === 'disconnect_smooth_flush');
        expect(sf.released_sentences).toBe(1);
        expect(sf.tailItemId).toBeTruthy();
    });

    it('flushes HOLD_N held tail', async () => {
        const { deps, emits } = makeDeps({ flushHoldN: () => 'gehaltene Worte' });
        await runDisconnectDrain(CTX, deps);
        expect(emits.some(e => e.text === 'gehaltene Worte')).toBe(true);
    });

    it('queue drain timeout -> stage_cut=queue_drain + drain_timeout event (never silent)', async () => {
        const { deps, events } = makeDeps({ drainQueue: () => new Promise(() => {}) });
        const res = await runDisconnectDrain({ ...CTX, timeouts: { finalTranscribeMs: 20, queueDrainMs: 20 } }, deps);
        expect(res.stageCut).toBe('queue_drain');
        const to = events.find(e => e.stage === 'disconnect_drain_timeout');
        expect(to).toBeTruthy();
        expect(to.stage_cut).toBe('queue_drain');
    });

    it('empty drain still logs start+done and runs summary then cleanup (no emits)', async () => {
        const { deps, order, events } = makeDeps();
        await runDisconnectDrain(CTX, deps);
        expect(events.find(e => e.stage === 'disconnect_drain_start')).toBeTruthy();
        expect(events.find(e => e.stage === 'disconnect_drain_done')).toBeTruthy();
        expect(order).toEqual(['drainQueue', 'flushSummary', 'cleanup']);
    });

    it('cleanup still runs even if a flush emit throws; counts emit error not submitted', async () => {
        const { deps, order } = makeDeps({
            flushSmooth: () => ({ text: 'boom', sentenceCount: 1, charCount: 4 }),
            emit: async () => { throw new Error('emit failed'); },
        });
        const res = await runDisconnectDrain(CTX, deps);
        expect(order).toContain('flushSummary');
        expect(order).toContain('cleanup');
        expect(order.indexOf('flushSummary')).toBeLessThan(order.indexOf('cleanup'));
        expect(res.emitErrors).toBe(1);
        expect(res.submitted).toBe(0);   // submitted != proof of broadcast; a thrown emit is an error, not a submit
    });
});

describe('withTimeout', () => {
    it('returns value when the promise resolves in time', async () => {
        const r = await withTimeout(Promise.resolve('x'), 50);
        expect(r).toEqual({ timedOut: false, value: 'x' });
    });
    it('flags timedOut when the promise is slow', async () => {
        const r = await withTimeout(new Promise(() => {}), 10);
        expect(r.timedOut).toBe(true);
        expect(r.value).toBeNull();
    });
    it('no timeout bound (0) just awaits', async () => {
        const r = await withTimeout(Promise.resolve(42), 0);
        expect(r).toEqual({ timedOut: false, value: 42 });
    });
});
