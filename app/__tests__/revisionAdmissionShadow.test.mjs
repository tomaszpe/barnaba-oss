import { describe, expect, it, vi } from 'vitest';
import { composeRevisionAdmissionTickets } from '../revisionAdmissionEvidence.js';
import {
  DEFAULT_REVISION_ADMISSION_CONFIG,
  RevisionAdmissionShadow,
} from '../revisionAdmissionShadow.js';

const AUDIO_A = 'a'.repeat(24);
const AUDIO_B = 'b'.repeat(24);

const lineage = (start, end, status = 'complete', logicalChunkId = AUDIO_A) => ({
  status,
  wordCount: 1,
  logicalChunkIds: [logicalChunkId],
  wordSpans: [{ wordIndex: 0, logicalChunkId, startSample: start, endSample: end }],
});

const meta = (seq, start, end, overrides = {}) => ({
  sessionEpoch: 'epoch-1',
  releaseSeq: seq,
  sourceHash: `hash-${seq}`,
  sourceLineage: lineage(start, end),
  ...overrides,
});

const v2Meta = (seq, start, end, text) => {
  const wordCount = text.trim().split(/\s+/).length;
  const sourceLineage = {
    status: 'complete',
    wordCount,
    logicalChunkIds: [AUDIO_A],
    wordSpans: Array.from({ length: wordCount }, (_, wordIndex) => ({
      wordIndex,
      logicalChunkId: AUDIO_A,
      startSample: Math.floor(start + ((end - start) * wordIndex) / wordCount),
      endSample: Math.floor(start + ((end - start) * (wordIndex + 1)) / wordCount),
    })),
  };
  return meta(seq, start, end, { sourceLineage });
};

const createLedger = (overrides = {}) => {
  const events = [];
  const ledger = new RevisionAdmissionShadow({
    config: { ...DEFAULT_REVISION_ADMISSION_CONFIG, enabled: true, ...overrides },
    logFn: (event) => events.push(event),
    now: () => 10_000,
  });
  return { ledger, events };
};

