import { describe, expect, it } from 'vitest';
import {
    EMITTED_SOURCE_NORMALIZER,
    buildTtsChunkIdentity,
    deliveryUnitIdFor,
    sourceMapDigestFromLineage,
    stampEmittedSourceIdentity,
} from '../emittedSourceIdentity.js';

describe('post-filter emitted source identity', () => {
    it('stamps the filtered text without replacing the original audit hash', () => {
        const stamped = stampEmittedSourceIdentity({
            sessionEpoch: 'epoch-1',
            releaseSeq: 94,
            sourceHash: 'pre-filter',
        }, 'Ich sage es nochmals.');

        expect(stamped.sourceHash).toBe('pre-filter');
        expect(stamped.emittedSourceNormalizer).toBe(EMITTED_SOURCE_NORMALIZER);
        expect(stamped.emittedWordCount).toBe(4);
        expect(stamped.emittedSourceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('derives text-free stable proof and delivery identities', () => {
        const releaseMeta = {
            sessionEpoch: 'epoch-a',
            releaseSeq: 9,
            sourceLineage: {
                version: 1,
                status: 'complete',
                wordCount: 1,
                logicalChunkIds: ['a'.repeat(24)],
                wordSpans: [{
                    wordIndex: 0,
                    logicalChunkId: 'a'.repeat(24),
                    startSample: 100,
                    endSample: 200,
                }],
            },
        };
        expect(sourceMapDigestFromLineage(releaseMeta.sourceLineage)).toMatch(/^[0-9a-f]{64}$/);
        expect(deliveryUnitIdFor(releaseMeta)).toMatch(/^[0-9a-f]{24}$/);
        expect(deliveryUnitIdFor(releaseMeta)).toBe(deliveryUnitIdFor({ ...releaseMeta }));
    });

    it('builds the canonical per-sentence TTS identity and word count', () => {
        const releaseMeta = stampEmittedSourceIdentity({
            sessionEpoch: 'epoch-2',
            releaseSeq: 7,
        }, 'Gefilterte Quelle.');
        const identity = buildTtsChunkIdentity({
            releaseMeta,
            language: 'pl',
            sentenceIndex: 1,
            sentenceText: 'To są trzy słowa.',
        });

        expect(identity).toMatchObject({
            session_epoch: 'epoch-2',
            release_seq: 7,
            language: 'pl',
            sentence_index: 1,
            chunk_word_count: 4,
            emitted_source_hash: releaseMeta.emittedSourceHash,
        });
        expect(identity.translated_chunk_hash).toMatch(/^[a-f0-9]{64}$/);
    });
});
