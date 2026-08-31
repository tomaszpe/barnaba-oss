import { describe, it, expect, vi } from 'vitest';
import {
    buildEmissionDecisionMetric,
    classifyMode,
    logEmissionDecision,
    normalizeDecision,
} from '../emissionDecisionMetrics.js';

describe('emission decision metrics', () => {
    it('normalizes legacy text_only decisions to audio_skip', () => {
        expect(normalizeDecision('text_only')).toBe('audio_skip');
    });

    it('maps fresh emit decisions to quality mode', () => {
        expect(classifyMode({ decision: 'emit', ageMs: 1200 })).toBe('quality');
    });

    it('maps older emit decisions through fast and catchup modes', () => {
        expect(classifyMode({ decision: 'emit', ageMs: 5000 })).toBe('fast');
        expect(classifyMode({ decision: 'emit', ageMs: 9000 })).toBe('catchup');
    });

    it('maps age-budget text-only to audio_skip mode', () => {
        const metric = buildEmissionDecisionMetric({
            churchId: 'c1',
            emissionId: 7,
            language: 'pl',
            decision: 'text_only',
            ageDecision: {
                action: 'text_only_stale',
                reason: 'age_over_text_only_threshold',
                ageMs: 13000,
                queueDepth: 4,
            },
        });

        expect(metric).toMatchObject({
            stage: 'emission_decision',
            churchId: 'c1',
            emissionId: 7,
            lang: 'pl',
            decision: 'audio_skip',
            mode: 'audio_skip',
            decision_reason: 'age_over_text_only_threshold',
            age_ms: 13000,
            queue_depth: 4,
        });
    });

    it('maps age-budget drop to drop mode', () => {
        const metric = buildEmissionDecisionMetric({
            churchId: 'c1',
            decision: 'drop',
            ageDecision: {
                action: 'drop_stale',
                reason: 'age_over_drop_threshold',
                ageMs: 21000,
                queueDepth: 2,
            },
        });

        expect(metric.decision).toBe('drop');
        expect(metric.mode).toBe('drop');
    });

    it('logs and returns the metric record', () => {
        const logFn = vi.fn();
        const metric = logEmissionDecision(logFn, {
            churchId: 'c1',
            language: 'en',
            decision: 'tts',
            ageMs: 2000,
            queueDepth: 1,
            reason: 'normal_tts',
        });

        expect(metric.decision).toBe('emit');
        expect(logFn).toHaveBeenCalledWith(metric);
    });
});
