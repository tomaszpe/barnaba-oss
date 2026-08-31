/**
 * Deadline provisional emission with a source-span ledger.
 *
 * Problem: the deadline watchdog achieved the hard
 * pause cap (max audible silence 5.2s, zero >10s) but emitted the RAW `latestPartial`
 * (a mid-clause LA hypothesis). The eventual final then arrived with (near) the same
 * content, so the listener heard partial + final = repetition, and the raw mid-clause
 * partial itself was garbled ("Mr Bean", "jak zarobic"). T5/B4 did not dedup it because
 * partial-vs-final word overlap was < 0.85.
 *
 * Refined model = "provisional emission lifecycle":
 *   1. Emit only the NEW STABLE DELTA since the last emitted source span (never the raw
 *      partial, never the whole cumulative stable). LA-confirmed prefix -> no mid-clause
 *      garble; delta-only -> no replay of already-spoken content.
 *   2. Fallback ladder (never emit raw mid-clause without protection):
 *        - newStableDelta >= minWords            -> emit  (mode: deadline_stable)
 *        - stable static but partial has a safe
 *          closed prefix that is new             -> emit  (mode: deadline_safe_prefix)
 *        - only raw mid-clause                    -> SKIP  (mode: deadline_no_safe_payload)
 *          (short silence < garble; the cap was proven reachable, we can afford to wait)
 *   3. Server-side supersede: a ledger of provisional releases lets the eventual final be
 *      matched by SOURCE SPAN (normalized words / prefix), not by release_seq. When a final
 *      only covers already-provisional content -> suppress it; when it extends the provisional
 *      -> emit only the new delta-tail; when it diverges (real new semantics) -> pass through.
 *
 * Pure module: no I/O, no clock (caller passes `now`), no mutable module state. All state
 * (emittedSourceNorm, ledger) is held by the caller in fallbackState.
 */

import { splitAtSafeBoundary } from './boundaryConfirmation.js';

