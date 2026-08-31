import { classifyRevisionRelation } from './revisionRelation.js';
import { isCompleteSourceMap, isCoordinateSpaceId } from './sourceMap.js';

const MAX_COMMITTED_SOURCE_RANGES = 8192;

const wholeReplacementReason = (olderMap, newerMap, relation) => {
  if (!isCompleteSourceMap(olderMap)) return 'older_source_not_complete';
  if (!isCompleteSourceMap(newerMap)) return 'newer_source_not_complete';
  if (newerMap.wordCount < olderMap.wordCount) return 'newer_source_word_count_regressed';
  if (!['same_source', 'newer_contains_older'].includes(relation.relation)) {
    return `relation_${relation.relation}`;
  }
  return 'proved_newer_covers_older';
};

export function revisionActionEligibility(olderMap, newerMap) {
  const relation = classifyRevisionRelation(olderMap, newerMap);
  const reason = wholeReplacementReason(olderMap, newerMap, relation);
  const wholeEligible = reason === 'proved_newer_covers_older';
  return Object.freeze({
    relation,
    t1DropWhole: Object.freeze({ eligible: wholeEligible, reason }),
    t2SupersedePending: Object.freeze({ eligible: wholeEligible, reason }),
  });
}

const normalizeCommittedRanges = (ranges) => {
  if (!Array.isArray(ranges) || ranges.length > MAX_COMMITTED_SOURCE_RANGES) return null;
  const normalized = [];
  for (const range of ranges) {
    const coordinateSpaceId = range?.coordinateSpaceId ?? range?.logicalChunkId ?? range?.logical_chunk_id;
    const startSample = range?.startSample ?? range?.start_sample;
    const endSample = range?.endSample ?? range?.end_sample;
    if (!isCoordinateSpaceId(coordinateSpaceId)
      || !Number.isSafeInteger(startSample) || startSample < 0
      || !Number.isSafeInteger(endSample) || endSample <= startSample) return null;
    normalized.push({ coordinateSpaceId, startSample, endSample });
  }
  normalized.sort((left, right) => left.coordinateSpaceId.localeCompare(right.coordinateSpaceId)
    || left.startSample - right.startSample || left.endSample - right.endSample);
  const byCoordinate = new Map();
  for (const range of normalized) {
    const coordinateRanges = byCoordinate.get(range.coordinateSpaceId) || [];
    const previous = coordinateRanges.at(-1);
    if (previous && range.startSample <= previous.endSample) {
      previous.endSample = Math.max(previous.endSample, range.endSample);
    } else coordinateRanges.push({ ...range });
    byCoordinate.set(range.coordinateSpaceId, coordinateRanges);
  }
  return byCoordinate;
};

const coveredByCommitted = (word, rangesByCoordinate, cursors) => {
  const ranges = rangesByCoordinate.get(word.coordinateSpaceId) || [];
  let index = cursors.get(word.coordinateSpaceId) || 0;
  while (index < ranges.length && ranges[index].endSample < word.startSample) index += 1;
  cursors.set(word.coordinateSpaceId, index);
  const range = ranges[index];
  return Boolean(range && range.startSample <= word.startSample && range.endSample >= word.endSample);
};

export function t4ResegmentationEligibility(sourceMap, committedRanges = []) {
  if (!isCompleteSourceMap(sourceMap)) {
    return Object.freeze({ eligible: false, reason: 'source_not_provable', startWord: 0 });
  }
  const committedByCoordinate = normalizeCommittedRanges(committedRanges);
  if (!committedByCoordinate) {
    return Object.freeze({ eligible: false, reason: 'committed_source_not_provable', startWord: 0 });
  }
  const byIndex = new Map(sourceMap.provenWords.map((word) => [word.wordIndex, word]));
  const committedCursors = new Map();
  let startWord = 0;
  while (startWord < sourceMap.wordCount) {
    const word = byIndex.get(startWord);
    if (!word || !coveredByCommitted(word, committedByCoordinate, committedCursors)) break;
    startWord += 1;
  }
  if (startWord === 0) {
    return Object.freeze({ eligible: false, reason: 'no_proved_committed_prefix', startWord: 0 });
  }
  let suffixComplete = true;
  for (let wordIndex = startWord; wordIndex < sourceMap.wordCount; wordIndex += 1) {
    if (!byIndex.has(wordIndex)) {
      suffixComplete = false;
      break;
    }
  }
  if (!suffixComplete) {
    return Object.freeze({ eligible: false, reason: 'residual_source_not_complete', startWord });
  }
  return Object.freeze({
    eligible: true,
    reason: startWord === sourceMap.wordCount ? 'source_fully_committed' : 'proved_residual_suffix',
    startWord,
  });
}
