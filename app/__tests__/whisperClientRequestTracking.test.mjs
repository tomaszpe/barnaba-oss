import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tracker's integration layer with `whisperClient`. Still WITHOUT `server.js`:
 * lifecycle, retry, provenance forwarding and the completion event are proven before a
 * snapshot is used in decision branches.
 */

const SERVICE_URL = 'http://whisper.test';
process.env.WHISPER_SERVICE_URL = SERVICE_URL;

const { sendStreamingChunk, getWhisperRequestsInFlight, clearAudioBuffer, WHISPER_CONFIG } =
    await import('../whisperClient.js');
const { sourceLineageFromWhisper } = await import('../sourceLineage.js');

// The `fetchWithRetry` backoff is 1 s + 2 s per error test. It is shortened in the fixture
// rather than adding injection to the production API purely to make tests faster.
const REAL_RETRY_DELAY_MS = WHISPER_CONFIG.retryDelayMs;

const SESSION_RESPONSE = { session_id: '7f8164eb-960d-4cfe-982b-3738d87cf0b9' };

function chunkResponse(overrides = {}) {
    return {
        partial_text: 'Hiob', confirmed_text: 'Hiob sprach',
        is_speech: true, has_new_transcription: true,
        stable_text: 'Hiob sprach', la_confirmed_word_count: 2, la_confirmed_char_count: 11,
        decode_id: 41, input_pcm_sha256: '3c3e527feb09a2a1e77cd062021e88fbe21e282448f956b61267c00d870e9f2d', input_start_sample: 0, input_end_sample: 32000,
        executor_wait_ms: 5.5, inference_ms: 120.4, worker_total_ms: 130.1, decode_total_ms: 140.0,
        transcribe_status: 'accepted', provenance_status: 'complete', provenance_reason: null,
        confirmed_word_spans: [{ text: 'Hiob', start_sample: 0, end_sample: 8000 }],
        partial_provenance_status: 'complete',
        partial_word_spans: [{ text: 'Hiob', start_sample: 0, end_sample: 8000 }],
        partial_alignment_status: 'exact',
        stable_provenance_status: 'complete',
        stable_word_spans: [
            { text: 'Hiob', start_sample: 0, end_sample: 8000 },
            { text: 'sprach', start_sample: 8000, end_sample: 16000 },
        ],
        stable_alignment_status: 'exact',
        alignment_status: 'exact', alignment_reason: null,
        ...overrides,
    };
}

function jsonOk(payload) {
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** Queue of responses to chunk requests; the session is handled automatically. */
function stubFetch(handlers) {
    const calls = [];
    const fetchMock = vi.fn(async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith('/session/create')) return jsonOk(SESSION_RESPONSE);
        const handler = handlers.shift();
        if (typeof handler === 'function') return handler(url, options);
        return jsonOk(handler);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
}

beforeEach(() => {
    clearAudioBuffer('ch1');
    WHISPER_CONFIG.retryDelayMs = 0;
});

afterEach(() => {
    // UNCONDITIONALLY, including after a failed test - otherwise later suites inherit a
    // mutated production configuration.
    WHISPER_CONFIG.retryDelayMs = REAL_RETRY_DELAY_MS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('whisperClient - registering and releasing a request', () => {
    it('a request is visible in the snapshot WHILE IN FLIGHT and gone once it returns', async () => {
        let seenDuringFlight = null;
        stubFetch([async () => {
            seenDuringFlight = getWhisperRequestsInFlight('ch1');
            return jsonOk(chunkResponse());
        }]);

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        expect(seenDuringFlight.count).toBe(1);
        expect(seenDuringFlight.requests).toHaveLength(1);
        expect(seenDuringFlight.requests[0].request_id).toMatch(/^[0-9a-f-]{36}:ch1:\d+$/);
        expect(seenDuringFlight.requests[0].whisper_session_id).toBe('7f8164eb-960d-4cfe-982b-3738d87cf0b9');
        // after the return: nothing leaked
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });

    it('an HTTP error also releases the record', async () => {
        stubFetch([
            async () => { throw new Error('socket hang up'); },
            async () => { throw new Error('socket hang up'); },
            async () => { throw new Error('socket hang up'); },
        ]);

        await expect(sendStreamingChunk('ch1', new Float32Array(1600), 16000, false))
            .rejects.toThrow('socket hang up');
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });

    it('an abort from a timeout releases the record too', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        stubFetch([
            async () => { throw abortError; },
            async () => { throw abortError; },
            async () => { throw abortError; },
        ]);

        await expect(sendStreamingChunk('ch1', new Float32Array(1600), 16000, false)).rejects.toThrow();
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });

    it('two parallel requests give count=2 and BOTH records', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let snapshotWithTwo = null;

        stubFetch([
            async () => { await gate; return jsonOk(chunkResponse()); },
            async () => {
                snapshotWithTwo = getWhisperRequestsInFlight('ch1');
                release();
                return jsonOk(chunkResponse({ decode_id: 42 }));
            },
        ]);

        const first = sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);
        const second = sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);
        await Promise.all([first, second]);

        expect(snapshotWithTwo.count).toBe(2);
        expect(snapshotWithTwo.requests).toHaveLength(2);
        expect(new Set(snapshotWithTwo.requests.map(r => r.request_id)).size).toBe(2);
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });
});

