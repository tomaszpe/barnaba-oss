import { describe, expect, it, vi } from 'vitest';
import { TranslationProviderError } from '../translationProviderError.js';
import { TranslationProviderHealth } from '../translationProviderHealth.js';

describe('TranslationProviderHealth', () => {
    it('keeps unknown policy sources out of the prompt counter', () => {
        const health = new TranslationProviderHealth();
        health.recordFailure(new TranslationProviderError({ kind: 'content_filter' }));
        health.recordDroppedSegment();

        expect(health.getStatus()).toMatchObject({
            policyBlocksPrompt: 0,
            policyBlocksCompletion: 0,
            policyBlocksUnknown: 1,
            droppedSegments: 1,
        });
    });

    it('counts provider policy attempts separately from one finally dropped segment', () => {
        const health = new TranslationProviderHealth();
        health.recordFailure(new TranslationProviderError({ kind: 'content_filter', filterSource: 'prompt' }));
        health.recordFailure(new TranslationProviderError({ kind: 'content_filter', filterSource: 'prompt' }));
        health.recordDroppedSegment();

        expect(health.getStatus()).toMatchObject({
            policyBlocksPrompt: 2,
            droppedSegments: 1,
        });
    });

    it('alerts on N invalid requests in a rolling window despite interleaved 503s', () => {
        let now = 1000;
        const onAlert = vi.fn();
        const health = new TranslationProviderHealth({
            invalidThreshold: 3,
            invalidWindowMs: 10000,
            now: () => now,
            onAlert,
        });
        const invalid = () => new TranslationProviderError({ kind: 'request_invalid', status: 400 });
        const unavailable = () => new TranslationProviderError({ kind: 'provider_5xx', status: 503 });

        health.recordFailure(invalid());
        now += 100;
        health.recordFailure(unavailable());
        now += 100;
        health.recordFailure(invalid());
        now += 100;
        health.recordFailure(unavailable());
        now += 100;
        health.recordFailure(invalid());

        expect(onAlert).toHaveBeenCalledTimes(1);
        expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({
            level: 'error',
            kind: 'request_invalid',
            count: 3,
            windowMs: 10000,
        }));
        expect(health.getStatus()).toMatchObject({
            requestInvalid: 3,
            requestInvalidInWindow: 3,
            requestInvalidAlerts: 1,
            providerFailures: 2,
        });
    });

    it('emits a critical alert for authentication or deployment failures', () => {
        const onAlert = vi.fn();
        const health = new TranslationProviderHealth({ onAlert });
        health.recordFailure(new TranslationProviderError({
            kind: 'auth_or_deployment',
            status: 404,
            code: 'DeploymentNotFound',
        }));

        expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({
            level: 'critical',
            kind: 'auth_or_deployment',
            status: 404,
        }));
        expect(health.getStatus()).toMatchObject({ providerFailures: 1, criticalAlerts: 1 });
    });

    it('re-arms the rolling-window alert after old events expire', () => {
        let now = 0;
        const onAlert = vi.fn();
        const health = new TranslationProviderHealth({
            invalidThreshold: 2,
            invalidWindowMs: 1000,
            now: () => now,
            onAlert,
        });
        const error = new TranslationProviderError({ kind: 'request_invalid', status: 400 });

        health.recordFailure(error);
        now = 10;
        health.recordFailure(error);
        now = 2000;
        health.getStatus();
        health.recordFailure(error);
        now = 2010;
        health.recordFailure(error);

        expect(onAlert).toHaveBeenCalledTimes(2);
    });
});
