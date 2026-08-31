import { describe, expect, it, vi } from 'vitest';
import { buildLiveQualitySnapshot } from '../liveQualityState.js';
import {
    buildAutopilotShadowMetric,
    decideAutopilotProfile,
    logAutopilotShadowDecision,
    normalizeAutopilotConfig,
    normalizeSnapshot,
} from '../autopilotPolicy.js';

describe('AutopilotPolicy profile selection', () => {
    it('is normal when live quality is good', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
            { stage: 'emission_decision', pause_ms: 2500, first_audio_ms: 240, queue_depth: 0 },
        ]));

        expect(decision).toMatchObject({
            profile: 'normal',
            reason: 'quality_good',
            controllerProfile: 'normal',
            flowGovernorProfile: 'normal',
        });
    });

    it('stays passive when disabled', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', pause_ms: 20000 },
        ]), { enabled: false });

        expect(decision).toMatchObject({
            enabled: false,
            profile: 'normal',
            reason: 'autopilot_disabled',
        });
    });

    it('stays normal when confidence is too low', () => {
        const decision = decideAutopilotProfile({
            state: 'critical',
            mainCause: 'whisper_delay',
            confidence: 0.2,
            metrics: {},
        }, { minConfidenceToAct: 0.4 });

        expect(decision).toMatchObject({
            profile: 'normal',
            reason: 'insufficient_confidence',
        });
    });

    it('keeps behavior normal but reports unknown when listener evidence is missing', () => {
        const quality = buildLiveQualitySnapshot([
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
        ]);
        const decision = decideAutopilotProfile(quality);

        expect(decision).toMatchObject({
            profile: 'normal',
            reason: 'quality_unknown',
            liveQualityState: 'unknown',
            freshness: { listener: { status: 'missing' } },
        });
    });

    it('does not honor a critical label when its stream freshness is missing', () => {
        const decision = decideAutopilotProfile({
            state: 'critical',
            mainCause: 'listener_drift',
            confidence: 1,
            metrics: {},
            freshness: {},
        });

        expect(decision).toMatchObject({
            profile: 'normal',
            reason: 'quality_unknown',
            liveQualityState: 'unknown',
        });
    });

    it('uses fast mode for degraded source-side delay', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', pause_ms: 8000, first_audio_ms: 240, queue_depth: 0 },
            { stage: 'whisper', latency_ms: 3200 },
            { stage: 'translation', latency_ms: 600 },
        ]));

        expect(decision).toMatchObject({
            profile: 'fast',
            reason: 'degraded_whisper_delay',
            controllerProfile: 'fast',
            flowGovernorProfile: 'fast',
        });
    });

    it('uses catchup for critical source-side delay', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', pause_ms: 20008, first_audio_ms: 239, queue_depth: 0 },
            { stage: 'emission_decision', pause_ms: 25786, first_audio_ms: 799, queue_depth: 0 },
            { stage: 'whisper', latency_ms: 2732 },
            { stage: 'translation', latency_ms: 942 },
        ]));

        expect(decision).toMatchObject({
            profile: 'catchup',
            reason: 'critical_whisper_delay',
            controllerProfile: 'catchup',
            flowGovernorProfile: 'catchup',
        });
    });

    it('uses text_only when TTS is the bottleneck', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', decision: 'audio_skip', first_audio_ms: 12000 },
            { stage: 'emission_decision', decision: 'audio_skip', first_audio_ms: 11000 },
            { stage: 'tts', latency_ms: 11000 },
        ]));

        expect(decision).toMatchObject({
            profile: 'text_only',
            reason: 'critical_tts_backlog',
            controllerProfile: 'audio_skip',
            flowGovernorProfile: 'fast',
        });
    });

    it('uses catchup for degraded queue pressure and critical for critical queue pressure', () => {
        const degraded = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', queue_depth: 3 },
            { stage: 'emission_decision', queue_depth: 3 },
            { stage: 'translation', latency_ms: 600 },
        ]));
        const critical = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', queue_depth: 6 },
            { stage: 'emission_decision', queue_depth: 6 },
            { stage: 'translation', latency_ms: 600 },
        ]));

        expect(degraded).toMatchObject({
            profile: 'catchup',
            reason: 'degraded_queue_pressure',
        });
        expect(critical).toMatchObject({
            profile: 'critical',
            reason: 'critical_queue_pressure',
        });
    });

    it('preserves quality when duplicate risk is the only degraded signal', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', adjacentWordDups: 1 },
            { stage: 'emission_decision', adjacentWordDups: 1 },
            { stage: 'emission_decision', adjacentWordDups: 0 },
            { stage: 'emission_decision', adjacentWordDups: 0 },
        ], { degradedDuplicateRate: 0.2, criticalDuplicateRate: 0.8 }));

        expect(decision).toMatchObject({
            profile: 'normal',
            reason: 'degraded_duplicate_risk_preserve_quality',
        });
    });
});

