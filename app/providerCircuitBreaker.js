class ProviderCircuitBreaker {
    constructor({ name, failureThreshold = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
        this.name = name || 'provider';
        this.failureThreshold = normalizePositiveInt(failureThreshold, 3);
        this.cooldownMs = normalizePositiveInt(cooldownMs, 30000);
        this.now = now;
        this.consecutiveFailures = 0;
        this.openUntil = 0;
        this.stats = {
            successes: 0,
            failures: 0,
            timeouts: 0,
            opened: 0,
        };
    }

    canRequest() {
        return this.now() >= this.openUntil;
    }

    recordSuccess() {
        this.consecutiveFailures = 0;
        this.openUntil = 0;
        this.stats.successes++;
    }

    recordProviderReachable() {
        this.consecutiveFailures = 0;
        this.openUntil = 0;
    }

    recordFailure(error = null) {
        this.consecutiveFailures++;
        this.stats.failures++;
        if (error?.name === 'AbortError' || /timeout/i.test(error?.message || '')) {
            this.stats.timeouts++;
        }
        if (this.consecutiveFailures >= this.failureThreshold) {
            this.openUntil = this.now() + this.cooldownMs;
            this.stats.opened++;
        }
    }

    getStatus() {
        const open = !this.canRequest();
        return {
            name: this.name,
            open,
            state: open ? 'open' : 'closed',
            consecutiveFailures: this.consecutiveFailures,
            openUntil: open ? this.openUntil : null,
            failureThreshold: this.failureThreshold,
            cooldownMs: this.cooldownMs,
            ...this.stats,
        };
    }
}

function normalizePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return parsed;
}

export {
    ProviderCircuitBreaker,
    normalizePositiveInt,
};
