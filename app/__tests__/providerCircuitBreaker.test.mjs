import { describe, it, expect } from 'vitest';
import { ProviderCircuitBreaker, normalizePositiveInt } from '../providerCircuitBreaker.js';

describe('ProviderCircuitBreaker', () => {
    it('opens after consecutive failures and closes after cooldown', () => {
        let now = 1000;
        const breaker = new ProviderCircuitBreaker({
            name: 'test',
            failureThreshold: 2,
            cooldownMs: 500,
            now: () => now,
        });

        expect(breaker.canRequest()).toBe(true);
        breaker.recordFailure(new Error('first'));
        expect(breaker.getStatus()).toMatchObject({ open: false, consecutiveFailures: 1 });

        breaker.recordFailure(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        expect(breaker.canRequest()).toBe(false);
        expect(breaker.getStatus()).toMatchObject({
            open: true,
            consecutiveFailures: 2,
            failures: 2,
            timeouts: 1,
            opened: 1,
        });

        now = 1600;
        expect(breaker.canRequest()).toBe(true);
        breaker.recordSuccess();
        expect(breaker.getStatus()).toMatchObject({ open: false, consecutiveFailures: 0, successes: 1 });
    });

    it('normalizes invalid positive integer config', () => {
        expect(normalizePositiveInt('bad', 7)).toBe(7);
        expect(normalizePositiveInt(0, 7)).toBe(7);
        expect(normalizePositiveInt('3', 7)).toBe(3);
    });

    it('records provider reachability without counting a translation success', () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
        breaker.recordFailure(new Error('503'));
        breaker.recordFailure(new Error('503'));

        breaker.recordProviderReachable();

        expect(breaker.getStatus()).toMatchObject({
            open: false,
            consecutiveFailures: 0,
            failures: 2,
            successes: 0,
        });
    });
});
