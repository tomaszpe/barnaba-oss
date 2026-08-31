const DEFAULT_AUTOPILOT_POLICY_CONFIG = {
    enabled: true,
    minConfidenceToAct: 0.4,
    recoveryMinConfidence: 0.6,
    normalProfile: {
        emission: 'normal',
        flowGovernor: 'normal',
    },
    fastProfile: {
        emission: 'fast',
        flowGovernor: 'fast',
    },
    catchupProfile: {
        emission: 'catchup',
        flowGovernor: 'catchup',
    },
    textOnlyProfile: {
        emission: 'audio_skip',
        flowGovernor: 'fast',
    },
    criticalProfile: {
        emission: 'critical',
        flowGovernor: 'critical',
    },
};

function normalizeAutopilotConfig(config = {}) {
    return {
        ...DEFAULT_AUTOPILOT_POLICY_CONFIG,
        ...config,
        enabled: config.enabled !== false,
        normalProfile: {
            ...DEFAULT_AUTOPILOT_POLICY_CONFIG.normalProfile,
            ...config.normalProfile,
        },
        fastProfile: {
            ...DEFAULT_AUTOPILOT_POLICY_CONFIG.fastProfile,
            ...config.fastProfile,
        },
        catchupProfile: {
            ...DEFAULT_AUTOPILOT_POLICY_CONFIG.catchupProfile,
            ...config.catchupProfile,
        },
        textOnlyProfile: {
            ...DEFAULT_AUTOPILOT_POLICY_CONFIG.textOnlyProfile,
            ...config.textOnlyProfile,
        },
        criticalProfile: {
            ...DEFAULT_AUTOPILOT_POLICY_CONFIG.criticalProfile,
            ...config.criticalProfile,
        },
    };
}

function decideAutopilotProfile(snapshot = {}, config = {}) {
    const cfg = normalizeAutopilotConfig(config);
    const normalizedSnapshot = normalizeSnapshot(snapshot);

    if (!cfg.enabled) {
        return buildDecision({
            profile: 'normal',
            reason: 'autopilot_disabled',
            snapshot: normalizedSnapshot,
            profileConfig: cfg.normalProfile,
            enabled: false,
        });
    }

    if (normalizedSnapshot.confidence < cfg.minConfidenceToAct) {
        return buildDecision({
            profile: 'normal',
            reason: 'insufficient_confidence',
            snapshot: normalizedSnapshot,
            profileConfig: cfg.normalProfile,
        });
    }

    const { state, mainCause } = normalizedSnapshot;

    if (state === 'unknown') {
        return buildDecision({
            profile: 'normal',
            reason: 'quality_unknown',
            snapshot: normalizedSnapshot,
            profileConfig: cfg.normalProfile,
        });
    }

    if (state === 'critical') {
        if (mainCause === 'tts_backlog') {
            return buildDecision({
                profile: 'text_only',
                reason: 'critical_tts_backlog',
                snapshot: normalizedSnapshot,
                profileConfig: cfg.textOnlyProfile,
            });
        }

        if (mainCause === 'queue_pressure' || mainCause === 'listener_drift') {
            return buildDecision({
                profile: 'critical',
                reason: `critical_${mainCause}`,
                snapshot: normalizedSnapshot,
                profileConfig: cfg.criticalProfile,
            });
        }

        if (mainCause === 'whisper_delay' || mainCause === 'source_stall') {
            return buildDecision({
                profile: 'catchup',
                reason: `critical_${mainCause}`,
                snapshot: normalizedSnapshot,
                profileConfig: cfg.catchupProfile,
            });
        }

        return buildDecision({
            profile: 'critical',
            reason: `critical_${mainCause}`,
            snapshot: normalizedSnapshot,
            profileConfig: cfg.criticalProfile,
        });
    }

    if (state === 'degraded') {
        if (mainCause === 'tts_backlog') {
            return buildDecision({
                profile: 'text_only',
                reason: 'degraded_tts_backlog',
                snapshot: normalizedSnapshot,
                profileConfig: cfg.textOnlyProfile,
            });
        }

        if (mainCause === 'whisper_delay' || mainCause === 'source_stall') {
            return buildDecision({
                profile: 'fast',
                reason: `degraded_${mainCause}`,
                snapshot: normalizedSnapshot,
                profileConfig: cfg.fastProfile,
            });
        }

        if (mainCause === 'queue_pressure' || mainCause === 'listener_drift') {
            return buildDecision({
                profile: 'catchup',
                reason: `degraded_${mainCause}`,
                snapshot: normalizedSnapshot,
                profileConfig: cfg.catchupProfile,
            });
        }

        if (mainCause === 'duplicate_risk') {
            return buildDecision({
                profile: 'normal',
                reason: 'degraded_duplicate_risk_preserve_quality',
                snapshot: normalizedSnapshot,
                profileConfig: cfg.normalProfile,
            });
        }

        return buildDecision({
            profile: 'fast',
            reason: `degraded_${mainCause}`,
            snapshot: normalizedSnapshot,
            profileConfig: cfg.fastProfile,
        });
    }

    return buildDecision({
        profile: 'normal',
        reason: 'quality_good',
        snapshot: normalizedSnapshot,
        profileConfig: cfg.normalProfile,
    });
}

