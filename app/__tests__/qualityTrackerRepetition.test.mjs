import { describe, expect, it } from 'vitest';
import qualityTracker from '../qualityTracker.js';

function makeSession({ repetitions, sourceText = '' }) {
    return {
        startedAt: new Date('2026-06-09T12:00:00.000Z').toISOString(),
        segments: 10,
        emissions: 1,
        dupTotals: {
            adjacentWordDups: repetitions.adjacentWordDups,
            effectiveAdjacentWordDups: repetitions.effectiveAdjacentWordDups,
            rhetoricalAdjacentWordDups: repetitions.rhetoricalAdjacentWordDups,
            bigramDups: 0,
            trigramDups: 0,
        },
        emissionLog: [
            {
                lang: 'en',
                repetitions,
                sourceText,
                pause: { bucket: '0-3s', isSpeakerPause: false },
                latency: { translationMs: 500 },
            },
        ],
    };
}

describe('qualityTracker repetition scoring', () => {
    it('keeps source-side rhetorical repetition as diagnostic raw data but removes it from effective score', () => {
        const repetitions = qualityTracker.deriveEffectiveRepetitions(
            { adjacentWordDups: 2, bigramDups: 0, trigramDups: 0, totalWordDups: 2 },
            'Unverschuldetes Leid. Warum, warum, warum? Er weiss nicht.',
        );

        expect(repetitions).toMatchObject({
            adjacentWordDups: 2,
            effectiveAdjacentWordDups: 0,
            rhetoricalAdjacentWordDups: 2,
        });

        const score = qualityTracker.computeObjectiveScore(makeSession({ repetitions }), Date.parse('2026-06-09T12:01:00.000Z'));
        expect(score.components.R_norm).toBe(0);
        expect(score.raw).toMatchObject({
            adjacentWordDups: 0,
            rawAdjacentWordDups: 2,
            rhetoricalAdjacentWordDups: 2,
        });
    });

    it('still penalizes translation-only adjacent repetition when the source does not repeat', () => {
        const repetitions = qualityTracker.deriveEffectiveRepetitions(
            { adjacentWordDups: 2, bigramDups: 0, trigramDups: 0, totalWordDups: 2 },
            'Unverschuldetes Leid. Er weiss nicht.',
        );

        expect(repetitions).toMatchObject({
            adjacentWordDups: 2,
            effectiveAdjacentWordDups: 2,
            rhetoricalAdjacentWordDups: 0,
        });

        const score = qualityTracker.computeObjectiveScore(makeSession({ repetitions }), Date.parse('2026-06-09T12:01:00.000Z'));
        expect(score.components.R_norm).toBe(2);
        expect(score.raw).toMatchObject({
            adjacentWordDups: 2,
            rawAdjacentWordDups: 2,
            rhetoricalAdjacentWordDups: 0,
        });
    });

    it('only discounts as many repetitions as the source can explain', () => {
        const repetitions = qualityTracker.deriveEffectiveRepetitions(
            { adjacentWordDups: 3, bigramDups: 0, trigramDups: 0, totalWordDups: 3 },
            'Warum, warum?',
        );

        expect(repetitions).toMatchObject({
            adjacentWordDups: 3,
            effectiveAdjacentWordDups: 2,
            rhetoricalAdjacentWordDups: 1,
        });
    });
});
