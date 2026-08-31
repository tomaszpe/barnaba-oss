import { describe, expect, it } from 'vitest';
import { composeSourceLineages, sliceSourceLineage } from '../sourceLineage.js';
import {
  MAX_SOURCE_MAP_WORDS,
  sourceMapFromLineage,
  sourceMapRanges,
  sourceMapTelemetry,
} from '../sourceMap.js';
import { classifyRevisionRelation } from '../revisionRelation.js';
import {
  revisionActionEligibility,
  t4ResegmentationEligibility,
} from '../revisionActionEligibility.js';

const AUDIO_A = 'a'.repeat(24);
const AUDIO_B = 'b'.repeat(24);

const lineage = ({
  status = 'complete',
  coordinate = AUDIO_A,
  starts = [0, 100, 200],
  wordCount = starts.length,
  wordIndexes = starts.map((_, index) => index),
  reason = null,
} = {}) => ({
  version: 1,
  status,
  reason,
  logicalChunkIds: [coordinate],
  wordCount,
  wordSpans: starts.map((startSample, index) => ({
    wordIndex: wordIndexes[index],
    logicalChunkId: coordinate,
    startSample,
    endSample: startSample + 80,
  })),
});

describe('FQF SourceMap V2', () => {
  it('represents absent lineage as missing rather than malformed proof', () => {
    expect(sourceMapFromLineage(null)).toMatchObject({
      status: 'missing', wordCount: 0, provenWords: [], reasonCodes: [],
    });
  });

  it('preserves explicit word indexes through partial composition and slicing', () => {
    const partial = composeSourceLineages([
      lineage({ starts: [0, 100] }),
      { status: 'missing', reason: 'not_observed', logicalChunkIds: [], wordSpans: [], wordCount: 1 },
      lineage({ starts: [300, 400] }),
    ]);

    expect(partial).toMatchObject({ status: 'partial', wordCount: 5 });
    expect(partial.wordSpans.map((span) => span.wordIndex)).toEqual([0, 1, 3, 4]);
    const tail = sliceSourceLineage(partial, 3, 2);
    expect(tail).toMatchObject({ status: 'partial', wordCount: 2 });
    expect(tail.wordSpans.map((span) => span.wordIndex)).toEqual([0, 1]);
    expect(sourceMapFromLineage(tail)).toMatchObject({
      status: 'complete',
      coverage: { provenWordCount: 2, unprovenWordCount: 0, ratio: 1 },
    });
  });

  it('reports text-free exact coverage and rejects duplicate word indexes', () => {
    const complete = sourceMapFromLineage(lineage());
    const ambiguous = sourceMapFromLineage(lineage({ wordIndexes: [0, 0, 2] }));

    expect(complete).toMatchObject({
      version: 2,
      status: 'complete',
      coverage: { provenWordCount: 3, unprovenWordCount: 0, ratio: 1 },
    });
    expect(sourceMapTelemetry(complete)).toMatchObject({
      source_map_v2_status: 'complete',
      source_map_v2_proven_word_count: 3,
      source_map_v2_coverage_ratio: 1,
    });
    expect(ambiguous).toMatchObject({ status: 'ambiguous' });
    expect(JSON.stringify(complete)).not.toMatch(/text|translation|sermon/i);
  });

  it('never promotes spans carried by missing or non-monotonic lineage', () => {
    const missingWithSpans = sourceMapFromLineage(lineage({ status: 'missing' }));
    const nonMonotonic = sourceMapFromLineage(lineage({ starts: [200, 100, 300] }));

    expect(missingWithSpans).toMatchObject({
      status: 'missing',
      provenWords: [],
      reasonCodes: expect.arrayContaining(['untrusted_spans_for_status']),
    });
    expect(nonMonotonic).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['non_monotonic_word_spans']),
    });
    expect(sourceMapRanges(missingWithSpans)).toEqual([]);
    expect(sourceMapRanges(nonMonotonic)).toEqual([]);
  });

  it('rejects descriptive coordinate identities before they can reach telemetry', () => {
    const map = sourceMapFromLineage(lineage({ coordinate: 'sermon-fragment' }));
    const telemetry = sourceMapTelemetry(map);
    expect(map.status).toBe('ambiguous');
    expect(telemetry.source_map_v2_coordinate_space_ids).toEqual([]);
    expect(JSON.stringify(telemetry)).not.toContain('sermon-fragment');
  });

  it('rejects lineage whose word count does not match the emitted source text', () => {
    expect(sourceMapFromLineage(lineage(), { expectedWordCount: 99 })).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['expected_word_count_mismatch']),
    });
  });

  it('fails closed on malformed containers and unreasonable word counts', () => {
    expect(sourceMapFromLineage({
      status: 'complete', wordCount: 1, wordSpans: {}, logicalChunkIds: [],
    })).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['invalid_word_spans_container']),
    });
    expect(sourceMapFromLineage({
      status: 'complete', wordCount: MAX_SOURCE_MAP_WORDS + 1, wordSpans: [], logicalChunkIds: [],
    })).toMatchObject({
      status: 'ambiguous',
      wordCount: 0,
      reasonCodes: expect.arrayContaining(['invalid_word_count']),
    });
    expect(sourceMapRanges({ status: 'complete', provenWords: null })).toEqual([]);
    expect(sourceMapFromLineage({
      ...lineage({ starts: [0] }),
      status: 'partial',
      wordSpans: [
        ...lineage({ starts: [0] }).wordSpans,
        { wordIndex: 99, logicalChunkId: AUDIO_A, startSample: 100, endSample: 180 },
      ],
    })).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['invalid_or_unindexed_word_span']),
    });
    expect(sourceMapFromLineage({
      ...lineage({ starts: [0] }),
      logicalChunkIds: [AUDIO_A, AUDIO_A],
    })).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['duplicate_coordinate_space_id']),
    });
    expect(sourceMapFromLineage({
      ...lineage({ starts: [0] }),
      logicalChunkIds: [AUDIO_A, AUDIO_B],
    })).toMatchObject({
      status: 'ambiguous',
      reasonCodes: expect.arrayContaining(['coordinate_space_coverage_mismatch']),
    });
  });

  it('marks malformed telemetry ambiguous instead of preserving a forged complete status', () => {
    const map = sourceMapFromLineage(lineage());
    expect(sourceMapTelemetry({
      ...map,
      coverage: { provenWordCount: 999, unprovenWordCount: 0, ratio: 1 },
    })).toMatchObject({
      source_map_v2_status: 'ambiguous',
      source_map_v2_reason_codes: expect.arrayContaining(['invalid_source_map_coverage']),
    });
  });
});