describe('AutopilotPolicy shadow logging', () => {
    it('builds compact JSONL-ready shadow metrics', () => {
        const decision = decideAutopilotProfile(snapshot([
            { stage: 'emission_decision', pause_ms: 20008, first_audio_ms: 239, queue_depth: 0 },
            { stage: 'whisper', latency_ms: 2732 },
            { stage: 'translation', latency_ms: 942 },
        ]));

        const metric = buildAutopilotShadowMetric(decision, {
            churchId: 'example-church',
            sessionId: 'reference_session_a',
        });

        expect(metric).toMatchObject({
            stage: 'live_quality_autopilot_shadow',
            churchId: 'example-church',
            sessionId: 'reference_session_a',
            profile: 'catchup',
            reason: 'critical_whisper_delay',
            live_quality_state: 'critical',
            main_cause: 'whisper_delay',
            controller_profile: 'catchup',
            flow_governor_profile: 'catchup',
            queue_depth_p95: 0,
            whisper_ms_p95: 2732,
            listener_freshness: 'live',
        });
    });

    it('logs and returns the same decision', () => {
        const logFn = vi.fn();
        const decision = logAutopilotShadowDecision(logFn, {
            churchId: 'c1',
            snapshot: snapshot([
                { stage: 'emission_decision', pause_ms: 8000, first_audio_ms: 240, queue_depth: 0 },
                { stage: 'whisper', latency_ms: 3200 },
            ]),
        });

        expect(decision.profile).toBe('fast');
        expect(logFn).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'live_quality_autopilot_shadow',
            churchId: 'c1',
            profile: 'fast',
            reason: 'degraded_whisper_delay',
        }));
    });
});

describe('AutopilotPolicy normalization', () => {
    it('normalizes config and custom profile labels', () => {
        expect(normalizeAutopilotConfig({
            catchupProfile: { emission: 'custom_catchup' },
        })).toMatchObject({
            enabled: true,
            catchupProfile: {
                emission: 'custom_catchup',
                flowGovernor: 'catchup',
            },
        });
    });

    it('normalizes incomplete snapshots defensively', () => {
        expect(normalizeSnapshot({ state: 'critical', confidence: 2 })).toMatchObject({
            state: 'critical',
            mainCause: 'healthy',
            confidence: 1,
            metrics: {
                pauseMs: expect.objectContaining({ p95: null }),
                rates: {
                    dropAudioSkip: 0,
                    duplicates: 0,
                    fallbacks: 0,
                },
            },
        });
    });
});

function snapshot(records, config = {}) {
    const withFreshListener = records.some(record => record.stage === 'listener_telemetry')
        ? records.map(record => record.stage === 'listener_telemetry'
            ? { listener_measurement_age_ms: 0, ...record }
            : record)
        : [...records, {
            stage: 'listener_telemetry',
            listener_buffer_depth: 0,
            audibleDriftMs: 0,
            listener_measurement_age_ms: 0,
        }];
    return buildLiveQualitySnapshot(withFreshListener, config);
}
