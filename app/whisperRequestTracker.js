/**
 * Tracker for gateway -> Whisper requests.
 *
 * WHAT THIS MODULE MEASURES: open HTTP REQUESTS to Whisper. That is NOT the same as a decode
 * in progress - when Whisper is busy, `process_chunk` returns `coalesced_skip` immediately:
 * the request was open, the decode never happened. That is why every field is named
 * `whisper_request_*`, never `decode_*`, and `decodeProof` is derived ONLY after the fact,
 * from the response (`decode_id != null`) - meaning "this response carries decode evidence",
 * not "a decode took place".
 *
 * WHAT IS DELIBERATELY ABSENT: logging, `evalLog`, emission decisions, `await`. The module is
 * pure bookkeeping - the consumer decides what to do with it. That way lifecycle, retry and
 * join can each be proven separately, before a snapshot reaches many branches of `server.js`.
 *
 * THERE ARE TWO CLOCKS AND THEY ARE DISJOINT:
 *   - monotonic (`now()`) - age ONLY; immune to an NTP jump and to clock changes,
 *   - wall clock (`wallNow()`) - log correlation ONLY.
 * Computing age from the wall clock could yield a negative or hour-long age, at which point
 * "a request of age X was open at the moment of the decision" would stop being a measurement.
 */

import { randomUUID } from 'crypto';

/**
 * @param {object} [options]
 * @param {() => number} [options.now]      monotonic time source (ms)
 * @param {() => number} [options.wallNow]  wall clock (ms epoch)
 * @param {string} [options.bootId]         process identifier override (tests)
 */
