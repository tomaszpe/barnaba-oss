import { sourceMapRanges } from './sourceMap.js';

const allCovered = (targets, covering) => {
  if (targets.length === 0) return false;
  let coveringIndex = 0;
  for (const target of targets) {
    while (coveringIndex < covering.length) {
      const candidate = covering[coveringIndex];
      if (candidate.coordinateSpaceId < target.coordinateSpaceId
        || (candidate.coordinateSpaceId === target.coordinateSpaceId
          && candidate.endSample < target.startSample)) {
        coveringIndex += 1;
        continue;
      }
      break;
    }
    const candidate = covering[coveringIndex];
    if (!candidate || candidate.coordinateSpaceId !== target.coordinateSpaceId
      || candidate.startSample > target.startSample
      || candidate.endSample < target.endSample) return false;
  }
  return true;
};

const overlapAndAdjacency = (olderRanges, newerRanges) => {
  let olderIndex = 0;
  let newerIndex = 0;
  let overlapSamples = 0;
  let adjacent = false;
  while (olderIndex < olderRanges.length && newerIndex < newerRanges.length) {
    const older = olderRanges[olderIndex];
    const newer = newerRanges[newerIndex];
    if (older.coordinateSpaceId < newer.coordinateSpaceId) {
      olderIndex += 1;
      continue;
    }
    if (older.coordinateSpaceId > newer.coordinateSpaceId) {
      newerIndex += 1;
      continue;
    }
    overlapSamples += Math.max(
      0,
      Math.min(older.endSample, newer.endSample) - Math.max(older.startSample, newer.startSample),
    );
    adjacent ||= older.endSample === newer.startSample || newer.endSample === older.startSample;
    if (older.endSample <= newer.endSample) olderIndex += 1;
    if (newer.endSample <= older.endSample) newerIndex += 1;
  }
  return { overlapSamples, adjacent };
};

export function classifyRevisionRelation(olderMap, newerMap) {
  if (olderMap?.status === 'ambiguous' || newerMap?.status === 'ambiguous') {
    return Object.freeze({
      relation: 'ambiguous', overlapSamples: 0, olderCovered: false, newerCovered: false,
      sharedCoordinateSpaceCount: 0,
    });
  }
  const olderRanges = sourceMapRanges(olderMap);
  const newerRanges = sourceMapRanges(newerMap);
  if (!olderRanges.length || !newerRanges.length) {
    return Object.freeze({
      relation: 'unproven', overlapSamples: 0, olderCovered: false, newerCovered: false,
      sharedCoordinateSpaceCount: 0,
    });
  }

  const olderCoordinates = new Set(olderRanges.map((range) => range.coordinateSpaceId));
  const sharedCoordinateSpaceCount = new Set(
    newerRanges.map((range) => range.coordinateSpaceId)
      .filter((coordinate) => olderCoordinates.has(coordinate)),
  ).size;
  const { overlapSamples, adjacent } = overlapAndAdjacency(olderRanges, newerRanges);
  const olderCovered = allCovered(olderRanges, newerRanges);
  const newerCovered = allCovered(newerRanges, olderRanges);
  const relation = overlapSamples > 0
    ? olderCovered && newerCovered
      ? 'same_source'
      : olderCovered
        ? 'newer_contains_older'
        : 'partial_overlap'
    : adjacent ? 'adjacent' : 'disjoint';
  return Object.freeze({
    relation, overlapSamples, olderCovered, newerCovered, sharedCoordinateSpaceCount,
  });
}
