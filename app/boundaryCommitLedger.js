const DEFAULT_CONFIG = {
  enabled: false,
  applyExact: false,
  shadowSemantic: true,
  // Semantic apply (v2) - tiered hybrid gate. OFF by default: when false the
  // semantic path stays shadow-only and behaviour is identical to v1.
  // Apply when: ratio >= semanticApplyRatio, OR (ratio >= semanticApplyRatioLong
  // AND pureLen >= semanticLongMinTokens). The long-cut tier lets a slightly weaker
  // overlap through only when the contiguous repeat is long enough to be a real
  // sentence/clause dedup - short low-ratio overlaps (which orphan clause starts)
  // stay shadow-only.
  applySemantic: false,
  semanticApplyRatio: 0.8,        // min stemmed-overlap ratio to APPLY (high-confidence tier)
  semanticHighConfidenceSpanRatio: 0.8, // min ratio to cut the full detected semantic span
  semanticApplyRatioLong: 0.7,    // min ratio for the long-cut tier (paired with semanticLongMinTokens)
  semanticLongMinTokens: 5,       // min pure-prefix content tokens to allow the lower-ratio tier
  semanticLexicalConfirm: 0.6,    // min raw-token overlap of the head span - rejects paraphrase false positives
  minExactTokens: 2,
  maxExactTokens: 8,
  maxTailTokens: 14,
  maxHeadTokens: 14,
  minRemainingTokens: 2,
  minRemainingChars: 8,
  semanticMinTokens: 3,
  semanticThreshold: 0.72,
  semanticMinOverlap: 3,
  historyTtlMs: 120000,
};

const ledgers = new Map();

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const clampFloat = (value, fallback, min, max) => {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    applyExact: config.applyExact ?? DEFAULT_CONFIG.applyExact,
    shadowSemantic: config.shadowSemantic ?? DEFAULT_CONFIG.shadowSemantic,
    applySemantic: config.applySemantic ?? DEFAULT_CONFIG.applySemantic,
    semanticApplyRatio: clampFloat(config.semanticApplyRatio, DEFAULT_CONFIG.semanticApplyRatio, 0.5, 0.98),
    semanticHighConfidenceSpanRatio: clampFloat(config.semanticHighConfidenceSpanRatio, DEFAULT_CONFIG.semanticHighConfidenceSpanRatio, 0.5, 0.98),
    semanticApplyRatioLong: clampFloat(config.semanticApplyRatioLong, DEFAULT_CONFIG.semanticApplyRatioLong, 0.5, 0.98),
    semanticLongMinTokens: clampInt(config.semanticLongMinTokens, DEFAULT_CONFIG.semanticLongMinTokens, 2, 16),
    semanticLexicalConfirm: clampFloat(config.semanticLexicalConfirm, DEFAULT_CONFIG.semanticLexicalConfirm, 0, 1),
    minExactTokens: clampInt(config.minExactTokens, DEFAULT_CONFIG.minExactTokens, 1, 6),
    maxExactTokens: clampInt(config.maxExactTokens, DEFAULT_CONFIG.maxExactTokens, 2, 16),
    maxTailTokens: clampInt(config.maxTailTokens, DEFAULT_CONFIG.maxTailTokens, 4, 32),
    maxHeadTokens: clampInt(config.maxHeadTokens, DEFAULT_CONFIG.maxHeadTokens, 4, 32),
    minRemainingTokens: clampInt(config.minRemainingTokens, DEFAULT_CONFIG.minRemainingTokens, 0, 8),
    minRemainingChars: clampInt(config.minRemainingChars, DEFAULT_CONFIG.minRemainingChars, 0, 40),
    semanticMinTokens: clampInt(config.semanticMinTokens, DEFAULT_CONFIG.semanticMinTokens, 2, 8),
    semanticThreshold: clampFloat(config.semanticThreshold, DEFAULT_CONFIG.semanticThreshold, 0.4, 0.98),
    semanticMinOverlap: clampInt(config.semanticMinOverlap, DEFAULT_CONFIG.semanticMinOverlap, 2, 10),
    historyTtlMs: clampInt(config.historyTtlMs, DEFAULT_CONFIG.historyTtlMs, 10000, 600000),
  };
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(^\p{P}+)|(\p{P}+$)/gu, '');
}