/** Normalized word tokens: lowercase, punctuation stripped, whitespace-collapsed. */
function normWords(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * Tokenize into content tokens with their char offsets in the ORIGINAL string, skipping
 * pure-punctuation tokens (which normWords also drops). Keeping offsets lets us slice the
 * original substring (preserving German casing/punctuation the translator needs) rather than
 * re-joining normalized words.
 * @returns {Array<{norm: string, start: number, end: number}>}
 */
function tokenizeWithOffsets(s) {
    const str = String(s || '');
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str))) {
        const norm = m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (!norm) continue; // pure punctuation token
        out.push({ norm, start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/** Length of the common leading run of two normalized-word arrays. */
function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    return k;
}

/**
 * New source content in `latestText` beyond what was already emitted (`emittedNorm`).
 * `emittedNorm` MUST be the normalized-word array of the already-emitted source span.
 *
 * If the already-emitted content is NOT a clean prefix of `latestText` (LA head-revision /
 * correction), we report `diverged: true` and no delta: re-emitting a corrected head is
 * exactly the replay we are avoiding, so the caller should treat it as "no safe payload".
 *
 * @returns {{delta: string, diverged: boolean, matchedWords: number, deltaWords: number}}
 */
function computeSourceDelta(emittedNorm, latestText) {
    const emitted = Array.isArray(emittedNorm) ? emittedNorm : normWords(emittedNorm);
    const tokens = tokenizeWithOffsets(latestText);
    const latestNorm = tokens.map((t) => t.norm);
    const k = commonPrefixLen(emitted, latestNorm);
    if (emitted.length > 0 && k < emitted.length) {
        // emitted head is not a prefix of latest -> correction/divergence
        return { delta: '', diverged: true, matchedWords: k, deltaWords: 0 };
    }
    if (k >= tokens.length) {
        return { delta: '', diverged: false, matchedWords: k, deltaWords: 0 };
    }
    const delta = String(latestText).slice(tokens[k].start).trim();
    return { delta, diverged: false, matchedWords: k, deltaWords: tokens.length - k };
}

/**
 * Decide the deadline payload via the fallback ladder.
 *
 * @param {object} args
 * @param {string} args.latestStable   LA-confirmed cumulative stable prefix (source/DE)
 * @param {string} args.latestPartial  raw latest partial hypothesis (source/DE)
 * @param {string[]} args.emittedNorm  normalized words already emitted this starvation span
 * @param {number} [args.minWords=3]   minimum new words to justify an emission
 * @returns {{mode: string, text: string, deltaWords: number}}
 *   mode ∈ { 'deadline_stable', 'deadline_safe_prefix', 'deadline_no_safe_payload' }
 */
function buildDeadlinePayload({ latestStable, latestPartial, emittedNorm = [], minWords = 3 }) {
    // Rung 1: new stable delta.
    const stable = computeSourceDelta(emittedNorm, latestStable || '');
    if (!stable.diverged && stable.deltaWords >= minWords) {
        return { mode: 'deadline_stable', text: stable.delta, deltaWords: stable.deltaWords };
    }
    // Rung 2: safe closed prefix of the partial (provisional), delta-guarded.
    const { head } = splitAtSafeBoundary(latestPartial || '');
    if (head) {
        const safe = computeSourceDelta(emittedNorm, head);
        if (!safe.diverged && safe.deltaWords >= minWords) {
            return { mode: 'deadline_safe_prefix', text: safe.delta, deltaWords: safe.deltaWords };
        }
    }
    // Rung 3: only raw mid-clause -> do NOT emit raw; short silence < garble.
    return { mode: 'deadline_no_safe_payload', text: '', deltaWords: 0 };
}

// German negation markers: a 1-2 word tail carrying one of these flips meaning and must NOT
// be suppressed as a "negligible" tail (finding #5).
const NEGATION_RE = /\b(nicht|kein|keine|keinen|keinem|keiner|niemals|nie|nichts|niemand|ohne|nein|weder|noch)\b/i;

/**
 * Is a short tail semantically load-bearing enough to emit even below minEmitTailWords?
 * German capitalizes ALL nouns, so a capitalization-based "proper noun" test is useless here;
 * we rescue only on unambiguous signals: digits (biblical refs / counts like "Hiob 42",
 * "7000") and negations (which invert meaning).
 */
function tailIsSignificant(text) {
    const t = String(text || '');
    if (/\d/.test(t)) return true;
    if (NEGATION_RE.test(t)) return true;
    return false;
}

/**
 * BASELINE supersede (pinned baseline = listening review 4.52). Matches an incoming FINAL against the
 * PER-ENTRY ledger of provisional deadline emissions: each entry must be fully contained as a
 * prefix of the final to count, the entry with the largest coverage wins, entries expire by
 * their OWN `at` timestamp, and already-superseded entries are skipped.
 *
 * Kept verbatim from the pinned baseline, the only empirically validated good state
 * (11.07: every attempt to improve on 4.52 regressed). Do NOT "modernize" it onto the
 * reviewFixes API - the caller marks `decision.entry.superseded = true`, which has no
 * equivalent in the cumulative variant.
 *
 * @param {object} args
 * @param {string} args.finalText   incoming non-deadline source release (final)
 * @param {object[]} args.ledger    per-provisional entries {norm|text, at, superseded}
 * @param {number} args.now         wall clock for the per-entry TTL check
 * @param {number} [args.ttlMs=25000]
 * @param {number} [args.minWords=3]
 * @returns {{action: string, text?: string, entry?: object, tailWords?: number, coveredWords?: number}}
 */
function supersedeDecisionBaseline({ finalText, ledger = [], now, ttlMs = 25000, minWords = 3 }) {
    const fw = normWords(finalText);
    if (fw.length === 0) return { action: 'pass' };
    let best = null; // entry with the largest coverage of the final's head
    for (const entry of ledger) {
        if (!entry || entry.superseded) continue;
        if (typeof entry.at === 'number' && now - entry.at > ttlMs) continue;
        const en = Array.isArray(entry.norm) ? entry.norm : normWords(entry.text);
        if (en.length === 0) continue;
        const m = commonPrefixLen(en, fw);
        // Provisional must be fully contained as a prefix of the final to be a supersede.
        if (m !== en.length) continue;
        if (!best || m > best.m) best = { entry, m };
    }
    if (!best) return { action: 'pass' };
    const tailWords = fw.length - best.m;
    if (tailWords < minWords) {
        // final == provisional (tail 0) or a negligible tail -> the listener already heard it.
        return { action: 'suppress', entry: best.entry, tailWords, coveredWords: best.m };
    }
    // final extends the provisional -> emit only the new tail.
    const tokens = tokenizeWithOffsets(finalText);
    const text = best.m < tokens.length ? String(finalText).slice(tokens[best.m].start).trim() : '';
    if (!text) return { action: 'suppress', entry: best.entry, tailWords, coveredWords: best.m };
    return { action: 'emit_tail', text, entry: best.entry, tailWords, coveredWords: best.m };
}

/**
 * REVIEW-FIXES supersede (the two review-fix commits). Matches the FINAL against the CUMULATIVE
 * source span already emitted provisionally in this starvation span (finding #2 - per-payload
 * ledger entries let a later provisional replay when the final was cumulative A+B+C).
 * Matched by normalized-word prefix, not release_seq.
 *
 *   final fully inside emitted prefix (m === fw.length) -> suppress (already fully played)
 *   emitted is a prefix of final (m === emitted.length) -> emit only the new tail
 *   diverges before covering emitted                     -> pass (real new content/correction)
 *
 * NOT VALIDATED: this arm shipped in the 6-finding batch that scored listening review 3.6 (11.07) and is
 * gated OFF by default (LISTENER_DEADLINE_REVIEW_FIXES_ENABLED). Kept as the candidate arm for a
 * future single-variable A/B, per the 11.07 rule "add ONE change at a time, never a batch".
 *
 * @param {object} args
 * @param {string} args.finalText          incoming non-deadline source release (final)
 * @param {string[]} args.emittedNorm      cumulative normalized words already emitted via deadline
 * @param {number} [args.minWords=3]        baseline min tail words to emit a correction
 * @param {number} [args.minEmitTailWords]  separate min for the emit-tail decision (finding #5);
 *                                          defaults to minWords. Tails below it are emitted ONLY
 *                                          when tailIsSignificant (digit/negation), else suppressed.
 * @returns {{action: string, text?: string, tailWords?: number, coveredWords?: number}}
 *   action ∈ { 'pass', 'suppress', 'emit_tail' }
 */
function supersedeDecisionReviewFixes({ finalText, emittedNorm = [], minWords = 3, minEmitTailWords = null }) {
    const fw = normWords(finalText);
    if (fw.length === 0) return { action: 'pass' };
    const en = Array.isArray(emittedNorm) ? emittedNorm : normWords(emittedNorm);
    if (en.length === 0) return { action: 'pass' };
    const m = commonPrefixLen(en, fw);
    if (m === fw.length) {
        // final is entirely within already-emitted content -> pure replay
        return { action: 'suppress', tailWords: 0, coveredWords: m };
    }
    if (m !== en.length) {
        // final diverges before covering all emitted -> genuinely new content or a correction
        return { action: 'pass', coveredWords: m };
    }
    // emitted is a strict prefix of final -> the new tail is fw[m:]
    const tailWords = fw.length - m;
    const tokens = tokenizeWithOffsets(finalText);
    const text = m < tokens.length ? String(finalText).slice(tokens[m].start).trim() : '';
    if (!text) return { action: 'suppress', tailWords, coveredWords: m };
    const minTail = (minEmitTailWords == null) ? minWords : minEmitTailWords;
    if (tailWords < minTail && !tailIsSignificant(text)) {
        return { action: 'suppress', tailWords, coveredWords: m };
    }
    return { action: 'emit_tail', text, tailWords, coveredWords: m };
}

/**
 * Routes to the supersede semantics the active config selects. The two arms take different
 * inputs on purpose (baseline: per-entry `ledger` + `now`/`ttlMs`; reviewFixes: cumulative
 * `emittedNorm`), so callers pass the union and each arm reads only what it needs.
 *
 * This is the ONLY place the flag picks an algorithm - keep it that way, because it is what
 * makes the routing testable without env. Two correct algorithms prove nothing if the 4.52
 * config silently calls the wrong one.
 *
 * @param {object} args union of both arms' inputs, plus:
 * @param {boolean} [args.reviewFixes=false] false -> baseline (4.52), true -> review-fixes arm
 */
function supersedeDecisionFor({ reviewFixes = false, ...args }) {
    return reviewFixes ? supersedeDecisionReviewFixes(args) : supersedeDecisionBaseline(args);
}

export {
    normWords,
    tokenizeWithOffsets,
    commonPrefixLen,
    computeSourceDelta,
    buildDeadlinePayload,
    tailIsSignificant,
    supersedeDecisionBaseline,
    supersedeDecisionReviewFixes,
    supersedeDecisionFor,
};
