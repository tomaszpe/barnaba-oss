import { describe, expect, it } from 'vitest';
import { createRepE3FallbackGuard } from '../repE3FallbackGuard.js';

const candidate = (changes = {}, text = 'Same complete fallback payload.') => ({ text, provenance: {
    whisperSessionId: 'session-111', decodeId: 111, inputPcmSha256: 'a'.repeat(64),
    inputStartSample: 7753600, inputEndSample: 7936000, ...changes,
} });
const accepted = async () => ({ acceptedForTranslation: true });

describe('REP E3 same-input partial -> deadline guard', () => {
    it('is default OFF and preserves the old second dispatch', async () => {
        const guard = createRepE3FallbackGuard();
        await guard.trackPartial(candidate(), accepted);
        expect(guard.deadlineDecision(candidate())).toEqual({ applied: false, reason: 'disabled' });
    });
    it('blocks the exact same input only after a real accepted enqueue', async () => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        await guard.trackPartial(candidate(), accepted);
        expect(guard.deadlineDecision(candidate())).toEqual({ applied: true, reason: 'same_input_already_accepted' });
    });
    it.each([
        { decodeId: 112 }, { whisperSessionId: 'new-session' }, { inputPcmSha256: 'b'.repeat(64) },
        { inputStartSample: 7753601 }, { inputEndSample: 7936001 },
    ])('preserves intentional repetition from a different input: %j', async (changes) => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        await guard.trackPartial(candidate(), accepted);
        expect(guard.deadlineDecision(candidate(changes)).applied).toBe(false);
    });
    it('does not suppress an extended, shortened or differently punctuated payload', async () => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        await guard.trackPartial(candidate(), accepted);
        for (const text of ['Same complete fallback payload. New content.', 'fallback payload.', 'Same complete fallback payload!']) {
            expect(guard.deadlineDecision(candidate({}, text)).applied).toBe(false);
        }
    });
    it.each([undefined, { acceptedForTranslation: false }])('does not poison state after rejection: %j', async (result) => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        await guard.trackPartial(candidate(), async () => result);
        expect(guard.deadlineDecision(candidate()).applied).toBe(false);
    });
    it('defers an in-flight duplicate and allows retry after a failed dispatch', async () => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        let reject;
        const dispatch = guard.trackPartial(candidate(), () => new Promise((_, fail) => { reject = fail; }));
        expect(guard.deadlineDecision(candidate())).toEqual({ applied: true, reason: 'same_input_inflight' });
        reject(new Error('queue failure'));
        await expect(dispatch).rejects.toThrow('queue failure');
        expect(guard.deadlineDecision(candidate()).applied).toBe(false);
    });
    it.each([
        { decodeId: null }, { inputPcmSha256: null }, { whisperSessionId: null },
        { inputEndSample: 0 }, { inputStartSample: -1 },
    ])('fails open without complete input identity: %j', async (changes) => {
        const guard = createRepE3FallbackGuard({ enabled: true });
        await guard.trackPartial(candidate(changes), accepted);
        expect(guard.deadlineDecision(candidate(changes)).applied).toBe(false);
    });
    it('isolates church/session lifecycle state', async () => {
        const first = createRepE3FallbackGuard({ enabled: true });
        const next = createRepE3FallbackGuard({ enabled: true });
        await first.trackPartial(candidate(), accepted);
        expect(next.deadlineDecision(candidate()).applied).toBe(false);
    });
    it('bounds completed history without blocking new content', async () => {
        const guard = createRepE3FallbackGuard({ enabled: true, maxEntries: 1 });
        await guard.trackPartial(candidate(), accepted);
        await guard.trackPartial(candidate({ decodeId: 112 }), accepted);
        expect(guard.deadlineDecision(candidate()).applied).toBe(false);
        expect(guard.deadlineDecision(candidate({ decodeId: 112 })).applied).toBe(true);
    });
});
