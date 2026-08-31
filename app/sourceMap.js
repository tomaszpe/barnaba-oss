const VALID_STATUSES = new Set(['complete', 'partial', 'ambiguous', 'missing']);
export const MAX_SOURCE_MAP_WORDS = 4096;
const REASON_CODE = /^[a-z0-9_]{1,64}$/;
const COORDINATE_SPACE_ID = /^[0-9a-f]{24}$/;

const safeIndex = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeSample = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const isCoordinateSpaceId = (value) => (
  typeof value === 'string' && COORDINATE_SPACE_ID.test(value)
);

const freezeMap = (map) => {
  for (const word of map.provenWords) Object.freeze(word);
  Object.freeze(map.provenWords);
  Object.freeze(map.coordinateSpaceIds);
  Object.freeze(map.reasonCodes);
  Object.freeze(map.coverage);
  return Object.freeze(map);
};

export function sourceMapFromLineage(lineage, { expectedWordCount = null } = {}) {
  const rawWordCount = lineage == null ? 0 : safeIndex(lineage.wordCount);
  const validWordCount = rawWordCount !== null && rawWordCount <= MAX_SOURCE_MAP_WORDS;
  const wordCount = validWordCount ? rawWordCount : 0;
  const declaredStatus = VALID_STATUSES.has(lineage?.status)
    ? lineage.status
    : lineage == null ? 'missing' : 'ambiguous';
  const sourceStatus = validWordCount ? declaredStatus : 'ambiguous';
  const reasons = new Set();
  if (lineage?.reason != null) {
    if (typeof lineage.reason === 'string' && REASON_CODE.test(lineage.reason)) {
      reasons.add(lineage.reason);
    } else reasons.add('invalid_reason_code');
  }
  if (!validWordCount) reasons.add('invalid_word_count');
  const validExpectedWordCount = expectedWordCount === null
    || (safeIndex(expectedWordCount) !== null && expectedWordCount <= MAX_SOURCE_MAP_WORDS);
  if (!validExpectedWordCount) reasons.add('invalid_expected_word_count');
  const expectedWordCountMismatch = validExpectedWordCount
    && expectedWordCount !== null && expectedWordCount !== wordCount;
  if (expectedWordCountMismatch) reasons.add('expected_word_count_mismatch');
  const rawSpans = Array.isArray(lineage?.wordSpans) ? lineage.wordSpans : [];
  if (lineage?.wordSpans != null && !Array.isArray(lineage.wordSpans)) {
    reasons.add('invalid_word_spans_container');
  }
  const spansTrustedByStatus = ['complete', 'partial'].includes(sourceStatus);
  if (!spansTrustedByStatus && rawSpans.length > 0) reasons.add('untrusted_spans_for_status');
  if (rawSpans.length > MAX_SOURCE_MAP_WORDS) reasons.add('too_many_word_spans');
  const canInferIndexes = sourceStatus === 'complete'
    && rawSpans.length === wordCount;
  const byIndex = new Map();

  const spansToInspect = spansTrustedByStatus
    ? rawSpans.slice(0, MAX_SOURCE_MAP_WORDS)
    : [];
  for (const [spanIndex, span] of spansToInspect.entries()) {
    const wordIndex = safeIndex(span?.wordIndex) ?? (canInferIndexes ? spanIndex : null);
    const rawCoordinateSpaceId = span?.logicalChunkId ?? span?.logical_chunk_id;
    const coordinateSpaceId = isCoordinateSpaceId(rawCoordinateSpaceId)
      ? rawCoordinateSpaceId
      : '';
    const startSample = safeSample(span?.startSample ?? span?.start_sample);
    const endSample = safeSample(span?.endSample ?? span?.end_sample);
    if (wordIndex === null || wordIndex >= wordCount || !coordinateSpaceId
      || startSample === null || endSample === null || endSample <= startSample) {
      reasons.add('invalid_or_unindexed_word_span');
      continue;
    }
    if (byIndex.has(wordIndex)) {
      reasons.add('duplicate_word_index');
      byIndex.delete(wordIndex);
      continue;
    }
    byIndex.set(wordIndex, { wordIndex, coordinateSpaceId, startSample, endSample });
  }

  const provenWords = [...byIndex.values()].sort((left, right) => left.wordIndex - right.wordIndex);
  const lastByCoordinate = new Map();
  let monotonic = true;
  for (const word of provenWords) {
    const previous = lastByCoordinate.get(word.coordinateSpaceId);
    if (previous && (word.startSample < previous.startSample || word.endSample < previous.endSample)) {
      monotonic = false;
      break;
    }
    lastByCoordinate.set(word.coordinateSpaceId, word);
  }
  if (!monotonic) reasons.add('non_monotonic_word_spans');
  const rawCoordinateSpaceIds = Array.isArray(lineage?.logicalChunkIds)
    ? lineage.logicalChunkIds.slice(0, MAX_SOURCE_MAP_WORDS)
    : [];
  if (lineage?.logicalChunkIds != null && !Array.isArray(lineage.logicalChunkIds)) {
    reasons.add('invalid_coordinate_spaces_container');
  }
  if (Array.isArray(lineage?.logicalChunkIds)
    && lineage.logicalChunkIds.length > MAX_SOURCE_MAP_WORDS) {
    reasons.add('too_many_coordinate_spaces');
  }
  if (rawCoordinateSpaceIds.some((id) => !isCoordinateSpaceId(id))) {
    reasons.add('invalid_coordinate_space_id');
  }
  const validDeclaredCoordinateSpaceIds = rawCoordinateSpaceIds.filter(isCoordinateSpaceId);
  if (new Set(validDeclaredCoordinateSpaceIds).size !== validDeclaredCoordinateSpaceIds.length) {
    reasons.add('duplicate_coordinate_space_id');
  }
  const provenCoordinateSpaceIds = [...new Set(
    provenWords.map((word) => word.coordinateSpaceId),
  )].sort();
  const declaredCoordinateSpaceIds = [...new Set(validDeclaredCoordinateSpaceIds)].sort();
  if (sourceStatus === 'complete' && declaredCoordinateSpaceIds.length > 0
    && (declaredCoordinateSpaceIds.length !== provenCoordinateSpaceIds.length
      || declaredCoordinateSpaceIds.some((id, index) => id !== provenCoordinateSpaceIds[index]))) {
    reasons.add('coordinate_space_coverage_mismatch');
  }
  const coordinateSpaceIds = [...new Set([
    ...declaredCoordinateSpaceIds,
    ...provenCoordinateSpaceIds,
  ])].sort();
  const provenWordCount = provenWords.length;
  const structurallyAmbiguous = sourceStatus === 'ambiguous'
    || reasons.has('duplicate_word_index')
    || reasons.has('non_monotonic_word_spans')
    || reasons.has('invalid_word_spans_container')
    || reasons.has('invalid_or_unindexed_word_span')
    || reasons.has('too_many_word_spans')
    || reasons.has('invalid_coordinate_spaces_container')
    || reasons.has('invalid_coordinate_space_id')
    || reasons.has('duplicate_coordinate_space_id')
    || reasons.has('coordinate_space_coverage_mismatch')
    || reasons.has('too_many_coordinate_spaces')
    || !validExpectedWordCount
    || (expectedWordCountMismatch && ['complete', 'partial'].includes(sourceStatus));
  let status;
  if (structurallyAmbiguous) status = 'ambiguous';
  else if (sourceStatus === 'missing') status = 'missing';
  else if (sourceStatus === 'complete' && provenWordCount !== wordCount) status = 'ambiguous';
  else if (provenWordCount === wordCount && wordCount > 0) status = 'complete';
  else if (provenWordCount > 0) status = 'partial';
  else status = 'missing';
  if (sourceStatus === 'complete' && provenWordCount !== wordCount) {
    reasons.add('complete_coverage_mismatch');
  }
  if (sourceStatus === 'partial' && provenWordCount === 0) {
    reasons.add('no_proven_words');
  }

  return freezeMap({
    version: 2,
    status,
    coordinateSpaceIds,
    wordCount,
    provenWords,
    coverage: {
      provenWordCount,
      unprovenWordCount: Math.max(0, wordCount - provenWordCount),
      ratio: wordCount > 0 ? provenWordCount / wordCount : 0,
    },
    reasonCodes: [...reasons].sort(),
  });
}

