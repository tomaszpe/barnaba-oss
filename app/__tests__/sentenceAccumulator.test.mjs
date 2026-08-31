import { describe, it, expect, vi, afterEach } from 'vitest';
import { SentenceAccumulator } from '../sentenceService.js';
import { sourceLineageFromWhisper } from '../sourceLineage.js';

describe('SentenceAccumulator smooth early release', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses configurable earlyReleaseMs instead of a hardcoded 7s threshold', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));

        const accumulator = new SentenceAccumulator({
            minSentences: 2,
            minChars: 1,
            earlyReleaseMs: 6000,
            maxHoldMs: 10000,
        });

        expect(accumulator.add('Pierwsze zdanie.', false)).toBeNull();

        vi.setSystemTime(new Date('2026-06-16T12:00:06.001Z'));
        const release = accumulator.add('Dalszy fragment bez kropki', false);

        expect(release).toMatchObject({
            text: 'Pierwsze zdanie.',
            sentenceCount: 1,
            reason: 'early',
        });
    });

    it('does not release before configured earlyReleaseMs when minSentences is not met', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));

        const accumulator = new SentenceAccumulator({
            minSentences: 2,
            minChars: 1,
            earlyReleaseMs: 8000,
            maxHoldMs: 10000,
        });

        expect(accumulator.add('Pierwsze zdanie.', false)).toBeNull();

        vi.setSystemTime(new Date('2026-06-16T12:00:06.500Z'));
        expect(accumulator.add('Dalszy fragment bez kropki', false)).toBeNull();
    });
});

describe('SentenceAccumulator FQF-4B lineage', () => {
    it('carries exact spans through sentence splitting and batching', () => {
        const accumulator = new SentenceAccumulator({ minSentences: 2, minChars: 1 });
        const lineage = sourceLineageFromWhisper('Hiob sprach. Er schwieg.', {
            whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9',
            decodeId: 'd1',
            inputPcmSha256: 'b'.repeat(64),
            inputStartSample: 0,
            inputEndSample: 100,
            provenanceStatus: 'complete',
            alignmentStatus: 'exact',
            confirmedWordSpans: [
                { text: 'Hiob', start_sample: 0, end_sample: 10 },
                { text: 'sprach', start_sample: 11, end_sample: 20 },
                { text: 'Er', start_sample: 21, end_sample: 30 },
                { text: 'schwieg', start_sample: 31, end_sample: 40 },
            ],
        });

        const release = accumulator.add('Hiob sprach. Er schwieg.', false, lineage);

        expect(release.text).toBe('Hiob sprach. Er schwieg.');
        expect(release.sourceLineage.status).toBe('complete');
        expect(release.sourceLineage.wordSpans).toHaveLength(4);
    });

    it('marks unscoped legacy input missing without changing released text', () => {
        const accumulator = new SentenceAccumulator({ minSentences: 1, minChars: 1 });
        const release = accumulator.add('Hiob sprach.', false);

        expect(release.text).toBe('Hiob sprach.');
        expect(release.sourceLineage.status).toBe('missing');
    });
});