function createWhisperRequestTracker(options = {}) {
    const now = options.now || (() => Number(process.hrtime.bigint() / 1000n) / 1000);
    const wallNow = options.wallNow || (() => Date.now());
    // `request_id` must be unique ALSO AFTER a gateway restart: measurement sessions are
    // stitched from several runs, and a bare per-congregation counter would collide with itself.
    const bootId = options.bootId || randomUUID();

    /** @type {Map<string, Map<string, object>>} churchId -> requestId -> rekord */
    const active = new Map();
    /** @type {Map<string, number>} churchId -> seq */
    const sequences = new Map();

    function churchBucket(churchId) {
        let bucket = active.get(churchId);
        if (!bucket) {
            bucket = new Map();
            active.set(churchId, bucket);
        }
        return bucket;
    }

    /**
     * Registers a request. Call AFTER obtaining `sessionId`, just before the first send
     * attempt: waiting for the session to be created is not a chunk request and must not be
     * counted into the age. The session wait has its own `sessionWaitMs` field so it does not
     * disappear silently.
     */
    function register({ churchId, whisperSessionId, sampleCount, sampleRate, isFinal = false,
                        latencyTxId = null, sessionWaitMs = null }) {
        const seq = (sequences.get(churchId) || 0) + 1;
        sequences.set(churchId, seq);
        const startedMono = now();
        const record = {
            requestId: `${bootId}:${churchId}:${seq}`,
            churchId,
            whisperSessionId: whisperSessionId || null,
            sentAtMs: wallNow(),
            sentAtMono: startedMono,
            attempt: 1,
            attemptStartedAtMono: startedMono,
            sampleCount: sampleCount ?? null,
            sampleRate: sampleRate ?? null,
            isFinal: Boolean(isFinal),
            latencyTxId: latencyTxId ?? null,
            sessionWaitMs: sessionWaitMs ?? null,
        };
        churchBucket(churchId).set(record.requestId, record);
        return record.requestId;
    }

    /**
     * Another attempt at THE SAME logical request. `fetchWithRetry` makes up to 3 HTTP
     * attempts inside one call - the record stays single and `attempt` increases. The age lives
     * in two fields: `ageMs` from the first attempt, `attemptAgeMs` from the current one. A
     * single number would repeat the `decode_duration_ms` mistake.
     */
    function markAttempt(churchId, requestId, attempt) {
        const record = active.get(churchId)?.get(requestId);
        if (!record) return false;
        record.attempt = attempt;
        record.attemptStartedAtMono = now();
        return true;
    }

    /**
     * Releases the record. Call it in `finally` - success, HTTP error, timeout, abort and a
     * parsing exception all leave by the same path. Leaking a record is not a transient error
     * but a permanent falsification of EVERY later measurement.
     *
     * Returns a summary of the request, or `null` when the record was already gone (a double
     * release must not produce a second completion event).
     */
    function complete(churchId, requestId, { provenance = null, error = null } = {}) {
        const bucket = active.get(churchId);
        const record = bucket?.get(requestId);
        if (!record) return null;
        bucket.delete(requestId);
        if (bucket.size === 0) active.delete(churchId);

        // IDENTITY fields also arrive from the network, so they are validated too: `decode_id`
        // must be an integer and `whisper_session_id` a uuid4, because that is how Whisper
        // generates it. Without this, text smuggles itself through a field that "is obviously
        // an identifier".
        const decodeId = asInt(provenance?.decodeId);
        const sessionId = asUuid(provenance?.whisperSessionId)
            ?? asUuid(record.whisperSessionId)
            ?? (record.whisperSessionId || provenance?.whisperSessionId ? 'unclassified' : null);
        // The completion event is destined FOR THE LOG, so it has to be safe BY CONSTRUCTION
        // rather than by the discipline of the caller in `server.js`.
        return {
            request_id: record.requestId,
            church_id: record.churchId,
            // A decode is identified by the PAIR - `decode_id` alone is unique only within a
            // Whisper session, so replacing the session would give a silent collision in the join.
            whisper_session_id: sessionId,
            decode_id: decodeId,
            // `absent` does NOT mean "there was no decode" - it means "this response carries no
            // evidence". That bucket also holds a pipeline exception, where the decode started
            // and left no evidence, as well as coalescing.
            decode_proof: decodeId != null ? 'present' : 'absent',
            age_ms: round1(now() - record.sentAtMono),
            attempt_age_ms: round1(now() - record.attemptStartedAtMono),
            attempt: record.attempt,
            sent_at_ms: record.sentAtMs,
            completed_at_ms: wallNow(),
            sample_count: record.sampleCount,
            sample_rate: record.sampleRate,
            is_final: record.isFinal,
            latency_tx_id: record.latencyTxId,
            session_wait_ms: record.sessionWaitMs,
            // NEVER the raw message: `fetchWithRetry` assembles it as `HTTP <status>: <body>`,
            // and a Whisper body can contain a transcript. Only the CODE goes to the log.
            // The caller receives the full exception separately - this is telemetry only.
            error_code: sanitizeErrorCode(error),
            provenance: sanitizeProvenance(provenance),
        };
    }

    /**
     * A pure snapshot at the moment of decision: it mutates nothing, waits for nothing and
     * returns COPIES of the records. The full set of active requests, not just the oldest - a
     * join needs the `request_id` of EVERY open request, and with `count > 1` the pair
     * (count, oldest) does not say which of them returned first.
     */
    function snapshot(churchId) {
        const bucket = active.get(churchId);
        const readAt = now();
        const requests = [...(bucket?.values() || [])]
            .map(record => ({
                request_id: record.requestId,
                age_ms: round1(readAt - record.sentAtMono),
                attempt_age_ms: round1(readAt - record.attemptStartedAtMono),
                attempt: record.attempt,
                whisper_session_id: record.whisperSessionId,
                is_final: record.isFinal,
            }))
            .sort((a, b) => a.age_ms - b.age_ms);
        const oldest = requests.length ? requests[requests.length - 1] : null;
        return {
            count: requests.length,
            oldest_age_ms: oldest ? oldest.age_ms : null,
            // A flat field alongside `oldest_age_ms`: the TWO-clock contract (from the first
            // attempt and from the current one) should be readable also by a helper that does
            // not look inside `requests`.
            oldest_attempt_age_ms: oldest ? oldest.attempt_age_ms : null,
            oldest_request_id: oldest ? oldest.request_id : null,
            oldest_attempt: oldest ? oldest.attempt : null,
            requests,
            read_at_ms: wallNow(),
        };
    }

    function activeCount(churchId) {
        if (churchId === undefined) {
            let total = 0;
            for (const bucket of active.values()) total += bucket.size;
            return total;
        }
        return active.get(churchId)?.size || 0;
    }

    return { register, markAttempt, complete, snapshot, activeCount, bootId };
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * An error code without content. `fetchWithRetry` assembles the message as
 * `HTTP <status>: <body>`, and a Whisper body can carry a transcript - the same problem as
 * `repr(word)` inside the body of `ProvenanceError` on the Whisper side.
 */
const SAFE_ERROR_NAMES = new Set(['AbortError']);

function sanitizeErrorCode(error) {
    if (!error) return null;
    const message = String(error.message || error);
    const httpStatus = message.match(/^HTTP (\d{3})/);
    if (httpStatus) return `HTTP_${httpStatus[1]}`;
    // An ALLOWLIST, not a pass-through of `error.name`. An exception name is just as arbitrary
    // a piece of text as the message - it can come from a library or from a remote response, so
    // passing it through directly would bypass the whole sanitisation. The contract has three
    // shapes: `HTTP_<status>`, `AbortError`, `Error`.
    return SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
}

/**
 * Provenance FOR THE LOG: scalars and a sample range, without the delta words. The full spans
 * (which contain text) go back to the caller through the result of `sendStreamingChunk` and
 * live in memory - text is unnecessary for computing coverage, and there is nothing to look for
 * in cloud logs.
 *
 * The range is computed with `min`/`max` rather than from the first and last record: span order
 * follows the order of the model's chunks, and that is sometimes non-chronological (the same
 * rule as `_build_decode_provenance_diag()` on the Whisper side).
 */
// Alignment reason codes that MAY be logged. Whisper no longer interpolates the word into
// `alignment_reason`, but the gateway MUST NOT rely on that: the field arrives from the
// network, and `...scalars` used to pass through any new string added on the other side.
const ALIGNMENT_REASON_CODES = new Set([
    'invalid_timestamp:non_numeric',
    'invalid_timestamp:non_finite',
    'invalid_timestamp:negative_start',
    'invalid_timestamp:zero_or_reversed',
    'invalid_timestamp:rounds_to_empty',
    'invalid_timestamp:beyond_input',
    'non_monotonic_start',
    'non_word_level_chunk',
    'no_word_timestamps',
    'token_count_mismatch',
    'token_sequence_mismatch',
    'empty_accepted_text_without_filter_signal',
    'window_rejected_by_filter',
]);

// `non_word_level_chunk:tokens=3` does NOT match the `code:subcode` pattern - a naive split on
// the colon produced `non_word_level_chunk:tokens`, which is not in the allowlist, so the whole
// intended diagnostic bucket fell into `unclassified`. The token count travels in a separate,
// VALIDATED numeric field.
const NON_WORD_LEVEL_CHUNK = /^non_word_level_chunk:tokens=(\d+)$/;

/** A free-form `alignment_reason` -> an allowlisted CODE plus an optional number. Text is dropped. */
function parseAlignmentReason(reason) {
    if (reason === null || reason === undefined || reason === '') return { code: null, tokens: null };
    if (typeof reason !== 'string') return { code: 'unclassified', tokens: null };
    const chunked = reason.match(NON_WORD_LEVEL_CHUNK);
    if (chunked) return { code: 'non_word_level_chunk', tokens: Number(chunked[1]) };
    const head = reason.match(/^[a-z_]+(?::[a-z_]+)?/);
    if (!head) return { code: 'unclassified', tokens: null };
    return {
        code: ALIGNMENT_REASON_CODES.has(head[0]) ? head[0] : 'unclassified',
        tokens: null,
    };
}

// -- VALUE validators ---------------------------------------------------------------
// A KEY allowlist alone is not enough: a faulty or malicious response smuggles text through an
// existing field ("`provenanceReason`: \'Gelassenheit\'"). Every field therefore has a type and
// a shape, and a value outside the contract is NEVER an echo of the input.

const TRANSCRIBE_STATUSES = new Set([
    'accepted', 'filtered_preprocess', 'filtered_chunk_rate', 'empty_model_output',
]);
const PROVENANCE_STATUSES = new Set([
    'complete', 'incomplete_provenance', 'no_delta', 'delta_filtered', 'no_confirmed_delta',
]);
const PROVENANCE_REASONS = new Set(['invalid_timestamp', 'missing_span', 'non_monotonic']);
const ALIGNMENT_STATUSES = new Set(['exact', 'unaligned', 'filtered_window']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asInt = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const asBool = (v) => (typeof v === 'boolean' ? v : null);
const asSha256 = (v) => (typeof v === 'string' && SHA256_RE.test(v) ? v : null);
const asUuid = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
/** Enum: no value -> `null`; a value outside the enum -> `unclassified`, never an echo. */
const asEnum = (set) => (v) => {
    if (v === null || v === undefined || v === '') return null;
    return typeof v === 'string' && set.has(v) ? v : 'unclassified';
};
const asSpanPair = (v) => (Array.isArray(v) && v.length === 2
    && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1]] : null);

