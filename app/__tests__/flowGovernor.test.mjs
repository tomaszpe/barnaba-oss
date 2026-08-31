import { describe, expect, it, vi } from 'vitest';
import {
    buildFlowGovernorShadowMetric,
    decideFlowGovernor,
    logFlowGovernorShadowDecision,
    normalizeFlowGovernorConfig,
    normalizeFlowSignals,
} from '../flowGovernor.js';

describe('FlowGovernor shadow decisions', () => {
    it('holds empty or unstable text', () => {
        expect(decideFlowGovernor({ text: '' })).toMatchObject({
            decision: 'would_hold',
            reason: 'empty_text',
        });

        expect(decideFlowGovernor({
            text: 'Das ist ein Anfang ohne genug stabile Worte',
            ageMs: 1500,
            profile: 'fast',
        })).toMatchObject({
            decision: 'would_hold',
            reason: 'waiting_for_stability',
        });
    });

    it('is conservative in normal profile even when prefix is stable', () => {
        const decision = decideFlowGovernor({
            text: 'Das ist ein stabiler Anfang und dann kommt noch mehr',
            stablePrefix: 'Das ist ein stabiler Anfang',
            ageMs: 6000,
            profile: 'normal',
            completenessScore: 0.7,
        });

        expect(decision).toMatchObject({
            decision: 'would_hold',
            reason: 'waiting_for_safe_boundary',
            profile: 'normal',
        });
    });

    it('soft-commits stable prefixes in fast profile when age budget is exceeded', () => {
        const decision = decideFlowGovernor({
            text: 'Das ist ein stabiler Anfang der Predigt und spaeter kommt noch mehr',
            stablePrefix: 'Das ist ein stabiler Anfang der Predigt',
            ageMs: 5200,
            profile: 'fast',
            completenessScore: 0.7,
        });

        expect(decision).toMatchObject({
            decision: 'would_soft_commit_prefix',
            reason: 'stable_prefix_age_budget',
            profile: 'fast',
            stablePrefixWordCount: 7,
        });
        expect(decision.stablePrefixRatio).toBeGreaterThan(0.55);
    });

    it('uses lower soft-commit age threshold in catchup and critical profiles', () => {
        const signals = {
            text: 'Das ist ein stabiler Satzteil fuer die Gemeinde und dann folgt noch etwas',
            stablePrefix: 'Das ist ein stabiler Satzteil fuer die Gemeinde',
            completenessScore: 0.7,
        };

        expect(decideFlowGovernor({ ...signals, ageMs: 3400, profile: 'catchup' })).toMatchObject({
            decision: 'would_hold',
        });
        expect(decideFlowGovernor({ ...signals, ageMs: 3600, profile: 'catchup' })).toMatchObject({
            decision: 'would_soft_commit_prefix',
        });
        expect(decideFlowGovernor({ ...signals, ageMs: 2600, profile: 'critical' })).toMatchObject({
            decision: 'would_soft_commit_prefix',
        });
    });

    it('micro-emits complete phrases with terminal punctuation', () => {
        expect(decideFlowGovernor({
            text: 'Gott ist treu und seine Gnade bleibt.',
            ageMs: 1200,
            profile: 'normal',
        })).toMatchObject({
            decision: 'would_micro_emit',
            reason: 'complete_micro_phrase',
            terminalBoundary: true,
        });
    });

    it('micro-emits strong clause boundaries only outside normal profile', () => {
        const text = 'Darum gehen wir gemeinsam weiter,';

        expect(decideFlowGovernor({
            text,
            ageMs: 6000,
            profile: 'normal',
            completenessScore: 0.8,
        })).toMatchObject({
            decision: 'would_hold',
        });

        expect(decideFlowGovernor({
            text,
            ageMs: 6000,
            profile: 'fast',
            completenessScore: 0.8,
        })).toMatchObject({
            decision: 'would_micro_emit',
            reason: 'strong_clause_boundary',
        });
    });

    it('blocks risky short fragments like Amen, Ja, Und', () => {
        expect(decideFlowGovernor({ text: 'Amen.', ageMs: 8000, profile: 'critical' })).toMatchObject({
            decision: 'would_hold',
            reason: 'risky_short_fragment',
        });
        expect(decideFlowGovernor({ text: 'Und', ageMs: 13000, profile: 'critical' })).toMatchObject({
            decision: 'would_merge_to_next',
            reason: 'risky_short_fragment_too_old',
        });
    });

    it('forces partial fallback when old enough but not safely soft-committable', () => {
        const decision = decideFlowGovernor({
            text: 'Wir schauen heute auf Hiob und auf die Frage des Leidens',
            ageMs: 7200,
            profile: 'fast',
            completenessScore: 0.6,
        });

        expect(decision).toMatchObject({
            decision: 'would_force_fallback',
            reason: 'age_budget_forces_partial_fallback',
        });
    });

    it('uses a lower force-fallback threshold in critical profile', () => {
        expect(decideFlowGovernor({
            text: 'Wir schauen heute auf Hiob und seine Geschichte',
            ageMs: 4600,
            profile: 'critical',
            completenessScore: 0.6,
        })).toMatchObject({
            decision: 'would_force_fallback',
        });
    });

    it('merges old fragments that still cannot be safely released', () => {
        expect(decideFlowGovernor({
            text: 'ein zwei drei',
            ageMs: 13000,
            profile: 'catchup',
            completenessScore: 0.2,
        })).toMatchObject({
            decision: 'would_merge_to_next',
            reason: 'max_hold_without_safe_release',
        });
    });

    it('flushes final text when enough content exists', () => {
        expect(decideFlowGovernor({
            text: 'Das ist der letzte Satz',
            isFinal: true,
        })).toMatchObject({
            decision: 'would_micro_emit',
            reason: 'final_flush',
        });
    });
});

