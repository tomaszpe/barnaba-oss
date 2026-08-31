/**
 * sourceSemanticRepeatShadow - SHADOW-only detection of semantic
 * repeats ACROSS emissions, on full closed DE source units, before fan-out.
 *
 * Contract:
 *  - never mutates text, fan-out, TTS or client config — `observe()` returns void;
 *  - scores only FULL, CLOSED units (a punctuation shard is not a claim);
 *  - history is per (churchId, sessionEpoch), pruned by BOTH a time window (150 s)
 *    and a hard unit cap (32) — the cap alone missed families that return after
 *    88-116 s, the window alone would grow without bound during dense speech;
 *  - both thresholds are scored in ONE pass: 0.75 = high-precision candidate,
 *    0.70 = exploratory only (3 known false positives at that level — never apply);
 *  - the BEST ELIGIBLE match wins, not the first one above threshold, and the best
 *    RAW match is logged alongside it so a guard can never hide what it blocked;
 *  - embedding runs off the hot path: `observe()` enqueues and returns, a bounded
 *    per-church queue drains sequentially. Overflow and errors are logged as
 *    `unscored`, never thrown — `await embedTextForDedup()` inside
 *    processCompleteSentence would change latency and contaminate delivery metrics.
 *
 * `new_lexical_token_count` is deliberately NOT called "new content": it counts
 * content-word types absent from the previous unit. It is a lexical proxy, and the
 * one signal that separated real repeats (<=2) from hard-negatives (>=4) offline.
 */

import { splitUnits, contentTokens, cosineSimilarity } from './intraEmissionDedupService.js';
import { hasRhetoricalRepeatIntent } from './b4RhetoricalRepeatPolicy.js';

export const DEFAULT_SHADOW_CONFIG = {
    enabled: false,
    windowSec: 150,
    maxHistoryUnits: 32,
    tauHighPrecision: 0.75,
    tauExploratory: 0.70,
    maxNewLexicalTokens: 2,
    minUnitWords: 4,
    minUnitContentTokens: 2,
    maxQueueDepth: 32,
    // Offline-measured mean: sum(tts audio_duration_estimate_ms) / sum(DE source words)
    // across the three sealed 05/04.08 sessions. A CONSTANT, not this unit's real audio —
    // hence `audio_estimate_basis` travels with every number derived from it.
    secPerSourceWord: 0.342,
};

const WORD_RE = /[\p{L}\p{N}]+/gu;
const TERMINAL_RE = /[.!?]+["'»”’)\]]*$/;

const OPEN_ENDING_WORDS = new Set([
    'und', 'oder', 'aber', 'denn', 'weil', 'dass', 'als', 'wenn', 'sondern', 'doch',
    'sowie', 'obwohl', 'damit', 'falls', 'bevor', 'nachdem', 'waehrend', 'während', 'sobald', 'wie',
    'in', 'an', 'auf', 'fuer', 'für', 'mit', 'von', 'zu', 'bei', 'nach', 'ueber', 'über',
    'unter', 'vor', 'durch', 'um', 'aus', 'gegen', 'ohne', 'seit', 'trotz', 'zwischen',
    'der', 'die', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    'dem', 'den', 'des', 'dieser', 'diese', 'dieses',
    'was', 'welche', 'welcher', 'welches', 'welchem', 'welchen', 'deren', 'dessen', 'denen',
]);

const NEGATIONS = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nie', 'niemals', 'without', 'not', 'no']);

const wordCount = (text) => (String(text || '').match(WORD_RE) || []).length;

const rawTokens = (text) => String(text || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .match(WORD_RE) || [];

const lastWord = (text) => {
    const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    return words.length ? words[words.length - 1] : '';
};

export const isClosedUnit = (text) => TERMINAL_RE.test(String(text || '').trim()) && !OPEN_ENDING_WORDS.has(lastWord(text));

export const isFullUnit = (text, config = DEFAULT_SHADOW_CONFIG) => (
    wordCount(text) >= config.minUnitWords
    && new Set(contentTokens(text)).size >= config.minUnitContentTokens
);

// Any difference in the number sets is a conflict — INCLUDING one side having no
// numbers at all. "Hiob hatte viele Schafe." vs "Hiob hatte 7000 Schafe." is a
// quantified claim replacing an unquantified one; suppressing the quantified unit
// would delete the only place the figure was ever said.
const hasConflictingNumbers = (a, b) => {
    const an = new Set(String(a || '').match(/\d+/g) || []);
    const bn = new Set(String(b || '').match(/\d+/g) || []);
    if (an.size === 0 && bn.size === 0) return false;
    if (an.size !== bn.size) return true;
    for (const value of an) if (!bn.has(value)) return true;
    return false;
};

const hasNegationFlip = (a, b) => (
    rawTokens(a).some((t) => NEGATIONS.has(t)) !== rawTokens(b).some((t) => NEGATIONS.has(t))
);

const hasBalancedQuote = (text) => {
    const value = String(text || '');
    return /«[^«»]*»/.test(value) || /„[^„“”]*[“”]/.test(value) || /"[^"]{3,}"/.test(value);
};

const looksLikeProtectedRepeat = (text) => {
    const value = String(text || '').trim();
    if (hasBalancedQuote(value)) return true;
    if (/^\d+[.)]/.test(value)) return true;
    if (/\b\d+\s*[,.:]\s*\d+\b/.test(value)) return true;
    return false;
};