describe('whisperClient - Whisper session', () => {
    it('an error on the FINAL chunk does NOT drop the session - the next send reuses it', async () => {
        const { calls } = stubFetch([
            async () => { throw new Error('HTTP 502: bad gateway'); },
            async () => { throw new Error('HTTP 502: bad gateway'); },
            async () => { throw new Error('HTTP 502: bad gateway'); },
            chunkResponse(),
        ]);

        await expect(sendStreamingChunk('ch1', new Float32Array(1600), 16000, true))
            .rejects.toThrow('HTTP 502');
        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        // exactly ONE `/session/create` - the session survived the failed final
        expect(calls.filter(c => String(c.url).endsWith('/session/create'))).toHaveLength(1);
        expect(calls.filter(c => String(c.url).includes('/chunk'))
            .every(c => String(c.url).includes('/session/7f8164eb-960d-4cfe-982b-3738d87cf0b9/'))).toBe(true);
        // the tracker record is released despite the error - these are two different things
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });

    it('a SUCCESSFUL final drops the session, so the next send creates a new one', async () => {
        const { calls } = stubFetch([chunkResponse(), chunkResponse()]);

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, true);
        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        expect(calls.filter(c => String(c.url).endsWith('/session/create'))).toHaveLength(2);
    });

    it('sessionWaitMs is measured monotonically, so a wall-clock jump does not move it', async () => {
        const realDateNow = Date.now;
        const events = [];
        stubFetch([chunkResponse()]);

        // An NTP jump one hour BACKWARDS happens BETWEEN the start and the end of the
        // measurement: the first wall-clock read is from before the jump, every later one after
        // it. With `Date.now()` this would give `session_wait_ms = -3600000`.
        let call = 0;
        Date.now = () => (call++ === 0 ? realDateNow() : realDateNow() - 3600_000);
        try {
            await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
                onRequestCompleted: (event) => events.push(event),
            });
        } finally {
            Date.now = realDateNow;
        }

        expect(events[0].session_wait_ms).toBeGreaterThanOrEqual(0);
        expect(events[0].session_wait_ms).toBeLessThan(10_000);
    });
});

describe('whisperClient — retry', () => {
    it('a retry does NOT create a second request, it only bumps attempt', async () => {
        let snapshotOnRetry = null;
        stubFetch([
            async () => { throw new Error('HTTP 503: busy'); },
            async () => {
                snapshotOnRetry = getWhisperRequestsInFlight('ch1');
                return jsonOk(chunkResponse());
            },
        ]);

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        expect(snapshotOnRetry.count).toBe(1);       // one LOGICAL REQUEST, two HTTP attempts
        expect(snapshotOnRetry.requests[0].attempt).toBe(2);
    });

    it('onAttemptStart does NOT reach fetch', async () => {
        const { calls } = stubFetch([chunkResponse()]);

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        const chunkCall = calls.find(c => String(c.url).includes('/chunk'));
        expect(chunkCall.options.onAttemptStart).toBeUndefined();
        expect(Object.values(chunkCall.options).some(v => typeof v === 'function')).toBe(false);
        expect(chunkCall.options.signal).toBeDefined();
    });
});

