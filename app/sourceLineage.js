import { createHash } from 'node:crypto';

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const VALID_STATUSES = new Set(['complete', 'partial', 'ambiguous', 'missing']);
const COORDINATE_SPACE_ID = /^[0-9a-f]{24}$/;
const LINEAGE_REASON_CODE = /^[a-z0-9_]{1,64}$/;

export function sourceWords(text) {
    return String(text || '').match(WORD_RE)?.map((word) => word.toLocaleLowerCase('de-CH')) || [];
}

function finiteInteger(value) {
    if (typeof value !== 'number') return null;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validLineageSpan(span) {
    return span && typeof span === 'object'
        && typeof span.logicalChunkId === 'string' && COORDINATE_SPACE_ID.test(span.logicalChunkId)
        && finiteInteger(span.startSample) !== null
        && finiteInteger(span.endSample) !== null
        && span.endSample > span.startSample;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

function logicalChunkId(provenance) {
    const whisperSessionId = provenance?.whisperSessionId;
    const pcmSha256 = provenance?.inputPcmSha256;
    if (typeof whisperSessionId !== 'string' || whisperSessionId.trim().length === 0
        || whisperSessionId.length > 128) return null;
    if (typeof pcmSha256 !== 'string' || !SHA256_RE.test(pcmSha256)) return null;
    // Absolute sample coordinates are comparable across growing decoder snapshots only
    // inside one Whisper streaming session. The snapshot PCM digest still proves that
    // the individual decode input is exact, but it must not define the coordinate space:
    // its value changes whenever the growing buffer receives more audio.
    return createHash('sha256').update(whisperSessionId.trim()).digest('hex').slice(0, 24);
}

function freezeLineage(lineage) {
    for (const span of lineage.wordSpans) Object.freeze(span);
    Object.freeze(lineage.wordSpans);
    Object.freeze(lineage.logicalChunkIds);
    return Object.freeze(lineage);
}

export function missingSourceLineage(reason = 'not_observed', wordCount = 0) {
    return freezeLineage({
        version: 1,
        status: 'missing',
        reason,
        logicalChunkIds: [],
        wordSpans: [],
        wordCount: finiteInteger(wordCount) || 0,
    });
}

/**
 * Convert Whisper evidence into the text-bound lineage used by the gateway.
 * Word text is used only for the local alignment check and is never retained.
 */
export function sourceLineageFromWhisper(text, provenance) {
    const textWords = sourceWords(text);
    if (textWords.length === 0) return missingSourceLineage('empty_text');
    if (!provenance) return missingSourceLineage('missing_provenance', textWords.length);

    const rawSpans = Array.isArray(provenance.confirmedWordSpans)
        ? provenance.confirmedWordSpans
        : [];
    const spanWordLists = rawSpans.map((span) => sourceWords(span?.text));
    const exactWords = rawSpans.length === textWords.length
        && spanWordLists.every((words, index) => (
            words.length === 1 && words[0] === textWords[index]
        ));
    const normalizedSpans = rawSpans.map((span) => ({
        start: finiteInteger(span?.start_sample),
        end: finiteInteger(span?.end_sample),
    }));
    const validRanges = normalizedSpans.every(({ start, end }) => (
        start !== null && end !== null && end > start
    ));
    const inputStart = finiteInteger(provenance.inputStartSample);
    const inputEnd = finiteInteger(provenance.inputEndSample);
    const validInputBounds = inputStart !== null && inputEnd !== null && inputEnd > inputStart
        && validRanges
        && normalizedSpans.every(({ start, end }) => (
            start >= inputStart && end <= inputEnd
        ));
    const monotonicRanges = validRanges && normalizedSpans.every(({ start, end }, index) => index === 0 || (
        start >= normalizedSpans[index - 1].start
        && end >= normalizedSpans[index - 1].end
    ));
    // `confirmedWordSpans` describe the post-dedup delta, while `alignmentStatus`
    // describes the whole raw decoder snapshot. A malformed timestamp belonging to
    // a word removed by timestamp dedup can therefore make the raw snapshot
    // `unaligned` even though the emitted delta has a complete, independently
    // validated sidecar. The checks above re-prove the delta word-for-word and
    // sample-for-sample, so only the delta provenance status is authoritative here.
    const alignmentComplete = provenance.provenanceStatus === 'complete';

    const chunkId = logicalChunkId(provenance);
    if (!exactWords || !validRanges || !validInputBounds || !monotonicRanges || !alignmentComplete || !chunkId) {
        return freezeLineage({
            version: 1,
            status: rawSpans.length > 0 ? 'ambiguous' : 'missing',
            reason: !alignmentComplete
                ? 'whisper_alignment_incomplete'
                : !exactWords
                    ? 'word_alignment_mismatch'
                    : !validRanges
                        ? 'invalid_sample_range'
                        : !validInputBounds
                            ? 'span_outside_input'
                            : !monotonicRanges
                                ? 'non_monotonic_span'
                        : 'missing_logical_identity',
            logicalChunkIds: chunkId ? [chunkId] : [],
            wordSpans: [],
            wordCount: textWords.length,
        });
    }

    return freezeLineage({
        version: 1,
        status: 'complete',
        reason: null,
        logicalChunkIds: [chunkId],
        wordSpans: normalizedSpans.map(({ start, end }, wordIndex) => ({
            wordIndex,
            logicalChunkId: chunkId,
            decodeId: provenance.decodeId,
            inputPcmSha256: provenance.inputPcmSha256,
            startSample: start,
            endSample: end,
        })),
        wordCount: textWords.length,
    });
}

export function composeSourceLineages(lineages, { reason = 'composed', forceAmbiguous = false } = {}) {
    const inputs = Array.isArray(lineages) ? lineages : [];
    const present = inputs
        .filter((lineage) => lineage && typeof lineage === 'object');
    const missingInput = inputs.some((lineage) => lineage == null);
    const invalidInput = inputs.some((lineage) => lineage != null && typeof lineage !== 'object');
    if (present.length === 0) {
        if (!invalidInput) return missingSourceLineage('no_lineage_parts');
        return freezeLineage({
            version: 1,
            status: 'ambiguous',
            reason: 'invalid_lineage_part',
            logicalChunkIds: [],
            wordSpans: [],
            wordCount: 0,
        });
    }
    const logicalChunkIds = [...new Set(present.flatMap((lineage) => (
        Array.isArray(lineage.logicalChunkIds) ? lineage.logicalChunkIds : []
    )))];
    let invalidPart = invalidInput || missingInput;
    let wordCount = 0;
    for (const lineage of present) {
        const count = finiteInteger(lineage.wordCount);
        if (count === null || !Number.isSafeInteger(wordCount + count)) {
            invalidPart = true;
            continue;
        }
        wordCount += count;
        if (lineage.wordSpans != null && !Array.isArray(lineage.wordSpans)) invalidPart = true;
        const lineageCoordinateIds = Array.isArray(lineage.logicalChunkIds)
            ? lineage.logicalChunkIds
            : null;
        if (!lineageCoordinateIds
            || lineageCoordinateIds.some((id) => (
                typeof id !== 'string' || !COORDINATE_SPACE_ID.test(id)
            ))
            || new Set(lineageCoordinateIds).size !== lineageCoordinateIds.length) {
            invalidPart = true;
        }
    }
    let wordOffset = 0;
    const wordSpans = present.flatMap((lineage) => {
        const lineageSpans = Array.isArray(lineage.wordSpans) ? lineage.wordSpans : [];
        const lineageWordCount = finiteInteger(lineage.wordCount) ?? 0;
        const lineageCoordinateIds = new Set(
            Array.isArray(lineage.logicalChunkIds) ? lineage.logicalChunkIds : [],
        );
        const localIndexes = new Set();
        const spans = lineageSpans.map((span, spanIndex) => {
            const validSpanObject = span && typeof span === 'object';
            if (!validSpanObject || !validLineageSpan(span)
                || !lineageCoordinateIds.has(span.logicalChunkId)) invalidPart = true;
            const localIndex = finiteInteger(validSpanObject ? span.wordIndex : null);
            const compatibleIndex = localIndex !== null && localIndex < lineageWordCount
                ? localIndex
                : validSpanObject && span.wordIndex == null
                    && lineage.status === 'complete' && lineageSpans.length === lineageWordCount
                    ? spanIndex
                    : null;
            if (compatibleIndex === null || localIndexes.has(compatibleIndex)) invalidPart = true;
            else localIndexes.add(compatibleIndex);
            return compatibleIndex === null
                ? { ...(validSpanObject ? span : {}) }
                : { ...span, wordIndex: wordOffset + compatibleIndex };
        });
        wordOffset += lineageWordCount;
        if (lineage.status === 'complete') {
            const spanCoordinateIds = new Set(
                lineageSpans.filter(validLineageSpan).map((span) => span.logicalChunkId),
            );
            if (spanCoordinateIds.size !== lineageCoordinateIds.size
                || [...spanCoordinateIds].some((id) => !lineageCoordinateIds.has(id))) {
                invalidPart = true;
            }
        }
        return spans;
    });
    const indexedWords = new Set(
        wordSpans.map((span) => finiteInteger(span.wordIndex)).filter((index) => index !== null),
    );
    let completeIndexCoverage = indexedWords.size === wordCount && wordSpans.length === wordCount;
    for (let index = 0; completeIndexCoverage && index < wordCount; index++) {
        completeIndexCoverage = indexedWords.has(index);
    }
    let status = forceAmbiguous || invalidPart
        ? 'ambiguous'
        : present.every((lineage) => lineage.status === 'complete')
            && wordSpans.length === wordCount && completeIndexCoverage
            ? 'complete'
            : present.every((lineage) => lineage.status === 'missing')
                ? 'missing'
                : present.some((lineage) => lineage.status === 'ambiguous')
                    ? 'ambiguous'
                    : wordSpans.length > 0
                        ? 'partial'
                        : 'missing';
    const lastByCoordinate = new Map();
    const monotonicComposition = wordSpans.every((span) => {
        const previous = lastByCoordinate.get(span.logicalChunkId);
        const monotonic = !previous
            || (span.startSample >= previous.startSample && span.endSample >= previous.endSample);
        lastByCoordinate.set(span.logicalChunkId, span);
        return monotonic;
    });
    if (['complete', 'partial'].includes(status) && !monotonicComposition) status = 'ambiguous';
    return freezeLineage({
        version: 1,
        status,
        reason: status === 'complete'
            ? null
            : invalidPart
                ? 'invalid_lineage_part'
                : !monotonicComposition
                ? 'non_monotonic_composition'
                : reason,
        logicalChunkIds,
        wordSpans: ['complete', 'partial'].includes(status)
            ? wordSpans.map((span) => ({ ...span }))
            : [],
        wordCount,
    });
}

export function sliceSourceLineage(lineage, startWord, wordCount) {
    const start = finiteInteger(startWord);
    const count = finiteInteger(wordCount);
    if (!lineage || start === null || count === null || count === 0) {
        return missingSourceLineage('invalid_slice');
    }
    const lineageWordCount = finiteInteger(lineage.wordCount) ?? 0;
    if (start > lineageWordCount || count > lineageWordCount - start) {
        return freezeLineage({
            version: 1,
            status: lineage.status === 'missing' ? 'missing' : 'ambiguous',
            reason: 'slice_not_provable',
            logicalChunkIds: Array.isArray(lineage.logicalChunkIds)
                ? [...lineage.logicalChunkIds]
                : [],
            wordSpans: [],
            wordCount: count,
        });
    }
    const lineageSpans = Array.isArray(lineage.wordSpans) ? lineage.wordSpans : [];
    const indexedSpans = lineageSpans.map((span, spanIndex) => {
        if (!span || typeof span !== 'object') return null;
        const explicitIndex = finiteInteger(span.wordIndex);
        if (explicitIndex !== null) return { ...span, wordIndex: explicitIndex };
        if (lineage.status === 'complete' && lineageSpans.length === lineageWordCount) {
            return { ...span, wordIndex: spanIndex };
        }
        return null;
    }).filter(Boolean);
    const spans = indexedSpans
        .filter((span) => span.wordIndex >= start && span.wordIndex < start + count)
        .map((span) => ({ ...span, wordIndex: span.wordIndex - start }));
    const provenIndexes = new Set(spans.map((span) => span.wordIndex));
    const validSliceSpans = spans.every(validLineageSpan);
    const sliceLastByCoordinate = new Map();
    const monotonicSlice = spans.every((span) => {
        const previous = sliceLastByCoordinate.get(span.logicalChunkId);
        const monotonic = !previous
            || (span.startSample >= previous.startSample && span.endSample >= previous.endSample);
        sliceLastByCoordinate.set(span.logicalChunkId, span);
        return monotonic;
    });
    const fullyProvenSlice = validSliceSpans && monotonicSlice && spans.length === count
        && provenIndexes.size === count
        && Array.from({ length: count }, (_, index) => provenIndexes.has(index)).every(Boolean);
    const status = !validSliceSpans || !monotonicSlice || lineage.status === 'ambiguous'
        ? 'ambiguous'
        : fullyProvenSlice && lineage.status === 'complete'
            ? 'complete'
            : spans.length > 0
                ? 'partial'
                : 'missing';
    return freezeLineage({
        version: 1,
        status,
        reason: status === 'complete'
            ? null
            : !validSliceSpans || !monotonicSlice
                ? 'invalid_slice_spans'
                : fullyProvenSlice ? 'slice_parent_not_complete' : 'slice_partial_coverage',
        logicalChunkIds: [...new Set([
            ...(spans.map((span) => span.logicalChunkId)),
            ...(spans.length === 0 && Array.isArray(lineage.logicalChunkIds)
                ? lineage.logicalChunkIds
                : []),
        ])],
        wordSpans: ['complete', 'partial'].includes(status) ? spans : [],
        wordCount: count,
    });
}

export function projectSourceLineage(originalText, emittedText, lineage) {
    const original = sourceWords(originalText);
    const emitted = sourceWords(emittedText);
    if (emitted.length === 0) return missingSourceLineage('empty_emitted_text');
    if (original.length === emitted.length
        && original.every((word, index) => word === emitted[index])) return lineage;

    const starts = [];
    for (let start = 0; start + emitted.length <= original.length; start++) {
        if (emitted.every((word, index) => word === original[start + index])) starts.push(start);
    }
    if (starts.length === 1) return sliceSourceLineage(lineage, starts[0], emitted.length);
    return composeSourceLineages([lineage], {
        reason: starts.length > 1 ? 'emitted_text_match_not_unique' : 'emitted_text_not_contiguous',
        forceAmbiguous: lineage?.status !== 'missing',
    });
}

export function sourceLineageTelemetry(lineage) {
    const safe = lineage || missingSourceLineage();
    const rawSpans = Array.isArray(safe.wordSpans) ? safe.wordSpans : [];
    const wordSpans = rawSpans.filter(validLineageSpan);
    const rawCoordinateIds = Array.isArray(safe.logicalChunkIds) ? safe.logicalChunkIds : [];
    const coordinateIds = [...new Set(rawCoordinateIds.filter((id) => (
        typeof id === 'string' && COORDINATE_SPACE_ID.test(id)
    )))];
    const validReason = safe.reason == null
        || (typeof safe.reason === 'string' && LINEAGE_REASON_CODE.test(safe.reason));
    const invalidStructure = !Array.isArray(safe.wordSpans)
        || !Array.isArray(safe.logicalChunkIds)
        || wordSpans.length !== rawSpans.length
        || coordinateIds.length !== rawCoordinateIds.length
        || !validReason;
    const starts = wordSpans.map((span) => span.startSample);
    const ends = wordSpans.map((span) => span.endSample);
    const sourceSpans = [];
    const orderedSpans = [...wordSpans].sort((left, right) => (
        String(left.logicalChunkId).localeCompare(String(right.logicalChunkId))
        || left.startSample - right.startSample
        || left.endSample - right.endSample
    ));
    for (const span of orderedSpans) {
        const previous = sourceSpans.at(-1);
        if (previous
            && previous.logical_chunk_id === span.logicalChunkId
            && span.startSample <= previous.end_sample) {
            previous.end_sample = Math.max(previous.end_sample, span.endSample);
        } else {
            sourceSpans.push({
                logical_chunk_id: span.logicalChunkId,
                start_sample: span.startSample,
                end_sample: span.endSample,
            });
        }
    }
    return {
        source_lineage_status: invalidStructure
            ? 'ambiguous'
            : VALID_STATUSES.has(safe.status) ? safe.status : 'ambiguous',
        source_lineage_reason: invalidStructure ? 'invalid_lineage_structure' : safe.reason || null,
        logical_chunk_count: coordinateIds.length,
        logical_chunk_ids: coordinateIds,
        source_spans: sourceSpans,
        source_span_word_count: wordSpans.length,
        source_span_start_sample: starts.length ? Math.min(...starts) : null,
        source_span_end_sample: ends.length ? Math.max(...ends) : null,
    };
}

export function sourceWordCount(text) {
    return sourceWords(text).length;
}
