import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBoundaryLedger,
  commitBoundaryText,
  processBoundaryCommit,
  tokenizeWithSpans,
} from '../boundaryCommitLedger.js';

const enabled = {
  enabled: true,
  applyExact: true,
  shadowSemantic: true,
  minExactTokens: 2,
  maxExactTokens: 8,
};

describe('Boundary Commit Ledger', () => {
  beforeEach(() => clearBoundaryLedger());

  it('tokenizes text with spans for prefix trimming', () => {
    expect(tokenizeWithSpans('  Przez Jezusa Chrystusa, amen.').map(t => t.norm))
      .toEqual(['przez', 'jezusa', 'chrystusa', 'amen']);
  });

  it('trims exact tail-head overlap without touching the new remainder', () => {
    commitBoundaryText('c1', 'pl', 'To wszystko dzieje sie przez Jezusa Chrystusa.', {
      emissionId: 10,
      config: enabled,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'pl',
      text: 'Jezusa Chrystusa widzimy teraz w tej historii.',
      emissionId: 11,
      config: enabled,
      now: () => 2000,
    });

    expect(result).toMatchObject({ action: 'trim', changed: true });
    expect(result.text).toBe('widzimy teraz w tej historii.');
    expect(result.metrics[0]).toMatchObject({
      action: 'exact_trim',
      reason: 'tail_head_exact_overlap',
      overlap_tokens: 2,
      previous_emission_id: 10,
    });
  });

  it('keeps full-overlap emissions when trimming would erase the whole text', () => {
    commitBoundaryText('c1', 'pl', 'On jest dobry.', {
      emissionId: 1,
      config: enabled,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'pl',
      text: 'jest dobry',
      emissionId: 2,
      config: enabled,
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.text).toBe('jest dobry');
    expect(result.metrics[0]).toMatchObject({
      action: 'would_exact_trim',
      reason: 'protected_full_overlap',
    });
  });

  it('records semantic shadow candidates without applying them', () => {
    commitBoundaryText('c1', 'en', 'We receive grace, mercy, and peace from God.', {
      emissionId: 1,
      config: enabled,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Grace and mercy from God are now visible in this passage.',
      emissionId: 2,
      config: { ...enabled, applyExact: true, semanticThreshold: 0.6 },
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics.some(m => m.action === 'would_semantic_trim')).toBe(true);
  });

  it('semantic v2: applies trim when hybrid gate passes (ratio + lexical confirm + safe remainder)', () => {
    const applyCfg = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.6,
      semanticHighConfidenceSpanRatio: 0.6,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1,
      config: applyCfg,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2,
      config: applyCfg,
      now: () => 2000,
    });

    expect(result.action).toBe('trim');
    expect(result.changed).toBe(true);
    expect(result.text).toContain('I want to explain more');
    expect(result.text.toLowerCase().startsWith('patience and composure are absolutely')).toBe(false);
    const m = result.metrics.find(x => x.action === 'semantic_trim');
    expect(m).toBeTruthy();
    expect(m.reason).toBe('tail_head_semantic_overlap_applied');
    expect(typeof m.lexical_confirm).toBe('number');
  });

  it('semantic v2: stays shadow when lexical confirmation is below the gate', () => {
    const strictLex = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.6,
      semanticLexicalConfirm: 0.99,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1,
      config: strictLex,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2,
      config: strictLex,
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    const m = result.metrics.find(x => x.action === 'would_semantic_trim');
    expect(m).toBeTruthy();
    expect(m.reason).toBe('tail_head_semantic_overlap_shadow');
    expect(m.lexical_confirm).toBeLessThan(0.99);
  });

  it('semantic v2: never applies when applySemantic is off (backward compatible)', () => {
    const shadowOnly = {
      ...enabled,
      applySemantic: false,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.6,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1,
      config: shadowOnly,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2,
      config: shadowOnly,
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics.some(m => m.action === 'would_semantic_trim')).toBe(true);
    expect(result.metrics.some(m => m.action === 'semantic_trim')).toBe(false);
  });

  it('semantic v2: does not apply when the remainder would be unsafe (too short)', () => {
    const applyCfg = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.6,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
      minRemainingTokens: 3,
      minRemainingChars: 12,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1,
      config: applyCfg,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Patience and composure are absolutely central now.',
      emissionId: 2,
      config: applyCfg,
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics.some(m => m.action === 'would_semantic_trim')).toBe(true);
  });

  it('semantic v2 tiered: long pure-prefix applies at the lower ratio tier when the high tier fails', () => {
    // High tier impossible (0.99); long tier (ratio>=0.6 AND pureLen>=5) carries it.
    // The apply text has a 5-token pure-prefix ("Patience and composure are absolutely").
    const tiered = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.99,
      semanticApplyRatioLong: 0.6,
      semanticLongMinTokens: 5,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1, config: tiered, nowMs: 1000,
    });
    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2, config: tiered, now: () => 2000,
    });
    expect(result.action).toBe('trim');
    expect(result.text).toContain('I want to explain more');
    expect(result.metrics.find(m => m.action === 'semantic_trim')).toBeTruthy();
  });

  it('semantic v2 tiered: short pure-prefix at the lower ratio is rejected (stays shadow)', () => {
    // Same text/pure-prefix (5 tokens) but require 6 for the long tier -> neither tier
    // passes (ratio < 0.99 high, pureLen 5 < 6 long) -> shadow. Guards the orphan case.
    const tiered = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.99,
      semanticApplyRatioLong: 0.6,
      semanticLongMinTokens: 6,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1, config: tiered, nowMs: 1000,
    });
    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2, config: tiered, now: () => 2000,
    });
    expect(result.changed).toBe(false);
    expect(result.metrics.some(m => m.action === 'would_semantic_trim')).toBe(true);
  });

  it('semantic v2 tiered: high-confidence tier still applies regardless of cut length', () => {
    // Low high-tier threshold -> applies via the high tier even if the long tier
    // floor is huge. Confirms the high tier is independent of pureLen.
    const tiered = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.6,
      semanticApplyRatio: 0.6,
      semanticHighConfidenceSpanRatio: 0.6,
      semanticApplyRatioLong: 0.6,
      semanticLongMinTokens: 99,
      semanticLexicalConfirm: 0.5,
      semanticMinOverlap: 2,
      semanticMinTokens: 2,
    };
    commitBoundaryText('c1', 'en', 'Patience and composure are absolutely essential.', {
      emissionId: 1, config: tiered, nowMs: 1000,
    });
    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'en',
      text: 'Patience and composure are absolutely central, and I want to explain more.',
      emissionId: 2, config: tiered, now: () => 2000,
    });
    expect(result.action).toBe('trim');
  });

  it('semantic v2: high-confidence overlap applies even when the clean prefix is short', () => {
    const applyCfg = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.72,
      semanticApplyRatio: 0.8,
      semanticApplyRatioLong: 0.7,
      semanticLongMinTokens: 5,
      semanticLexicalConfirm: 0.6,
      semanticMinOverlap: 3,
      semanticMinTokens: 3,
    };
    commitBoundaryText('c1', 'de', 'ich will dich fragen, lehre mich! Es ist ein Besonderes.', {
      emissionId: 1, config: applyCfg, nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'de',
      text: 'Wir dich fragen, lehre mich. Es ist etwas sehr Interessantes, Hiob zitiert sich selber.',
      emissionId: 2, config: applyCfg, now: () => 2000,
    });

    expect(result.action).toBe('trim');
    expect(result.text).toBe('etwas sehr Interessantes, Hiob zitiert sich selber.');
    const m = result.metrics.find(x => x.action === 'semantic_trim');
    expect(m).toMatchObject({
      high_confidence_gate: true,
      pure_prefix_tokens: 0,
      safe_remainder: true,
    });
  });

  it('semantic v2: high-confidence span cut stops at the last matching token', () => {
    const applyCfg = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.72,
      semanticApplyRatio: 0.8,
      semanticHighConfidenceSpanRatio: 0.8,
      semanticLexicalConfirm: 0.6,
      semanticMinOverlap: 3,
      semanticMinTokens: 3,
      minRemainingTokens: 3,
      minRemainingChars: 12,
    };
    commitBoundaryText('c1', 'en', 'alpha beta gamma delta epsilon older tail.', {
      emissionId: 1, config: applyCfg, nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'en',
      text: 'alpha beta gamma delta epsilon nova continues with safe remainder.',
      emissionId: 2, config: applyCfg, now: () => 2000,
    });

    expect(result.action).toBe('trim');
    expect(result.text).toBe('nova continues with safe remainder.');
    expect(result.metrics.find(x => x.action === 'semantic_trim')).toMatchObject({
      overlap_ratio: 0.8333,
      overlap_text: 'alpha beta gamma delta epsilon',
      high_confidence_span_gate: true,
    });
  });

  it('semantic v2: lower-ratio tier never cuts the full semantic span', () => {
    const lowerTier = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.72,
      semanticApplyRatio: 0.95,
      semanticHighConfidenceSpanRatio: 0.73,
      semanticApplyRatioLong: 0.73,
      semanticLongMinTokens: 99,
      semanticLexicalConfirm: 0.6,
      semanticMinOverlap: 3,
      semanticMinTokens: 3,
    };
    commitBoundaryText('c1', 'en', 'alpha beta gamma delta epsilon older tail.', {
      emissionId: 1, config: lowerTier, nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'en',
      text: 'alpha beta gamma delta epsilon nova continues with safe remainder.',
      emissionId: 2, config: lowerTier, now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics.find(x => x.action === 'would_semantic_trim')).toMatchObject({
      high_confidence_gate: false,
      high_confidence_span_gate: false,
      long_pure_prefix_gate: false,
    });
  });

  it('semantic v2: lower-ratio tier still requires a long pure prefix', () => {
    const applyCfg = {
      ...enabled,
      applySemantic: true,
      semanticThreshold: 0.72,
      semanticApplyRatio: 0.95,
      semanticApplyRatioLong: 0.7,
      semanticLongMinTokens: 5,
      semanticLexicalConfirm: 0.6,
      semanticMinOverlap: 3,
      semanticMinTokens: 3,
    };
    commitBoundaryText('c1', 'de', 'ich will dich fragen, lehre mich! Es ist ein Besonderes.', {
      emissionId: 1, config: applyCfg, nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1', lang: 'de',
      text: 'Wir dich fragen, lehre mich. Es ist etwas sehr Interessantes, Hiob zitiert sich selber.',
      emissionId: 2, config: applyCfg, now: () => 2000,
    });

    expect(result.changed).toBe(false);
    const m = result.metrics.find(x => x.action === 'would_semantic_trim');
    expect(m).toMatchObject({
      high_confidence_gate: false,
      long_pure_prefix_gate: false,
      pure_prefix_tokens: 0,
    });
  });
  it('expires old ledger entries', () => {
    commitBoundaryText('c1', 'pl', 'To jest koniec poprzedniej mysli.', {
      config: { ...enabled, historyTtlMs: 10000 },
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'pl',
      text: 'poprzedniej mysli zaczyna nastepna wypowiedz.',
      config: { ...enabled, historyTtlMs: 10000 },
      now: () => 12000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics).toEqual([]);
  });

  it('uses isolated ledgers per church and language', () => {
    commitBoundaryText('c1', 'pl', 'Przez Jezusa Chrystusa.', {
      config: enabled,
      nowMs: 1000,
    });

    const result = processBoundaryCommit({
      churchId: 'c1',
      lang: 'en',
      text: 'Jezusa Chrystusa should not trim in English ledger.',
      config: enabled,
      now: () => 2000,
    });

    expect(result.changed).toBe(false);
    expect(result.metrics).toEqual([]);
  });
});