export function sourceMapTelemetry(sourceMap) {
  const map = sourceMap || sourceMapFromLineage(null);
  const rawWordCount = safeIndex(map?.wordCount);
  const rawProvenWordCount = safeIndex(map?.coverage?.provenWordCount);
  const rawUnprovenWordCount = safeIndex(map?.coverage?.unprovenWordCount);
  const rawRatio = map?.coverage?.ratio;
  const validCoverage = rawWordCount !== null && rawWordCount <= MAX_SOURCE_MAP_WORDS
    && rawProvenWordCount !== null && rawProvenWordCount <= rawWordCount
    && rawUnprovenWordCount === rawWordCount - rawProvenWordCount
    && typeof rawRatio === 'number' && Number.isFinite(rawRatio)
    && rawRatio === (rawWordCount > 0 ? rawProvenWordCount / rawWordCount : 0);
  const wordCount = validCoverage ? rawWordCount : 0;
  const provenWordCount = validCoverage ? rawProvenWordCount : 0;
  const ratio = validCoverage ? rawRatio : 0;
  const rawCoordinateSpaceIds = Array.isArray(map?.coordinateSpaceIds)
    ? map.coordinateSpaceIds
    : null;
  const validCoordinateSpaceIds = rawCoordinateSpaceIds
    ? rawCoordinateSpaceIds.filter(isCoordinateSpaceId)
    : [];
  const uniqueCoordinateSpaceIds = [...new Set(validCoordinateSpaceIds)];
  const invalidCoordinateSpaceIds = !rawCoordinateSpaceIds
    || validCoordinateSpaceIds.length !== rawCoordinateSpaceIds.length
    || uniqueCoordinateSpaceIds.length !== validCoordinateSpaceIds.length;
  const rawReasonCodes = Array.isArray(map?.reasonCodes) ? map.reasonCodes : null;
  const validReasonCodes = rawReasonCodes
    ? rawReasonCodes.filter((reason) => typeof reason === 'string' && REASON_CODE.test(reason))
    : [];
  const invalidReasonCodes = !rawReasonCodes
    || rawReasonCodes.length > 16
    || validReasonCodes.length !== rawReasonCodes.length;
  const reasonMarkers = [];
  if (invalidReasonCodes) reasonMarkers.push('invalid_source_map_reason_codes');
  if (invalidCoordinateSpaceIds) reasonMarkers.push('invalid_source_map_coordinate_spaces');
  if (!validCoverage) reasonMarkers.push('invalid_source_map_coverage');
  const safeReasonCodes = [
    ...validReasonCodes.slice(0, 16 - reasonMarkers.length),
    ...reasonMarkers,
  ];
  const telemetryStatus = reasonMarkers.length > 0
    ? 'ambiguous'
    : VALID_STATUSES.has(map?.status) ? map.status : 'ambiguous';
  return {
    source_map_v2_status: telemetryStatus,
    source_map_v2_word_count: wordCount,
    source_map_v2_proven_word_count: provenWordCount,
    source_map_v2_coverage_ratio: Number(ratio.toFixed(4)),
    source_map_v2_coordinate_space_count: uniqueCoordinateSpaceIds.length,
    source_map_v2_coordinate_space_ids: uniqueCoordinateSpaceIds.slice(0, 16),
    source_map_v2_reason_codes: safeReasonCodes,
  };
}

