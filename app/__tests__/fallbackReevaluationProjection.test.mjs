import { describe, expect, it } from 'vitest';
import { classifyFallbackReevaluation } from '../fallbackReevaluationProjection.js';

const project = ({ original, p2Text = original, p2Action = 'emit', b4Text = p2Text,
  b4Action = 'emit', minTailWords = 3 }) => classifyFallbackReevaluation({
  originalText: original,
  p2Result: { text: p2Text, action: p2Action },
  b4Result: { text: b4Text, action: b4Action },
  minTailWords,
});

describe('FQF-2 loser re-evaluation projection', () => {
  it('keeps a payload unchanged when the committed history finds no repeat', () => {
    expect(project({ original: 'Das ist vollstÃ¤ndig neuer Inhalt.' })).toMatchObject({
      action: 'keep_full',
      projectedWords: 5,
    });
  });

  it('drops a payload classified as a history repeat', () => {
    expect(project({
      original: 'Das wurde bereits vollstÃ¤ndig gesendet.',
      p2Text: '',
      p2Action: 'skip',
      b4Text: '',
      b4Action: 'not_run',
    })).toMatchObject({ action: 'drop_history_repeat', projectedWords: 0 });
  });

  it('accepts a sufficiently long closed tail', () => {
    expect(project({
      original: 'Alter langer PrÃ¤fix. Das ist der sichere neue Inhalt.',
      p2Text: 'Das ist der sichere neue Inhalt.',
      p2Action: 'trim',
      b4Text: 'Das ist der sichere neue Inhalt.',
    })).toMatchObject({ action: 'trim_and_emit_tail', projectedWords: 6 });
  });

  it('uses the canonical terminal rule for repeated closing punctuation', () => {
    expect(project({
      original: 'Alte Frage?»» Das ist der sichere neue Inhalt.',
      p2Text: 'Das ist der sichere neue Inhalt.',
      p2Action: 'trim',
    })).toMatchObject({ action: 'trim_and_emit_tail' });
  });

  it('rejects a projected tail below the existing minimum', () => {
    expect(project({
      original: 'Alter langer PrÃ¤fix. Neuer Satz.',
      p2Text: 'Neuer Satz.',
      p2Action: 'trim',
    })).toMatchObject({ action: 'tail_too_short', projectedWords: 2 });
  });

  it('rejects a projected open cut even when it is long enough', () => {
    expect(project({
      original: 'Alter langer PrÃ¤fix. Das ist ein offener neuer Inhalt weil',
      p2Text: 'Das ist ein offener neuer Inhalt weil',
      p2Action: 'trim',
    })).toMatchObject({ action: 'unsafe_open_cut' });
  });

  it('rejects a tail that starts in the middle of an open sentence', () => {
    expect(project({
      original: 'Alter offener Präfix und das ist der neue geschlossene Inhalt.',
      p2Text: 'das ist der neue geschlossene Inhalt.',
      p2Action: 'trim',
    })).toMatchObject({ action: 'unsafe_open_cut' });
  });

  it('rejects invalid minimum-tail configuration', () => {
    expect(() => project({ original: 'Inhalt.', minTailWords: 0 }))
      .toThrow('minTailWords must be a positive integer');
  });
});
