const clamp = (value, min, max, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

export const CLIENT_FEATURE_ENV = Object.freeze({
    preserveTtsPitch: 'PWA_PRESERVE_PITCH_ENABLED',
    instantFeedback: 'INSTANT_FEEDBACK_ENABLED',
    listenerPlaybackPolicyV2: 'LISTENER_PLAYBACK_POLICY_V2_ENABLED',
    listenerBoundedScheduler: 'LISTENER_BOUNDED_SCHEDULER_ENABLED',
    listenerCatchupMaxRate: 'LISTENER_CATCHUP_MAX_RATE',
    listenerCatchupChunkAgeSec: 'LISTENER_CATCHUP_CHUNK_AGE_SEC',
    listenerBacklogBudgetSec: 'LISTENER_BACKLOG_BUDGET_SEC',
    listenerEarlyCatchup: 'LISTENER_EARLY_CATCHUP_ENABLED',
    listenerEarlyCatchupEnterMs: 'LISTENER_EARLY_CATCHUP_ENTER_MS',
    listenerEarlyCatchupExitMs: 'LISTENER_EARLY_CATCHUP_EXIT_MS',
    listenerEarlyCatchupDwellMs: 'LISTENER_EARLY_CATCHUP_DWELL_MS',
    listenerEarlyCatchupRate: 'LISTENER_EARLY_CATCHUP_RATE',
    fqfT2SupersessionShadow: 'FQF_T2_SUPERSESSION_SHADOW_ENABLED',
    fqfT2SupersessionApply: 'FQF_T2_SUPERSESSION_APPLY_ENABLED',
});

export const CLIENT_FEATURE_ENV_KEYS = Object.freeze(Object.values(CLIENT_FEATURE_ENV));

export const buildClientFeatureConfig = (env = process.env) => ({
    preserveTtsPitch: env[CLIENT_FEATURE_ENV.preserveTtsPitch] === 'true',
    instantFeedback: env[CLIENT_FEATURE_ENV.instantFeedback] === 'true',
    listenerPlaybackPolicyV2: env[CLIENT_FEATURE_ENV.listenerPlaybackPolicyV2] === 'true',
    listenerBoundedScheduler: env[CLIENT_FEATURE_ENV.listenerBoundedScheduler] === 'true',
    listenerCatchupMaxRate: clamp(env[CLIENT_FEATURE_ENV.listenerCatchupMaxRate], 1.0, 1.5, 1.3),
    listenerCatchupChunkAgeMs: clamp(env[CLIENT_FEATURE_ENV.listenerCatchupChunkAgeSec], 1, 120, 10) * 1000,
    listenerBacklogBudgetMs: clamp(env[CLIENT_FEATURE_ENV.listenerBacklogBudgetSec], 1, 120, 15) * 1000,
    // Early Catch-up. The defaults are the specified ones, so an A/B changes exactly one
    // thing: the flag.
    listenerEarlyCatchup: env[CLIENT_FEATURE_ENV.listenerEarlyCatchup] === 'true',
    listenerEarlyCatchupEnterMs: clamp(env[CLIENT_FEATURE_ENV.listenerEarlyCatchupEnterMs], 0, 60000, 2500),
    listenerEarlyCatchupExitMs: clamp(env[CLIENT_FEATURE_ENV.listenerEarlyCatchupExitMs], 0, 60000, 1200),
    listenerEarlyCatchupDwellMs: clamp(env[CLIENT_FEATURE_ENV.listenerEarlyCatchupDwellMs], 0, 300000, 15000),
    // Capped at the same 1.5 ceiling as the ladder's max rate; the effective cap at runtime
    // is still `listenerCatchupMaxRate` (1.3), applied client-side.
    listenerEarlyCatchupRate: clamp(env[CLIENT_FEATURE_ENV.listenerEarlyCatchupRate], 1.0, 1.5, 1.25),
    fqfT2SupersessionShadow: env[CLIENT_FEATURE_ENV.fqfT2SupersessionShadow] === 'true',
    fqfT2SupersessionApply: env[CLIENT_FEATURE_ENV.fqfT2SupersessionApply] === 'true',
});
