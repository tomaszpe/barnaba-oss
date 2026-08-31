const DROP_REASONS = [
    'age_budget',
    'backlog_budget',
    'late_arrival',
    'superseded_candidate',
    'superseded_emission',
    'server_epoch_changed',
    'duplicate_chunk',
    'playback_reset',
];

const DELIVERY_OUTCOMES = [
    'chunk_received',
    'play_started',
    'play_completed',
    'explicit_drop',
    'superseded',
    'null_audio',
    'playback_error',
    'supersession_shadow',
];

// What actually played the audio. `web_audio` with pitch preservation on is FORCED to 1.0x
// (index.html), so an arm that requests catch-up and lands here does nothing while the
// requested rate still looks right — the gate has to be able to see the difference.
const PLAYBACK_ENGINES = ['html_audio', 'web_audio'];
const SOURCE_LINEAGE_STATUSES = new Set(['complete', 'partial', 'missing', 'ambiguous']);

export const allowedDropReasons = new Set(DROP_REASONS);
export const allowedDeliveryOutcomes = new Set(DELIVERY_OUTCOMES);
export const allowedPlaybackEngines = new Set(PLAYBACK_ENGINES);

const finiteNumber = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const boundedInt = (value, min, max, fallback = null) => {
    const parsed = finiteNumber(value, fallback);
    if (parsed === null) return null;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const clippedString = (value, maxLength) => (
    value == null ? null : String(value).slice(0, maxLength)
);

// `Number(null) === 0` and `Number('') === 0`, so the helpers above turn an explicitly reported
// null into a real zero: "no rate reported" would read as "played at 0x", "no decoder duration"
// as "0 ms", and "depth unknown" as "the queue was empty". Those three distinctions are the
// entire point of the new fields, so they get their own helpers instead of widening
// finiteNumber/boundedInt, which the older fields still depend on.
const nullableNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

export const sanitizeListenerMeasurementAgeMs = (value) => {
    const parsed = nullableNumber(value);
    return parsed === null ? null : Math.max(0, parsed);
};

// Out of range is REJECTED, not clamped: clamping would turn junk into a plausible-looking
// measurement that then gets averaged in.
const nullableIntInRange = (value, min, max) => {
    const parsed = nullableNumber(value);
    if (parsed === null) return null;
    const truncated = Math.trunc(parsed);
    return truncated >= min && truncated <= max ? truncated : null;
};

// Playback is capped at 1.5x client-side and never runs below 1.0x, so anything outside that
// band is not a measurement of this system.
const nullableRate = (value) => {
    const parsed = nullableNumber(value);
    return parsed !== null && parsed >= 1.0 && parsed <= 1.5 ? parsed : null;
};

export const sanitizeDeliveryOutcomeEvent = (item) => {
    if (!item || typeof item !== 'object') return null;
    const outcome = String(item.outcome || '');
    const outcomeId = clippedString(item.outcome_id, 128);
    const chunkKey = clippedString(item.chunk_key, 256);
    if (!allowedDeliveryOutcomes.has(outcome) || !outcomeId || !chunkKey) return null;

    const event = {
        stage: 'listener_delivery_outcome',
        outcome_id: outcomeId,
        listener_session_id: clippedString(item.listener_session_id, 64),
        sequence: boundedInt(item.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
        occurred_at_ms: boundedInt(item.occurred_at_ms, 0, Number.MAX_SAFE_INTEGER),
        chunk_key: chunkKey,
        session_epoch: clippedString(item.session_epoch, 64),
        release_seq: boundedInt(item.release_seq, 0, Number.MAX_SAFE_INTEGER),
        language: clippedString(item.language || 'unknown', 8),
        sentence_index: boundedInt(item.sentence_index, 0, 10000, 0),
        emitted_source_hash: clippedString(item.emitted_source_hash, 128),
        chunk_word_count: boundedInt(item.chunk_word_count, 0, 10000, 0),
        delivery_unit_id: clippedString(item.delivery_unit_id, 64),
        source_map_digest: clippedString(item.source_map_digest, 128),
        source_lineage_status: SOURCE_LINEAGE_STATUSES.has(String(item.source_lineage_status))
            ? String(item.source_lineage_status)
            : null,
        revision_family_id: clippedString(item.revision_family_id, 64),
        revision_generation: boundedInt(item.revision_generation, 1, 1000000),
        revision_ticket_id: clippedString(item.revision_ticket_id, 64),
        revision_evidence: clippedString(item.revision_evidence, 64),
        revision_apply_eligible: typeof item.revision_apply_eligible === 'boolean'
            ? item.revision_apply_eligible
            : null,
        source_map_v2_status: SOURCE_LINEAGE_STATUSES.has(String(item.source_map_v2_status))
            ? String(item.source_map_v2_status)
            : null,
        t2_supersede_pending_v2_eligible:
            typeof item.t2_supersede_pending_v2_eligible === 'boolean'
                ? item.t2_supersede_pending_v2_eligible
                : null,
        outcome,
    };

    if (outcome === 'play_started' || outcome === 'play_completed') {
        event.playback_rate = finiteNumber(item.playback_rate, null);
    }
    if (outcome === 'play_completed') {
        event.duration_ms = boundedInt(item.duration_ms, 0, 3600000);
        // Playback FACTS, as opposed to `playback_rate`, which is only what was requested.
        event.playback_engine = item.playback_engine == null
            ? null
            : (allowedPlaybackEngines.has(String(item.playback_engine)) ? String(item.playback_engine) : 'unknown');
        event.effective_playback_rate = nullableRate(item.effective_playback_rate);
        event.preserves_pitch = typeof item.preserves_pitch === 'boolean' ? item.preserves_pitch : null;
        // Decoder's own view of medium length — the reference that validates the server-side
        // `audio_duration_estimate_ms` (bytes/CBR rate).
        event.decoder_duration_ms = nullableIntInRange(item.decoder_duration_ms, 0, 3600000);
    }
    if (outcome === 'play_started') {
        // Age at play start: the exact value the playback policy saw on this chunk.
        event.age_ms = boundedInt(item.age_ms, 0, 3600000);
        // Same null-vs-zero trap, and here it is the load-bearing one: depth 0 means the queue
        // was empty, depth null means nobody reported it.
        event.queue_depth_at_play_start = nullableIntInRange(item.queue_depth_at_play_start, 0, 10000);
        // Did the Early Catch-up automaton own the rate for THIS chunk. Tri-state on purpose,
        // same trap as `queue_depth_at_play_start` above: `false` is the automaton answering
        // "not engaged", `null` is a client that never reported it. Collapsing null into false
        // would let a candidate arm read as "catch-up never engaged" when the truth is "we did
        // not ask" — and this field is the sole source of `early_catchup_active_pct`, so the
        // A/B would be scored on a fabricated zero.
        event.early_catchup_active = typeof item.early_catchup_active === 'boolean'
            ? item.early_catchup_active
            : null;
    }
    if (outcome === 'explicit_drop' || outcome === 'superseded') {
        const reason = String(item.reason || '');
        event.reason = allowedDropReasons.has(reason) ? reason : 'unknown';
    }
    if (outcome === 'superseded') {
        event.policy_applied = item.policy_applied === true;
        event.superseded_by_chunk_key = clippedString(item.superseded_by_chunk_key, 256);
        event.superseded_by_release_seq = boundedInt(
            item.superseded_by_release_seq, 0, Number.MAX_SAFE_INTEGER,
        );
        event.superseded_by_revision_generation = boundedInt(
            item.superseded_by_revision_generation, 1, 1000000,
        );
        event.superseded_by_revision_apply_eligible =
            typeof item.superseded_by_revision_apply_eligible === 'boolean'
                ? item.superseded_by_revision_apply_eligible
                : null;
        event.candidate_age_ms = boundedInt(item.candidate_age_ms, 0, 3600000);
        event.queue_depth_at_observation = boundedInt(
            item.queue_depth_at_observation, 0, 10000,
        );
        event.source_map_v2_shadow_eligible = item.source_map_v2_shadow_eligible === true;
        event.superseded_by_t2_v2_eligible =
            typeof item.superseded_by_t2_v2_eligible === 'boolean'
                ? item.superseded_by_t2_v2_eligible
                : null;
    }
    if (outcome === 'supersession_shadow') {
        event.reason = 'superseded_candidate';
        event.policy_applied = false;
        event.superseded_by_chunk_key = clippedString(item.superseded_by_chunk_key, 256);
        event.superseded_by_release_seq = boundedInt(
            item.superseded_by_release_seq, 0, Number.MAX_SAFE_INTEGER,
        );
        event.superseded_by_revision_generation = boundedInt(
            item.superseded_by_revision_generation, 1, 1000000,
        );
        event.superseded_by_revision_apply_eligible =
            typeof item.superseded_by_revision_apply_eligible === 'boolean'
                ? item.superseded_by_revision_apply_eligible
                : null;
        event.candidate_age_ms = boundedInt(item.candidate_age_ms, 0, 3600000);
        event.queue_depth_at_observation = boundedInt(
            item.queue_depth_at_observation, 0, 10000,
        );
        event.source_map_v2_shadow_eligible = item.source_map_v2_shadow_eligible === true;
        event.superseded_by_t2_v2_eligible =
            typeof item.superseded_by_t2_v2_eligible === 'boolean'
                ? item.superseded_by_t2_v2_eligible
                : null;
    }
    if (outcome === 'playback_error') {
        event.error_name = clippedString(item.error_name || 'Error', 64);
    }
    return event;
};

export const sanitizeDeliveryOutcomeBatch = (value, limit = 100) => {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)))
        .map(sanitizeDeliveryOutcomeEvent)
        .filter(Boolean);
};

export const sanitizePendingDropSample = (value, limit = 10) => {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => allowedDropReasons.has(String(item && item.reason)))
        .slice(0, limit)
        .map(item => ({
            ts: boundedInt(item && item.ts, 0, Number.MAX_SAFE_INTEGER),
            reason: String(item.reason),
            emissionId: boundedInt(item && item.emissionId, 0, Number.MAX_SAFE_INTEGER),
            release_seq: boundedInt(item && item.release_seq, 0, Number.MAX_SAFE_INTEGER),
            session_epoch: clippedString(item && item.session_epoch, 64),
            language: clippedString(item && item.language, 8),
            source_hash: clippedString(item && item.source_hash, 64),
            emitted_source_hash: clippedString(item && item.emitted_source_hash, 128),
            sentence_index: boundedInt(item && item.sentence_index, 0, 10000),
            chunk_word_count: boundedInt(item && item.chunk_word_count, 0, 10000, 0),
            age_ms: boundedInt(item && item.age_ms, 0, 3600000),
        }));
};