const longestCommonRun = (a, b) => {
    if (!a.length || !b.length) return 0;
    let best = 0;
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        const curr = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                curr[j] = prev[j - 1] + 1;
                if (curr[j] > best) best = curr[j];
            }
        }
        prev = curr;
    }
    return best;
};

/**
 * Lexical signals + guards for one (previous, current) pair. Pure, no embeddings.
 */
export const pairSignals = (previousText, currentText) => {
    const prevContent = new Set(contentTokens(previousText));
    const currContent = new Set(contentTokens(currentText));
    let shared = 0;
    for (const token of currContent) if (prevContent.has(token)) shared++;
    const minSize = Math.min(prevContent.size, currContent.size);
    const unionSize = prevContent.size + currContent.size - shared;
    const prevRaw = rawTokens(previousText);
    const currRaw = rawTokens(currentText);
    const run = longestCommonRun(prevRaw, currRaw);

    let newLexicalTokenCount = 0;
    for (const token of currContent) if (!prevContent.has(token)) newLexicalTokenCount++;

    return {
        new_lexical_token_count: newLexicalTokenCount,
        containment: minSize > 0 ? Number((shared / minSize).toFixed(4)) : 0,
        jaccard: unionSize > 0 ? Number((shared / unionSize).toFixed(4)) : 0,
        run,
        run_coverage: Math.min(prevRaw.length, currRaw.length) > 0
            ? Number((run / Math.min(prevRaw.length, currRaw.length)).toFixed(4))
            : 0,
        guard_numbers: hasConflictingNumbers(previousText, currentText),
        guard_negation: hasNegationFlip(previousText, currentText),
        guard_quote: looksLikeProtectedRepeat(previousText) || looksLikeProtectedRepeat(currentText),
        guard_rhetorical: hasRhetoricalRepeatIntent(currentText),
        // The previous unit survives verbatim inside a LONGER current one: the current is the
        // fuller version (INTRA's `expanded_correction`, which drops the PREVIOUS). P2.7 may
        // never drop an earlier unit, so suppressing the current here would delete content
        // the listener never heard in full. Two offline false positives came from exactly this.
        guard_expansion: run === prevRaw.length && currRaw.length > prevRaw.length,
    };
};

export const GUARD_KEYS = ['guard_numbers', 'guard_negation', 'guard_quote', 'guard_rhetorical', 'guard_expansion'];

export const firedGuards = (signals) => GUARD_KEYS.filter((key) => signals[key]);

/**
 * Verdict ladder for one scored unit. `matches` are {entry, cosine, signals}.
 * Returns the verdict plus the best RAW and best ELIGIBLE match, so a blocked
 * candidate is always visible in telemetry.
 */
export const decideVerdict = (matches, config = DEFAULT_SHADOW_CONFIG) => {
    if (!matches.length) {
        return { verdict: 'keep', reason: 'no_history', bestRaw: null, bestEligible: null };
    }
    const byCosine = [...matches].sort((a, b) => b.cosine - a.cosine);
    const bestRaw = byCosine[0];

    const eligible = byCosine.filter((m) => (
        firedGuards(m.signals).length === 0
        && m.signals.new_lexical_token_count <= config.maxNewLexicalTokens
        && m.cosine >= config.tauExploratory
    ));
    const bestEligible = eligible.length ? eligible[0] : null;

    if (bestEligible) {
        const highPrecision = bestEligible.cosine >= config.tauHighPrecision;
        return {
            verdict: highPrecision ? 'candidate_high_precision' : 'candidate_exploratory',
            reason: highPrecision ? 'above_high_precision_tau' : 'above_exploratory_tau',
            bestRaw,
            bestEligible,
        };
    }

    if (bestRaw.cosine < config.tauExploratory) {
        return { verdict: 'keep', reason: 'below_exploratory_tau', bestRaw, bestEligible: null };
    }

    // The verdict describes the STRONGEST relation found (best raw match). A guard is the
    // stronger statement about why nothing may be suppressed, so it wins over "new content".
    const guards = firedGuards(bestRaw.signals);
    if (guards.length > 0) {
        return { verdict: 'guarded', reason: guards.join(','), bestRaw, bestEligible: null };
    }
    return { verdict: 'related_with_new_content', reason: 'new_lexical_tokens_above_max', bestRaw, bestEligible: null };
};

