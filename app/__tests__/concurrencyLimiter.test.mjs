import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    ConcurrencyLimiter,
    normalizeLimit,
    runProviderRequestWithTimeout,
} from '../concurrencyLimiter.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConcurrencyLimiter', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('normalizes invalid limits to one', () => {
        expect(normalizeLimit(0)).toBe(1);
        expect(normalizeLimit('bad')).toBe(1);
        expect(normalizeLimit(3)).toBe(3);
    });

    it('does not exceed maxConcurrency', async () => {
        const limiter = new ConcurrencyLimiter({ name: 'test', maxConcurrency: 2 });
        let active = 0;
        let maxActive = 0;

        await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await delay(20);
            active--;
        })));

        expect(maxActive).toBeLessThanOrEqual(2);
        expect(limiter.getStats()).toMatchObject({
            maxConcurrency: 2,
            started: 6,
            completed: 6,
            failed: 0,
            active: 0,
            queueDepth: 0,
        });
        expect(limiter.getStats().maxObservedQueue).toBeGreaterThan(0);
    });

    it('releases a queued task when a running task fails', async () => {
        const limiter = new ConcurrencyLimiter({ name: 'test', maxConcurrency: 1 });
        const order = [];

        const failed = limiter.run(async () => {
            order.push('first');
            await delay(10);
            throw new Error('boom');
        }).catch((error) => error.message);

        const second = limiter.run(async () => {
            order.push('second');
            return 'ok';
        });

        await expect(failed).resolves.toBe('boom');
        await expect(second).resolves.toBe('ok');
        expect(order).toEqual(['first', 'second']);
        expect(limiter.getStats()).toMatchObject({
            completed: 1,
            failed: 1,
            active: 0,
            queueDepth: 0,
        });
    });

    it('starts a provider timeout only after a queued task is admitted', async () => {
        vi.useFakeTimers();
        const limiter = new ConcurrencyLimiter({ name: 'provider', maxConcurrency: 1 });
        let finishFirst;
        const starts = [];
        const signals = [];

        const first = runProviderRequestWithTimeout({
            limiter,
            timeoutMs: 100,
            onStart: () => starts.push('first'),
            request: (signal) => {
                signals.push(signal);
                return new Promise((resolve) => { finishFirst = resolve; });
            },
        });
        const second = runProviderRequestWithTimeout({
            limiter,
            timeoutMs: 100,
            onStart: () => starts.push('second'),
            request: async (signal) => {
                signals.push(signal);
                return 'second';
            },
        });

        await vi.advanceTimersByTimeAsync(101);
        expect(starts).toEqual(['first']);
        expect(signals[0].aborted).toBe(true);

        finishFirst('first');
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        expect(starts).toEqual(['first', 'second']);
        expect(signals[1].aborted).toBe(false);
    });
});
