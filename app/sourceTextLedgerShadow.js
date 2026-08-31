import { normalizedWords } from './emittedSourceIdentity.js';
import { classifySourceTextPair, isBetterSourceTextMatch } from './sourceTextLedgerClassifier.js';

const QUOTE_RE = /["“”„«»]/u;

export const DEFAULT_SOURCE_TEXT_LEDGER_CONFIG = Object.freeze({
  enabled: false,
  windowSec: 150,
  maxHistoryReleases: 32,
  minOverlapWords: 3,
  maxWordsPerRelease: 256,
});

const positiveNumber = (value) => Number.isFinite(value) && value > 0;
const positiveInteger = (value) => Number.isInteger(value) && value > 0;

const normalizeConfig = (input = {}) => ({
  enabled: input.enabled === true,
  windowSec: Number(input.windowSec ?? DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.windowSec),
  maxHistoryReleases: Number(input.maxHistoryReleases ?? DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.maxHistoryReleases),
  minOverlapWords: Number(input.minOverlapWords ?? DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.minOverlapWords),
  maxWordsPerRelease: Number(input.maxWordsPerRelease ?? DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.maxWordsPerRelease),
});

const configErrors = (config) => {
  if (!config.enabled) return [];
  const errors = [];
  if (!positiveNumber(config.windowSec)) errors.push('windowSec must be positive');
  if (!positiveInteger(config.maxHistoryReleases)) errors.push('maxHistoryReleases must be a positive integer');
  if (!positiveInteger(config.minOverlapWords)) errors.push('minOverlapWords must be a positive integer');
  if (!positiveInteger(config.maxWordsPerRelease)) errors.push('maxWordsPerRelease must be a positive integer');
  if (positiveInteger(config.maxWordsPerRelease) && positiveInteger(config.minOverlapWords)
    && config.maxWordsPerRelease < config.minOverlapWords) {
    errors.push('maxWordsPerRelease must be at least minOverlapWords');
  }
  return errors;
};

export class SourceTextLedgerShadow {
  constructor({ config = {}, logFn = () => {}, now = Date.now } = {}) {
    this.config = normalizeConfig(config);
    this.configErrors = configErrors(this.config);
    this.enabled = this.config.enabled && this.configErrors.length === 0;
    this._logFn = logFn;
    this._now = now;
    this._history = new Map();
  }

  observe({ churchId, origin, text, releaseMeta = null }) {
    if (!this.enabled) return null;
    try {
      return this._observe({ churchId, origin, text, releaseMeta });
    } catch {
      return null;
    }
  }

  _observe({ churchId, origin, text, releaseMeta }) {
    const nowMs = this._now();
    if (!Number.isFinite(nowMs)) return null;
    const allWords = normalizedWords(text);
    const inputTruncated = allWords.length > this.config.maxWordsPerRelease;
    const words = allWords.slice(0, this.config.maxWordsPerRelease);
    const sessionEpoch = releaseMeta?.sessionEpoch ?? null;
    const releaseSeq = releaseMeta?.releaseSeq ?? null;
    if (!churchId || !sessionEpoch || releaseSeq === null) return null;

    const history = this._historyFor(churchId, sessionEpoch);
    this._prune(history, nowMs);
    const current = { words, hasQuote: QUOTE_RE.test(String(text || '')) };
    let best = null;
    if (!inputTruncated && words.length >= this.config.minOverlapWords) {
      for (const [recencyRank, entry] of history.entries.entries()) {
        if (entry.inputTruncated) continue;
        const comparison = {
          ...classifySourceTextPair(entry, current, this.config.minOverlapWords),
          entry,
          recencyRank,
        };
        if (comparison.verdict !== 'new_content' && isBetterSourceTextMatch(comparison, best)) best = comparison;
      }
    }

    const event = this._event({
      churchId, origin, releaseMeta, words, totalWords: allWords.length, inputTruncated, nowMs, best,
    });
    history.entries.push({
      sessionEpoch,
      releaseSeq,
      origin: origin || 'legacy',
      sourceHash: releaseMeta?.sourceHash ?? null,
      emittedSourceHash: releaseMeta?.emittedSourceHash ?? null,
      words,
      hasQuote: current.hasQuote,
      inputTruncated,
      atMs: nowMs,
    });
    this._prune(history, nowMs);
    try { this._logFn(event); } catch { /* shadow telemetry is fail-open */ }
    return event;
  }

  clear(churchId) { this._history.delete(churchId); }

  _historyFor(churchId, sessionEpoch) {
    const existing = this._history.get(churchId);
    if (existing?.sessionEpoch === sessionEpoch) return existing;
    const fresh = { sessionEpoch, entries: [] };
    this._history.set(churchId, fresh);
    return fresh;
  }

  _prune(history, nowMs) {
    const cutoff = nowMs - (this.config.windowSec * 1000);
    history.entries = history.entries
      .filter((entry) => entry.atMs >= cutoff)
      .slice(-this.config.maxHistoryReleases);
  }

  _event({ churchId, origin, releaseMeta, words, totalWords, inputTruncated, nowMs, best }) {
    let verdict = best?.verdict ?? 'new_content';
    if (words.length < this.config.minOverlapWords) verdict = 'unscorable';
    if (inputTruncated) verdict = 'unscorable_truncated';
    const matched = best?.entry;
    return {
      stage: 'fqf_source_text_ledger_shadow',
      churchId,
      policy_applied: false,
      verdict,
      overlap_kind: best?.overlapKind ?? 'none',
      current_origin: origin || 'legacy',
      current_session_epoch: releaseMeta?.sessionEpoch ?? null,
      current_release_seq: releaseMeta?.releaseSeq ?? null,
      current_source_hash: releaseMeta?.sourceHash ?? null,
      current_emitted_source_hash: releaseMeta?.emittedSourceHash ?? null,
      current_words: totalWords,
      ledger_words: words.length,
      input_truncated: inputTruncated,
      covered_words_exact: best?.coveredWordsExact ?? null,
      new_tail_words_exact: best?.newTailWordsExact ?? null,
      lexical_shared_unique_words: best?.lexicalSharedUniqueWords ?? null,
      matched_origin: matched?.origin ?? null,
      matched_session_epoch: matched?.sessionEpoch ?? null,
      matched_release_seq: matched?.releaseSeq ?? null,
      matched_source_hash: matched?.sourceHash ?? null,
      matched_emitted_source_hash: matched?.emittedSourceHash ?? null,
      match_delta_ms: matched ? nowMs - matched.atMs : null,
      hard_negative_signals: best?.hardNegativeSignals ?? [],
    };
  }
}

export const createSourceTextLedgerShadow = (options) => new SourceTextLedgerShadow(options);
