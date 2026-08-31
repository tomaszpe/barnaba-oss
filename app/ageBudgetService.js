const DEFAULT_AGE_BUDGET = {
    enabled: false,
    textOnlyAfterMs: 12000,
    cautiousAfterMs: 8000,
    dropAfterMs: 20000,
    unhealthyQueueDepth: 4,
};

function normalizeAgeBudgetConfig(config = {}) {
    return {
        ...DEFAULT_AGE_BUDGET,
        ...config,
        enabled: config.enabled === true,
    };
}

function decideAgeBudget({ ageMs = 0, queueDepth = 0, config = {} } = {}) {
    const cfg = normalizeAgeBudgetConfig(config);
    const age = Math.max(0, Number(ageMs) || 0);
    const depth = Math.max(0, Number(queueDepth) || 0);

    if (!cfg.enabled) {
        return { action: 'normal_tts', reason: 'disabled', ageMs: age, queueDepth: depth };
    }

    if (age > cfg.dropAfterMs) {
        return { action: 'drop_stale', reason: 'age_over_drop_threshold', ageMs: age, queueDepth: depth };
    }

    if (age > cfg.textOnlyAfterMs) {
        return { action: 'text_only_stale', reason: 'age_over_text_only_threshold', ageMs: age, queueDepth: depth };
    }

    if (age > cfg.cautiousAfterMs && depth >= cfg.unhealthyQueueDepth) {
        return { action: 'text_only_stale', reason: 'age_and_queue_unhealthy', ageMs: age, queueDepth: depth };
    }

    return { action: 'normal_tts', reason: 'fresh_enough', ageMs: age, queueDepth: depth };
}

export {
    DEFAULT_AGE_BUDGET,
    decideAgeBudget,
    normalizeAgeBudgetConfig,
};
