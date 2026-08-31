import { describe, expect, it } from 'vitest';
import {
    LiveQualityState,
    buildLiveQualitySnapshot,
    collectLiveQualityMetrics,
    scoreMainCauses,
    summarizeNumbers,
} from '../liveQualityState.js';

describe('LiveQualityState aggregation', () => {
    it('summarizes numeric metric windows with percentiles', () => {
        const summary = summarizeNumbers([100, 200, 300, 400, 500]);

        expect(summary).toEqual({
            count: 5,
            min: 100,
            max: 500,
            avg: 300,
            p50: 300,
            p95: 500,
            p99: 500,
        });
    });

    it('collects gateway, provider and listener metrics from mixed records', () => {
        const metrics = collectLiveQualityMetrics([
            { stage: 'emission_decision', first_audio_ms: 240, age_ms: 550, queue_depth: 0 },
            { stage: 'listener_telemetry', listener_buffer_depth: 2, audibleDriftMs: 4500, listener_measurement_age_ms: 0 },
            { stage: 'translation', latency_ms: 640 },
            { stage: 'tts', latency_ms: 300 },
            { stage: 'whisper', latency_ms: 2600 },
            { stage: 'fallback', stall_ms: 8000 },
            { stage: 'quality', adjacentWordDups: 2 },
        ]);

        expect(metrics.firstAudioMs.p95).toBe(240);
        expect(metrics.listenerBufferDepth.p95).toBe(2);
        expect(metrics.listenerDriftMs.p95).toBe(4500);
        expect(metrics.gptMs.p95).toBe(640);
        expect(metrics.ttsMs.p95).toBe(300);
        expect(metrics.whisperMs.p95).toBe(2600);
        expect(metrics.fallbackStallMs.p95).toBe(8000);
        expect(metrics.counters.fallbacks).toBe(1);
        expect(metrics.counters.duplicates).toBe(2);
    });

    it('prunes records outside the rolling window', () => {
        const state = new LiveQualityState({ windowMs: 1000 });
        state.record({ stage: 'whisper', latency_ms: 9000 }, 1000);
        state.record({ stage: 'translation', latency_ms: 400 }, 2500);

        const snapshot = state.snapshot(2500);

        expect(snapshot.metrics.whisperMs.count).toBe(0);
        expect(snapshot.metrics.gptMs.p95).toBe(400);
        expect(snapshot.state).toBe('unknown');
        expect(snapshot.freshness.whisper).toMatchObject({ status: 'stale', ageMs: 1500 });
    });
});

