import { endsOnOpenWord, endsWithTerminal } from './boundaryConfirmation.js';

const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

const startsAtClosedBoundary = (original, projected) => {
  const start = original.lastIndexOf(projected);
  if (start <= 0) return start === 0;
  const prefix = original.slice(0, start).trimEnd();
  return endsWithTerminal(prefix);
};

export const classifyFallbackReevaluation = ({
  originalText,
  p2Result,
  b4Result,
  minTailWords,
}) => {
  if (!Number.isInteger(minTailWords) || minTailWords < 1) {
    throw new TypeError('minTailWords must be a positive integer');
  }

  const original = String(originalText || '').trim();
  const projected = String(b4Result?.text ?? p2Result?.text ?? original).trim();
  const filters = [
    ...(p2Result?.action ? [{ stage: 'P2', action: p2Result.action }] : []),
    ...(b4Result?.action ? [{ stage: 'B4', action: b4Result.action }] : []),
  ];
  const result = {
    action: 'keep_full',
    projectedText: original,
    originalWords: wordCount(original),
    projectedWords: wordCount(original),
    filters,
  };

  if (!projected || p2Result?.action === 'skip' || b4Result?.action === 'skip') {
    return { ...result, action: 'drop_history_repeat', projectedText: '', projectedWords: 0 };
  }
  if (projected === original) return result;

  const projectedWords = wordCount(projected);
  if (projectedWords < minTailWords) {
    return { ...result, action: 'tail_too_short', projectedText: projected, projectedWords };
  }
  if (!startsAtClosedBoundary(original, projected)
      || !endsWithTerminal(projected)
      || endsOnOpenWord(projected)) {
    return { ...result, action: 'unsafe_open_cut', projectedText: projected, projectedWords };
  }
  return { ...result, action: 'trim_and_emit_tail', projectedText: projected, projectedWords };
};
