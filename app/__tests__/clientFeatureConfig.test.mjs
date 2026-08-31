import { describe, expect, it } from 'vitest';
import {
    buildClientFeatureConfig,
    CLIENT_FEATURE_ENV_KEYS,
} from '../clientFeatureConfig.js';

describe('client feature config contract', () => {
    it('exports the complete env contract consumed by both config endpoints', () => {
        expect(CLIENT_FEATURE_ENV_KEYS).toHaveLength(14);
        expect(CLIENT_FEATURE_ENV_KEYS).toEqual(expect.arrayContaining([
            'PWA_PRESERVE_PITCH_ENABLED',
            'INSTANT_FEEDBACK_ENABLED',
            'LISTENER_BOUNDED_SCHEDULER_ENABLED',
            'LISTENER_EARLY_CATCHUP_RATE',
            'FQF_T2_SUPERSESSION_SHADOW_ENABLED',
            'FQF_T2_SUPERSESSION_APPLY_ENABLED',
        ]));
    });

    it('keeps T2 apply independently opt-in', () => {
        expect(buildClientFeatureConfig({}).fqfT2SupersessionApply).toBe(false);
        expect(buildClientFeatureConfig({
            FQF_T2_SUPERSESSION_APPLY_ENABLED: 'true',
        }).fqfT2SupersessionApply).toBe(true);
    });

    it('keeps T2 supersession strictly shadow and opt-in', () => {
        expect(buildClientFeatureConfig({}).fqfT2SupersessionShadow).toBe(false);
        expect(buildClientFeatureConfig({
            FQF_T2_SUPERSESSION_SHADOW_ENABLED: 'true',
        }).fqfT2SupersessionShadow).toBe(true);
    });

    it('exposes all catch-up fields consumed by the PWA', () => {
        expect(buildClientFeatureConfig({
            LISTENER_BOUNDED_SCHEDULER_ENABLED: 'true',
            LISTENER_CATCHUP_MAX_RATE: '1.3',
            LISTENER_CATCHUP_CHUNK_AGE_SEC: '12',
            LISTENER_BACKLOG_BUDGET_SEC: '18',
        })).toMatchObject({
            listenerBoundedScheduler: true,
            listenerCatchupMaxRate: 1.3,
            listenerCatchupChunkAgeMs: 12000,
            listenerBacklogBudgetMs: 18000,
        });
    });

    it('clamps unsafe values and keeps policy v2 opt-in', () => {
        const result = buildClientFeatureConfig({
            LISTENER_CATCHUP_MAX_RATE: '9',
            LISTENER_CATCHUP_CHUNK_AGE_SEC: '0',
            LISTENER_BACKLOG_BUDGET_SEC: '999',
            LISTENER_PLAYBACK_POLICY_V2_ENABLED: 'false',
        });
        expect(result.listenerCatchupMaxRate).toBe(1.5);
        expect(result.listenerCatchupChunkAgeMs).toBe(1000);
        expect(result.listenerBacklogBudgetMs).toBe(120000);
        expect(result.listenerPlaybackPolicyV2).toBe(false);
        expect(result.listenerBoundedScheduler).toBe(false);
    });
});
