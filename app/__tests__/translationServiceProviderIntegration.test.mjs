import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    getServiceStatus,
    translateToAllLanguages,
} from '../translationService.js';

describe('translation service provider integration', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('propagates a client configuration failure without creating a fake request outcome', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onRequestStart = vi.fn();
        const onProviderOutcome = vi.fn();

        const results = await translateToAllLanguages(
            'Dies ist ein neutraler Testsatz ohne Cache-Treffer.',
            ['pl'],
            'provider-integration-test',
            null,
            null,
            { onRequestStart, onProviderOutcome },
        );

        expect(results[0]).toMatchObject({
            language: 'pl',
            success: false,
            failureKind: 'auth_or_deployment',
            attempts: 0,
            contextMode: 'full',
            recoveredFromContentFilter: false,
            filterSource: null,
        });
        expect(onRequestStart).not.toHaveBeenCalled();
        expect(onProviderOutcome).not.toHaveBeenCalled();
        expect(getServiceStatus()).toMatchObject({
            criticalProviderAlerts: 1,
            providerFailures: 1,
            circuitBreaker: { failures: 1 },
        });
    });
});