describe('T1 revision admission shadow', () => {
  it('is OFF and side-effect free by default', () => {
    const logFn = vi.fn();
    const ledger = new RevisionAdmissionShadow({ logFn });
    expect(ledger.enabled).toBe(false);
    expect(ledger.registerAccepted({ churchId: 'church', text: 'eins zwei', releaseMeta: meta(1, 0, 100) })).toBeNull();
    expect(logFn).not.toHaveBeenCalled();
  });

  it('fails closed on invalid configuration while the live path stays open', () => {
    const ledger = new RevisionAdmissionShadow({ config: { enabled: true, minLexicalAnchorWords: 0 } });
    expect(ledger.enabled).toBe(false);
    expect(ledger.configErrors).toContain('minLexicalAnchorWords must be a positive integer');
  });

  it('assigns one family and monotonic generations to overlapping source spans', () => {
    const { ledger, events } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'Alpha beta gamma delta', releaseMeta: meta(1, 0, 1000) });
    ledger.observeCheckpoint({ churchId: 'church', ticket: first, language: 'pl' });
    const second = ledger.registerAccepted({ churchId: 'church', text: 'Gamma delta epsilon zeta', releaseMeta: meta(2, 600, 1500) });

    expect(second.familyId).toBe(first.familyId);
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(second.evidence).toBe('span_overlap');
    expect(second.applyEligible).toBe(true);
    expect(events[2]).toMatchObject({
      phase: 'accepted_enqueue',
      family_state: 'active_plus_pending',
      active_generation: 1,
      pending_generation: 2,
      span_overlap_samples: 400,
    });
  });

  it('never treats equal local sample offsets from different logical audio chunks as overlap', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({
      churchId: 'church',
      text: 'Alpha beta gamma delta',
      releaseMeta: meta(1, 0, 1000, {
        sourceLineage: lineage(0, 1000, 'complete', AUDIO_A),
      }),
    });
    const second = ledger.registerAccepted({
      churchId: 'church',
      text: 'Epsilon zeta eta theta',
      releaseMeta: meta(2, 0, 1000, {
        sourceLineage: lineage(0, 1000, 'complete', AUDIO_B),
      }),
    });

    expect(second.familyId).not.toBe(first.familyId);
    expect(second.evidence).toBe('new_span_family');
    expect(second.generation).toBe(1);
  });

  it('recognizes an interior lexical anchor in shadow but never makes it APPLY-eligible', () => {
    const { ledger, events } = createLedger();
    const first = ledger.registerAccepted({
      churchId: 'church',
      text: 'Heute alpha beta gamma delta endet hier',
      releaseMeta: meta(1, 0, 500),
    });
    const second = ledger.registerAccepted({
      churchId: 'church',
      text: 'Neu alpha beta gamma delta mit Fortsetzung',
      releaseMeta: meta(2, 2000, 2600),
    });

    expect(second.familyId).toBe(first.familyId);
    expect(second.evidence).toBe('lexical_disjoint_span_shadow_only');
    expect(second.applyEligible).toBe(false);
    expect(events[1]).toMatchObject({
      lexical_anchor_length: 4,
      disjoint_span_lexical_match: true,
    });
  });

  it('does not treat a tolerated one-or-two-word prefix as a revision family', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({
      churchId: 'church',
      text: 'Darum gehen wir heute gemeinsam weiter',
      releaseMeta: meta(1, 0, 500),
    });
    const second = ledger.registerAccepted({
      churchId: 'church',
      text: 'Darum gehen andere Menschen nach Hause',
      releaseMeta: meta(2, 1000, 1500),
    });

    expect(second.familyId).not.toBe(first.familyId);
    expect(second.evidence).toBe('new_span_family');
  });

  it('keeps disjoint source ranges in independent FIFO families without a lexical anchor', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier', releaseMeta: meta(1, 0, 500) });
    const second = ledger.registerAccepted({ churchId: 'church', text: 'fuenf sechs sieben acht', releaseMeta: meta(2, 1000, 1500) });
    expect(second.familyId).not.toBe(first.familyId);
    expect(second.generation).toBe(1);
    expect(ledger.isCurrent(first).decision).toBe('emit_whole');
    expect(ledger.isCurrent(second).decision).toBe('emit_whole');
  });

  it('keeps one active and only the latest pending generation', () => {
    const { ledger, events } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'a b c d', releaseMeta: meta(1, 0, 1000) });
    ledger.observeCheckpoint({ churchId: 'church', ticket: first, language: 'pl' });
    const second = ledger.registerAccepted({ churchId: 'church', text: 'a b c d e', releaseMeta: meta(2, 0, 1100) });
    const third = ledger.registerAccepted({ churchId: 'church', text: 'a b c d e f', releaseMeta: meta(3, 0, 1200) });

    expect(ledger.isCurrent(first)).toMatchObject({ decision: 'emit_whole', currentGeneration: 1 });
    expect(ledger.isCurrent(second)).toMatchObject({ decision: 'would_drop_whole', currentGeneration: 3 });
    expect(ledger.isCurrent(third)).toMatchObject({ decision: 'emit_whole', currentGeneration: 3 });
    expect(events[3]).toMatchObject({
      active_generation: 1,
      pending_generation: 3,
      replaced_pending_generation: 2,
    });
    expect(ledger.observeCheckpoint({ churchId: 'church', ticket: third, language: 'pl' }).shadow_decision).toBe('emit_whole');
    ledger.registerAccepted({ churchId: 'church', text: 'a b c d e f g', releaseMeta: meta(4, 0, 1300) });
    expect(events.at(-1)).toMatchObject({
      active_generation: 3,
      pending_generation: 4,
      replaced_pending_generation: null,
    });
  });

  it('latches one whole-variant decision across language checkpoints', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'a b c d', releaseMeta: meta(1, 0, 1000) });
    expect(ledger.observeCheckpoint({ churchId: 'church', ticket: first, language: 'pl' }).shadow_decision).toBe('emit_whole');
    ledger.registerAccepted({ churchId: 'church', text: 'a b c d e', releaseMeta: meta(2, 0, 1100) });
    expect(ledger.observeCheckpoint({ churchId: 'church', ticket: first, language: 'de' })).toMatchObject({
      shadow_decision: 'emit_whole',
      current_generation: 1,
    });
  });

  it('logs a pre-TTS decision without sermon or translation text', () => {
    const { ledger, events } = createLedger();
    const secret = 'TAJNY TEKST KAZANIA';
    const ticket = ledger.registerAccepted({ churchId: 'church', text: secret, releaseMeta: meta(1, 0, 1000) });
    const event = ledger.observeCheckpoint({ churchId: 'church', ticket, language: 'pl', emissionId: 17 });
    const serialized = JSON.stringify(event);

    expect(event).toMatchObject({
      phase: 'accepted_output_pre_tts',
      policy_applied: false,
      shadow_decision: 'emit_whole',
      language: 'pl',
      emissionId: 17,
    });
    expect(serialized).not.toContain(secret);
    expect(Object.keys(event).some((key) => ['text', 'translation', 'src'].includes(key))).toBe(false);
    expect(events).toHaveLength(2);
  });

  it('fails open and reports unscorable when accepted identity is missing', () => {
    const { ledger } = createLedger();
    const ticket = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier', releaseMeta: {} });
    expect(ticket.kind).toBe('unscorable');
    expect(ledger.observeCheckpoint({ churchId: 'church', ticket }).shadow_decision).toBe('unscorable');
  });

  it('resets families on epoch change instead of mixing sessions', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier', releaseMeta: meta(1, 0, 1000) });
    const second = ledger.registerAccepted({
      churchId: 'church',
      text: 'eins zwei drei vier',
      releaseMeta: meta(1, 0, 1000, { sessionEpoch: 'epoch-2' }),
    });
    expect(second.familyId).not.toBe(first.familyId);
    expect(ledger.isCurrent(first).decision).toBe('unscorable');
  });

  it('computes fail-closed V2 containment separately from legacy overlap eligibility', () => {
    const { ledger, events } = createLedger({ sourceMapV2ShadowEnabled: true });
    const firstText = 'eins zwei drei vier';
    const secondText = 'zwei drei vier fuenf';
    const first = ledger.registerAccepted({
      churchId: 'church', text: firstText, releaseMeta: v2Meta(1, 100, 200, firstText),
    });
    const partialOverlap = ledger.registerAccepted({
      churchId: 'church', text: secondText, releaseMeta: v2Meta(2, 150, 250, secondText),
    });

    expect(partialOverlap.applyEligible).toBe(true);
    expect(partialOverlap).toMatchObject({
      revisionRelationV2: 'partial_overlap',
      t1DropWholeV2Eligible: false,
      t2SupersedePendingV2Eligible: false,
      supersedesGenerationsV2: [],
    });
    expect(events.at(-1)).toMatchObject({
      source_map_v2_status: 'complete',
      source_map_v2_coverage_ratio: 1,
      t1_drop_whole_v2_eligible: false,
    });
    expect(ledger.isCurrent(first)).toMatchObject({
      decision: 'would_drop_whole',
      v2Decision: 'emit_whole',
      v2Reason: 'supersession_chain_not_proved',
    });
  });

  it('carries a proved V2 supersession chain only across containing pending generations', () => {
    const { ledger } = createLedger({ sourceMapV2ShadowEnabled: true });
    const firstText = 'eins zwei drei vier';
    const secondText = 'eins zwei drei vier fuenf';
    const thirdText = 'eins zwei drei vier fuenf sechs';
    const first = ledger.registerAccepted({
      churchId: 'church', text: firstText, releaseMeta: v2Meta(1, 100, 200, firstText),
    });
    const second = ledger.registerAccepted({
      churchId: 'church', text: secondText, releaseMeta: v2Meta(2, 50, 250, secondText),
    });
    const third = ledger.registerAccepted({
      churchId: 'church', text: thirdText, releaseMeta: v2Meta(3, 0, 300, thirdText),
    });

    expect(second.supersedesGenerationsV2).toEqual([1]);
    expect(third.supersedesGenerationsV2).toEqual([1, 2]);
    expect(ledger.isCurrent(first)).toMatchObject({
      v2Decision: 'would_drop_whole',
      v2Reason: 'proved_newer_covers_older',
    });
  });

  it('bounds long V2 supersession chains and keeps the truncation signal latched', () => {
    const { ledger } = createLedger({ sourceMapV2ShadowEnabled: true });
    const text = 'eins zwei drei vier';
    let ticket;
    for (let releaseSeq = 1; releaseSeq <= 67; releaseSeq += 1) {
      ticket = ledger.registerAccepted({
        churchId: 'church', text, releaseMeta: v2Meta(releaseSeq, 0, 1000, text),
      });
    }

    expect(ticket.supersedesGenerationsV2).toHaveLength(64);
    expect(ticket.supersedesGenerationsV2[0]).toBe(3);
    expect(ticket.supersedesGenerationsV2.at(-1)).toBe(66);
    expect(ticket.supersessionChainV2Truncated).toBe(true);
  });

  it('makes a proved checkpointed generation visible to T2 without making it T1-pending', () => {
    const { ledger } = createLedger({ sourceMapV2ShadowEnabled: true });
    const firstText = 'eins zwei drei vier';
    const secondText = 'eins zwei drei vier fuenf';
    const first = ledger.registerAccepted({
      churchId: 'church', text: firstText, releaseMeta: v2Meta(1, 100, 200, firstText),
    });
    ledger.observeCheckpoint({ churchId: 'church', ticket: first, language: 'pl' });
    const second = ledger.registerAccepted({
      churchId: 'church', text: secondText, releaseMeta: v2Meta(2, 50, 250, secondText),
    });

    expect(second).toMatchObject({
      t1DropWholeV2Eligible: false,
      t1DropWholeV2Reason: 'no_pending_generation',
      t2SupersedePendingV2Eligible: true,
      t2RevisionRelationV2: 'newer_contains_older',
      supersedesGenerationsV2: [1],
    });
  });

  it('rejects stale releases in preflight without mutating the current family', () => {
    const { ledger } = createLedger({ sourceMapV2ShadowEnabled: true });
    const current = ledger.registerAccepted({
      churchId: 'church', text: 'eins zwei drei vier', releaseMeta: meta(4, 0, 1000),
    });

    expect(ledger.preflightAccepted({
      churchId: 'church', text: 'alte version', releaseMeta: meta(3, 0, 800),
    })).toMatchObject({ decision: 'reject', accept: false, reason: 'stale_release_seq' });
    expect(ledger.isCurrent(current)).toMatchObject({ decision: 'emit_whole', currentGeneration: 1 });
  });

  it('distinguishes an exact retry from a conflicting reuse of a release sequence', () => {
    const { ledger } = createLedger();
    const releaseMeta = meta(7, 0, 1000);
    const first = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei', releaseMeta });

    expect(ledger.preflightAccepted({
      churchId: 'church', text: 'eins zwei drei', releaseMeta,
    })).toMatchObject({ decision: 'duplicate', accept: false, reason: 'exact_release_retry' });
    expect(ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei', releaseMeta })).toBe(first);
    expect(ledger.preflightAccepted({
      churchId: 'church', text: 'anderer inhalt', releaseMeta,
    })).toMatchObject({ decision: 'reject', accept: false, reason: 'release_identity_conflict' });
  });
});

describe('revision ticket queue composition', () => {
  it('marks every multi-item queue merge as composite and fail-open', () => {
    const { ledger } = createLedger();
    const first = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier', releaseMeta: meta(1, 0, 1000) });
    const second = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier fuenf', releaseMeta: meta(2, 0, 1200) });
    const composite = composeRevisionAdmissionTickets([first, second]);

    expect(composite).toMatchObject({
      kind: 'composite',
      familyId: null,
      generation: null,
      applyEligible: false,
      scorable: false,
      componentCount: 2,
    });
    expect(ledger.observeCheckpoint({ churchId: 'church', ticket: composite }).shadow_decision).toBe('unscorable');
  });

  it('keeps a merge fail-open when one source item has no ticket', () => {
    const { ledger } = createLedger();
    const ticket = ledger.registerAccepted({ churchId: 'church', text: 'eins zwei drei vier', releaseMeta: meta(1, 0, 1000) });
    const composite = composeRevisionAdmissionTickets([ticket, null]);
    expect(composite).toMatchObject({ kind: 'composite', scorable: false, componentCount: 2 });
  });
});
