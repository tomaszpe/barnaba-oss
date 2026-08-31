const NEGATIONS = new Set(['nicht', 'nichts', 'nie', 'niemals', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'ohne']);

const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);
const startsWithWords = (words, prefix) => (
  prefix.length <= words.length && prefix.every((word, index) => words[index] === word)
);

const containsWords = (words, candidate) => {
  if (candidate.length > words.length) return false;
  for (let start = 0; start <= words.length - candidate.length; start += 1) {
    if (candidate.every((word, index) => words[start + index] === word)) return true;
  }
  return false;
};

const suffixPrefixLength = (previous, current) => {
  for (let length = Math.min(previous.length, current.length); length > 0; length -= 1) {
    const offset = previous.length - length;
    if (current.slice(0, length).every((word, index) => word === previous[offset + index])) return length;
  }
  return 0;
};

const sharedTokenCount = (a, b) => {
  const right = new Set(b);
  return new Set(a.filter((word) => right.has(word))).size;
};

const significantOccurrences = (words, predicate) => words.filter(predicate).sort();
const changedOccurrences = (a, b) => a.length !== b.length || a.some((value, index) => value !== b[index]);

export const classifySourceTextPair = (previous, current, minOverlapWords) => {
  const prior = previous.words;
  const words = current.words;
  let verdict = 'new_content';
  let overlapKind = 'none';
  let coveredWordsExact = null;
  let newTailWordsExact = null;
  let lexicalSharedUniqueWords = null;

  if (sameWords(prior, words)) {
    verdict = 'exact_replay';
    overlapKind = 'exact';
    coveredWordsExact = words.length;
    newTailWordsExact = 0;
  } else if (words.length >= minOverlapWords && containsWords(prior, words)) {
    verdict = 'contained_replay';
    overlapKind = 'current_inside_previous';
    coveredWordsExact = words.length;
    newTailWordsExact = 0;
  } else if (prior.length >= minOverlapWords && startsWithWords(words, prior)) {
    verdict = 'overlap_with_new_tail';
    overlapKind = 'previous_is_current_prefix';
    coveredWordsExact = prior.length;
    newTailWordsExact = words.length - prior.length;
  } else {
    const suffixPrefix = suffixPrefixLength(prior, words);
    const shared = sharedTokenCount(prior, words);
    if (suffixPrefix >= minOverlapWords && words.length > suffixPrefix) {
      verdict = 'overlap_with_new_tail';
      overlapKind = 'previous_suffix_current_prefix';
      coveredWordsExact = suffixPrefix;
      newTailWordsExact = words.length - suffixPrefix;
    } else if (shared >= minOverlapWords) {
      verdict = 'partial_overlap_guarded';
      overlapKind = 'lexical_partial';
      lexicalSharedUniqueWords = shared;
    }
  }

  const priorNumbers = significantOccurrences(prior, (word) => /^\d+$/u.test(word));
  const currentNumbers = significantOccurrences(words, (word) => /^\d+$/u.test(word));
  const priorNegations = significantOccurrences(prior, (word) => NEGATIONS.has(word));
  const currentNegations = significantOccurrences(words, (word) => NEGATIONS.has(word));
  const hardNegativeSignals = [];
  if (changedOccurrences(priorNumbers, currentNumbers)) hardNegativeSignals.push('number_changed');
  if (changedOccurrences(priorNegations, currentNegations)) hardNegativeSignals.push('negation_changed');
  if (previous.hasQuote || current.hasQuote) hardNegativeSignals.push('quote_present');
  if (verdict === 'exact_replay' && words.length <= 8) hardNegativeSignals.push('short_exact_repeat');

  return {
    verdict,
    overlapKind,
    coveredWordsExact,
    newTailWordsExact,
    lexicalSharedUniqueWords,
    matchStrength: coveredWordsExact ?? lexicalSharedUniqueWords ?? 0,
    hardNegativeSignals,
  };
};

const VERDICT_RANK = Object.freeze({
  new_content: 0,
  partial_overlap_guarded: 1,
  overlap_with_new_tail: 2,
  contained_replay: 3,
  exact_replay: 4,
});

export const isBetterSourceTextMatch = (candidate, best) => (
  !best
  || VERDICT_RANK[candidate.verdict] > VERDICT_RANK[best.verdict]
  || (VERDICT_RANK[candidate.verdict] === VERDICT_RANK[best.verdict]
    && (
      candidate.matchStrength > best.matchStrength
      || (candidate.matchStrength === best.matchStrength
        && (candidate.recencyRank ?? -1) > (best.recencyRank ?? -1))
    ))
);
