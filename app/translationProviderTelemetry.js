const DEFAULT_SAFE_ANNOTATION_SAMPLE_EVERY = 20;

const normalizeSampleEvery = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_SAFE_ANNOTATION_SAMPLE_EVERY;
};

class SuccessAnnotationSampler {
    constructor({ sampleEvery = DEFAULT_SAFE_ANNOTATION_SAMPLE_EVERY } = {}) {
        this.sampleEvery = normalizeSampleEvery(sampleEvery);
        this.safeResponseCounts = new Map();
    }

    select(annotations = [], { key = 'global' } = {}) {
        const entries = Array.isArray(annotations) ? annotations : [];
        const actionable = entries.some((entry) => (
            entry?.filtered === true
            || entry?.detected === true
            || (entry?.severity && entry.severity !== 'safe')
        ));

        if (actionable) {
            return {
                filterResults: entries,
                sampled: true,
                total: entries.length,
            };
        }

        const safeResponseCount = (this.safeResponseCounts.get(key) || 0) + 1;
        this.safeResponseCounts.set(key, safeResponseCount);
        const sampled = safeResponseCount % this.sampleEvery === 0;
        return {
            filterResults: sampled ? entries : [],
            sampled,
            total: entries.length,
        };
    }
}

const createTranslationRequestTelemetry = ({
    evalLog,
    churchId,
    emissionId,
    releaseFields = {},
    queuedAt = null,
}) => ({
    queuedAt,
    onRequestStart: ({ targetLang, model, startedAtMs, attempt = 1, contextMode = 'full' }) => evalLog({
        ts: new Date(startedAtMs).toISOString(),
        stage: 'translation_request_started',
        churchId,
        emissionId,
        ...releaseFields,
        lang: targetLang,
        model,
        attempt,
        context_mode: contextMode,
    }),
    onProviderOutcome: (outcome) => evalLog({
        stage: 'translation_provider_outcome',
        churchId,
        emissionId,
        ...releaseFields,
        lang: outcome.targetLang,
        provider: 'azure_openai',
        deployment: outcome.model,
        outcome: outcome.outcome,
        failure_kind: outcome.failure_kind,
        http_status: outcome.http_status,
        provider_code: outcome.provider_code,
        filter_source: outcome.filter_source,
        filter_results: outcome.filter_results,
        filter_annotations_sampled: outcome.filter_annotations_sampled ?? null,
        filter_annotation_count: outcome.filter_annotation_count ?? null,
        attempt: outcome.attempt,
        context_mode: outcome.context_mode,
        apim_request_id: outcome.apim_request_id,
        x_ms_request_id: outcome.x_ms_request_id,
        x_request_id: outcome.x_request_id,
        provider_message_hash: outcome.provider_message_hash,
        latency_ms: outcome.latency_ms,
        queue_wait_ms: outcome.queue_wait_ms,
    }),
});

export {
    SuccessAnnotationSampler,
    createTranslationRequestTelemetry,
    normalizeSampleEvery,
};