/**
 * An EXPLICIT field ALLOWLIST, not `...scalars`. Spreading the rest of the object let
 * `alignmentReason` carrying `repr(word)` through straight into the cloud log - and with every
 * new field on the Whisper side it would repeat the same mistake silently. Only what is listed
 * passes here: numbers, hashes, statuses and codes.
 */
function sanitizeProvenance(provenance) {
    if (!provenance) return null;
    const spans = Array.isArray(provenance.confirmedWordSpans) ? provenance.confirmedWordSpans : [];
    const spanStarts = spans.map(s => asNumber(s?.start_sample ?? s?.startSample)).filter(n => n !== null);
    const spanEnds = spans.map(s => asNumber(s?.end_sample ?? s?.endSample)).filter(n => n !== null);
    const alignment = parseAlignmentReason(provenance.alignmentReason);

    const clean = {
        decodeId: asInt(provenance.decodeId),
        inputPcmSha256: asSha256(provenance.inputPcmSha256),
        inputStartSample: asInt(provenance.inputStartSample),
        inputEndSample: asInt(provenance.inputEndSample),
        decodeRequestedAtMs: asNumber(provenance.decodeRequestedAtMs),
        decodeStartedAtMs: asNumber(provenance.decodeStartedAtMs),
        decodeFinishedAtMs: asNumber(provenance.decodeFinishedAtMs),
        executorWaitMs: asNumber(provenance.executorWaitMs),
        inferenceMs: asNumber(provenance.inferenceMs),
        workerTotalMs: asNumber(provenance.workerTotalMs),
        decodeTotalMs: asNumber(provenance.decodeTotalMs),
        transcribeStatus: asEnum(TRANSCRIBE_STATUSES)(provenance.transcribeStatus),
        provenanceStatus: asEnum(PROVENANCE_STATUSES)(provenance.provenanceStatus),
        provenanceReason: asEnum(PROVENANCE_REASONS)(provenance.provenanceReason),
        textTokenCount: asInt(provenance.textTokenCount),
        spanTokenCount: asInt(provenance.spanTokenCount),
        alignmentStatus: asEnum(ALIGNMENT_STATUSES)(provenance.alignmentStatus),
        // An allowlisted CODE, never a free-form string from the network.
        alignmentReasonCode: alignment.code,
        nonWordLevelChunkTokens: asInt(alignment.tokens),
        unalignedWordCount: asInt(provenance.unalignedWordCount),
        nonWordLevelChunk: asBool(provenance.nonWordLevelChunk),
        alignedSpan: asSpanPair(provenance.alignedSpan),
        confirmedWordSpanCount: Array.isArray(provenance.confirmedWordSpans) ? spans.length : null,
        confirmedSpanStartSample: spanStarts.length ? Math.min(...spanStarts) : null,
        confirmedSpanEndSample: spanEnds.length ? Math.max(...spanEnds) : null,
    };

    // "The field arrived but in the wrong shape" is different from "the field was absent" - the
    // report has to see a broken response. ONLY FIELD NAMES travel (ours, fixed), never values.
    const rejected = [];
    for (const [key, value] of Object.entries(clean)) {
        if (value !== null) continue;
        if (key === 'nonWordLevelChunkTokens' || key.startsWith('confirmedSpan')) continue;
        const raw = provenance[key];
        if (raw !== null && raw !== undefined && raw !== '') rejected.push(key);
    }
    if (rejected.length) clean.rejectedFields = rejected;
    return clean;
}

