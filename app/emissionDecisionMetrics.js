const QUALITY_MAX_AGE_MS = 3000;
const FAST_MAX_AGE_MS = 7000;
const CATCHUP_MAX_AGE_MS = 12000;

function normalizeAgeMs(value) {
    return Math.max(0, Number(value) || 0);
}

function normalizeQueueDepth(value) {
    return Math.max(0, Number(value) || 0);
}

function classifyMode({ decision = 'emit', ageMs = 0, ageDecision = null } = {}) {
    if (decision === 'drop' || ageDecision?.action === 'drop_stale') return 'drop';
    if (decision === 'audio_skip' || ageDecision?.action === 'text_only_stale') return 'audio_skip';

    const age = normalizeAgeMs(ageDecision?.ageMs ?? ageMs);
    if (age <= QUALITY_MAX_AGE_MS) return 'quality';
    if (age <= FAST_MAX_AGE_MS) return 'fast';
    if (age <= CATCHUP_MAX_AGE_MS) return 'catchup';
    return 'audio_skip';
}

function normalizeDecision(decision) {
    if (decision === 'text_only') return 'audio_skip';
    if (decision === 'tts') return 'emit';
    if (decision === 'normal_tts') return 'emit';
    return decision || 'emit';
}

function buildEmissionDecisionMetric({
    churchId,
    emissionId = null,
    language = null,
    gender = null,
    decision = 'emit',
    reason = null,
    ageDecision = null,
    ageMs = 0,
    queueDepth = 0,
    source = null,
    latencyTxId = null,
    firstAudioMs = null,
    listenersServed = null,
    progressive = null,
} = {}) {
    const normalizedDecision = normalizeDecision(decision);
    const normalizedAgeMs = normalizeAgeMs(ageDecision?.ageMs ?? ageMs);
    const normalizedQueueDepth = normalizeQueueDepth(ageDecision?.queueDepth ?? queueDepth);

    return {
        stage: 'emission_decision',
        churchId,
        emissionId,
        lang: language,
        gender,
        decision: normalizedDecision,
        mode: classifyMode({
            decision: normalizedDecision,
            ageMs: normalizedAgeMs,
            ageDecision,
        }),
        decision_reason: reason || ageDecision?.reason || 'unspecified',
        age_ms: normalizedAgeMs,
        queue_depth: normalizedQueueDepth,
        source,
        txId: latencyTxId,
        first_audio_ms: firstAudioMs,
        listeners_served: listenersServed,
        progressive,
    };
}

function logEmissionDecision(logFn, payload) {
    const metric = buildEmissionDecisionMetric(payload);
    logFn(metric);
    return metric;
}

export {
    buildEmissionDecisionMetric,
    classifyMode,
    logEmissionDecision,
    normalizeDecision,
};
