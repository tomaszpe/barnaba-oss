class ConcurrencyLimiter {
    constructor({ name, maxConcurrency = 1, log = () => {} } = {}) {
        this.name = name || 'limiter';
        this.maxConcurrency = normalizeLimit(maxConcurrency);
        this.log = log;
        this.active = 0;
        this.queue = [];
        this.stats = {
            started: 0,
            completed: 0,
            failed: 0,
            queued: 0,
            maxObservedQueue: 0,
            maxObservedActive: 0,
        };
    }

    async run(task) {
        if (typeof task !== 'function') {
            throw new TypeError('ConcurrencyLimiter.run requires a function');
        }

        if (this.active >= this.maxConcurrency) {
            this.stats.queued++;
            if (this.queue.length + 1 > this.stats.maxObservedQueue) {
                this.stats.maxObservedQueue = this.queue.length + 1;
            }
            await new Promise((resolve) => {
                this.queue.push(resolve);
            });
        }

        this.active++;
        this.stats.started++;
        if (this.active > this.stats.maxObservedActive) {
            this.stats.maxObservedActive = this.active;
        }

        try {
            const result = await task();
            this.stats.completed++;
            return result;
        } catch (error) {
            this.stats.failed++;
            throw error;
        } finally {
            this.active--;
            this.releaseNext();
        }
    }

    releaseNext() {
        const next = this.queue.shift();
        if (next) next();
    }

    getStats() {
        return {
            name: this.name,
            maxConcurrency: this.maxConcurrency,
            active: this.active,
            queueDepth: this.queue.length,
            ...this.stats,
        };
    }
}

async function runProviderRequestWithTimeout({ limiter, timeoutMs, onStart = () => {}, request }) {
    if (!(limiter instanceof ConcurrencyLimiter)) {
        throw new TypeError('runProviderRequestWithTimeout requires a ConcurrencyLimiter');
    }
    if (typeof request !== 'function') {
        throw new TypeError('runProviderRequestWithTimeout requires a request function');
    }

    return limiter.run(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            onStart();
            return await request(controller.signal);
        } finally {
            clearTimeout(timeout);
        }
    });
}

function normalizeLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return parsed;
}

export {
    ConcurrencyLimiter,
    normalizeLimit,
    runProviderRequestWithTimeout,
};