/**
 * A fail-open read for the consumer. An exception from the tracker must not change an emission
 * decision - `{ unavailable: true, reason }` means "WE DO NOT KNOW" and is something DIFFERENT
 * from `count: 0` ("we know nothing is in progress"). A report must not add them together.
 */
function safeSnapshot(tracker, churchId) {
    try {
        const snap = tracker?.snapshot(churchId);
        if (!snap) return { unavailable: true, reason: 'no_tracker' };
        return snap;
    } catch (error) {
        return { unavailable: true, reason: String(error?.message || error) };
    }
}

/**
 * Prefixed evidence fields for `evalLog`. A PURE function over ONE snapshot - it does not read
 * the tracker, so a record cannot be assembled from several reads (each would describe a
 * different moment).
 *
 * `unavailable` remains a DISTINCT STATE: no `count`, no empty array, no default values.
 * "We do not know" and "we know nothing is in progress" have to differ in the data, otherwise a
 * report will silently add one to the other.
 *
 * `publication: true` adds `premature_publication_candidate` - a CANDIDATE, not evidence. An
 * open request proves neither that a decode was running (it may be `coalesced_skip`) nor that a
 * later result would have improved the emission: that needs source identity at the `queued`
 * point. With `unavailable` the field is NOT created - absence of knowledge is not "not a
 * candidate".
 */
