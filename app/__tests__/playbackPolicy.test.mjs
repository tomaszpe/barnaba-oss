import { describe, it, expect } from 'vitest';
import { choosePlaybackRate, targetPlaybackRate } from '../playbackPolicy.js';

describe('adaptive playback policy', () => {
    it('keeps normal speed for fresh empty queue', () => {
        expect(targetPlaybackRate({ queueDepth: 0, ageMs: 1200 })).toBe(1.0);
    });

    it('raises speed from queue depth or chunk age', () => {
        expect(targetPlaybackRate({ queueDepth: 2, ageMs: 500 })).toBe(1.08);
        expect(targetPlaybackRate({ queueDepth: 0, ageMs: 3500 })).toBe(1.08);
        expect(targetPlaybackRate({ queueDepth: 4, ageMs: 1000 })).toBe(1.15);
        expect(targetPlaybackRate({ queueDepth: 0, ageMs: 7000 })).toBe(1.15);
        expect(targetPlaybackRate({ queueDepth: 7, ageMs: 1000 })).toBe(1.2);
        expect(targetPlaybackRate({ queueDepth: 0, ageMs: 11000 })).toBe(1.2);
    });

    it('uses hysteresis when backing down from elevated speed', () => {
        expect(choosePlaybackRate({ queueDepth: 1, ageMs: 2400, previousRate: 1.08 })).toBe(1.08);
        expect(choosePlaybackRate({ queueDepth: 0, ageMs: 1000, previousRate: 1.08 })).toBe(1.0);
        expect(choosePlaybackRate({ queueDepth: 3, ageMs: 5200, previousRate: 1.15 })).toBe(1.15);
        expect(choosePlaybackRate({ queueDepth: 1, ageMs: 1000, previousRate: 1.15 })).toBe(1.08);
    });

    it('clamps invalid previous rates', () => {
        expect(choosePlaybackRate({ queueDepth: 0, ageMs: 0, previousRate: Number.NaN })).toBe(1.0);
        expect(choosePlaybackRate({ queueDepth: 10, ageMs: 0, previousRate: 3 })).toBe(1.2);
    });

    it('allows liveness catch-up cap above legacy 1.2x', () => {
        expect(targetPlaybackRate({ queueDepth: 7, ageMs: 1000, maxRate: 1.3 })).toBe(1.3);
        expect(choosePlaybackRate({ queueDepth: 10, ageMs: 0, previousRate: 3, maxRate: 1.3 })).toBe(1.3);
    });
});