describe('LiveQualityState classification', () => {
    it('classifies healthy traffic as good', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
            { stage: 'emission_decision', first_audio_ms: 240, queue_depth: 0, pause_ms: 2500 },
            { stage: 'listener_telemetry', listener_buffer_depth: 0, audibleDriftMs: 0, listener_measurement_age_ms: 0 },
        ]);

        expect(snapshot.state).toBe('good');
        expect(snapshot.mainCause).toBe('healthy');
        expect(snapshot.confidence).toBeGreaterThan(0);
    });

    it('identifies listener drift before provider latency when listener metrics are critical', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'listener_telemetry', listener_buffer_depth: 6, audibleDriftMs: 15000, listener_measurement_age_ms: 0 },
            { stage: 'translation', latency_ms: 600 },
            { stage: 'tts', latency_ms: 400 },
            { stage: 'whisper', latency_ms: 2400 },
        ]);

        expect(snapshot.state).toBe('critical');
        expect(snapshot.mainCause).toBe('listener_drift');
        expect(snapshot.causeScores.listener_drift).toBe('critical');
    });

    it('identifies TTS backlog from first audio latency and audio skips', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'emission_decision', decision: 'audio_skip', first_audio_ms: 11000 },
            { stage: 'emission_decision', decision: 'audio_skip', first_audio_ms: 9000 },
            { stage: 'emission_decision', decision: 'emit', first_audio_ms: 7000 },
        ]);

        expect(snapshot.state).toBe('critical');
        expect(snapshot.mainCause).toBe('tts_backlog');
        expect(snapshot.causeScores.tts_backlog).toBe('critical');
    });

    it('classifies duplicate risk from duplicate rate', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'emission_decision', emissionId: 1, adjacentWordDups: 1 },
            { stage: 'emission_decision', emissionId: 2, adjacentWordDups: 1 },
            { stage: 'emission_decision', emissionId: 3, adjacentWordDups: 0 },
            { stage: 'emission_decision', emissionId: 4, adjacentWordDups: 0 },
        ], { degradedDuplicateRate: 0.2, criticalDuplicateRate: 0.4 });

        expect(snapshot.state).toBe('critical');
        expect(snapshot.mainCause).toBe('duplicate_risk');
    });

    it('classifies queue pressure separately from source delay', () => {
        const scores = scoreMainCauses(collectLiveQualityMetrics([
            { stage: 'emission_decision', queue_depth: 6, pause_ms: 3000 },
            { stage: 'translation', latency_ms: 600 },
            { stage: 'tts', latency_ms: 400 },
        ]));

        expect(scores.queue_pressure).toBe('critical');
        expect(scores.whisper_delay).toBe('good');
    });

    it('matches current DEV baseline as whisper_delay/source-side degradation', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'whisper', latency_ms: 2419 },
            { stage: 'whisper', latency_ms: 2549 },
            { stage: 'whisper', latency_ms: 2732 },
            { stage: 'translation', latency_ms: 554 },
            { stage: 'translation', latency_ms: 942 },
            { stage: 'emission_decision', first_audio_ms: 239, queue_depth: 0, pause_ms: 11727 },
            { stage: 'emission_decision', first_audio_ms: 799, queue_depth: 0, pause_ms: 20008 },
            { stage: 'emission_decision', first_audio_ms: 0, queue_depth: 0, pause_ms: 25786 },
        ]);

        expect(snapshot.state).toBe('critical');
        expect(snapshot.mainCause).toBe('whisper_delay');
        expect(snapshot.metrics.pauseMs.p95).toBe(25786);
        expect(snapshot.metrics.queueDepth.p95).toBe(0);
        expect(snapshot.causeScores.tts_backlog).toBe('good');
        expect(snapshot.causeScores.queue_pressure).toBe('good');
    });

    it('marks missing listener evidence unknown instead of green', () => {
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
        ]);

        expect(snapshot.state).toBe('unknown');
        expect(snapshot.causeScores.listener_drift).toBe('unknown');
        expect(snapshot.freshness.listener).toMatchObject({ status: 'missing', ageMs: null });
    });

    it('ignores a stale listener measurement even when its historical drift is critical', () => {
        const snapshot = buildLiveQualitySnapshot([
            {
                stage: 'listener_telemetry',
                listener_buffer_depth: 6,
                audibleDriftMs: 290000,
                listener_measurement_age_ms: 30001,
            },
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
        ]);

        expect(snapshot.state).toBe('unknown');
        expect(snapshot.mainCause).toBe('healthy');
        expect(snapshot.causeScores.listener_drift).toBe('unknown');
        expect(snapshot.metrics.listenerDriftMs.count).toBe(0);
        expect(snapshot.metrics.queueDepth.count).toBe(0);
        expect(snapshot.freshness.listener).toMatchObject({ status: 'stale', ageMs: 30001 });
    });

    it('keeps stale distinct from missing after the metric window is pruned', () => {
        const state = new LiveQualityState({ windowMs: 1000, listenerMeasurementMaxAgeMs: 500 });
        state.record({
            stage: 'listener_telemetry',
            queue_depth: 9,
            listener_buffer_depth: 9,
            listener_drift_ms: 290000,
            listener_measurement_age_ms: 0,
        }, 1000);

        const snapshot = state.snapshot(2500);
        expect(snapshot.freshness.listener).toMatchObject({ status: 'stale', ageMs: 1500 });
        expect(snapshot.freshness.tts).toMatchObject({ status: 'missing', ageMs: null });
        expect(snapshot.causeScores.listener_drift).toBe('unknown');
        expect(snapshot.causeScores.queue_pressure).toBe('good');
        expect(snapshot.state).toBe('unknown');
    });

    it('uses the current coverage gauge instead of a historical audible-drift maximum', () => {
        const snapshot = buildLiveQualitySnapshot([
            {
                stage: 'listener_telemetry',
                listener_buffer_depth: 0,
                listener_drift_ms: 0,
                audibleDriftMs: 290000,
                listener_measurement_age_ms: 1000,
            },
            { stage: 'whisper', latency_ms: 2400 },
            { stage: 'translation', latency_ms: 550 },
            { stage: 'tts', latency_ms: 300 },
            { stage: 'emission_decision', queue_depth: 0 },
        ]);

        expect(snapshot.state).toBe('good');
        expect(snapshot.metrics.listenerDriftMs.p95).toBe(0);
        expect(snapshot.causeScores.listener_drift).toBe('good');
    });

    it('reports freshness independently for every stream', () => {
        const now = 100000;
        const snapshot = buildLiveQualitySnapshot([
            { stage: 'listener_telemetry', tsMs: now - 1000, listener_measurement_age_ms: 2000, audibleDriftMs: 1000 },
            { stage: 'whisper', tsMs: now - 2000, latency_ms: 2400 },
            { stage: 'translation', tsMs: now - 3000, latency_ms: 550 },
            { stage: 'tts', tsMs: now - 4000, latency_ms: 300 },
            { stage: 'emission_decision', tsMs: now - 5000, queue_depth: 0 },
        ], {}, now);

        expect(snapshot.state).toBe('good');
        expect(snapshot.freshness).toEqual({
            listener: { status: 'live', ageMs: 3000, lastSampleTsMs: now - 1000 },
            whisper: { status: 'live', ageMs: 2000, lastSampleTsMs: now - 2000 },
            translation: { status: 'live', ageMs: 3000, lastSampleTsMs: now - 3000 },
            tts: { status: 'live', ageMs: 4000, lastSampleTsMs: now - 4000 },
            emission: { status: 'live', ageMs: 5000, lastSampleTsMs: now - 5000 },
        });
    });
});
