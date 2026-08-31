const DEFAULT_EMISSION_CONTROLLER_CONFIG = {
    enabled: true,
    qualityMaxAgeMs: 3000,
    fastMaxAgeMs: 7000,
    catchupMaxAgeMs: 12000,
    dropAfterMs: 20000,
    unhealthyQueueDepth: 4,
    overloadedQueueDepth: 8,
};

function normalizeConfig(config = {}) {
    return {
        ...DEFAULT_EMISSION_CONTROLLER_CONFIG,
        ...config,
        enabled: config.enabled !== false,
    };
}

function normalizeSignals(signals = {}) {
    return {
        ageMs: Math.max(0, Number(signals.ageMs) || 0),
        queueDepth: Math.max(0, Number(signals.queueDepth) || 0),
        asrStable: signals.asrStable !== false,
        semanticComplete: signals.semanticComplete !== false,
        providerHealthy: signals.providerHealthy !== false,
        ttsEnabled: signals.ttsEnabled !== false,
        activeLanguages: Math.max(0, Number(signals.activeLanguages) || 0),
        activeGenders: Math.max(0, Number(signals.activeGenders) || 0),
    };
}

function decideEmission(signals = {}, config = {}) {
    const cfg = normalizeConfig(config);
    const s = normalizeSignals(signals);

    if (!cfg.enabled) {
        return decision('emit', 'quality', 'controller_disabled', s, cfg);
    }

    if (s.ageMs >= cfg.dropAfterMs) {
        return decision('drop', 'drop', 'age_over_drop_threshold', s, cfg);
    }

    if (!s.providerHealthy || !s.ttsEnabled) {
        return decision('audio_skip', 'audio_skip', s.ttsEnabled ? 'provider_unhealthy' : 'tts_disabled', s, cfg);
    }

    if (s.queueDepth >= cfg.overloadedQueueDepth && s.ageMs >= cfg.fastMaxAgeMs) {
        return decision('merge', 'catchup', 'queue_overloaded', s, cfg);
    }

    if (s.queueDepth >= cfg.unhealthyQueueDepth && s.ageMs >= cfg.catchupMaxAgeMs) {
        return decision('audio_skip', 'audio_skip', 'age_and_queue_unhealthy', s, cfg);
    }

    if (!s.asrStable || !s.semanticComplete) {
        if (s.ageMs < cfg.qualityMaxAgeMs) {
            return decision('hold', 'quality', 'young_unstable_segment', s, cfg);
        }
        if (s.ageMs < cfg.fastMaxAgeMs) {
            return decision('emit', 'fast', 'age_budget_forces_unstable_emit', s, cfg);
        }
    }

    if (s.ageMs <= cfg.qualityMaxAgeMs) {
        return decision('emit', 'quality', 'fresh_stable_segment', s, cfg);
    }

    if (s.ageMs <= cfg.fastMaxAgeMs) {
        return decision('emit', 'fast', 'segment_getting_old', s, cfg);
    }

    if (s.ageMs <= cfg.catchupMaxAgeMs) {
        return decision('merge', 'catchup', 'catchup_age_budget', s, cfg);
    }

    return decision('audio_skip', 'audio_skip', 'age_over_catchup_threshold', s, cfg);
}

function decision(action, mode, reason, signals, config) {
    return {
        action,
        mode,
        reason,
        ageMs: signals.ageMs,
        queueDepth: signals.queueDepth,
        asrStable: signals.asrStable,
        semanticComplete: signals.semanticComplete,
        providerHealthy: signals.providerHealthy,
        ttsEnabled: signals.ttsEnabled,
        activeLanguages: signals.activeLanguages,
        activeGenders: signals.activeGenders,
        config: {
            qualityMaxAgeMs: config.qualityMaxAgeMs,
            fastMaxAgeMs: config.fastMaxAgeMs,
            catchupMaxAgeMs: config.catchupMaxAgeMs,
            dropAfterMs: config.dropAfterMs,
            unhealthyQueueDepth: config.unhealthyQueueDepth,
            overloadedQueueDepth: config.overloadedQueueDepth,
        },
    };
}

function logEmissionControllerDecision(logFn, payload = {}) {
    const controllerDecision = decideEmission(payload.signals, payload.config);
    logFn({
        stage: 'emission_controller_shadow',
        churchId: payload.churchId,
        emissionId: payload.emissionId ?? null,
        lang: payload.language ?? null,
        gender: payload.gender ?? null,
        source: payload.source ?? null,
        runtime_decision: payload.runtimeDecision ?? null,
        controller_action: controllerDecision.action,
        controller_mode: controllerDecision.mode,
        controller_reason: controllerDecision.reason,
        age_ms: controllerDecision.ageMs,
        queue_depth: controllerDecision.queueDepth,
        active_languages: controllerDecision.activeLanguages,
        active_genders: controllerDecision.activeGenders,
        provider_healthy: controllerDecision.providerHealthy,
        tts_enabled: controllerDecision.ttsEnabled,
    });
    return controllerDecision;
}

export {
    DEFAULT_EMISSION_CONTROLLER_CONFIG,
    decideEmission,
    logEmissionControllerDecision,
    normalizeConfig,
    normalizeSignals,
};
