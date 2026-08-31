import { describe, expect, it } from 'vitest';
import {
  evaluatePostTranslationDedup,
  historyEntryFor,
  tokenizeContentWords,
} from '../t5DedupPolicy.js';

function evalWithHistory(text, historyTexts, options = {}) {
  return evaluatePostTranslationDedup(
    text,
    'pl',
    historyTexts.map((h) => historyEntryFor(h)),
    options,
  );
}

describe('T5 v2 post-translation dedup policy', () => {
  it('keeps Polish diacritic stopwords out of content-word scoring', () => {
    expect(tokenizeContentWords('że się już')).toEqual([]);
  });

  it('keeps exact duplicates blocked in both legacy and v2 (known limitation for verbatim rhetoric)', () => {
    const text = 'Powtarzam to jeszcze raz, ksiega Hioba jest ksiega perspektywy.';
    const result = evalWithHistory(text, [text]);

    expect(result.legacy.action).toBe('skip');
    expect(result.v2.action).toBe('skip');
    expect(result.metrics.overlap_ratio).toBe(1);
  });

  it('keeps the short-text exact-repeat branch unchanged', () => {
    const result = evalWithHistory('Tak, alleluja.', ['Alleluja! Tak.']);

    expect(result.legacy.action).toBe('skip');
    expect(result.v2.action).toBe('skip');
    expect(result.legacy.reason).toContain('exact short repeat');
  });

  it('allows rhetorical repeats with a new tail that legacy Jaccard would skip', () => {
    const previous = 'Kiedy nasz czerwony guzik zostaje nacisniety, jak reagujemy przed Bogiem?';
    const current = 'Kiedy nasz czerwony guzik zostaje nacisniety, jak reagujemy przed Bogiem w biograficznych tsunami naszego zycia?';

    const result = evalWithHistory(current, [previous]);

    expect(result.metrics.jaccard).toBeGreaterThan(0.45);
    expect(result.metrics.overlap_ratio).toBeLessThan(0.85);
    expect(result.legacy.action).toBe('skip');
    expect(result.v2.action).toBe('emit');
  });

  it('still blocks long near-duplicates with no meaningful new content', () => {
    const previous = 'Kiedy nasz czerwony guzik zostaje nacisniety, jak reagujemy przed Bogiem?';
    const current = 'Przed Bogiem, kiedy nasz czerwony guzik zostaje nacisniety, jak reagujemy?';

    const result = evalWithHistory(current, [previous]);

    expect(result.metrics.overlap_ratio).toBeGreaterThanOrEqual(0.85);
    expect(result.legacy.action).toBe('skip');
    expect(result.v2.action).toBe('skip');
  });
});
