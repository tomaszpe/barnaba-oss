import { describe, expect, it } from 'vitest';

import { evaluateT4CommittedPrefixApply } from '../t4CommittedPrefixApply.js';

const coordinate = 'a'.repeat(24);
const lineage = {
    status: 'complete',
    wordCount: 6,
    logicalChunkIds: [coordinate],
    wordSpans: Array.from({ length: 6 }, (_, wordIndex) => ({
        wordIndex,
        logicalChunkId: coordinate,
        startSample: wordIndex * 100,
        endSample: (wordIndex + 1) * 100,
    })),
};
const sourceMap = {
    version: 2,
    status: 'complete',
    coordinateSpaceIds: [coordinate],
    wordCount: 6,
    provenWords: lineage.wordSpans.map((span) => ({
        wordIndex: span.wordIndex,
        coordinateSpaceId: span.logicalChunkId,
        startSample: span.startSample,
        endSample: span.endSample,
    })),
    coverage: { provenWordCount: 6, unprovenWordCount: 0, ratio: 1 },
    reasonCodes: [],
};

describe('T4 committed-prefix APPLY boundary', () => {
    it('resegments with the same action selected by the planner', () => {
        const evaluation = evaluateT4CommittedPrefixApply({
            text: 'eins zwei drei vier fuenf sechs',
            sourceLineage: lineage,
            sourceMap,
            proofs: [{
                releaseSeq: 1,
                committedAt: 1,
                ranges: [{ coordinateSpaceId: coordinate, startSample: 0, endSample: 400 }],
            }],
            safeBoundaryWordIndexes: [4],
            ledgerVersion: 3,
        });

        expect(evaluation).toMatchObject({
            actionConsistent: true,
            plan: { eligible: true, action: 'resegment', safeBoundaryWord: 4 },
            result: {
                action: 'resegment',
                startWord: 4,
                remainingWords: 2,
                sourceLineage: { status: 'complete', wordCount: 2 },
            },
        });
    });
});
