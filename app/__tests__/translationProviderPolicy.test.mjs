import { describe, expect, it } from 'vitest';
import { getServiceStatus } from '../translationService.js';

describe('translation provider request policy', () => {
    it('disables hidden SDK retries so one telemetry event equals one HTTP attempt', () => {
        expect(getServiceStatus().maxRetries).toBe(0);
    });

    it('exposes P0A content-filter counters without enabling P0B', () => {
        expect(getServiceStatus().contentFilter).toMatchObject({
            policyBlocksPrompt: 0,
            policyBlocksCompletion: 0,
            policyBlocksUnknown: 0,
            sourceOnlyRetries: 0,
            recovered: 0,
            activeSuppressions: 0,
            retryBudgetExhausted: 0,
        });
    });

    it('exposes rolling-window invalid-request alert state', () => {
        expect(getServiceStatus()).toMatchObject({
            requestInvalid: 0,
            requestInvalidInWindow: 0,
            requestInvalidAlertThreshold: 3,
            requestInvalidWindowMs: 60000,
            requestInvalidAlerts: 0,
            criticalProviderAlerts: 0,
        });
    });
});