const unitId = (sessionEpoch, releaseSeq, unitIndex) => `${sessionEpoch ?? 'no_epoch'}:${releaseSeq ?? 'no_seq'}:${unitIndex}`;

/**
 * Validate + normalize the config. A bad env value must DISABLE the shadow, never
 * half-configure it: `parseInt('abc')` is NaN, and `queue.length >= NaN` is false
 * forever, which would turn the bounded queue into an unbounded one.
 * @returns {{config: object, errors: string[]}}
 */
export const normalizeShadowConfig = (input = {}) => {
    const merged = { ...DEFAULT_SHADOW_CONFIG, ...input };
    const errors = [];

    const positiveNumber = (key) => {
        const value = Number(merged[key]);
        if (!Number.isFinite(value) || value <= 0) {
            errors.push(`${key}=${merged[key]} (expected a finite number > 0)`);
            return;
        }
        merged[key] = value;
    };
    const nonNegativeInteger = (key) => {
        const value = Number(merged[key]);
        if (!Number.isInteger(value) || value < 0) {
            errors.push(`${key}=${merged[key]} (expected an integer >= 0)`);
            return;
        }
        merged[key] = value;
    };
    const positiveInteger = (key) => {
        const value = Number(merged[key]);
        if (!Number.isInteger(value) || value <= 0) {
            errors.push(`${key}=${merged[key]} (expected an integer > 0)`);
            return;
        }
        merged[key] = value;
    };
    const unitInterval = (key) => {
        const value = Number(merged[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            errors.push(`${key}=${merged[key]} (expected a number in [0, 1])`);
            return;
        }
        merged[key] = value;
    };

    positiveNumber('windowSec');
    positiveInteger('maxHistoryUnits');
    positiveInteger('maxQueueDepth');
    positiveInteger('minUnitWords');
    positiveInteger('minUnitContentTokens');
    nonNegativeInteger('maxNewLexicalTokens');
    unitInterval('tauExploratory');
    unitInterval('tauHighPrecision');
    positiveNumber('secPerSourceWord');

    if (Number.isFinite(merged.tauExploratory) && Number.isFinite(merged.tauHighPrecision)
        && merged.tauExploratory > merged.tauHighPrecision) {
        errors.push(`tauExploratory=${merged.tauExploratory} > tauHighPrecision=${merged.tauHighPrecision}`);
    }

    merged.enabled = merged.enabled === true && errors.length === 0;
    merged.configErrors = errors;
    return { config: merged, errors };
};

/**
 * Split one post-filter emission into the units the shadow reasons about.
 * Exported so the `source_semantic_reference` event and the shadow agree by construction.
 */
// NOTE: `splitUnits` returns {index, raw} objects, not strings.
export const buildSourceUnits = ({ sessionEpoch, releaseSeq, text }, config = DEFAULT_SHADOW_CONFIG) => (
    splitUnits(text).map(({ raw }, index) => ({
        source_unit_id: unitId(sessionEpoch, releaseSeq, index),
        unit_index: index,
        text: raw,
        words: wordCount(raw),
        content_tokens: new Set(contentTokens(raw)).size,
        closed: isClosedUnit(raw),
        full_unit: isFullUnit(raw, config),
        scorable: isClosedUnit(raw) && isFullUnit(raw, config),
    }))
);

const noop = () => {};

class SourceSemanticRepeatShadow {
    constructor({ embedFn, logFn, now, config } = {}) {
        this._embedFn = embedFn;
        this._logFn = logFn || noop;
        this._now = now || (() => Date.now());
        const { config: normalized, errors } = normalizeShadowConfig(config || {});
        this._config = normalized;
        this._configErrors = errors;
        if (errors.length > 0) {
            // Invalid config disables measurement outright and says so once, loudly.
            // A partially applied config would silently drop the memory bounds.
            this._log({
                stage: 'source_semantic_repeat_shadow',
                verdict: 'unscored',
                reason: 'invalid_config',
                config_state: 'INVALID/DISABLED',
                config_errors: errors,
            });
        }
        /** @type {Map<string, {sessionEpoch: string|null, entries: Array}>} */
        this._history = new Map();
        /** @type {Map<string, {items: Array, draining: boolean}>} */
        this._queues = new Map();
        this._stats = { observed: 0, scored: 0, unscored: 0, dropped: 0 };
    }

    get config() { return this._config; }

    get configErrors() { return [...this._configErrors]; }

    stats() { return { ...this._stats }; }

    /**
     * Queue one emission for shadow scoring. Returns immediately; never throws.
     * @returns {number} units queued (0 when disabled or nothing scorable)
     */
    observe({ churchId, sessionEpoch = null, releaseSeq = null, text, units = null, activeLanguages = null } = {}) {
        if (!this._config.enabled) return 0;
        try {
            const built = units || buildSourceUnits({ sessionEpoch, releaseSeq, text }, this._config);
            const scorable = built.filter((unit) => unit.scorable);
            if (scorable.length === 0) return 0;

            const key = String(churchId ?? '_default');
            const queue = this._queues.get(key) || { items: [], draining: false };
            this._queues.set(key, queue);

            const tsMs = this._now();
            for (const unit of scorable) {
                if (queue.items.length >= this._config.maxQueueDepth) {
                    this._stats.dropped++;
                    this._stats.unscored++;
                    this._log({
                        stage: 'source_semantic_repeat_shadow',
                        churchId: key,
                        session_epoch: sessionEpoch,
                        release_seq: releaseSeq,
                        source_unit_id: unit.source_unit_id,
                        unit_index: unit.unit_index,
                        verdict: 'unscored',
                        reason: 'queue_overflow',
                        queue_depth: queue.items.length,
                    });
                    continue;
                }
                queue.items.push({ churchId: key, sessionEpoch, releaseSeq, unit, tsMs, activeLanguages });
                this._stats.observed++;
            }
            this._drain(key);
            return scorable.length;
        } catch (error) {
            this._stats.unscored++;
            this._log({ stage: 'source_semantic_repeat_shadow', churchId, verdict: 'unscored', reason: 'observe_error', error: error?.message });
            return 0;
        }
    }

    /** Await the currently queued work — tests only; production never blocks on this. */
    async idle() {
        const busy = () => [...this._queues.values()].some((queue) => queue.items.length > 0 || queue.draining);
        for (let guard = 0; guard < 1000 && busy(); guard++) {
            const pending = [...this._queues.values()].map((queue) => queue.drainPromise).filter(Boolean);
            if (pending.length === 0) break;
            await Promise.all(pending);
        }
    }

    reset() {
        this._history.clear();
        this._queues.clear();
    }

    _drain(key) {
        const queue = this._queues.get(key);
        if (!queue || queue.draining) return;
        queue.draining = true;
        queue.drainPromise = (async () => {
            try {
                while (queue.items.length > 0) {
                    const item = queue.items.shift();
                    try {
                        await this._score(item);
                    } catch (error) {
                        // Fail-open must hold for EVERY throw inside scoring, not only the
                        // embedding call — an escaping rejection here would surface as an
                        // unhandled promise rejection and could take the process down.
                        this._stats.unscored++;
                        this._log({
                            stage: 'source_semantic_repeat_shadow',
                            churchId: item?.churchId ?? null,
                            session_epoch: item?.sessionEpoch ?? null,
                            release_seq: item?.releaseSeq ?? null,
                            source_unit_id: item?.unit?.source_unit_id ?? null,
                            verdict: 'unscored',
                            reason: 'score_error',
                            error: error?.message,
                        });
                    }
                }
            } finally {
                queue.draining = false;
                queue.drainPromise = null;
            }
        })();
    }

    _historyFor(churchId, sessionEpoch) {
        const existing = this._history.get(churchId);
        // A new session epoch means a new sermon/session: history must not leak across it.
        if (!existing || existing.sessionEpoch !== sessionEpoch) {
            const fresh = { sessionEpoch, entries: [] };
            this._history.set(churchId, fresh);
            return fresh;
        }
        return existing;
    }

    _prune(history, nowMs) {
        const cutoff = nowMs - this._config.windowSec * 1000;
        let entries = history.entries.filter((entry) => entry.tsMs >= cutoff);
        if (entries.length > this._config.maxHistoryUnits) {
            entries = entries.slice(entries.length - this._config.maxHistoryUnits);
        }
        history.entries = entries;
    }

    async _score({ churchId, sessionEpoch, releaseSeq, unit, tsMs, activeLanguages }) {
        const history = this._historyFor(churchId, sessionEpoch);
        this._prune(history, tsMs);

        let embedding = null;
        try {
            embedding = await this._embedFn(unit.text);
        } catch (error) {
            this._stats.unscored++;
            this._log({
                stage: 'source_semantic_repeat_shadow',
                churchId,
                session_epoch: sessionEpoch,
                release_seq: releaseSeq,
                source_unit_id: unit.source_unit_id,
                unit_index: unit.unit_index,
                verdict: 'unscored',
                reason: 'embed_error',
                error: error?.message,
            });
            return;
        }

        if (!Array.isArray(embedding) || embedding.length === 0) {
            this._stats.unscored++;
            this._log({
                stage: 'source_semantic_repeat_shadow',
                churchId,
                session_epoch: sessionEpoch,
                release_seq: releaseSeq,
                source_unit_id: unit.source_unit_id,
                unit_index: unit.unit_index,
                verdict: 'unscored',
                reason: 'empty_embedding',
            });
            return;
        }

        const matches = [];
        for (const entry of history.entries) {
            // Same emission = INTRA's job, not P2.7's.
            if (entry.releaseSeq === releaseSeq) continue;
            const cosine = cosineSimilarity(entry.embedding, embedding);
            if (!Number.isFinite(cosine)) continue;
            matches.push({ entry, cosine, signals: pairSignals(entry.text, unit.text) });
        }

        const decision = decideVerdict(matches, this._config);
        this._stats.scored++;
        this._log(this._buildRecord({ churchId, sessionEpoch, releaseSeq, unit, tsMs, activeLanguages, history, decision }));

        history.entries.push({
            sourceUnitId: unit.source_unit_id,
            releaseSeq,
            unitIndex: unit.unit_index,
            text: unit.text,
            words: unit.words,
            embedding,
            tsMs,
        });
        this._prune(history, tsMs);
    }

    _buildRecord({ churchId, sessionEpoch, releaseSeq, unit, tsMs, activeLanguages, history, decision }) {
        const describe = (match, prefix) => {
            if (!match) return {};
            return {
                [`${prefix}_source_unit_id`]: match.entry.sourceUnitId,
                [`${prefix}_release_seq`]: match.entry.releaseSeq,
                [`${prefix}_unit_index`]: match.entry.unitIndex,
                [`${prefix}_cosine`]: Number(match.cosine.toFixed(4)),
                [`${prefix}_delta_sec`]: Number(((tsMs - match.entry.tsMs) / 1000).toFixed(1)),
                [`${prefix}_text`]: String(match.entry.text).slice(0, 200),
                [`${prefix}_new_lexical_token_count`]: match.signals.new_lexical_token_count,
                [`${prefix}_jaccard`]: match.signals.jaccard,
                [`${prefix}_containment`]: match.signals.containment,
                [`${prefix}_run`]: match.signals.run,
                [`${prefix}_run_coverage`]: match.signals.run_coverage,
                [`${prefix}_guards`]: firedGuards(match.signals),
            };
        };

        const eligible = decision.bestEligible;
        return {
            stage: 'source_semantic_repeat_shadow',
            churchId,
            session_epoch: sessionEpoch,
            release_seq: releaseSeq,
            source_unit_id: unit.source_unit_id,
            unit_index: unit.unit_index,
            unit_text: String(unit.text).slice(0, 200),
            unit_words: unit.words,
            active_languages: activeLanguages,
            verdict: decision.verdict,
            reason: decision.reason,
            candidate_high_precision: decision.verdict === 'candidate_high_precision',
            candidate_exploratory: decision.verdict === 'candidate_high_precision' || decision.verdict === 'candidate_exploratory',
            tau_high_precision: this._config.tauHighPrecision,
            tau_exploratory: this._config.tauExploratory,
            max_new_lexical_tokens: this._config.maxNewLexicalTokens,
            history_units: history.entries.length,
            history_window_sec: this._config.windowSec,
            // Named for what it is: a constant-rate ESTIMATE, not this unit's audio.
            estimated_redundant_audio_sec: eligible
                ? Number((unit.words * this._config.secPerSourceWord).toFixed(2))
                : null,
            audio_estimate_basis: eligible ? 'sec_per_source_word_constant' : null,
            sec_per_source_word: eligible ? this._config.secPerSourceWord : null,
            ...describe(decision.bestRaw, 'best_raw'),
            ...describe(decision.bestEligible, 'best_eligible'),
        };
    }

    _log(entry) {
        try { this._logFn(entry); } catch { /* telemetry must never break the pipeline */ }
    }
}

export const createSourceSemanticRepeatShadow = (options) => new SourceSemanticRepeatShadow(options);

export { SourceSemanticRepeatShadow };
