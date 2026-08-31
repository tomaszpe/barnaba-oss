import { describe, expect, it } from 'vitest';
import { buildWhisperRequestEvidence, createWhisperRequestTracker } from '../whisperRequestTracker.js';

/**
 * The shape of the evidence attached to fallback decisions. A pure function over ONE snapshot,
 * so it can be checked directly, without `server.js` (which calls `listen()` at the top level
 * and cannot be imported).
 */

function makeClock(start = 1000) {
    let mono = start;
    return { now: () => mono, wallNow: () => 1_700_000_000_000, advance: (ms) => { mono += ms; } };
}

describe('buildWhisperRequestEvidence - the "we do not know" state', () => {
    it('unavailable does NOT become count 0 or an empty array', () => {
        const fields = buildWhisperRequestEvidence({ unavailable: true, reason: 'tracker down' });

        expect(fields.whisper_request_in_flight_unavailable).toBe(true);
        expect(fields.whisper_request_in_flight_unavailable_reason).toBe('tracker down');
        // NO default values: a report must not add "we do not know" to "nothing is in progress"
        expect(fields).not.toHaveProperty('whisper_request_in_flight_count');
        expect(fields).not.toHaveProperty('whisper_request_in_flight_request_ids');
        expect(fields).not.toHaveProperty('whisper_request_in_flight_oldest_age_ms');
    });

    it('a missing snapshot is also the "we do not know" state, not a zero', () => {
        const fields = buildWhisperRequestEvidence(null);
        expect(fields.whisper_request_in_flight_unavailable).toBe(true);
        expect(fields).not.toHaveProperty('whisper_request_in_flight_count');
    });

    it('an empty snapshot is KNOWLEDGE that nothing is in progress - count 0 and no unavailable flag', () => {
        const tracker = createWhisperRequestTracker(makeClock());
        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'));

        expect(fields.whisper_request_in_flight_count).toBe(0);
        expect(fields.whisper_request_in_flight_request_ids).toEqual([]);
        expect(fields).not.toHaveProperty('whisper_request_in_flight_unavailable');
    });
});

describe('buildWhisperRequestEvidence - the full set of requests', () => {
    it('with count>1 it carries ALL request_ids and ages, not only the oldest', () => {
        const clock = makeClock();
        const tracker = createWhisperRequestTracker({ ...clock, bootId: 'boot-A' });
        const first = tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });
        clock.advance(300);
        const second = tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });
        clock.advance(100);

        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'));

        expect(fields.whisper_request_in_flight_count).toBe(2);
        expect(fields.whisper_request_in_flight_request_ids).toEqual([second, first]);
        expect(fields.whisper_request_in_flight_ages_ms).toEqual([100, 400]);
        expect(fields.whisper_request_in_flight_oldest_request_id).toBe(first);
        expect(fields.whisper_request_in_flight_oldest_age_ms).toBe(400);
    });

    it('carries both timings of the oldest request: from the first attempt and from the current one', () => {
        const clock = makeClock();
        const tracker = createWhisperRequestTracker({ ...clock, bootId: 'boot-A' });
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });
        clock.advance(1000);
        tracker.markAttempt('ch1', requestId, 2);
        clock.advance(150);

        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'));
        expect(fields.whisper_request_in_flight_oldest_age_ms).toBe(1150);
        expect(fields.whisper_request_in_flight_oldest_attempt_age_ms).toBe(150);
        expect(fields.whisper_request_in_flight_oldest_attempt).toBe(2);
    });
});

describe('buildWhisperRequestEvidence - a candidate, not evidence', () => {
    it('publishing while a request is open gives a CANDIDATE', () => {
        const tracker = createWhisperRequestTracker(makeClock());
        tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });

        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'), { publication: true });
        expect(fields.premature_publication_candidate).toBe(true);
        // The name is the only admissible claim: an open request proves neither that a decode
        // was running (it may be `coalesced_skip`) nor that a later result would have been better.
        expect(Object.keys(fields).some(k => /premature_publication(?!_candidate)/.test(k))).toBe(false);
        expect(Object.keys(fields).some(k => k.includes('proof') || k.includes('proven'))).toBe(false);
    });

    it('a NEGATIVE decision gets no candidate flag at all', () => {
        const tracker = createWhisperRequestTracker(makeClock());
        tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });

        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'));
        expect(fields).not.toHaveProperty('premature_publication_candidate');
    });

    it('publishing with no open request is an explicit false', () => {
        const tracker = createWhisperRequestTracker(makeClock());
        const fields = buildWhisperRequestEvidence(tracker.snapshot('ch1'), { publication: true });
        expect(fields.premature_publication_candidate).toBe(false);
    });

    it('with unavailable the candidate flag is NOT created - absence of knowledge is not "not a candidate"', () => {
        const fields = buildWhisperRequestEvidence({ unavailable: true, reason: 'boom' }, { publication: true });
        expect(fields).not.toHaveProperty('premature_publication_candidate');
    });
});

describe('buildWhisperRequestEvidence - cleanliness', () => {
    it('does not read the tracker, so a record cannot be assembled from several moments', () => {
        const clock = makeClock();
        const tracker = createWhisperRequestTracker({ ...clock, bootId: 'boot-A' });
        tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });
        const snapshot = tracker.snapshot('ch1');

        clock.advance(5000);
        tracker.register({ churchId: 'ch1', whisperSessionId: 's1' });

        // the same snapshot gives the same result, even though the tracker has moved on
        const fields = buildWhisperRequestEvidence(snapshot);
        expect(fields.whisper_request_in_flight_count).toBe(1);
        expect(fields.whisper_request_in_flight_oldest_age_ms).toBe(0);
    });
});
