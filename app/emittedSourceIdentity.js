import crypto from 'crypto';
import { normWords } from './deadlineProvisional.js';

export const EMITTED_SOURCE_NORMALIZER = 'deadline_norm_v1';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const sourceMapDigestFromLineage = (lineage) => sha256(JSON.stringify({
    version: lineage?.version ?? null,
    status: lineage?.status ?? 'missing',
    wordCount: lineage?.wordCount ?? 0,
    coordinateSpaceIds: Array.isArray(lineage?.logicalChunkIds)
        ? lineage.logicalChunkIds
        : [],
    words: Array.isArray(lineage?.wordSpans) ? lineage.wordSpans.map((span) => ({
        wordIndex: span.wordIndex ?? null,
        coordinateSpaceId: span.logicalChunkId ?? span.coordinateSpaceId ?? null,
        startSample: span.startSample ?? null,
        endSample: span.endSample ?? null,
    })) : [],
}));

export const deliveryUnitIdFor = (releaseMeta) => sha256(JSON.stringify({
    protocol: 2,
    sessionEpoch: releaseMeta?.sessionEpoch ?? null,
    releaseSeq: releaseMeta?.releaseSeq ?? null,
    familyId: releaseMeta?.revisionTicket?.familyId ?? null,
    generation: releaseMeta?.revisionTicket?.generation ?? null,
    sourceMapDigest: sourceMapDigestFromLineage(releaseMeta?.sourceLineage),
    action: releaseMeta?.t4Action ?? 'whole',
    sourceStartWord: releaseMeta?.t4SourceStartWord ?? 0,
})).slice(0, 24);

export const normalizedWords = (text) => normWords(String(text || ''));

export const stampEmittedSourceIdentity = (releaseMeta, text) => {
    const words = normalizedWords(text);
    return {
        ...(releaseMeta || {}),
        emittedSourceHash: sha256(words.join(' ')),
        emittedSourceNormalizer: EMITTED_SOURCE_NORMALIZER,
        emittedWordCount: words.length,
    };
};

export const chunkWordCount = (text) => (
    String(text || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []
).length;

export const buildTtsChunkIdentity = ({
    releaseMeta,
    language,
    sentenceIndex,
    sentenceText,
}) => {
    const normalizedChunk = String(sentenceText || '').trim().toLocaleLowerCase();
    const sourceMapDigest = sourceMapDigestFromLineage(releaseMeta?.sourceLineage);
    return {
        session_epoch: releaseMeta?.sessionEpoch ?? null,
        release_seq: releaseMeta?.releaseSeq ?? null,
        language: language || 'unknown',
        sentence_index: Number(sentenceIndex) || 0,
        emitted_source_hash: releaseMeta?.emittedSourceHash ?? null,
        emitted_source_normalizer: releaseMeta?.emittedSourceNormalizer ?? null,
        emitted_word_count: releaseMeta?.emittedWordCount ?? null,
        chunk_word_count: chunkWordCount(sentenceText),
        translated_chunk_hash: sha256(normalizedChunk),
        source_map_digest: sourceMapDigest,
        delivery_unit_id: deliveryUnitIdFor(releaseMeta),
    };
};
