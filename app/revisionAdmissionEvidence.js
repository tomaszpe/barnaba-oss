import { createHash } from 'node:crypto';
import { normalizedWords } from './emittedSourceIdentity.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const COORDINATE_SPACE_ID = /^[0-9a-f]{24}$/;
const MAX_LINEAGE_RANGES = 4096;

export const revisionIdentity = (...parts) => sha256(parts.map((part) => part ?? '').join('|')).slice(0, 24);

export const revisionWords = (text, maxWords) => normalizedWords(text).slice(0, maxWords);

export const lineageRanges = (lineage) => {
  if (!['complete', 'partial'].includes(lineage?.status)
    || !Array.isArray(lineage.wordSpans)
    || lineage.wordSpans.length > MAX_LINEAGE_RANGES) return [];
  const rawRanges = lineage.wordSpans
    .map((span) => {
      const logicalChunkId = span?.logicalChunkId ?? span?.logical_chunk_id;
      const start = span?.startSample ?? span?.start_sample;
      const end = span?.endSample ?? span?.end_sample;
      return { logicalChunkId, start, end };
    });
  if (rawRanges.some(({ logicalChunkId, start, end }) => !(
    typeof logicalChunkId === 'string' && COORDINATE_SPACE_ID.test(logicalChunkId)
      && Number.isSafeInteger(start)
      && Number.isSafeInteger(end)
      && start >= 0
      && end > start
  ))) return [];
  const ranges = rawRanges
    .sort((left, right) => left.logicalChunkId.localeCompare(right.logicalChunkId)
      || left.start - right.start
      || left.end - right.end);
  const collapsed = [];
  for (const range of ranges) {
    const previous = collapsed.at(-1);
    if (previous
      && previous.logicalChunkId === range.logicalChunkId
      && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else collapsed.push({ ...range });
  }
  return collapsed;
};

export const overlapSamples = (left, right) => {
  let leftIndex = 0;
  let rightIndex = 0;
  let total = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex];
    const b = right[rightIndex];
    if (a.logicalChunkId < b.logicalChunkId) leftIndex += 1;
    else if (a.logicalChunkId > b.logicalChunkId) rightIndex += 1;
    else {
      total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      if (a.end <= b.end) leftIndex += 1;
      if (b.end <= a.end) rightIndex += 1;
    }
  }
  return total;
};

export const longestCommonWordRun = (left, right) => {
  if (!left.length || !right.length) return 0;
  const row = new Array(right.length + 1).fill(0);
  let longest = 0;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = right.length; j >= 1; j -= 1) {
      row[j] = left[i - 1] === right[j - 1] ? row[j - 1] + 1 : 0;
      longest = Math.max(longest, row[j]);
    }
  }
  return longest;
};

const uniqueBest = (matches, scoreKey) => {
  if (!matches.length) return { match: null, ambiguous: false };
  const ordered = [...matches].sort((a, b) => b[scoreKey] - a[scoreKey] || b.family.updatedAtMs - a.family.updatedAtMs);
  if (ordered.length > 1 && ordered[0][scoreKey] === ordered[1][scoreKey]) {
    return { match: null, ambiguous: true };
  }
  return { match: ordered[0], ambiguous: false };
};

export const classifyRevisionFamily = ({ families, ranges, words, lineageStatus, minLexicalAnchorWords }) => {
  const spanMatches = families
    .map((family) => ({ family, spanOverlap: overlapSamples(family.ranges, ranges) }))
    .filter((candidate) => candidate.spanOverlap > 0);
  const spanBest = uniqueBest(spanMatches, 'spanOverlap');
  if (spanBest.ambiguous) return { evidence: 'ambiguous_span_families', scorable: false };
  if (spanBest.match) {
    return {
      family: spanBest.match.family,
      evidence: 'span_overlap',
      scorable: true,
      applyEligible: lineageStatus === 'complete' && spanBest.match.family.lineageStatus === 'complete',
      spanOverlapSamples: spanBest.match.spanOverlap,
      lexicalAnchorLength: 0,
      disjointSpans: false,
    };
  }

  const lexicalMatches = families
    .map((family) => ({
      family,
      lexicalAnchorLength: longestCommonWordRun(family.words, words),
    }))
    .filter((candidate) => candidate.lexicalAnchorLength >= minLexicalAnchorWords);
  const lexicalBest = uniqueBest(lexicalMatches, 'lexicalAnchorLength');
  if (lexicalBest.ambiguous) return { evidence: 'ambiguous_lexical_families', scorable: false };
  if (lexicalBest.match) {
    const familyHasSpans = lexicalBest.match.family.ranges.length > 0;
    const candidateHasSpans = ranges.length > 0;
    return {
      family: lexicalBest.match.family,
      evidence: familyHasSpans && candidateHasSpans
        ? 'lexical_disjoint_span_shadow_only'
        : 'lexical_shadow_only',
      scorable: true,
      applyEligible: false,
      spanOverlapSamples: 0,
      lexicalAnchorLength: lexicalBest.match.lexicalAnchorLength,
      disjointSpans: familyHasSpans && candidateHasSpans,
    };
  }
  return {
    evidence: ranges.length > 0 ? 'new_span_family' : 'new_unproven_family',
    scorable: ranges.length > 0 || words.length >= minLexicalAnchorWords,
    applyEligible: lineageStatus === 'complete' && ranges.length > 0,
    spanOverlapSamples: 0,
    lexicalAnchorLength: 0,
    disjointSpans: false,
  };
};

export const composeRevisionAdmissionTickets = (tickets, reason = 'translation_queue_merge') => {
  const inputs = tickets || [];
  const present = inputs.filter(Boolean);
  if (present.length === 0) return null;
  if (inputs.length === 1 && present.length === 1) return present[0];
  const epochs = [...new Set(present.map((ticket) => ticket.sessionEpoch).filter(Boolean))];
  return Object.freeze({
    version: 1,
    kind: 'composite',
    ticketId: revisionIdentity('composite', reason, ...present.map((ticket) => ticket.ticketId)),
    familyId: null,
    generation: null,
    evidence: 'composite_queue_merge',
    applyEligible: false,
    scorable: false,
    sessionEpoch: epochs.length === 1 ? epochs[0] : null,
    releaseSeq: null,
    sourceHash: null,
    componentCount: present.reduce((sum, ticket) => sum + (ticket.componentCount || 1), 0)
      + (inputs.length - present.length),
    sourceMapV2ShadowEnabled: present.some((ticket) => ticket.sourceMapV2ShadowEnabled === true),
    sourceMap: null,
    sourceMapV2Status: 'missing',
    sourceMapV2CoverageRatio: 0,
    revisionRelationV2: 'unproven',
    revisionRelationV2OverlapSamples: 0,
    revisionRelationV2SharedCoordinateSpaceCount: 0,
    t1DropWholeV2Eligible: false,
    t1DropWholeV2Reason: 'composite_queue_merge',
    t1RevisionRelationV2: 'unproven',
    t1RevisionSharedCoordinateSpaceCountV2: 0,
    t2SupersedePendingV2Eligible: false,
    t2SupersedePendingV2Reason: 'composite_queue_merge',
    t2RevisionRelationV2: 'unproven',
    t2RevisionSharedCoordinateSpaceCountV2: 0,
    supersedesGenerationsV2: Object.freeze([]),
    supersessionChainV2Truncated: false,
    reason,
  });
};