function tokenizeWithSpans(text) {
  const source = String(text || '');
  const tokens = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
  let match;
  while ((match = re.exec(source)) !== null) {
    const raw = match[0];
    const norm = normalizeToken(raw);
    if (!norm) continue;
    tokens.push({
      raw,
      norm,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return tokens;
}

function contentKey(token) {
  let v = token.norm;
  if (v.length > 6) v = v.replace(/(owego|owej|ami|ach|ego|ymi|ing|tion|mente|mente|ung|keit|heit|en|em|er|es|ie|y|i|a|o)$/u, '');
  return v;
}

function getLedgerKey(churchId, lang) {
  return `${churchId || ''}::${lang || ''}`;
}

function getEntry(churchId, lang, nowMs, cfg, { pruneExpired = true } = {}) {
  const key = getLedgerKey(churchId, lang);
  const entry = ledgers.get(key);
  if (!entry) return null;
  if (nowMs - entry.committedAt > cfg.historyTtlMs) {
    if (pruneExpired) ledgers.delete(key);
    return null;
  }
  return entry;
}

function findExactOverlap(previousTokens, currentTokens, cfg) {
  const max = Math.min(cfg.maxExactTokens, previousTokens.length, currentTokens.length);
  for (let n = max; n >= cfg.minExactTokens; n--) {
    const tail = previousTokens.slice(previousTokens.length - n).map(t => t.norm).join(' ');
    const head = currentTokens.slice(0, n).map(t => t.norm).join(' ');
    if (tail === head) return { tokens: n, phrase: currentTokens.slice(0, n).map(t => t.raw).join(' ') };
  }
  return null;
}

function hasSafeRemainder(text, currentTokens, trimmedTokens, cfg) {
  const remaining = text.slice(currentTokens[trimmedTokens - 1].end).trim();
  if (!remaining) return false;
  const remainingTokens = tokenizeWithSpans(remaining);
  return remaining.length >= cfg.minRemainingChars && remainingTokens.length >= cfg.minRemainingTokens;
}

function trimExactPrefix(text, currentTokens, overlap) {
  const cutAt = currentTokens[overlap.tokens - 1].end;
  return String(text || '').slice(cutAt).replace(/^[\s,;:.!?–—-]+/u, '').trim();
}

function semanticCandidate(previousTokens, currentTokens, cfg) {
  // Compute when either shadow logging or apply is requested.
  if (!cfg.shadowSemantic && !cfg.applySemantic) return null;

  const tailSlice = previousTokens.slice(-cfg.maxTailTokens);
  const tailKeys = new Set(tailSlice.map(contentKey).filter(t => t.length > 2));
  const tailNorms = new Set(tailSlice.map(t => t.norm).filter(Boolean));
  if (tailKeys.size < cfg.semanticMinTokens) return null;

  // Head built over currentTokens so each candidate keeps its real index (needed
  // to map the overlap back to a character cut position when applying).
  const head = [];
  for (let i = 0; i < currentTokens.length && head.length < cfg.maxHeadTokens; i++) {
    const key = contentKey(currentTokens[i]);
    if (key.length > 2) head.push({ index: i, key, norm: currentTokens[i].norm });
  }
  if (head.length < cfg.semanticMinTokens) return null;

  // Detection span: largest head prefix whose stem-overlap with the tail clears
  // the threshold. Backward-compatible with v1 (ratio over the stemmed key set).
  let best = null;
  for (let n = cfg.semanticMinTokens; n <= head.length; n++) {
    const span = head.slice(0, n);
    const headKeySet = new Set(span.map(h => h.key));
    const overlap = new Set([...headKeySet].filter(k => tailKeys.has(k)));
    const ratio = overlap.size / Math.max(1, headKeySet.size);
    if (overlap.size >= cfg.semanticMinOverlap && ratio >= cfg.semanticThreshold) {
      // Lexical confirmation over the detection span: how much of the head is a
      // real word-level repeat vs a stem coincidence / paraphrase. The apply gate
      // rejects high-ratio-but-low-lexical candidates (the false positives).
      const headNormSet = new Set(span.map(h => h.norm));
      const lexOverlap = [...headNormSet].filter(t => tailNorms.has(t)).length;
      const lexicalConfirm = lexOverlap / Math.max(1, headNormSet.size);
      let lastMatchingSpanTokenIndex = null;
      for (const h of span) {
        if (tailKeys.has(h.key)) lastMatchingSpanTokenIndex = h.index;
      }
      best = {
        tokens: n,
        overlap: overlap.size,
        ratio,
        lexicalConfirm,
        spanCutTokenIndex: lastMatchingSpanTokenIndex,
      };
    }
  }
  if (!best) return null;

  // Cut point for apply: the contiguous prefix of head tokens that are ALL present
  // in the tail (the verbatim-ish repeat). Stopping at the first non-matching token
  // means we never trim into genuinely new content and never orphan a clause start.
  let pureLen = 0;
  for (const h of head) {
    if (tailKeys.has(h.key)) pureLen++;
    else break;
  }
  best.pureLen = pureLen;
  best.cutTokenIndex = pureLen > 0 ? head[pureLen - 1].index : null;
  return best;
}

function processBoundaryCommit({ churchId, lang, text, sourceText = null, emissionId = null, config = {}, now = () => Date.now(), deferCommit = false } = {}) {
  const cfg = normalizeConfig(config);
  const original = String(text || '');
  const currentTokens = tokenizeWithSpans(original);
  const nowMs = now();

  if (!cfg.enabled || currentTokens.length === 0) {
    return { action: 'emit', text: original, changed: false, metrics: [] };
  }

  const previous = getEntry(churchId, lang, nowMs, cfg, { pruneExpired: !deferCommit });
  const metrics = [];
  let output = original;
  let action = 'emit';

  if (previous?.tokens?.length) {
    const exact = findExactOverlap(previous.tokens, currentTokens, cfg);
    if (exact) {
      const safe = hasSafeRemainder(original, currentTokens, exact.tokens, cfg);
      const applied = cfg.applyExact && safe;
      metrics.push({
        stage: 'boundary_commit_ledger',
        action: applied ? 'exact_trim' : 'would_exact_trim',
        reason: safe ? 'tail_head_exact_overlap' : 'protected_full_overlap',
        churchId,
        lang,
        emissionId,
        overlap_tokens: exact.tokens,
        overlap_text: exact.phrase,
        previous_emission_id: previous.emissionId ?? null,
      });
      if (applied) {
        output = trimExactPrefix(original, currentTokens, exact);
        action = 'trim';
      }
    } else {
      const sem = semanticCandidate(previous.tokens, currentTokens, cfg);
      if (sem) {
        // Hybrid gate: ratio/lexical confirmation AND a safe remainder. High-confidence
        // semantic overlaps cut up to the LAST matching token in the detected span (not
        // the end of the span) - this trims leading prepends/substitutions while keeping
        // a genuinely-new trailing token out of the cut. Requiring a contiguous pure
        // prefix here leaked real duplicates when ASR prepended or substituted one token
        // before the repeated thought. The lower-ratio long tier stays conservative and
        // still requires a clean pure-prefix cut.
        const highConfidenceGate = sem.ratio >= cfg.semanticApplyRatio;
        const highConfidenceSpanGate = highConfidenceGate
          && sem.ratio >= cfg.semanticHighConfidenceSpanRatio;
        const longPurePrefixGate = sem.ratio >= cfg.semanticApplyRatioLong
          && sem.pureLen >= cfg.semanticLongMinTokens;
        const applyCutTokenIndex = highConfidenceSpanGate
          ? sem.spanCutTokenIndex
          : longPurePrefixGate
            ? sem.cutTokenIndex
            : null;

        let applyRemainder = '';
        let applySafeRemainder = false;
        if (applyCutTokenIndex != null) {
          const applyCutEnd = currentTokens[applyCutTokenIndex].end;
          applyRemainder = String(original).slice(applyCutEnd).replace(/^[\s,;:.!?–—-]+/u, '').trim();
          const applyRemainderTokens = tokenizeWithSpans(applyRemainder);
          applySafeRemainder = applyRemainder.length >= cfg.minRemainingChars
            && applyRemainderTokens.length >= cfg.minRemainingTokens;
        }

        const gatePassed = cfg.applySemantic
          && applyCutTokenIndex != null
          && (highConfidenceSpanGate || longPurePrefixGate)
          && sem.lexicalConfirm >= cfg.semanticLexicalConfirm
          && applySafeRemainder;
        const metric = {
          stage: 'boundary_commit_ledger',
          action: gatePassed ? 'semantic_trim' : 'would_semantic_trim',
          reason: gatePassed ? 'tail_head_semantic_overlap_applied' : 'tail_head_semantic_overlap_shadow',
          churchId,
          lang,
          emissionId,
          overlap_tokens: sem.tokens,
          overlap_count: sem.overlap,
          overlap_ratio: Number(sem.ratio.toFixed(4)),
          lexical_confirm: Number(sem.lexicalConfirm.toFixed(4)),
          pure_prefix_tokens: sem.pureLen,
          high_confidence_gate: highConfidenceGate,
          high_confidence_span_gate: highConfidenceSpanGate,
          long_pure_prefix_gate: longPurePrefixGate,
          safe_remainder: applySafeRemainder,
          previous_emission_id: previous.emissionId ?? null,
        };
        if (gatePassed) {
          const cutEnd = currentTokens[applyCutTokenIndex].end;
          metric.overlap_text = String(original).slice(0, cutEnd).trim();
          output = applyRemainder;
          action = 'trim';
        }
        metrics.push(metric);
      }
    }
  }

  if (!deferCommit) {
    commitBoundaryText(churchId, lang, output, { sourceText, emissionId, nowMs, config: cfg });
  }
  return { action, text: output, changed: output !== original, metrics };
}

function commitBoundaryText(churchId, lang, text, { sourceText = null, emissionId = null, nowMs = Date.now(), config = {} } = {}) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return null;
  const tokens = tokenizeWithSpans(text);
  const entry = {
    text: String(text || ''),
    sourceText,
    emissionId,
    committedAt: nowMs,
    tokens: tokens.slice(-cfg.maxTailTokens),
  };
  ledgers.set(getLedgerKey(churchId, lang), entry);
  return entry;
}

function clearBoundaryLedger(churchId = null) {
  if (!churchId) {
    ledgers.clear();
    return;
  }
  const prefix = `${churchId}::`;
  for (const key of ledgers.keys()) {
    if (key.startsWith(prefix)) ledgers.delete(key);
  }
}

export {
  DEFAULT_CONFIG,
  clearBoundaryLedger,
  commitBoundaryText,
  normalizeConfig,
  processBoundaryCommit,
  tokenizeWithSpans,
};
