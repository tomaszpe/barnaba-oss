const TERMINAL_SOURCE_OUTCOMES = new Set([
    'blocked_pre_queue',
    'translated_blocked',
    'broadcasted',
]);

const sanitizeLanguages = (languages) => (
    Array.isArray(languages)
        ? languages.filter((language) => typeof language === 'string').slice(0, 32)
        : []
);

export const buildPipelineObserverMessage = (entry) => {
    if (!entry?.churchId || !entry?.stage) return null;

    if (entry.stage === 'source_release_outcome') {
        return {
            type: 'pipeline_decision',
            decisionType: 'source_release',
            release_seq: entry.release_seq ?? null,
            source_hash: entry.source_hash ?? null,
            emissionId: entry.emissionId ?? null,
            outcome: entry.outcome || 'unknown',
            blockStage: entry.block_stage || null,
            language: entry.lang || null,
            languages: sanitizeLanguages(entry.languages),
            terminal: TERMINAL_SOURCE_OUTCOMES.has(entry.outcome),
        };
    }

    if (entry.stage === 'emission_decision') {
        return {
            type: 'pipeline_decision',
            decisionType: 'emission',
            emissionId: entry.emissionId ?? null,
            outcome: entry.decision || 'unknown',
            language: entry.lang || null,
            gender: entry.gender || null,
            terminal: entry.decision !== 'hold',
        };
    }

    if (entry.stage === 'disconnect_drain_start') {
        return {
            type: 'pipeline_drain',
            phase: 'started',
            drainId: entry.drainId || null,
        };
    }

    if (entry.stage === 'disconnect_drain_done') {
        return {
            type: 'pipeline_drain',
            phase: 'done',
            drainId: entry.drainId || null,
            stageCut: entry.stage_cut || null,
            tailItems: Number(entry.tail_items_total) || 0,
            submitted: Number(entry.tail_items_submitted) || 0,
        };
    }

    if (entry.stage === 'disconnect_drain_timeout') {
        return {
            type: 'pipeline_drain',
            phase: 'timeout',
            drainId: entry.drainId || null,
            stageCut: entry.stage_cut || null,
        };
    }

    return null;
};

export const buildSourceActivityMessage = ({ isFinal, vad, observedAtMs = Date.now() }) => ({
    type: 'source_activity',
    speechActive: vad?.hasSpeech === true,
    speechRatio: Number.isFinite(vad?.speechRatio) ? Number(vad.speechRatio.toFixed(4)) : 0,
    confidence: Number.isFinite(vad?.confidence) ? Number(vad.confidence.toFixed(4)) : 0,
    isFinal: isFinal === true,
    observedAt: new Date(observedAtMs).toISOString(),
});

export default { buildPipelineObserverMessage, buildSourceActivityMessage };