describe('FQF RevisionRelation and stage eligibility', () => {
  it.each([
    [[0, 100], [0, 100], 'same_source'],
    [[100, 200], [0, 100, 200, 300], 'newer_contains_older'],
    [[0, 100, 200], [200, 300], 'partial_overlap'],
    [[0], [80], 'adjacent'],
    [[0], [200], 'disjoint'],
  ])('classifies %j against %j as %s', (olderStarts, newerStarts, expected) => {
    const older = sourceMapFromLineage(lineage({ starts: olderStarts }));
    const newer = sourceMapFromLineage(lineage({ starts: newerStarts }));
    expect(classifyRevisionRelation(older, newer).relation).toBe(expected);
  });

  it('never treats equal offsets from different audio sessions as a revision', () => {
    const older = sourceMapFromLineage(lineage({ coordinate: AUDIO_A }));
    const newer = sourceMapFromLineage(lineage({ coordinate: AUDIO_B }));
    const result = revisionActionEligibility(older, newer);
    expect(result.relation.relation).toBe('disjoint');
    expect(result.t1DropWhole.eligible).toBe(false);
    expect(result.t2SupersedePending.eligible).toBe(false);
  });

  it('requires complete containment for whole T1/T2 replacement', () => {
    const older = sourceMapFromLineage(lineage({ starts: [100, 200] }));
    const containing = sourceMapFromLineage(lineage({ starts: [0, 100, 200, 300] }));
    const overlapping = sourceMapFromLineage(lineage({ starts: [200, 300] }));

    expect(revisionActionEligibility(older, containing).t1DropWhole.eligible).toBe(true);
    expect(revisionActionEligibility(older, overlapping).t1DropWhole).toMatchObject({
      eligible: false,
      reason: 'relation_partial_overlap',
    });

    const forgedComplete = {
      ...containing,
      provenWords: containing.provenWords.map((word) => ({ ...word, wordIndex: 0 })),
    };
    expect(revisionActionEligibility(older, forgedComplete).t1DropWhole).toMatchObject({
      eligible: false,
      reason: 'newer_source_not_complete',
    });

    const forgedCoordinates = { ...containing, coordinateSpaceIds: [AUDIO_B] };
    expect(revisionActionEligibility(older, forgedCoordinates).t2SupersedePending).toMatchObject({
      eligible: false,
      reason: 'newer_source_not_complete',
    });

    const fewerWordsOverSameAudio = {
      version: 2,
      status: 'complete',
      coordinateSpaceIds: [AUDIO_A],
      wordCount: 1,
      provenWords: [{
        wordIndex: 0, coordinateSpaceId: AUDIO_A, startSample: 100, endSample: 280,
      }],
      coverage: { provenWordCount: 1, unprovenWordCount: 0, ratio: 1 },
      reasonCodes: [],
    };
    expect(revisionActionEligibility(older, fewerWordsOverSameAudio).t1DropWhole).toMatchObject({
      eligible: false,
      reason: 'newer_source_word_count_regressed',
    });
  });

  it('allows T4 only after a proved committed prefix and a fully proved residual', () => {
    const complete = sourceMapFromLineage(lineage({ starts: [0, 100, 200, 300] }));
    const committed = [{ logicalChunkId: AUDIO_A, startSample: 0, endSample: 180 }];
    expect(t4ResegmentationEligibility(complete, committed)).toMatchObject({
      eligible: true,
      reason: 'proved_residual_suffix',
      startWord: 2,
    });

    const partial = sourceMapFromLineage(lineage({
      status: 'partial', starts: [0, 100, 300], wordCount: 4, wordIndexes: [0, 1, 3],
    }));
    expect(t4ResegmentationEligibility(partial, committed)).toMatchObject({
      eligible: false,
      reason: 'source_not_provable',
      startWord: 0,
    });
    expect(t4ResegmentationEligibility(complete, null)).toMatchObject({
      eligible: false,
      reason: 'committed_source_not_provable',
    });
    expect(t4ResegmentationEligibility({
      ...complete,
      coverage: { provenWordCount: 0, unprovenWordCount: complete.wordCount, ratio: 0 },
    }, committed)).toMatchObject({ eligible: false, reason: 'source_not_provable' });
  });
});
