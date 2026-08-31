const DEFAULT_THRESHOLDS = {
    lowAgeMs: 3000,
    mediumAgeMs: 6000,
    highAgeMs: 10000,
    lowQueueDepth: 1,
    mediumQueueDepth: 3,
    highQueueDepth: 6,
    hysteresisMs: 1000,
    hysteresisQueue: 1,
};

function clampRate(rate, maxRate = 1.2) {
    const cap = Number.isFinite(maxRate) ? Math.max(1.0, maxRate) : 1.2;
    if (!Number.isFinite(rate)) return 1.0;
    return Math.min(cap, Math.max(1.0, rate));
}

function targetPlaybackRate({ queueDepth = 0, ageMs = 0, thresholds = DEFAULT_THRESHOLDS, maxRate = 1.2 } = {}) {
    const q = Math.max(0, Number(queueDepth) || 0);
    const age = Math.max(0, Number(ageMs) || 0);
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

    const cap = clampRate(maxRate, maxRate);
    if (q > t.highQueueDepth || age > t.highAgeMs) return cap;
    if (q >= 4 || age >= t.mediumAgeMs) return 1.15;
    if (q >= 2 || age >= t.lowAgeMs) return 1.08;
    return 1.0;
}

function choosePlaybackRate({ queueDepth = 0, ageMs = 0, previousRate = 1.0, thresholds = DEFAULT_THRESHOLDS, maxRate = 1.2 } = {}) {
    const target = targetPlaybackRate({ queueDepth, ageMs, thresholds, maxRate });
    const previous = clampRate(previousRate, maxRate);
    const cap = clampRate(maxRate, maxRate);
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

    if (target >= previous) return target;

    const q = Math.max(0, Number(queueDepth) || 0);
    const age = Math.max(0, Number(ageMs) || 0);

    if (previous >= cap) {
        if (q > t.highQueueDepth - t.hysteresisQueue || age > t.highAgeMs - t.hysteresisMs) return cap;
    }
    if (previous >= 1.15) {
        if (q >= 4 - t.hysteresisQueue || age >= t.mediumAgeMs - t.hysteresisMs) return 1.15;
    }
    if (previous >= 1.08) {
        if (q >= 2 - t.hysteresisQueue || age >= t.lowAgeMs - t.hysteresisMs) return 1.08;
    }

    return target;
}

export {
    DEFAULT_THRESHOLDS,
    choosePlaybackRate,
    targetPlaybackRate,
};
