import { describe, it, expect } from 'vitest';
import { decideAgeBudget } from '../ageBudgetService.js';

const enabled = {
    enabled: true,
    cautiousAfterMs: 8000,
    textOnlyAfterMs: 12000,
    dropAfterMs: 20000,
    unhealthyQueueDepth: 4,
};

describe('age budget policy', () => {
    it('is a no-op when disabled', () => {
        expect(decideAgeBudget({ ageMs: 60000, queueDepth: 99, config: { enabled: false } })).toMatchObject({
            action: 'normal_tts',
            reason: 'disabled',
        });
    });

    it('allows normal TTS for fresh items', () => {
        expect(decideAgeBudget({ ageMs: 5000, queueDepth: 0, config: enabled })).toMatchObject({
            action: 'normal_tts',
            reason: 'fresh_enough',
        });
    });

    it('uses text-only for stale items', () => {
        expect(decideAgeBudget({ ageMs: 13000, queueDepth: 0, config: enabled })).toMatchObject({
            action: 'text_only_stale',
            reason: 'age_over_text_only_threshold',
        });
    });

    it('uses text-only when age and queue are both unhealthy', () => {
        expect(decideAgeBudget({ ageMs: 9000, queueDepth: 4, config: enabled })).toMatchObject({
            action: 'text_only_stale',
            reason: 'age_and_queue_unhealthy',
        });
    });

    it('drops very stale emissions', () => {
        expect(decideAgeBudget({ ageMs: 21000, queueDepth: 0, config: enabled })).toMatchObject({
            action: 'drop_stale',
            reason: 'age_over_drop_threshold',
        });
    });
});