function buildAutopilotShadowMetric(decision, payload = {}) {
    const d = decision || decideAutopilotProfile(payload.snapshot, payload.config);
    return {
        stage: 'live_quality_autopilot_shadow',
        churchId: payload.churchId ?? null,
        sessionId: payload.sessionId ?? null,
        profile: d.profile,
        reason: d.reason,
        live_quality_state: d.liveQualityState,
        main_cause: d.mainCause,
        confidence: d.confidence,
        controller_profile: d.controllerProfile,
        flow_governor_profile: d.flowGovernorProfile,
        pause_ms_p95: d.metrics.pauseMs.p95,
        first_text_ms_p95: d.metrics.firstTextMs.p95,
        first_audio_ms_p95: d.metrics.firstAudioMs.p95,
        listener_buffer_depth_p95: d.metrics.listenerBufferDepth.p95,
        listener_drift_ms_p95: d.metrics.listenerDriftMs.p95,
        queue_depth_p95: d.metrics.queueDepth.p95,
        whisper_ms_p95: d.metrics.whisperMs.p95,
        gpt_ms_p95: d.metrics.gptMs.p95,
        tts_ms_p95: d.metrics.ttsMs.p95,
        drop_audio_skip_rate: d.metrics.rates.dropAudioSkip,
        duplicate_rate: d.metrics.rates.duplicates,
        fallback_rate: d.metrics.rates.fallbacks,
        listener_freshness: d.freshness.listener.status,
        listener_measurement_age_ms: d.freshness.listener.ageMs,
        whisper_freshness: d.freshness.whisper.status,
        translation_freshness: d.freshness.translation.status,
        tts_freshness: d.freshness.tts.status,
        emission_freshness: d.freshness.emission.status,
        sample_count: d.sampleCount,
    };
}

function logAutopilotShadowDecision(logFn, payload = {}) {
    const decision = decideAutopilotProfile(payload.snapshot, payload.config);
    logFn(buildAutopilotShadowMetric(decision, payload));
    return decision;
}

function buildDecision({
    profile,
    reason,
    snapshot,
    profileConfig,
    enabled = true,
}) {
    return {
        enabled,
        profile,
        reason,
        liveQualityState: snapshot.state,
        mainCause: snapshot.mainCause,
        confidence: snapshot.confidence,
        controllerProfile: profileConfig.emission,
        flowGovernorProfile: profileConfig.flowGovernor,
        metrics: snapshot.metrics,
        causeScores: snapshot.causeScores,
        freshness: snapshot.freshness,
        sampleCount: snapshot.sampleCount,
    };
}

function normalizeSnapshot(snapshot = {}) {
    const freshness = normalizeFreshness(snapshot.freshness);
    const declaredState = ['good', 'degraded', 'critical', 'unknown'].includes(snapshot.state)
        ? snapshot.state
        : 'unknown';
    const mainCause = snapshot.mainCause || 'healthy';
    const freshnessBlocksState = (
        declaredState === 'good'
        && Object.values(freshness).some(stream => stream.status !== 'live')
    ) || (
        mainCause === 'listener_drift'
        && freshness.listener.status !== 'live'
    );
    return {
        state: freshnessBlocksState ? 'unknown' : declaredState,
        mainCause,
        confidence: clamp01(Number(snapshot.confidence) || 0),
        metrics: normalizeMetrics(snapshot.metrics),
        causeScores: snapshot.causeScores || {},
        freshness,
        sampleCount: Math.max(0, Number(snapshot.sampleCount) || 0),
    };
}

function normalizeFreshness(freshness = {}) {
    return Object.fromEntries(
        ['listener', 'whisper', 'translation', 'tts', 'emission'].map(stream => {
            const item = freshness?.[stream] || {};
            const status = ['live', 'stale', 'missing', 'unknown'].includes(item.status)
                ? item.status
                : 'missing';
            return [stream, {
                status,
                ageMs: nullableNumber(item.ageMs),
                lastSampleTsMs: nullableNumber(item.lastSampleTsMs),
            }];
        }),
    );
}

function normalizeMetrics(metrics = {}) {
    return {
        firstTextMs: normalizeNumberSummary(metrics.firstTextMs),
        firstAudioMs: normalizeNumberSummary(metrics.firstAudioMs),
        segmentAgeMs: normalizeNumberSummary(metrics.segmentAgeMs),
        pauseMs: normalizeNumberSummary(metrics.pauseMs),
        queueDepth: normalizeNumberSummary(metrics.queueDepth),
        listenerBufferDepth: normalizeNumberSummary(metrics.listenerBufferDepth),
        listenerDriftMs: normalizeNumberSummary(metrics.listenerDriftMs),
        whisperMs: normalizeNumberSummary(metrics.whisperMs),
        gptMs: normalizeNumberSummary(metrics.gptMs),
        ttsMs: normalizeNumberSummary(metrics.ttsMs),
        localAgreementConfirmationMs: normalizeNumberSummary(metrics.localAgreementConfirmationMs),
        fallbackStallMs: normalizeNumberSummary(metrics.fallbackStallMs),
        counters: metrics.counters || {},
        rates: {
            dropAudioSkip: normalizeRate(metrics.rates?.dropAudioSkip),
            duplicates: normalizeRate(metrics.rates?.duplicates),
            fallbacks: normalizeRate(metrics.rates?.fallbacks),
        },
    };
}

function normalizeNumberSummary(summary = {}) {
    return {
        count: Math.max(0, Number(summary.count) || 0),
        min: nullableNumber(summary.min),
        max: nullableNumber(summary.max),
        avg: nullableNumber(summary.avg),
        p50: nullableNumber(summary.p50),
        p95: nullableNumber(summary.p95),
        p99: nullableNumber(summary.p99),
    };
}

function nullableNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeRate(value) {
    return clamp01(Number(value) || 0);
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

export {
    DEFAULT_AUTOPILOT_POLICY_CONFIG,
    buildAutopilotShadowMetric,
    decideAutopilotProfile,
    logAutopilotShadowDecision,
    normalizeAutopilotConfig,
    normalizeSnapshot,
};
