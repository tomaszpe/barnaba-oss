import { describe, expect, it } from 'vitest';

import { planT4CommittedPrefix } from '../t4CommittedPrefixPlanner.js';
import { safeSourceBoundaryWordIndexes } from '../sourceBoundaryMap.js';

const coordinate = 'a'.repeat(24);
const sourceMap = (wordCount = 6) => ({
    version: 2,
    status: 'complete',
    coordinateSpaceIds: [coordinate],
    wordCount,
    provenWords: Array.from({ length: wordCount }, (_, wordIndex) => ({
        wordIndex,
        coordinateSpaceId: coordinate,
        startSample: wordIndex * 100,
        endSample: (wordIndex + 1) * 100,
    })),
    coverage: { provenWordCount: wordCount, unprovenWordCount: 0, ratio: 1 },
    reasonCodes: [],
});
const proof = (ranges, releaseSeq = 1, committedAt = 1000) => ({
    releaseSeq,
    committedAt,
    ranges: ranges.map(([startSample, endSample]) => ({
        coordinateSpaceId: coordinate, startSample, endSample,
    })),
});

describe('T4.1 committed prefix planner', () => {
    it('resegments only at a source-provided safe boundary', () => {
        const result = planT4CommittedPrefix({
            sourceMap: sourceMap(),
            proofs: [proof([[0, 400]])],
            safeBoundaryWordIndexes: [3],
        });
        expect(result).toMatchObject({
            eligible: true,
            action: 'resegment',
            topology: 'proved_prefix',
            provedPrefixWords: 4,
            safeBoundaryWord: 3,
            bridgeWords: 1,
        });
    });

    it('keeps a one or two word prefix unchanged', () => {
        expect(planT4CommittedPrefix({
            sourceMap: sourceMap(), proofs: [proof([[0, 200]])], safeBoundaryWordIndexes: [1],
        })).toMatchObject({
            eligible: false, action: 'unchanged', reason: 'proved_prefix_below_benefit',
        });
    });

    it('keeps an interior committed island as a hard negative', () => {
        expect(planT4CommittedPrefix({
            sourceMap: sourceMap(), proofs: [proof([[200, 400]])], safeBoundaryWordIndexes: [3],
        })).toMatchObject({
            eligible: false,
            action: 'unchanged',
            topology: 'proved_committed_infix_non_actionable',
        });
    });

    it('does not turn a partial boundary overlap into a committed word', () => {
        expect(planT4CommittedPrefix({
            sourceMap: sourceMap(), proofs: [proof([[0, 50]])], safeBoundaryWordIndexes: [3],
        })).toMatchObject({
            eligible: false, topology: 'boundary_overlap_only', provedPrefixWords: 0,
        });
    });

    it('does not bridge sample gaps or out-of-order proof history', () => {
        const result = planT4CommittedPrefix({
            sourceMap: sourceMap(),
            proofs: [proof([[0, 200], [400, 600]], 1, 1000), proof([[200, 400]], 2, 2000)],
            safeBoundaryWordIndexes: [3],
        });
        expect(result.provedPrefixWords).toBe(4);
        expect(result.topology).toBe('fragmented_non_actionable');
        expect(result.action).toBe('unchanged');
    });

    it('suppresses only complete chronological coverage', () => {
        expect(planT4CommittedPrefix({
            sourceMap: sourceMap(), proofs: [proof([[0, 600]])],
        })).toMatchObject({ eligible: true, action: 'suppress', topology: 'full' });
    });

    it('derives boundaries only after closed source units with exact word balance', () => {
        const units = [
            { words: 3, closed: true },
            { words: 2, closed: true },
            { words: 1, closed: false },
        ];
        expect(safeSourceBoundaryWordIndexes(units, 6)).toEqual([3, 5]);
        expect(safeSourceBoundaryWordIndexes(units, 7)).toEqual([]);
    });
});