describe('FlowGovernor normalization', () => {
    it('derives stable prefix from stable word count', () => {
        const signals = normalizeFlowSignals({
            text: 'eins zwei drei vier fuenf sechs sieben',
            stablePrefixWords: 5,
            profile: 'catchup',
        });

        expect(signals.stablePrefix).toBe('eins zwei drei vier fuenf');
        expect(signals.stablePrefixWordCount).toBe(5);
        expect(signals.profile).toBe('catchup');
    });

    it('normalizes custom config without disabling by default', () => {
        expect(normalizeFlowGovernorConfig({ minStableWords: 7 })).toMatchObject({
            enabled: true,
            minStableWords: 7,
        });
        expect(normalizeFlowGovernorConfig({ enabled: false })).toMatchObject({
            enabled: false,
        });
    });
});

describe('FlowGovernor shadow logging', () => {
    it('builds JSONL-ready shadow metrics', () => {
        const decision = decideFlowGovernor({
            text: 'Das ist ein stabiler Anfang der Predigt und spaeter kommt noch mehr',
            stablePrefix: 'Das ist ein stabiler Anfang der Predigt',
            ageMs: 5200,
            profile: 'fast',
            completenessScore: 0.7,
        });

        const metric = buildFlowGovernorShadowMetric(decision, {
            churchId: 'example-church',
            sessionId: 'reference_session_a',
            emissionId: 42,
            source: 'unit_test',
        });

        expect(metric).toMatchObject({
            stage: 'flow_governor_shadow',
            churchId: 'example-church',
            sessionId: 'reference_session_a',
            emissionId: 42,
            profile: 'fast',
            decision: 'would_soft_commit_prefix',
            reason: 'stable_prefix_age_budget',
            stable_prefix_word_count: 7,
            source: 'unit_test',
        });
    });

    it('logs and returns the same decision', () => {
        const logFn = vi.fn();
        const decision = logFlowGovernorShadowDecision(logFn, {
            churchId: 'c1',
            signals: {
                text: 'Wir schauen heute auf Hiob und auf die Frage des Leidens',
                ageMs: 7200,
                profile: 'fast',
                completenessScore: 0.6,
            },
        });

        expect(decision.decision).toBe('would_force_fallback');
        expect(logFn).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'flow_governor_shadow',
            churchId: 'c1',
            decision: 'would_force_fallback',
            reason: 'age_budget_forces_partial_fallback',
        }));
    });
});
