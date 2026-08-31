import { describe, expect, it, vi } from 'vitest';
import { TranslationProviderError } from '../translationProviderError.js';
import {
    TranslationContentFilterRecovery,
    executeTranslationWithContentFilterRecovery,
    translationSourceHash,
} from '../translationContentFilterRecovery.js';

const promptBlock = () => new TranslationProviderError({
    kind: 'content_filter',
    filterSource: 'prompt',
});

const completionBlock = () => new TranslationProviderError({
    kind: 'content_filter',
    filterSource: 'completion',
});

const createRecovery = (overrides = {}) => new TranslationContentFilterRecovery({
    enabled: true,
    languages: ['de', 'pl'],
    retryMaxAgeMs: 10000,
    retryBudgetCount: 3,
    retryBudgetWindowMs: 60000,
    ...overrides,
});

const execute = ({ recovery, attempt, queuedAt = 900, churchId = 'church-1', targetLang = 'de', source = 'Quelle' }) => (
    executeTranslationWithContentFilterRecovery({
        recovery,
        churchId,
        targetLang,
        sourceHash: translationSourceHash(source),
        queuedAt,
        attempt,
    })
);

describe('translation content-filter recovery', () => {
    it('retries one prompt-side block without context and marks the recovered result', async () => {
        const recovery = createRecovery({ now: () => 1000 });
        const attempt = vi.fn()
            .mockRejectedValueOnce(promptBlock())
            .mockResolvedValueOnce({ text: 'Übersetzung' });

        await expect(execute({ recovery, attempt })).resolves.toMatchObject({
            text: 'Übersetzung',
            providerMeta: {
                attempts: 2,
                contextMode: 'source_only',
                recoveredFromContentFilter: true,
                filterSource: 'prompt',
            },
        });
        expect(attempt.mock.calls.map(([input]) => input)).toEqual([
            { contextMode: 'full', attempt: 1 },
            { contextMode: 'source_only', attempt: 2 },
        ]);
        expect(recovery.getStatus()).toMatchObject({
            sourceOnlyRetries: 1,
            recovered: 1,
            activeSuppressions: 1,
        });
    });

    it('keeps the language source-only after both attempts are policy-blocked', async () => {
        const recovery = createRecovery({ now: () => 1000 });
        const firstAttempt = vi.fn().mockRejectedValue(promptBlock());

        await expect(execute({ recovery, attempt: firstAttempt })).rejects.toMatchObject({
            kind: 'content_filter',
            attempts: 2,
            contextMode: 'source_only',
        });

        const nextAttempt = vi.fn().mockResolvedValue({ text: 'neutral' });
        await expect(execute({ recovery, attempt: nextAttempt, source: 'next' })).resolves.toMatchObject({
            providerMeta: { attempts: 1, contextMode: 'source_only' },
        });
        expect(nextAttempt).toHaveBeenCalledOnce();
    });

    it('does not retry a completion-side block but suppresses context for the next segment', async () => {
        const recovery = createRecovery({ now: () => 1000 });
        const blocked = vi.fn().mockRejectedValue(completionBlock());

        await expect(execute({ recovery, attempt: blocked })).rejects.toMatchObject({
            kind: 'content_filter',
            filterSource: 'completion',
            attempts: 1,
        });
        expect(blocked).toHaveBeenCalledOnce();

        const nextAttempt = vi.fn().mockResolvedValue({ text: 'next' });
        await execute({ recovery, attempt: nextAttempt, source: 'next' });
        expect(nextAttempt).toHaveBeenCalledWith({ contextMode: 'source_only', attempt: 1 });
    });

    it.each([null, 0, -1, Number.NaN, 1])(
        'fails closed for an absent, invalid or stale queuedAt (%s)',
        async (queuedAt) => {
            const recovery = createRecovery({ now: () => 20000 });
            const attempt = vi.fn().mockRejectedValue(promptBlock());
            await expect(execute({ recovery, attempt, queuedAt })).rejects.toMatchObject({ attempts: 1 });
            expect(attempt).toHaveBeenCalledOnce();
            expect(recovery.isContextSuppressed('church-1', 'de')).toBe(true);
        },
    );

    it('does not retry when queuedAt is missing', async () => {
        const recovery = createRecovery({ now: () => 1000 });
        const attempt = vi.fn().mockRejectedValue(promptBlock());
        await expect(executeTranslationWithContentFilterRecovery({
            recovery,
            churchId: 'church-1',
            targetLang: 'de',
            sourceHash: translationSourceHash('Quelle'),
            attempt,
        })).rejects.toMatchObject({ attempts: 1 });
        expect(attempt).toHaveBeenCalledOnce();
    });

    it('leaves P0B completely inert while the recovery flag is disabled', async () => {
        const recovery = createRecovery({ enabled: false, now: () => 1000 });
        const attempt = vi.fn().mockRejectedValue(promptBlock());
        await expect(execute({ recovery, attempt })).rejects.toMatchObject({ attempts: 1 });
        expect(attempt).toHaveBeenCalledOnce();
        expect(recovery.getStatus()).toMatchObject({
            activeSuppressions: 0,
            sourceOnlyRetries: 0,
        });
    });

    it('does not retry or suppress a language outside the canary allowlist', async () => {
        const recovery = createRecovery({ languages: ['de'], now: () => 1000 });
        const attempt = vi.fn().mockRejectedValue(promptBlock());
        await expect(execute({ recovery, attempt, targetLang: 'pl' })).rejects.toMatchObject({ attempts: 1 });
        expect(attempt).toHaveBeenCalledOnce();
        expect(recovery.isContextSuppressed('church-1', 'pl')).toBe(false);
    });

    it('isolates suppression and prevents a repeated retry for the same language/source', async () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 10,
        });
        const deAttempt = vi.fn()
            .mockRejectedValueOnce(promptBlock())
            .mockResolvedValueOnce({ text: 'recovered' });
        await execute({ recovery, attempt: deAttempt });

        expect(recovery.isContextSuppressed('church-1', 'de')).toBe(true);
        expect(recovery.isContextSuppressed('church-1', 'pl')).toBe(false);
        expect(recovery.isContextSuppressed('church-2', 'de')).toBe(false);

        recovery.deleteLanguageState('church-1', 'de');
        now = 1100;
        const repeated = vi.fn().mockRejectedValue(promptBlock());
        await expect(execute({ recovery, attempt: repeated })).rejects.toBeTruthy();
        expect(repeated).toHaveBeenCalledOnce();

        const otherLanguage = vi.fn().mockResolvedValue({ text: 'polski' });
        await execute({ recovery, attempt: otherLanguage, targetLang: 'pl' });
        expect(otherLanguage).toHaveBeenCalledWith({ contextMode: 'full', attempt: 1 });
    });

    it('enforces the rolling retry budget without blocking base translations', async () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            retryBudgetCount: 1,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 10,
        });
        const first = vi.fn()
            .mockRejectedValueOnce(promptBlock())
            .mockResolvedValueOnce({ text: 'recovered' });
        await execute({ recovery, attempt: first });

        const state = recovery.getLanguageState('church-1', 'de');
        state.sourceOnlySuccesses = 3;
        now = 1100;
        const probe = vi.fn().mockRejectedValue(promptBlock());
        await expect(execute({ recovery, attempt: probe, source: 'new' })).rejects.toMatchObject({ attempts: 1 });
        expect(probe).toHaveBeenCalledOnce();
        expect(recovery.getStatus().retryBudgetExhausted).toBe(1);
    });

    it('releases retry budget after the rolling window expires', async () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            retryBudgetCount: 1,
            retryBudgetWindowMs: 1000,
        });
        const first = vi.fn()
            .mockRejectedValueOnce(promptBlock())
            .mockResolvedValueOnce({ text: 'first recovery' });
        await execute({ recovery, attempt: first, source: 'first' });

        recovery.deleteLanguageState('church-1', 'de');
        now = 2500;
        const second = vi.fn()
            .mockRejectedValueOnce(promptBlock())
            .mockResolvedValueOnce({ text: 'second recovery' });
        await expect(execute({ recovery, attempt: second, source: 'second', queuedAt: 2400 }))
            .resolves.toMatchObject({ providerMeta: { attempts: 2 } });
    });

    it('doubles half-open backoff after another policy block up to the configured cap', () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 100,
            halfOpenMaxMs: 250,
        });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        expect(recovery.getLanguageState('church-1', 'de').backoffMs).toBe(100);
        now = 1100;
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        expect(recovery.getLanguageState('church-1', 'de').backoffMs).toBe(200);
        now = 1200;
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        expect(recovery.getLanguageState('church-1', 'de')).toMatchObject({
            backoffMs: 250,
            nextProbeAt: 1450,
        });
    });

    it('allows exactly one half-open full-context probe and restores normal mode on success', async () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 100,
        });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        const state = recovery.getLanguageState('church-1', 'de');
        state.sourceOnlySuccesses = 3;
        now = 1200;

        const probe = recovery.beginAttempt('church-1', 'de');
        const concurrent = recovery.beginAttempt('church-1', 'de');
        expect(probe).toMatchObject({ contextMode: 'full', probe: true });
        expect(probe.probeToken).toBeTypeOf('number');
        expect(concurrent).toEqual({ contextMode: 'source_only', probe: false, probeToken: null });

        recovery.recordSuccess({ churchId: 'church-1', targetLang: 'de', contextMode: 'source_only' });
        expect(recovery.beginAttempt('church-1', 'de'))
            .toEqual({ contextMode: 'source_only', probe: false, probeToken: null });

        recovery.recordSuccess({
            churchId: 'church-1',
            targetLang: 'de',
            contextMode: 'full',
            probe: true,
            probeToken: probe.probeToken,
        });
        expect(recovery.isContextSuppressed('church-1', 'de')).toBe(false);
        expect(recovery.beginAttempt('church-1', 'de'))
            .toEqual({ contextMode: 'full', probe: false, probeToken: null });
    });

    it('does not restore full context when a concurrent source-only request is blocked', () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 100,
        });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        recovery.getLanguageState('church-1', 'de').sourceOnlySuccesses = 3;
        now = 1200;
        const probe = recovery.beginAttempt('church-1', 'de');

        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'source_only' });
        recovery.recordSuccess({
            churchId: 'church-1',
            targetLang: 'de',
            contextMode: 'full',
            probe: true,
            probeToken: probe.probeToken,
        });

        expect(recovery.isContextSuppressed('church-1', 'de')).toBe(true);
        expect(recovery.beginAttempt('church-1', 'de'))
            .toEqual({ contextMode: 'source_only', probe: false, probeToken: null });
    });

    it('returns to source-only and delays another probe after a half-open provider failure', () => {
        let now = 1000;
        const recovery = createRecovery({
            now: () => now,
            sourceOnlyForSession: false,
            halfOpenAfterMs: 100,
        });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        recovery.getLanguageState('church-1', 'de').sourceOnlySuccesses = 3;
        now = 1200;
        const probe = recovery.beginAttempt('church-1', 'de');
        recovery.recordNonPolicyFailure({
            churchId: 'church-1',
            targetLang: 'de',
            probe: probe.probe,
            probeToken: probe.probeToken,
        });

        expect(recovery.beginAttempt('church-1', 'de'))
            .toEqual({ contextMode: 'source_only', probe: false, probeToken: null });
        expect(recovery.getLanguageState('church-1', 'de')).toMatchObject({
            sourceOnlySuccesses: 0,
            nextProbeAt: 1300,
            probeInFlight: false,
        });
    });

    it('clears all language state for a church at teardown', () => {
        const recovery = createRecovery({ now: () => 1000 });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'de', contextMode: 'full' });
        recovery.recordPolicyBlock({ churchId: 'church-1', targetLang: 'pl', contextMode: 'full' });
        recovery.clearChurch('church-1');
        expect(recovery.getStatus().activeSuppressions).toBe(0);
    });
});