describe('whisperClient — provenance i completion', () => {
    it('keeps fallback partial spans separate from an empty confirmed-delta lineage', async () => {
        stubFetch([chunkResponse({
            partial_text: 'Hiob',
            confirmed_text: '',
            has_new_transcription: false,
            provenance_status: 'no_confirmed_delta',
            confirmed_word_spans: [],
        })]);

        const result = await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);
        const wrongConfirmedLineage = sourceLineageFromWhisper(result.partial, result.provenance);
        const partialLineage = sourceLineageFromWhisper(result.partial, result.partialProvenance);

        expect(wrongConfirmedLineage.status).toBe('missing');
        expect(partialLineage.status).toBe('complete');
        expect(partialLineage.wordSpans).toHaveLength(1);
    });

    it('forwards the WHOLE provenance, including provenance_reason', async () => {
        stubFetch([chunkResponse({
            provenance_status: 'incomplete_provenance',
            provenance_reason: 'non_monotonic',
            confirmed_word_spans: [],
        })]);

        const result = await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false);

        expect(result.confirmed).toBe('Hiob sprach');          // emission unchanged
        expect(result.provenance.provenanceStatus).toBe('incomplete_provenance');
        expect(result.provenance.provenanceReason).toBe('non_monotonic');
        expect(result.provenance.decodeId).toBe(41);
        expect(result.provenance.inputPcmSha256).toBe('3c3e527feb09a2a1e77cd062021e88fbe21e282448f956b61267c00d870e9f2d');
        expect(result.provenance.workerTotalMs).toBe(130.1);
        expect(result.provenance.inferenceMs).toBe(120.4);
        expect(result.partialProvenance).toMatchObject({
            provenanceStatus: 'complete',
            alignmentStatus: 'exact',
        });
        expect(result.partialProvenance.confirmedWordSpans).toHaveLength(1);
        expect(result.stableProvenance.confirmedWordSpans).toHaveLength(2);
    });

    it('the completion event links request_id to the (session, decode) pair and carries decode_proof', async () => {
        stubFetch([chunkResponse()]);
        const events = [];

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
            latencyTxId: 'tx-7',
            onRequestCompleted: (event) => events.push(event),
        });

        expect(events).toHaveLength(1);
        // `seq` grows over the whole process lifetime - we guard the SHAPE of the identifier
        // (boot id + congregation + number), not a specific counter value.
        expect(events[0].request_id).toMatch(/^[0-9a-f-]{36}:ch1:\d+$/);
        expect(events[0].whisper_session_id).toBe('7f8164eb-960d-4cfe-982b-3738d87cf0b9');
        expect(events[0].decode_id).toBe(41);
        expect(events[0].decode_proof).toBe('present');
        expect(events[0].latency_tx_id).toBe('tx-7');
        expect(events[0].provenance.provenanceReason).toBeNull();
    });

    it('completion from a real HTTP response: the non_word_level_chunk bucket and zero text', async () => {
        // The full path: network response -> `sendStreamingChunk` -> completion event.
        // The response is DELIBERATELY faulty - it carries source text in fields that are on the
        // key allowlist, plus a code with a token count.
        stubFetch([chunkResponse({
            alignment_status: 'unaligned',
            alignment_reason: 'non_word_level_chunk:tokens=3',
            provenance_status: 'incomplete_provenance',
            provenance_reason: 'Gelassenheit',
            transcribe_status: "accepted 'Minuten'",
            input_pcm_sha256: 'des',
        })]);
        const events = [];

        await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        });

        const blob = JSON.stringify(events[0]);
        for (const word of ['Gelassenheit', 'Minuten', 'des']) {
            expect(blob, `word ${word} reached the event`).not.toContain(word);
        }
        expect(events[0].provenance.alignmentReasonCode).toBe('non_word_level_chunk');
        expect(events[0].provenance.nonWordLevelChunkTokens).toBe(3);
        expect(events[0].provenance.provenanceReason).toBe('unclassified');
        expect(events[0].provenance.inputPcmSha256).toBeNull();
        expect(events[0].provenance.rejectedFields).toContain('inputPcmSha256');
    });

    it('a missing decode_id means decode_proof=absent, NOT "no decode"', async () => {
        // a coalesced response: Whisper was busy, so this request did not decode
        stubFetch([chunkResponse({
            decode_id: null, confirmed_text: '', has_new_transcription: false,
            provenance_status: null, provenance_reason: null,
        })]);
        const events = [];

        await sendStreamingChunk('ch1', new Float32Array(1600), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        });

        expect(events[0].decode_proof).toBe('absent');
        expect(Object.keys(events[0])).not.toContain('decoded');
    });

    it('the completion event is produced on request failure too', async () => {
        stubFetch([
            async () => { throw new Error('HTTP 500: boom'); },
            async () => { throw new Error('HTTP 500: boom'); },
            async () => { throw new Error('HTTP 500: boom'); },
        ]);
        const events = [];

        await expect(sendStreamingChunk('ch1', new Float32Array(1600), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        })).rejects.toThrow('HTTP 500: boom');

        expect(events).toHaveLength(1);
        expect(events[0].decode_proof).toBe('absent');
        expect(events[0].error_code).toBe('HTTP_500');
        expect(events[0].attempt).toBe(3);
    });

    it('completion carries neither delta words nor a raw error body', async () => {
        // Whisper answers with an error whose body carries a transcript - `fetchWithRetry`
        // assembles the message `HTTP 500: <body>` from it, so without sanitisation the text
        // would land in the cloud log together with the completion event.
        const leakyBody = '{"detail":"Wie bekommst du mehr Gelassenheit?"}';
        stubFetch(Array.from({ length: 3 }, () => async () => ({
            ok: false, status: 500, text: async () => leakyBody, json: async () => ({}),
        })));
        const events = [];

        await expect(sendStreamingChunk('ch1', new Float32Array(1600), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        })).rejects.toThrow('Gelassenheit');   // the caller DOES receive the full exception

        expect(events[0].error_code).toBe('HTTP_500');
        expect(JSON.stringify(events[0])).not.toContain('Gelassenheit');
    });

    it('completion describes spans with a counter and a range, without word text', async () => {
        stubFetch([chunkResponse({
            confirmed_word_spans: [
                { text: 'Gelassenheit', start_sample: 16000, end_sample: 32000 },
                { text: 'Hiob', start_sample: 0, end_sample: 8000 },
            ],
            partial_word_spans: [
                { text: 'Suppe', start_sample: 24000, end_sample: 30000 },
            ],
            stable_word_spans: [
                { text: 'Atkinson', start_sample: 0, end_sample: 8000 },
            ],
        })]);
        const events = [];

        const result = await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        });

        // the caller gets the FULL spans (a join needs the ranges), the log gets only the verdict
        expect(result.provenance.confirmedWordSpans).toHaveLength(2);
        expect(events[0].provenance.confirmedWordSpanCount).toBe(2);
        expect(events[0].provenance.confirmedSpanStartSample).toBe(0);
        expect(events[0].provenance.confirmedSpanEndSample).toBe(32000);
        expect(JSON.stringify(events[0])).not.toContain('Gelassenheit');
        expect(JSON.stringify(events[0])).not.toContain('Suppe');
        expect(JSON.stringify(events[0])).not.toContain('Atkinson');
    });

    it('an exception from the telemetry callback does not touch the response or the session', async () => {
        stubFetch([chunkResponse()]);

        const result = await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
            onRequestCompleted: () => { throw new Error('telemetry down'); },
        });

        expect(result.confirmed).toBe('Hiob sprach');
        expect(getWhisperRequestsInFlight('ch1').count).toBe(0);
    });

    // GAP RECORDED DELIBERATELY: fail-open for `onAttemptStart` has no test, because the callback
    // is created inside `sendStreamingChunk` and cannot be substituted from outside without
    // widening the module API. `tracker.markAttempt` is total (it returns `false` for an unknown
    // record rather than throwing), so the guard in `fetchWithRetry` protects future callbacks.
    // A test that does NOT invoke it would be green without checking anything - that pattern is
    // not repeated on this track.
});

describe('whisperClient - an older Whisper without provenance', () => {
    it('a response without provenance fields does not break the client', async () => {
        stubFetch([{
            partial_text: 'Hiob', confirmed_text: 'Hiob sprach',
            is_speech: true, has_new_transcription: true,
        }]);
        const events = [];

        const result = await sendStreamingChunk('ch1', new Float32Array(16000), 16000, false, {
            onRequestCompleted: (event) => events.push(event),
        });

        expect(result.confirmed).toBe('Hiob sprach');
        expect(result.provenance.decodeId).toBeNull();
        expect(events[0].decode_proof).toBe('absent');
    });
});
