import { describe, expect, it } from 'vitest';
import { resegmentSourceAtWord } from '../sourceResegmentation.js';

const lineage = {
    status: 'complete',
    wordCount: 5,
    logicalChunkIds: ['a'.repeat(24)],
    wordSpans: Array.from({ length: 5 }, (_, index) => ({
        logicalChunkId: 'a'.repeat(24),
        startSample: index * 100,
        endSample: (index + 1) * 100,
    })),
};

describe('T4 source-audio resegmentation', () => {
    it('creates a complete residual from the original source word boundary', () => {
        const result = resegmentSourceAtWord('Er sagt: das ist wichtig.', lineage, 2);
        expect(result).toMatchObject({
            action: 'resegment',
            text: 'das ist wichtig.',
            startWord: 2,
            remainingWords: 3,
            sourceLineage: { status: 'complete', wordCount: 3 },
        });
        expect(result.sourceLineage.wordSpans[0].startSample).toBe(200);
    });

    it('suppresses a fully committed variant instead of producing an empty translation', () => {
        expect(resegmentSourceAtWord('Er sagt das ist wichtig', lineage, 5)).toMatchObject({
            action: 'suppress',
            reason: 'source_fully_committed',
        });
    });

    it('fails open without complete and exactly aligned lineage', () => {
        expect(resegmentSourceAtWord(
            'Er sagt das ist wichtig',
            { ...lineage, status: 'partial' },
            2,
        )).toMatchObject({ action: 'unchanged', reason: 'lineage_not_complete' });
        expect(resegmentSourceAtWord('Er sagt das ist wichtig', lineage, -1))
            .toMatchObject({ action: 'unchanged', reason: 'invalid_prefix' });
    });
});
