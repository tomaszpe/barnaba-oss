import { describe, it, expect, vi } from 'vitest';
import {
    decideEmission,
    logEmissionControllerDecision,
    normalizeConfig,
    normalizeSignals,
} from '../emissionController.js';

const enabled = { enabled: true };

describe('EmissionController decisions', () => {
    it('is passive when disabled', () => {
        expect(decideEmission({ ageMs: 60000, queueDepth: 99 }, { enabled: false })).toMatchObject({
            action: 'emit',
            mode: 'quality',
            reason: 'controller_disabled',
        });
    });

    it('is enabled by default unless explicitly disabled', () => {
        expect(normalizeConfig({})).toMatchObject({ enabled: true });
        expect(normalizeConfig({ enabled: false })).toMatchObject({ enabled: false });
    });

    it('holds young unstable segments', () => {
        expect(decideEmission({
            ageMs: 1200,
            asrStable: false,
            semanticComplete: false,
        }, enabled)).toMatchObject({
            action: 'hold',
            mode: 'quality',
            reason: 'young_unstable_segment',
        });
    });

    it('forces fast emit when an unstable segment gets older', () => {
        expect(decideEmission({
            ageMs: 4500,
            asrStable: false,
            semanticComplete: true,
        }, enabled)).toMatchObject({
            action: 'emit',
            mode: 'fast',
            reason: 'age_budget_forces_unstable_emit',
        });
    });

    it('uses quality, fast and catchup by age budget', () => {
        expect(decideEmission({ ageMs: 2000 }, enabled)).toMatchObject({ action: 'emit', mode: 'quality' });
        expect(decideEmission({ ageMs: 5000 }, enabled)).toMatchObject({ action: 'emit', mode: 'fast' });
        expect(decideEmission({ ageMs: 9000 }, enabled)).toMatchObject({ action: 'merge', mode: 'catchup' });
    });

    it('audio-skips when provider or TTS cannot support audio', () => {
        expect(decideEmission({ providerHealthy: false }, enabled)).toMatchObject({
            action: 'audio_skip',
            mode: 'audio_skip',
            reason: 'provider_unhealthy',
        });
        expect(decideEmission({ ttsEnabled: false }, enabled)).toMatchObject({
            action: 'audio_skip',
            mode: 'audio_skip',
            reason: 'tts_disabled',
        });
    });

    it('drops very stale segments', () => {
        expect(decideEmission({ ageMs: 21000 }, enabled)).toMatchObject({
            action: 'drop',
            mode: 'drop',
            reason: 'age_over_drop_threshold',
        });
    });

    it('normalizes invalid signal and config input', () => {
        expect(normalizeSignals({ ageMs: -5, queueDepth: 'bad' })).toMatchObject({
            ageMs: 0,
            queueDepth: 0,
            asrStable: true,
            semanticComplete: true,
        });
        expect(normalizeConfig({ fastMaxAgeMs: 6000 })).toMatchObject({
            enabled: true,
            fastMaxAgeMs: 6000,
        });
    });
});

describe('EmissionController shadow logging', () => {
    it('logs controller decision beside runtime decision', () => {
        const logFn = vi.fn();
        const decision = logEmissionControllerDecision(logFn, {
            churchId: 'c1',
            emissionId: 99,
            language: 'pl',
            source: 'test',
            runtimeDecision: 'emit',
            signals: { ageMs: 9000, queueDepth: 6 },
            config: enabled,
        });

        expect(decision).toMatchObject({ action: 'merge', mode: 'catchup' });
        expect(logFn).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'emission_controller_shadow',
            churchId: 'c1',
            emissionId: 99,
            lang: 'pl',
            source: 'test',
            runtime_decision: 'emit',
            controller_action: 'merge',
            controller_mode: 'catchup',
            age_ms: 9000,
            queue_depth: 6,
        }));
    });
});
