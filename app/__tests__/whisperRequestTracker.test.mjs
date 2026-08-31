import { describe, expect, it } from 'vitest';
import { createWhisperRequestTracker, safeSnapshot } from '../whisperRequestTracker.js';

/**
 * Acceptance tests for the tracker ALONE, without `whisperClient` and without `server.js`.
 * Lifecycle, retry and join are proven separately, before a snapshot reaches many decision
 * branches.
 */

function makeClock(start = 1000) {
    let mono = start;
    let wall = 1_700_000_000_000;
    return {
        now: () => mono,
        wallNow: () => wall,
        advance: (ms) => { mono += ms; wall += ms; },
        rewindWall: (ms) => { wall -= ms; },   // NTP jump backwards, monotonic clock unchanged
    };
}

const SESSION_A = '7f8164eb-960d-4cfe-982b-3738d87cf0b9';

function makeTracker(overrides = {}) {
    const clock = makeClock();
    const tracker = createWhisperRequestTracker({
        now: clock.now, wallNow: clock.wallNow, bootId: 'boot-A', ...overrides,
    });
    return { tracker, clock };
}

describe('whisperRequestTracker - record identity', () => {
    it('issues a request_id that stays unique across a gateway restart', () => {
        const a = createWhisperRequestTracker({ bootId: 'boot-A' });
        const b = createWhisperRequestTracker({ bootId: 'boot-B' });

        const first = a.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const second = b.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        // same congregation, same seq - different process runs
        expect(first).toBe('boot-A:ch1:1');
        expect(second).toBe('boot-B:ch1:1');
        expect(first).not.toBe(second);
    });

    it('assigns a default bootId when none is injected', () => {
        const tracker = createWhisperRequestTracker();
        expect(tracker.bootId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('whisperRequestTracker - request age', () => {
    it('does not count the wait for session creation into age_ms', () => {
        const { tracker, clock } = makeTracker();
        // 900 ms went into `getOrCreateStreamingSession` BEFORE registration
        clock.advance(900);
        const requestId = tracker.register({
            churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9', sessionWaitMs: 900,
        });
        clock.advance(120);

        const snap = tracker.snapshot('ch1');
        expect(snap.requests[0].age_ms).toBe(120);

        const done = tracker.complete('ch1', requestId, { provenance: { decodeId: 7 } });
        expect(done.age_ms).toBe(120);
        // the session wait does not disappear silently - it has its own field
        expect(done.session_wait_ms).toBe(900);
    });

    it('measures age with the monotonic clock, so a wall-clock rewind does not move it', () => {
        const { tracker, clock } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        clock.advance(200);
        clock.rewindWall(60 * 60 * 1000);   // NTP jumps an hour backwards

        expect(tracker.snapshot('ch1').requests[0].age_ms).toBe(200);
        expect(tracker.complete('ch1', requestId).age_ms).toBe(200);
    });
});

describe('whisperRequestTracker — retry', () => {
    it('a further attempt does NOT create a second request, it only bumps attempt', () => {
        const { tracker, clock } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        clock.advance(1000);
        expect(tracker.markAttempt('ch1', requestId, 2)).toBe(true);
        clock.advance(150);

        const snap = tracker.snapshot('ch1');
        expect(snap.count).toBe(1);
        // two disjoint timings: from the first attempt and from the current one
        expect(snap.requests[0].age_ms).toBe(1150);
        expect(snap.requests[0].attempt_age_ms).toBe(150);
        expect(snap.requests[0].attempt).toBe(2);
        // both timings also as flat fields - the two-clock contract must be readable
        // by a helper that does not look inside `requests`
        expect(snap.oldest_age_ms).toBe(1150);
        expect(snap.oldest_attempt_age_ms).toBe(150);
    });

    it('markAttempt on an unknown record does not create a new one', () => {
        const { tracker } = makeTracker();
        expect(tracker.markAttempt('ch1', 'boot-A:ch1:99', 2)).toBe(false);
        expect(tracker.snapshot('ch1').count).toBe(0);
    });
});

describe('whisperRequestTracker — snapshot', () => {
    it('with count=2 it returns BOTH active requests, not only the oldest', () => {
        const { tracker, clock } = makeTracker();
        const first = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        clock.advance(300);
        const second = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        clock.advance(100);

        const snap = tracker.snapshot('ch1');
        expect(snap.count).toBe(2);
        expect(snap.requests.map(r => r.request_id)).toEqual([second, first]);
        expect(snap.requests.map(r => r.age_ms)).toEqual([100, 400]);
        // `oldest_*` is a shortcut DERIVED from `requests`, not a replacement for them
        expect(snap.oldest_request_id).toBe(first);
        expect(snap.oldest_age_ms).toBe(400);
    });

    it('does not mix congregations', () => {
        const { tracker } = makeTracker();
        tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        tracker.register({ churchId: 'ch2', whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' });

        expect(tracker.snapshot('ch1').count).toBe(1);
        expect(tracker.snapshot('ch2').count).toBe(1);
        expect(tracker.activeCount()).toBe(2);
    });

    it('returns copies, so a read cannot change tracker state', () => {
        const { tracker } = makeTracker();
        tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        const snap = tracker.snapshot('ch1');
        snap.requests[0].age_ms = 999999;
        snap.requests.pop();

        expect(tracker.snapshot('ch1').count).toBe(1);
        expect(tracker.snapshot('ch1').requests[0].age_ms).toBe(0);
    });

    it('carries no field about decode state', () => {
        const { tracker } = makeTracker();
        tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const snap = tracker.snapshot('ch1');

        // live state describes REQUESTS; `decode_proof` is derived from the response
        expect(Object.keys(snap).some(k => k.startsWith('decode'))).toBe(false);
        expect(Object.keys(snap.requests[0]).some(k => k.startsWith('decode'))).toBe(false);
    });

    it('unavailable is not the same thing as count 0', () => {
        const { tracker } = makeTracker();
        const empty = safeSnapshot(tracker, 'ch1');
        expect(empty.count).toBe(0);
        expect(empty.unavailable).toBeUndefined();

        const broken = safeSnapshot({
            snapshot() { throw new Error('tracker down'); },
        }, 'ch1');
        expect(broken).toEqual({ unavailable: true, reason: 'tracker down' });
        expect(broken.count).toBeUndefined();

        expect(safeSnapshot(null, 'ch1')).toEqual({ unavailable: true, reason: 'no_tracker' });
    });
});

describe('whisperRequestTracker — completion i join', () => {
    it('wiaze request_id z para (whisper_session_id, decode_id)', () => {
        const { tracker, clock } = makeTracker();
        const requestId = tracker.register({
            churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9', sampleCount: 32000, sampleRate: 16000,
            latencyTxId: 'tx-9',
        });
        clock.advance(216);

        const done = tracker.complete('ch1', requestId, {
            provenance: { decodeId: 41, whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9', provenanceStatus: 'complete' },
        });

        expect(done.request_id).toBe(requestId);
        expect(done.whisper_session_id).toBe('7f8164eb-960d-4cfe-982b-3738d87cf0b9');
        expect(done.decode_id).toBe(41);
        expect(done.age_ms).toBe(216);
        expect(done.latency_tx_id).toBe('tx-9');
        // provenance scalars pass through unchanged; word text is removed (separate test)
        expect(done.provenance.provenanceStatus).toBe('complete');
    });

    it('the same decode_id from two sessions does not merge into one decode', () => {
        const { tracker } = makeTracker();
        const a = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const doneA = tracker.complete('ch1', a, { provenance: { decodeId: 1, whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' } });
        const b = tracker.register({ churchId: 'ch1', whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' });
        const doneB = tracker.complete('ch1', b, { provenance: { decodeId: 1, whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' } });

        expect(doneA.decode_id).toBe(doneB.decode_id);
        expect(doneA.whisper_session_id).not.toBe(doneB.whisper_session_id);
        const key = d => `${d.whisper_session_id}:${d.decode_id}`;
        expect(key(doneA)).not.toBe(key(doneB));
    });

    it('decode_proof=absent does NOT mean "there was no decode"', () => {
        const { tracker } = makeTracker();
        const coalesced = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const done = tracker.complete('ch1', coalesced, {
            provenance: { decodeId: null, whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' },
        });

        // `absent` = this response carries no evidence. Coalescing, a too-short buffer, a missing
        // model AND a pipeline exception (the decode started and left no evidence) are all
        // indistinguishable here.
        expect(done.decode_proof).toBe('absent');
        expect(Object.keys(done)).not.toContain('decoded');
        expect(Object.keys(done)).not.toContain('decode_in_flight');
    });

    it('releases the record on error and records ONLY the reason CODE', () => {
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        const done = tracker.complete('ch1', requestId, {
            error: new Error('HTTP 503: {"detail":"Hiob sprach zum Herrn"}'),
        });

        expect(done.error_code).toBe('HTTP_503');
        // a response body can carry a transcript - it must never reach the log
        expect(JSON.stringify(done)).not.toContain('Hiob');
        expect(done.decode_proof).toBe('absent');
        expect(tracker.snapshot('ch1').count).toBe(0);
    });

    it('abort and errors without an HTTP status also give a safe code', () => {
        const { tracker } = makeTracker();
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';

        const a = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        expect(tracker.complete('ch1', a, { error: abort }).error_code).toBe('AbortError');
        const b = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        expect(tracker.complete('ch1', b, { error: new Error('socket hang up') }).error_code).toBe('Error');
    });

    it('an unknown exception name degrades to Error rather than passing through as text', () => {
        // `error.name` is just as arbitrary a piece of text as the message - it can come from a
        // library or from a remote response. Passing it through directly would bypass the whole
        // sanitisation by a side door.
        const { tracker } = makeTracker();
        const exotic = new Error('anything at all');
        exotic.name = 'Gelassenheit';

        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const done = tracker.complete('ch1', requestId, { error: exotic });

        expect(done.error_code).toBe('Error');
        expect(JSON.stringify(done)).not.toContain('Gelassenheit');
    });

    it('completion does not pass through a free-form alignment_reason containing a source word', () => {
        // A REAL LEAK from a DEV smoke run: `alignment_reason` carried `repr(word)`, and
        // `...scalars` passed it straight into `evalLog`. Sanitisation runs off a field
        // ALLOWLIST, so any new field on the Whisper side does NOT reach the log by default.
        const { tracker } = makeTracker();
        const leaked = ["des", "Wenn", "Minuten", "Gelassenheit"];

        for (const word of leaked) {
            const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
            const done = tracker.complete('ch1', requestId, {
                provenance: {
                    decodeId: 11,
                    whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9',
                    provenanceStatus: 'incomplete_provenance',
                    provenanceReason: 'invalid_timestamp',
                    alignmentStatus: 'unaligned',
                    alignmentReason: `invalid_timestamp:zero_or_reversed [2.18, 2.18] for '${word}'`,
                    inferenceMs: 2294.4,
                    inputPcmSha256: '3c3e527feb09a2a1e77cd062021e88fbe21e282448f956b61267c00d870e9f2d',
                },
            });

            const blob = JSON.stringify(done);
            expect(blob).not.toContain(word);
            // the raw field disappears; only `alignmentReasonCode` remains
            expect(done.provenance).not.toHaveProperty('alignmentReason');
            expect(blob).not.toContain('[2.18, 2.18]');
            // the reason CODE stays - the report must still be able to split subtypes
            expect(done.provenance.alignmentReasonCode).toBe('invalid_timestamp:zero_or_reversed');
            expect(done.provenance.provenanceReason).toBe('invalid_timestamp');
            // numeric values pass through unchanged
            expect(done.provenance.inferenceMs).toBe(2294.4);
            expect(done.provenance.inputPcmSha256).toBe('3c3e527feb09a2a1e77cd062021e88fbe21e282448f956b61267c00d870e9f2d');
        }
    });

    it('an unknown alignment code degrades to unclassified rather than passing as text', () => {
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const done = tracker.complete('ch1', requestId, {
            provenance: { decodeId: 1, alignmentReason: 'a_code_nobody_ever_added Gelassenheit' },
        });

        expect(done.provenance.alignmentReasonCode).toBe('unclassified');
        expect(JSON.stringify(done)).not.toContain('Gelassenheit');
    });

    it('text injected into EVERY permitted field does not reach the log', () => {
        // A KEY allowlist is not enough: a faulty or malicious response smuggles text through a
        // field that is on the list. Every value therefore has a type and a shape.
        const { tracker } = makeTracker();
        const fields = [
            'decodeId', 'whisperSessionId', 'inputPcmSha256', 'inputStartSample', 'inputEndSample',
            'decodeRequestedAtMs', 'decodeStartedAtMs', 'decodeFinishedAtMs', 'executorWaitMs',
            'inferenceMs', 'workerTotalMs', 'decodeTotalMs', 'transcribeStatus', 'provenanceStatus',
            'provenanceReason', 'textTokenCount', 'spanTokenCount', 'alignmentStatus',
            'alignmentReason', 'unalignedWordCount', 'nonWordLevelChunk', 'alignedSpan',
            'confirmedWordSpans',
        ];

        for (const field of fields) {
            const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: SESSION_A });
            const done = tracker.complete('ch1', requestId, {
                provenance: { [field]: 'Gelassenheit' },
            });
            expect(JSON.stringify(done), `field ${field} let text through`).not.toContain('Gelassenheit');
        }

        // also when the text sits INSIDE a structure of the correct shape
        const rid = tracker.register({ churchId: 'ch1', whisperSessionId: SESSION_A });
        const nested = tracker.complete('ch1', rid, {
            provenance: {
                decodeId: 1,
                alignedSpan: [0, 'Gelassenheit'],
                confirmedWordSpans: [{ text: 'Gelassenheit', start_sample: 'Gelassenheit', end_sample: 8000 }],
            },
        });
        expect(JSON.stringify(nested)).not.toContain('Gelassenheit');
        expect(nested.provenance.alignedSpan).toBeNull();
    });

    it('a broken field is RECORDED by name rather than silently zeroed', () => {
        // "The field arrived in the wrong shape" is different from "the field was absent" - the
        // same principle as `unavailable` vs `count: 0`. Field NAMES travel, never values.
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: SESSION_A });
        const done = tracker.complete('ch1', requestId, {
            provenance: { decodeId: 1, inferenceMs: 'Gelassenheit', transcribeStatus: 'Gelassenheit' },
        });

        expect(done.provenance.inferenceMs).toBeNull();
        expect(done.provenance.transcribeStatus).toBe('unclassified');
        expect(done.provenance.rejectedFields).toContain('inferenceMs');
        expect(JSON.stringify(done)).not.toContain('Gelassenheit');
    });

    it('non_word_level_chunk keeps its bucket and its token count', () => {
        // Regression: `^[a-z_]+(?::[a-z_]+)?` cut `non_word_level_chunk:tokens`, which is not in
        // the allowlist - so the whole intended diagnostic bucket fell into `unclassified`.
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: SESSION_A });
        const done = tracker.complete('ch1', requestId, {
            provenance: {
                decodeId: 9, alignmentStatus: 'unaligned',
                alignmentReason: 'non_word_level_chunk:tokens=3',
            },
        });

        expect(done.provenance.alignmentReasonCode).toBe('non_word_level_chunk');
        expect(done.provenance.nonWordLevelChunkTokens).toBe(3);
    });

    it('an unknown field added on the Whisper side does NOT reach the log', () => {
        // An allowlist instead of `...scalars`: a new field must be added DELIBERATELY.
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });
        const done = tracker.complete('ch1', requestId, {
            provenance: { decodeId: 1, futureDebugField: "raw text 'Minuten'" },
        });

        expect(done.provenance).not.toHaveProperty('futureDebugField');
        expect(JSON.stringify(done)).not.toContain('Minuten');
    });

    it('completion carries no delta words, only a counter and a sample range', () => {
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        const done = tracker.complete('ch1', requestId, {
            provenance: {
                decodeId: 41, whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9', provenanceStatus: 'complete',
                confirmedWordSpans: [
                    { text: 'Gelassenheit', start_sample: 16000, end_sample: 32000 },
                    { text: 'Hiob', start_sample: 0, end_sample: 8000 },
                ],
            },
        });

        expect(JSON.stringify(done)).not.toContain('Gelassenheit');
        expect(done.provenance.confirmedWordSpans).toBeUndefined();
        expect(done.provenance.confirmedWordSpanCount).toBe(2);
        // min/max, not the first and last record - span order is sometimes non-chronological
        expect(done.provenance.confirmedSpanStartSample).toBe(0);
        expect(done.provenance.confirmedSpanEndSample).toBe(32000);
        // scalars pass through unchanged
        expect(done.provenance.provenanceStatus).toBe('complete');
    });

    it('a double release does not produce a second completion event', () => {
        const { tracker } = makeTracker();
        const requestId = tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' });

        expect(tracker.complete('ch1', requestId)).not.toBeNull();
        expect(tracker.complete('ch1', requestId)).toBeNull();
    });

    it('after every request finishes, each map has count 0', () => {
        const { tracker } = makeTracker();
        const ids = [
            ['ch1', tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' })],
            ['ch1', tracker.register({ churchId: 'ch1', whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' })],
            ['ch2', tracker.register({ churchId: 'ch2', whisperSessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' })],
        ];
        for (const [churchId, id] of ids) tracker.complete(churchId, id);

        expect(tracker.activeCount()).toBe(0);
        expect(tracker.snapshot('ch1').count).toBe(0);
        expect(tracker.snapshot('ch2').count).toBe(0);
    });
});