export function sourceMapRanges(sourceMap) {
  if (!['complete', 'partial'].includes(sourceMap?.status)
    || !Array.isArray(sourceMap?.provenWords)
    || sourceMap.provenWords.length > MAX_SOURCE_MAP_WORDS) return [];
  const ordered = sourceMap.provenWords
    .filter((word) => word && isCoordinateSpaceId(word.coordinateSpaceId)
      && Number.isSafeInteger(word.startSample) && Number.isSafeInteger(word.endSample)
      && word.startSample >= 0 && word.endSample > word.startSample)
    .map((word) => ({
      coordinateSpaceId: word.coordinateSpaceId,
      startSample: word.startSample,
      endSample: word.endSample,
    }))
    .sort((left, right) => left.coordinateSpaceId.localeCompare(right.coordinateSpaceId)
      || left.startSample - right.startSample || left.endSample - right.endSample);
  const collapsed = [];
  for (const range of ordered) {
    const previous = collapsed.at(-1);
    if (previous && previous.coordinateSpaceId === range.coordinateSpaceId
      && range.startSample <= previous.endSample) {
      previous.endSample = Math.max(previous.endSample, range.endSample);
    } else collapsed.push({ ...range });
  }
  return collapsed;
}

export function isCompleteSourceMap(sourceMap) {
  if (sourceMap?.version !== 2 || sourceMap.status !== 'complete'
    || !Number.isSafeInteger(sourceMap.wordCount)
    || sourceMap.wordCount <= 0 || sourceMap.wordCount > MAX_SOURCE_MAP_WORDS
    || !Array.isArray(sourceMap.provenWords)
    || sourceMap.provenWords.length !== sourceMap.wordCount
    || sourceMap.coverage?.provenWordCount !== sourceMap.wordCount
    || sourceMap.coverage?.unprovenWordCount !== 0
    || sourceMap.coverage?.ratio !== 1
    || !Array.isArray(sourceMap.coordinateSpaceIds)
    || sourceMap.coordinateSpaceIds.length === 0
    || sourceMap.coordinateSpaceIds.length > MAX_SOURCE_MAP_WORDS
    || new Set(sourceMap.coordinateSpaceIds).size !== sourceMap.coordinateSpaceIds.length
    || sourceMap.coordinateSpaceIds.some((id) => !isCoordinateSpaceId(id))
    || !Array.isArray(sourceMap.reasonCodes)
    || sourceMap.reasonCodes.length > 16
    || sourceMap.reasonCodes.some((reason) => (
      typeof reason !== 'string' || !REASON_CODE.test(reason)
    ))) return false;

  const seenIndexes = new Set();
  const lastByCoordinate = new Map();
  for (const [position, word] of sourceMap.provenWords.entries()) {
    if (!word || !Number.isSafeInteger(word.wordIndex)
      || word.wordIndex !== position
      || seenIndexes.has(word.wordIndex)
      || !isCoordinateSpaceId(word.coordinateSpaceId)
      || !Number.isSafeInteger(word.startSample) || word.startSample < 0
      || !Number.isSafeInteger(word.endSample) || word.endSample <= word.startSample) return false;
    const previous = lastByCoordinate.get(word.coordinateSpaceId);
    if (previous && (word.startSample < previous.startSample || word.endSample < previous.endSample)) {
      return false;
    }
    seenIndexes.add(word.wordIndex);
    lastByCoordinate.set(word.coordinateSpaceId, word);
  }
  if (seenIndexes.size !== sourceMap.wordCount) return false;
  for (let index = 0; index < sourceMap.wordCount; index += 1) {
    if (!seenIndexes.has(index)) return false;
  }
  const provenCoordinateSpaceIds = [...lastByCoordinate.keys()].sort();
  const declaredCoordinateSpaceIds = [...sourceMap.coordinateSpaceIds].sort();
  if (provenCoordinateSpaceIds.length !== declaredCoordinateSpaceIds.length
    || provenCoordinateSpaceIds.some((id, index) => id !== declaredCoordinateSpaceIds[index])) {
    return false;
  }
  return true;
}