function buildWhisperRequestEvidence(snapshot, { publication = false } = {}) {
    if (!snapshot || snapshot.unavailable) {
        return {
            whisper_request_in_flight_unavailable: true,
            whisper_request_in_flight_unavailable_reason: snapshot?.reason || 'no_snapshot',
        };
    }
    const fields = {
        whisper_request_in_flight_count: snapshot.count,
        whisper_request_in_flight_oldest_age_ms: snapshot.oldest_age_ms,
        whisper_request_in_flight_oldest_attempt_age_ms: snapshot.oldest_attempt_age_ms,
        whisper_request_in_flight_oldest_attempt: snapshot.oldest_attempt,
        whisper_request_in_flight_oldest_request_id: snapshot.oldest_request_id,
        // The FULL set of open requests - a join needs the `request_id` of each of them, not
        // only the oldest one.
        whisper_request_in_flight_request_ids: (snapshot.requests || []).map(r => r.request_id),
        whisper_request_in_flight_ages_ms: (snapshot.requests || []).map(r => r.age_ms),
        whisper_request_in_flight_read_at_ms: snapshot.read_at_ms,
    };
    if (publication) {
        fields.premature_publication_candidate = snapshot.count > 0;
    }
    return fields;
}

export { createWhisperRequestTracker, safeSnapshot, buildWhisperRequestEvidence };
