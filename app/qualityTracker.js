/**
 * Quality Tracker — per-emission metrics for dedup optimization
 * =============================================================
 * Tracks word-level repetitions, pause buckets, and filter actions.
 * Writes buffered JSONL to /app/logs/quality-{date}.jsonl (Azure Files persistent).
 *
 * Usage:
 *   import qualityTracker from './qualityTracker.js';
 *   qualityTracker.trackFilterAction(churchId, 'P2', 'trim');
 *   qualityTracker.trackEmission(churchId, lang, { ... });
 *   qualityTracker.flushSessionSummary(churchId, 'disconnect');
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// /app/logs is Azure Files mount on both DEV and PROD
const LOG_DIR = process.env.QUALITY_LOG_DIR || '/app/logs';
const FLUSH_INTERVAL_MS = 250;
const ENABLED = process.env.QUALITY_TRACKING !== 'false'; // default: enabled

// --- Objective score weights ---
// Tune these on 3-5 historical sessions where you know subjectively which was better.
// Lower score = better configuration.
const SCORE_WEIGHTS = {
    R: 1.0,   // word repetitions per EMISSION (per-listener problem, scales with langs)
    P: 2.0,   // non-speaker pauses >=7s per emission (avg across langs)
    S: 5.0,   // starvation: too few SEGMENTS per minute (pipeline-level, lang-independent)
};

// Hard rejection thresholds — if exceeded, configuration is disqualified (penalty = +Infinity).
// CRITICAL: All denominators use SEGMENTS (DE inputs), not EMISSIONS (segments × langs).
// Using emissions would inflate metrics by language count and mask problems in
// multi-language sessions.
const HARD_LIMITS = {
    medianLatencyMs: 6000,         // median translation latency above 6s is unacceptable
    minSegments: 10,               // sessions with <10 DE segments are not measurable
    minSegmentsPerMin: 3.0,        // below 3 segments/min the pipeline is starving
};

// Optimizer reliability thresholds — sessions below these are still accepted and logged,
// but flagged with lowConfidence:true so Optuna can filter them out. The reasoning:
// Poisson statistics — for a rare event rate of ~0.05 (typical R_norm), you need ~500
// observations for the measurement error to drop below 20%. At 8 segments/min in a
// 3-language pipeline that's ~20 min wall-clock. Sessions shorter than this produce
// score values dominated by statistical noise, not filter quality differences.
const OPTIMIZER_LIMITS = {
    minSegments: 150,              // ~20 min @ 8 seg/min — below this R_norm is noisy
    minDurationMin: 15,             // hard wall-clock floor independent of segment rate
};

// Confidence scaling: sessions with more segments get higher confidence.
// Used for weighted_score = score / confidence — lets Optuna penalize short noisy runs.
// Clamped to [0.1, 1.0] so a 15-segment session doesn't get confidence=0.03 (which
// would blow up weighted_score to absurd levels).
const CONFIDENCE_FULL_SEGMENTS = 500;   // segments count at which confidence = 1.0
const CONFIDENCE_FLOOR = 0.1;           // minimum confidence value (prevents divide-by-tiny)

// Expected segment rate per minute — anything below contributes to S_norm.
// This is a property of the SPEAKER, not the pipeline (how often does the speaker
// produce a complete sentence). Calibrate from historical data.
const TARGET_SEGMENTS_PER_MIN = 8.0;

// In-memory buffer — flushed every 250ms
const buffer = [];
let flushTimer = null;
let dirReady = false;

// Per-church session state (accumulated during session, written on disconnect)
const sessions = new Map(); // churchId -> { startedAt, emissions, filterStats, pauseBuckets, dupTotals }

// Per-church per-lang last emission timestamp (for pause calculation)
const lastEmissionTime = new Map(); // churchId -> Map(lang -> timestamp)

// Per-church last DE input timestamp (for isSpeakerPause calculation)
const lastDEInputTime = new Map(); // churchId -> timestamp

// Per-emission filter actions collector (accumulated across filters, flushed with emission)
const pendingFilterActions = new Map(); // churchId -> { P2, B4, B2, P3, T5, BCL, PF, B1, punctGate }

function getDayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getLogFile() {
    return path.join(LOG_DIR, `quality-${getDayKey()}.jsonl`);
}

function pushToBuffer(record) {
    if (!ENABLED) return;
    buffer.push(record);
    if (!flushTimer) {
        flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
    }
}

function flushBuffer() {
    flushTimer = null;
    if (buffer.length === 0) return;

    const batch = buffer.splice(0, buffer.length)
        .map(r => JSON.stringify(r))
        .join('\n') + '\n';

    const file = getLogFile();

    const doWrite = () => {
        fs.appendFile(file, batch, 'utf8', (err) => {
            if (err) console.error('[QualityTracker] Write error:', err.message);
        });
    };

    if (!dirReady) {
        fs.mkdir(LOG_DIR, { recursive: true }, (err) => {
            if (err && err.code !== 'EEXIST') {
                console.error('[QualityTracker] Mkdir error:', err.message);
                return;
            }
            dirReady = true;
            doWrite();
        });
    } else {
        doWrite();
    }
}

function getSession(churchId) {
    if (!sessions.has(churchId)) {
        sessions.set(churchId, {
            startedAt: new Date().toISOString(),
            config: null,           // set via setSessionConfig()
            configHash: null,       // sha256(canonical(config)).slice(0,12)
            meta: null,             // optional {goldenSetName, trialId, ...} — NOT hashed
                                    // (identifies WHICH run, not WHAT config)
            segments: 0,            // DE inputs count (incremented in trackDEInput)
                                    // — language-independent, used as denominator in score
            emissions: 0,           // total emissions to listeners (segments × active langs)
                                    // — diagnostic only, NOT used in score (would inflate
                                    // R_norm/S_norm by language count — see W3)
            filterStats: {
                P2:  { emit: 0, trim: 0, skip: 0, warn: 0 },
                B4:  { emit: 0, trim: 0, skip: 0 },
                B2:  { emit: 0, trim: 0, skip: 0 },
                P3:  { emit: 0, trim: 0, skip: 0 },
                INTRA: { emit: 0, trim: 0, blocked: 0 },
                INTRA_SEM: { emit: 0, trim: 0, blocked: 0, dry_run: 0 },
                T5:  { emit: 0, skip: 0 },
                BCL: { emit: 0, trim: 0, semantic_shadow: 0, protected: 0 },
                PF:  { fired: 0, blocked: 0 },
                B1:  { pass: 0, reject: 0 },
                punctGate: { pass: 0, hold: 0 },
            },
            pauseBuckets: { '0-3s': 0, '3-7s': 0, '7-15s': 0, '>15s': 0 },
            speakerPauses: 0,
            speakerPauses7sPlus: 0,
            dupTotals: {
                adjacentWordDups: 0,
                effectiveAdjacentWordDups: 0,
                rhetoricalAdjacentWordDups: 0,
                bigramDups: 0,
                trigramDups: 0,
            },
            // emissionLog grows unbounded during session. Size: ~500B per record.
            // 2h session × 5 langs × 8 em/min ≈ 4800 records ≈ 2.4 MB — acceptable.
            // If session duration can exceed 4h, introduce a rolling buffer here (I4).
            emissionLog: [], // per-emission records for report generation
        });
    }
    return sessions.get(churchId);
}

function getPauseBucket(ms) {
    if (ms < 3000) return '0-3s';
    if (ms < 7000) return '3-7s';
    if (ms < 15000) return '7-15s';
    return '>15s';
}

function tokenizeForRepetition(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[\p{L}\p{N}]+/gu) || [];
}

function countAdjacentWordDupsFromText(text) {
    const words = tokenizeForRepetition(text);
    let count = 0;
    for (let i = 1; i < words.length; i++) {
        if (words[i] === words[i - 1]) count++;
    }
    return count;
}

function deriveEffectiveRepetitions(repetitions = {}, sourceText = '') {
    const rawAdjacent = Number(repetitions.adjacentWordDups) || 0;
    const sourceAdjacent = countAdjacentWordDupsFromText(sourceText);
    const rhetoricalAdjacent = Math.min(rawAdjacent, sourceAdjacent);
    const effectiveAdjacent = Math.max(0, rawAdjacent - rhetoricalAdjacent);

    return {
        adjacentWordDups: rawAdjacent,
        effectiveAdjacentWordDups: effectiveAdjacent,
        rhetoricalAdjacentWordDups: rhetoricalAdjacent,
        bigramDups: Number(repetitions.bigramDups) || 0,
        trigramDups: Number(repetitions.trigramDups) || 0,
        totalWordDups: Number(repetitions.totalWordDups) || rawAdjacent,
    };
}

/**
 * Canonical JSON serialization with recursively sorted keys.
 * Required for deterministic config hash regardless of property insertion order.
 * Works for arbitrarily nested objects (unlike JSON.stringify replacer-array,
 * which only filters top-level keys).
 */
function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// --- Public API ---

/**
 * Set the filter configuration for this session. Call ONCE at session start,
 * before any trackDEInput / trackEmission calls. The config object should contain
 * all 14 filter parameters used in this run. configHash is a deterministic
 * 12-char SHA256 prefix that links session_summary records to a given experiment.
 *
 * @param {string} churchId
 * @param {object} configObject - filter parameters (gateway + whisper_frozen)
 * @param {object} [meta] - optional metadata about this specific run. Common fields:
 *   - goldenSetName: which audio file is being processed (e.g. 'golden_001.wav')
 *   - trialId: Optuna trial number (e.g. 42) for linking back to the study
 *   - runType: 'baseline' | 'optuna' | 'validation' | 'sensitivity'
 *   - notes: free-form string
 *   Meta is intentionally NOT hashed — two trials with the same config but
 *   different trialId must share the same configHash (hash = experiment identity,
 *   meta = run identity).
 *
 * RECONNECT BEHAVIOR (W5): If a session already exists for this churchId AND the
 * new config differs from the existing one, the session counters are reset.
 * This prevents counter accumulation across reconnects without explicit disconnect.
 * If the same config is set twice (idempotent), state is preserved.
 */
function setSessionConfig(churchId, configObject, meta = null) {
    if (!ENABLED) return;
    const canonical = canonicalJSON(configObject);
    const newHash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);

    const existing = sessions.get(churchId);
    if (existing && existing.configHash && existing.configHash !== newHash) {
        // Config changed mid-stream → treat as new experiment, reset state
        console.log(`[QualityTracker] Config change detected for ${churchId}: ${existing.configHash} → ${newHash}, resetting session`);
        sessions.delete(churchId);
        lastEmissionTime.delete(churchId);
        lastDEInputTime.delete(churchId);
        pendingFilterActions.delete(churchId);
    }

    const session = getSession(churchId);
    session.config = configObject;
    session.configHash = newHash;
    if (meta !== null) session.meta = meta;
}

/**
 * Record DE input arrival (for isSpeakerPause calculation).
 *
 * Position in pipeline (as of server.js:2557-2565):
 *   Whisper (Python: VAD, hallucination filter)
 *      -> [DE text reaches gateway]
 *      -> resetPendingFilters()
 *      -> trackDEInput()                      <-- THIS POINT
 *      -> sanity gate (alpha ratio)
 *      -> dedup filters (B1, B2, B4, P2, P3, T5, PF, punctGate, ...)
 *      -> emission
 *
 * Implications for K2 / P_norm:
 *   - Pauses caused by GATEWAY filters ARE counted as non-speaker pauses (good — that's
 *     what we want to optimize).
 *   - Pauses caused by WHISPER filters (VAD cutting silence, hallucination filter
 *     dropping garbage) are invisible here — they look like speaker silence to the
 *     tracker. This is fine as long as Whisper params stay frozen during a tuning
 *     campaign. If you change Whisper VAD/hallucination thresholds between runs,
 *     P_norm becomes non-comparable across those runs.
 *
 * Rule of thumb: optimize the 14 gateway filters with Whisper held constant.
 * Tune Whisper as a separate campaign with its own baseline.
 */
function trackDEInput(churchId) {
    if (!ENABLED) return;
    lastDEInputTime.set(churchId, Date.now());
    // Increment segments — language-independent counter used as denominator
    // for R_norm and S_norm. Must be incremented exactly once per DE input,
    // BEFORE any filters run (matches the position of trackDEInput in the pipeline).
    const session = getSession(churchId);
    session.segments++;
}

/**
 * Record a filter decision (called from processCompleteSentence)
 * Accumulated until trackEmission is called.
 */
function trackFilterAction(churchId, filterName, action) {
    if (!ENABLED) return;
    if (!pendingFilterActions.has(churchId)) {
        pendingFilterActions.set(churchId, {
            P2: 'n/a', B4: 'n/a', B2: 'n/a', P3: 'n/a',
            INTRA: 'n/a', INTRA_SEM: 'n/a', T5: 'n/a', BCL: 'n/a', PF: 'n/a', B1: 'n/a', punctGate: 'n/a'
        });
    }
    pendingFilterActions.get(churchId)[filterName] = action;

    // Update session stats
    const session = getSession(churchId);
    const stats = session.filterStats[filterName];
    if (stats && action in stats) {
        stats[action]++;
    }
}

/**
 * Record a translation emission to a listener (1 record per lang per emission)
 */
function trackEmission(churchId, lang, data = {}) {
    if (!ENABLED) return;

    const now = Date.now();
    const session = getSession(churchId);
    session.emissions++;

    // Pause calculation
    if (!lastEmissionTime.has(churchId)) lastEmissionTime.set(churchId, new Map());
    const langTimes = lastEmissionTime.get(churchId);
    const prevTime = langTimes.get(lang) || 0;
    const sinceLastMs = prevTime > 0 ? now - prevTime : 0;
    langTimes.set(lang, now);

    const bucket = prevTime > 0 ? getPauseBucket(sinceLastMs) : '0-3s';

    // isSpeakerPause: true if no DE input since last emission (speaker is silent)
    const lastDE = lastDEInputTime.get(churchId) || 0;
    const isSpeakerPause = prevTime > 0 && lastDE < prevTime;

    // Update session pause stats
    if (prevTime > 0) {
        session.pauseBuckets[bucket]++;
        if (isSpeakerPause) {
            session.speakerPauses++;
            if (bucket === '7-15s' || bucket === '>15s') session.speakerPauses7sPlus++;
        }
    }

    const repetitions = deriveEffectiveRepetitions(data.repetitions, data.sourceText);

    // Update session dup stats. Raw adjacent dups stay diagnostic; effective adjacent
    // dups drive scoring so source-side rhetorical repetitions are not treated as
    // hallucinated translation loops.
    session.dupTotals.adjacentWordDups += repetitions.adjacentWordDups;
    session.dupTotals.effectiveAdjacentWordDups += repetitions.effectiveAdjacentWordDups;
    session.dupTotals.rhetoricalAdjacentWordDups += repetitions.rhetoricalAdjacentWordDups;
    session.dupTotals.bigramDups += repetitions.bigramDups;
    session.dupTotals.trigramDups += repetitions.trigramDups;

    // Get and clear pending filter actions
    const filters = pendingFilterActions.get(churchId) || {
        P2: 'n/a', B4: 'n/a', B2: 'n/a', P3: 'n/a',
        INTRA: 'n/a', INTRA_SEM: 'n/a', T5: 'n/a', BCL: 'n/a', PF: 'n/a', B1: 'n/a', punctGate: 'n/a'
    };

    const record = {
        ts: new Date(now).toISOString(),
        type: 'emission',
        churchId,
        lang,
        emissionId: session.emissions,
        repetitions,
        pause: {
            sinceLastEmissionMs: sinceLastMs,
            bucket,
            isSpeakerPause,
        },
        filters: { ...filters },
        latency: data.latency || {},
    };

    // Store for report generation
    session.emissionLog.push(record);

    pushToBuffer(record);
}

/**
 * Record when a filter blocks the entire pipeline (no emission happens)
 * Used for skip actions where no translation is produced.
 */
function trackPipelineBlock(churchId, filterName, reason) {
    if (!ENABLED) return;
    pushToBuffer({
        ts: new Date().toISOString(),
        type: 'pipeline_block',
        churchId,
        filter: filterName,
        reason,
    });
    // Defensive: clear pending filter actions so they don't bleed into next emission.
    // Today resetPendingFilters at start of next cycle handles this, but explicit
    // cleanup here makes the contract robust to future pipeline changes (C2).
    pendingFilterActions.delete(churchId);
}

/**
 * Record fallback event
 */
function trackFallback(churchId, action, similarity) {
    if (!ENABLED) return;
    const session = getSession(churchId);
    if (action === 'fired') session.filterStats.PF.fired++;
    if (action === 'blocked') session.filterStats.PF.blocked++;

    pushToBuffer({
        ts: new Date().toISOString(),
        type: 'fallback',
        churchId,
        action,
        similarity,
    });
}

/**
 * Compute single-number objective score for optimizer (Optuna, grid search, etc.)
 *
 * Lower = better. Returns:
 *   {
 *     score:      Number      // main value to minimize; +Infinity if hard limit hit
 *     accepted:   Boolean     // false if any HARD_LIMITS exceeded
 *     components: { R_norm, P_norm, S_norm, weighted_R, weighted_P, weighted_S }
 *     raw:        { ... }     // underlying numbers for debugging
 *     rejection:  String|null // human-readable reason if accepted=false
 *   }
 *
 * Components:
 *   R_norm = adjacentWordDups / emissions
 *      Word repetitions per emission. Only adjacentWordDups is used —
 *      bigram/trigram counts are double/triple-counting the same phenomenon.
 *
 *   P_norm = avg over languages of (nonSpeakerPauses>=7s in lang / emissions in lang)
 *      Per-language averaging avoids inflating the score with the number of
 *      target languages (5 langs sharing one system-wide pause should count once,
 *      not five times).
 *
 *   S_norm = max(0, 1 - actualEmissionsPerMin / TARGET_EMISSIONS_PER_MIN)
 *      Starvation penalty. 0 when pipeline produces at or above target rate;
 *      grows linearly to 1.0 as emissions/min approaches zero. Without this term
 *      the optimizer would happily pick configurations that filter everything out
 *      (zero repetitions, zero pauses, zero content).
 */
function computeObjectiveScore(session, now = Date.now()) {
    const log = session.emissionLog;
    const durationMs = now - new Date(session.startedAt).getTime();
    const durationMin = durationMs / 60000;

    // --- Raw numbers ---
    // CRITICAL: use `segments` (DE inputs) as denominator, NOT `emissions`.
    // emissions = segments × active_langs, so using emissions would make sessions
    // with more languages look artificially better (W3 in code review).
    const segments = session.segments;
    const emissions = session.emissions; // diagnostic only
    const adjacentDups = session.dupTotals.effectiveAdjacentWordDups ?? session.dupTotals.adjacentWordDups;
    const rawAdjacentDups = session.dupTotals.adjacentWordDups;

    // Latency: median across all emissions
    const latencies = log.map(e => e.latency?.translationMs).filter(v => typeof v === 'number');
    const sortedLat = [...latencies].sort((a, b) => a - b);
    const medianLatency = sortedLat.length > 0
        ? sortedLat[Math.floor(sortedLat.length / 2)]
        : 0;

    // Per-language non-speaker pauses >=7s, normalized by per-lang emission count
    // Replaces the old (buggy) approach of summing pause buckets across all langs.
    const langAgg = {}; // lang -> { emissions, nonSpeakerPauses7sPlus }
    for (const e of log) {
        if (!langAgg[e.lang]) langAgg[e.lang] = { emissions: 0, nonSpeakerPauses7sPlus: 0 };
        langAgg[e.lang].emissions++;
        const isLong = e.pause.bucket === '7-15s' || e.pause.bucket === '>15s';
        if (isLong && !e.pause.isSpeakerPause) {
            langAgg[e.lang].nonSpeakerPauses7sPlus++;
        }
    }
    const perLangPauseRates = Object.values(langAgg)
        .map(s => s.emissions > 0 ? s.nonSpeakerPauses7sPlus / s.emissions : 0);
    const P_norm = perLangPauseRates.length > 0
        ? perLangPauseRates.reduce((a, b) => a + b, 0) / perLangPauseRates.length
        : 0;

    const R_norm = emissions > 0 ? adjacentDups / emissions : 0;
    // Note: R_norm uses EMISSIONS, not segments. Word repetitions are a per-listener
    // problem — a repetition in the PL stream and a repetition in the EN stream are
    // two independent defects, each heard by a different user. Both numerator
    // (session.dupTotals.adjacentWordDups) and denominator (session.emissions) scale
    // with language count, so R_norm stays invariant across sessions with different
    // active language counts. This is the correct fix for W3 for the repetition metric.

    // S_norm uses segments/min, NOT emissions/min. Starvation is a pipeline-level
    // problem — if gateway filters drop a segment, ALL languages lose that emission
    // simultaneously. Dividing by emissions would hide starvation in multi-lang
    // sessions (5 langs × half-rate pipeline looks the same as 1 lang × full-rate).
    const segmentsPerMin = durationMin > 0 ? segments / durationMin : 0;
    const S_norm = Math.max(0, 1 - segmentsPerMin / TARGET_SEGMENTS_PER_MIN);

    // --- Hard limits (disqualify configuration) ---
    // ORDER MATTERS: minSegments must be checked first — for 0 segments,
    // medianLatency=0 would falsely pass the latency limit (W7).
    let rejection = null;
    if (segments < HARD_LIMITS.minSegments) {
        rejection = `too few segments (${segments} < ${HARD_LIMITS.minSegments})`;
    } else if (medianLatency > HARD_LIMITS.medianLatencyMs) {
        rejection = `median latency ${medianLatency}ms > ${HARD_LIMITS.medianLatencyMs}ms`;
    } else if (segmentsPerMin < HARD_LIMITS.minSegmentsPerMin) {
        rejection = `starvation: ${segmentsPerMin.toFixed(2)} segments/min < ${HARD_LIMITS.minSegmentsPerMin}`;
    }

    const weighted_R = SCORE_WEIGHTS.R * R_norm;
    const weighted_P = SCORE_WEIGHTS.P * P_norm;
    const weighted_S = SCORE_WEIGHTS.S * S_norm;
    const baseScore = weighted_R + weighted_P + weighted_S;

    // Sentinel value for rejected configs. Using 1e9 instead of Infinity because
    // JSON.stringify(Infinity) === 'null', which would break the optimizer's parsing.
    const REJECT_SCORE = 1e9;

    // Confidence: how much we trust this score based on sample size.
    // Scales linearly from CONFIDENCE_FLOOR to 1.0 as segments grow to CONFIDENCE_FULL_SEGMENTS.
    const confidence = Math.max(
        CONFIDENCE_FLOOR,
        Math.min(1.0, segments / CONFIDENCE_FULL_SEGMENTS)
    );

    // Low-confidence flag: session too short for Optuna to trust the result.
    // NOT a rejection — score is still computed and logged, just flagged so the
    // optimizer script can filter it out (or weight it lower) when ranking configs.
    const lowConfidence =
        segments < OPTIMIZER_LIMITS.minSegments ||
        durationMin < OPTIMIZER_LIMITS.minDurationMin;

    // Weighted score for optimizer: short noisy sessions get penalized.
    // A session with confidence=0.2 and score=0.1 becomes weighted_score=0.5 — Optuna
    // sees it as worse than a long reliable session with score=0.3 (weighted_score=0.3).
    const weightedScore = rejection ? REJECT_SCORE : Number((baseScore / confidence).toFixed(4));

    return {
        score: rejection ? REJECT_SCORE : Number(baseScore.toFixed(4)),
        weighted_score: weightedScore,
        accepted: rejection === null,
        lowConfidence,
        confidence: Number(confidence.toFixed(3)),
        rejection,
        components: {
            R_norm: Number(R_norm.toFixed(4)),
            P_norm: Number(P_norm.toFixed(4)),
            S_norm: Number(S_norm.toFixed(4)),
            weighted_R: Number(weighted_R.toFixed(4)),
            weighted_P: Number(weighted_P.toFixed(4)),
            weighted_S: Number(weighted_S.toFixed(4)),
        },
        raw: {
            segments,                                  // primary denominator
            emissions,                                 // diagnostic (= segments × langCount)
            adjacentWordDups: adjacentDups,
            rawAdjacentWordDups: rawAdjacentDups,
            rhetoricalAdjacentWordDups: session.dupTotals.rhetoricalAdjacentWordDups || 0,
            durationMin: Number(durationMin.toFixed(2)),
            segmentsPerMin: Number(segmentsPerMin.toFixed(2)),
            medianLatencyMs: medianLatency,
            perLangPauseRates: perLangPauseRates.map(v => Number(v.toFixed(4))),
            langCount: Object.keys(langAgg).length,
        },
        weights: { ...SCORE_WEIGHTS },
    };
}

/**
 * Write session summary and clean up state for a church
 */
function flushSessionSummary(churchId, reason) {
    if (!ENABLED) return;
    const session = sessions.get(churchId);
    if (!session) return;

    // Capture timing snapshot ONCE — prevents JSONL/MD landing in different files
    // on midnight boundary (C3) and prevents durationMin drift between JSONL and MD (I6).
    const now = Date.now();
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const durationMin = Math.round((now - new Date(session.startedAt).getTime()) / 60000);

    // Compute objective score for optimizer
    const objective = computeObjectiveScore(session, now);

    pushToBuffer({
        ts: new Date(now).toISOString(),
        type: 'session_summary',
        churchId,
        reason,
        configHash: session.configHash,
        config: session.config,
        meta: session.meta, // goldenSetName, trialId, runType, etc.
        objective, // <-- single source of truth for optimizer
        startedAt: session.startedAt,
        durationMin,
        segments: session.segments,
        emissions: session.emissions,
        k1_repetitions: {
            adjacentWordDups: session.dupTotals.effectiveAdjacentWordDups ?? session.dupTotals.adjacentWordDups,
            rawAdjacentWordDups: session.dupTotals.adjacentWordDups,
            rhetoricalAdjacentWordDups: session.dupTotals.rhetoricalAdjacentWordDups || 0,
            // Note: bigram/trigram intentionally excluded from objective (double-counting),
            // kept here only for diagnostic visibility.
            bigramDups_diagnostic: session.dupTotals.bigramDups,
            trigramDups_diagnostic: session.dupTotals.trigramDups,
        },
        k2_pauses: {
            ...session.pauseBuckets,
            speakerPauses: session.speakerPauses,
            nonSpeakerPauses7sPlus: Math.max(0,
                (session.pauseBuckets['7-15s'] || 0) +
                (session.pauseBuckets['>15s'] || 0) -
                session.speakerPauses7sPlus),
        },
        filterStats: session.filterStats,
    });

    // Force flush buffer now (session ending)
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    flushBuffer();

    // Generate markdown report (pass captured snapshot — no more Date.now() calls inside)
    generateReport(churchId, session, reason, { objective, dayKey, durationMin, now });

    // Cleanup
    sessions.delete(churchId);
    lastEmissionTime.delete(churchId);
    lastDEInputTime.delete(churchId);
    pendingFilterActions.delete(churchId);
}

/**
 * Generate markdown quality report from session data.
 * Receives a snapshot ({objective, dayKey, durationMin, now}) captured atomically
 * in flushSessionSummary — no Date.now() calls inside, no JSONL/MD drift across
 * midnight (C3, I6).
 */
function generateReport(churchId, session, reason, snapshot) {
    const log = session.emissionLog;
    if (log.length === 0) {
        console.log(`[QualityTracker] No emissions for ${churchId} — skipping report (filters: ${JSON.stringify(session.filterStats)})`);
        return;
    }

    const { objective: obj, dayKey: date, durationMin, now } = snapshot;
    const time = new Date(now).toISOString().slice(11, 16);

    // Per-lang breakdown
    const langStats = {};
    for (const e of log) {
        if (!langStats[e.lang]) {
            langStats[e.lang] = {
                count: 0,
                dups: { adj: 0, bi: 0, tri: 0 },
                pauses: [],
                pauseBuckets: { '0-3s': 0, '3-7s': 0, '7-15s': 0, '>15s': 0 },
                speakerPauses: 0,
                latencies: [],
            };
        }
        const s = langStats[e.lang];
        s.count++;
        s.dups.adj += e.repetitions.effectiveAdjacentWordDups ?? e.repetitions.adjacentWordDups ?? 0;
        s.dups.bi += e.repetitions.bigramDups || 0;
        s.dups.tri += e.repetitions.trigramDups || 0;
        if (e.pause.sinceLastEmissionMs > 0) {
            s.pauses.push(e.pause.sinceLastEmissionMs);
            s.pauseBuckets[e.pause.bucket]++;
            if (e.pause.isSpeakerPause) s.speakerPauses++;
        }
        if (e.latency?.translationMs) s.latencies.push(e.latency.translationMs);
    }

    const minMax = (arr) => {
        if (arr.length === 0) return { min: '-', max: '-', avg: '-', median: '-' };
        const sorted = [...arr].sort((a, b) => a - b);
        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
            median: sorted[Math.floor(sorted.length / 2)],
        };
    };

    // Filter stats summary
    const fStats = session.filterStats;
    const filterTotal = (f) => Object.values(f).reduce((a, b) => a + b, 0);

    // Build markdown
    const lines = [];
    lines.push(`# Quality Tracking Report`);
    lines.push(``);
    lines.push(`| Field | Value |`);
    lines.push(`|------|---------|`);
    lines.push(`| Congregation | ${churchId} |`);
    lines.push(`| Date | ${date} ${time} |`);
    lines.push(`| Duration | ${durationMin} min |`);
    lines.push(`| Ended by | ${reason} |`);
    lines.push(`| Segments (DE inputs) | ${session.segments} |`);
    lines.push(`| Emissions total | ${session.emissions} |`);
    lines.push(`| Languages | ${Object.keys(langStats).join(', ')} |`);
    if (session.meta) {
        if (session.meta.goldenSetName) lines.push(`| Golden set | ${session.meta.goldenSetName} |`);
        if (session.meta.trialId !== undefined) lines.push(`| Trial ID | ${session.meta.trialId} |`);
        if (session.meta.runType) lines.push(`| Run type | ${session.meta.runType} |`);
        if (session.meta.notes) lines.push(`| Notes | ${session.meta.notes} |`);
    }
    lines.push(``);

    // K1: Repetitions (only adjacentWordDups — bigram/trigram are double-counting)
    lines.push(`## K1: Word repetitions`);
    lines.push(``);
    lines.push(`| Type | Total |`);
    lines.push(`|-----|------|`);
    lines.push(`| Adjacent words, effective (score) | ${session.dupTotals.effectiveAdjacentWordDups ?? session.dupTotals.adjacentWordDups} |`);
    lines.push(`| Adjacent words, raw (diagnostic) | ${session.dupTotals.adjacentWordDups} |`);
    lines.push(`| Rhetorical source repetitions | ${session.dupTotals.rhetoricalAdjacentWordDups || 0} |`);
    lines.push(`| Bigrams (diagnostic)  | ${session.dupTotals.bigramDups} |`);
    lines.push(`| Trigrams (diagnostic) | ${session.dupTotals.trigramDups} |`);
    lines.push(``);
    lines.push(`*Only adjacentWordDups feeds the objective function - bigrams/trigrams contain the same repetitions.*`);
    lines.push(``);

    // K1 per lang
    lines.push(`### K1 per language`);
    lines.push(``);
    lines.push(`| Language | Emissions | Adj |`);
    lines.push(`|-------|--------|-----|`);
    for (const [lang, s] of Object.entries(langStats)) {
        lines.push(`| ${lang} | ${s.count} | ${s.dups.adj} |`);
    }
    lines.push(``);

    // K2: Pauses
    lines.push(`## K2: Pauses`);
    lines.push(``);
    lines.push(`| Bucket | Total | Speaker | Non-speaker |`);
    lines.push(`|--------|------|---------|-------------|`);
    const pb = session.pauseBuckets;
    for (const b of ['0-3s', '3-7s', '7-15s', '>15s']) {
        lines.push(`| ${b} | ${pb[b]} | - | - |`);
    }
    const nonSpeaker7s = Math.max(0, (pb['7-15s'] || 0) + (pb['>15s'] || 0) - session.speakerPauses7sPlus);
    lines.push(`| **Speaker pauses (all)** | **${session.speakerPauses}** | | |`);
    lines.push(`| **Non-speaker >=7s** | **${nonSpeaker7s}** | | |`);
    lines.push(``);

    // K2 per lang — min/max/avg/median pause
    lines.push(`### K2 pauses per language (ms)`);
    lines.push(``);
    lines.push(`| Language | Count | Min | Max | Avg | Median |`);
    lines.push(`|-------|-------|-----|-----|-----|--------|`);
    for (const [lang, s] of Object.entries(langStats)) {
        const mm = minMax(s.pauses);
        lines.push(`| ${lang} | ${s.pauses.length} | ${mm.min} | ${mm.max} | ${mm.avg} | ${mm.median} |`);
    }
    lines.push(``);

    // Latency
    // Latency: use type check, not .filter(Boolean) — the latter would drop 0ms
    // (cache hits) which are valid datapoints (I5).
    const allLatencies = log.map(e => e.latency?.translationMs).filter(v => typeof v === 'number');
    if (allLatencies.length > 0) {
        const mm = minMax(allLatencies);
        lines.push(`## Translation latency (ms)`);
        lines.push(``);
        lines.push(`| Metric | Value |`);
        lines.push(`|---------|---------|`);
        lines.push(`| Min | ${mm.min} |`);
        lines.push(`| Max | ${mm.max} |`);
        lines.push(`| Avg | ${mm.avg} |`);
        lines.push(`| Median | ${mm.median} |`);
        lines.push(`| Samples | ${allLatencies.length} |`);
        lines.push(``);
    }

    // Filter stats
    lines.push(`## Dedup filters`);
    lines.push(``);
    lines.push(`| Filtr | Emit | Trim | Skip | Total | Skip% |`);
    lines.push(`|-------|------|------|------|-------|-------|`);
    for (const [name, stats] of Object.entries(fStats)) {
        if (name === 'PF') {
            lines.push(`| PF | fired: ${stats.fired} | blocked: ${stats.blocked} | | ${stats.fired + stats.blocked} | |`);
        } else if (name === 'B1') {
            lines.push(`| B1 | pass: ${stats.pass} | reject: ${stats.reject} | | ${stats.pass + stats.reject} | ${stats.reject > 0 ? Math.round(stats.reject / (stats.pass + stats.reject) * 100) : 0}% |`);
        } else if (name === 'punctGate') {
            lines.push(`| punctGate | pass: ${stats.pass} | hold: ${stats.hold} | | ${stats.pass + stats.hold} | ${stats.hold > 0 ? Math.round(stats.hold / (stats.pass + stats.hold) * 100) : 0}% |`);
        } else if (name === 'INTRA_SEM') {
            const total = filterTotal(stats);
            const intervention = (stats.trim || 0) + (stats.dry_run || 0);
            lines.push(`| INTRA_SEM | ${stats.emit || 0} | ${stats.trim || 0} | blocked: ${stats.blocked || 0}, dry_run: ${stats.dry_run || 0} | ${total} | ${total > 0 ? Math.round(intervention / total * 100) : 0}% |`);
        } else if (name === 'BCL') {
            const total = filterTotal(stats);
            const intervention = (stats.trim || 0) + (stats.semantic_shadow || 0);
            lines.push(`| BCL | ${stats.emit || 0} | ${stats.trim || 0} | semantic_shadow: ${stats.semantic_shadow || 0}, protected: ${stats.protected || 0} | ${total} | ${total > 0 ? Math.round(intervention / total * 100) : 0}% |`);
        } else {
            const total = filterTotal(stats);
            const skipPct = total > 0 ? Math.round((stats.skip || 0) / total * 100) : 0;
            lines.push(`| ${name} | ${stats.emit || 0} | ${stats.trim || 0} | ${stats.skip || 0} | ${total} | ${skipPct}% |`);
        }
    }
    lines.push(``);

    // Verdict — single objective score for optimizer (received via snapshot, W4)
    lines.push(`## Verdict (Objective Score)`);
    lines.push(``);
    lines.push(`**Config hash:** \`${session.configHash || 'NOT SET'}\``);
    lines.push(``);
    if (obj.accepted) {
        lines.push(`**Score: ${obj.score}** (lower = better)`);
        lines.push(``);
        lines.push(`**Weighted score for Optuna: ${obj.weighted_score}** (= score / confidence)`);
        lines.push(``);
        lines.push(`**Confidence: ${obj.confidence}** ${obj.lowConfidence ? '⚠️ LOW - session too short for reliable optimisation' : '✓'}`);
        if (obj.lowConfidence) {
            lines.push(``);
            lines.push(`> This session is flagged as **lowConfidence**. The score is computed and stored,`);
            lines.push(`> but the Optuna script should filter it out or treat it as a low-weight observation.`);
            lines.push(`> Minimum for optimisation: ${OPTIMIZER_LIMITS.minSegments} segments / ${OPTIMIZER_LIMITS.minDurationMin} min.`);
        }
    } else {
        lines.push(`**Score: REJECTED** — ${obj.rejection}`);
    }
    lines.push(``);
    lines.push(`| Component | Value | Weight | Contribution |`);
    lines.push(`|-----------|---------|------|-------|`);
    lines.push(`| R_norm (effective adj dups / emission) | ${obj.components.R_norm} | ${obj.weights.R} | ${obj.components.weighted_R} |`);
    lines.push(`| P_norm (non-speaker pauses >=7s, avg per lang) | ${obj.components.P_norm} | ${obj.weights.P} | ${obj.components.weighted_P} |`);
    lines.push(`| S_norm (starvation: deficit to ${TARGET_SEGMENTS_PER_MIN} seg/min) | ${obj.components.S_norm} | ${obj.weights.S} | ${obj.components.weighted_S} |`);
    lines.push(``);
    lines.push(`### Raw data`);
    lines.push(``);
    lines.push(`| Field | Value |`);
    lines.push(`|------|---------|`);
    lines.push(`| Segments (DE inputs) | ${obj.raw.segments} |`);
    lines.push(`| Emissions (total, diagnostic) | ${obj.raw.emissions} |`);
    lines.push(`| Effective adjacent word dups | ${obj.raw.adjacentWordDups} |`);
    lines.push(`| Raw adjacent word dups | ${obj.raw.rawAdjacentWordDups ?? obj.raw.adjacentWordDups} |`);
    lines.push(`| Rhetorical source dups | ${obj.raw.rhetoricalAdjacentWordDups || 0} |`);
    lines.push(`| Duration (min) | ${obj.raw.durationMin} |`);
    lines.push(`| Segments/min | ${obj.raw.segmentsPerMin} (target: ${TARGET_SEGMENTS_PER_MIN}) |`);
    lines.push(`| Median latency (ms) | ${obj.raw.medianLatencyMs} (limit: ${HARD_LIMITS.medianLatencyMs}) |`);
    lines.push(`| Pause rates per lang | ${obj.raw.perLangPauseRates.join(', ')} |`);
    lines.push(``);
    lines.push(`---`);
    lines.push(`*Generated automatically by qualityTracker.js*`);

    // Write MD file — include time-of-day with seconds to prevent overwrites (W6).
    // Minutes-only granularity is insufficient: multiple sessions can flush within
    // the same minute (e.g., batch end-of-day cleanup, test runs).
    // Uniqueness strategy:
    //   - If trialId present (Optuna run) → append _t{trialId} (globally unique in study)
    //   - Otherwise → append _{churchId} (baseline/manual runs, unique per church)
    const langs = Object.keys(langStats).sort().join('-') || 'none';
    const timeSlug = new Date(now).toISOString().slice(11, 19).replace(/:/g, '');
    const uniqueSlug = session.meta?.trialId !== undefined
        ? `_t${session.meta.trialId}`
        : `_${churchId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const filename = `Quality_Tracking_${langs}_${date}_${timeSlug}${uniqueSlug}.md`;
    const filepath = path.join(LOG_DIR, filename);
    const content = lines.join('\n');

    console.log(`[QualityTracker] Writing report: ${filepath} (${content.length} chars, ${log.length} emissions)`);

    try {
        if (!dirReady) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            dirReady = true;
        }
        fs.writeFileSync(filepath, content, 'utf8');
        console.log(`[QualityTracker] Report saved: ${filename}`);
    } catch (err) {
        console.error(`[QualityTracker] Report write FAILED: ${err.code || err.name}: ${err.message}`);
        console.error(`[QualityTracker] LOG_DIR=${LOG_DIR}, filepath=${filepath}, dirReady=${dirReady}`);
    }
}

/**
 * Reset filter actions for a new emission cycle
 */
function resetPendingFilters(churchId) {
    pendingFilterActions.delete(churchId);
}

/**
 * Synchronous flush for graceful shutdown (SIGTERM).
 *
 * KNOWN LIMITATION (C4): Shares buffer[] with async flushBuffer. In Node.js
 * single-threaded runtime there is no data corruption (V8 won't preempt mid-function),
 * but if flushBuffer's async fs.appendFile is in-flight when flushSync runs,
 * the two writes may land in the JSONL in non-deterministic order. Consumers
 * (Optuna, analysis scripts) must sort records by `ts` field, not rely on file order.
 */
function flushSync() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length)
        .map(r => JSON.stringify(r))
        .join('\n') + '\n';
    const file = getLogFile();
    try {
        if (!dirReady) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            dirReady = true;
        }
        fs.appendFileSync(file, batch, 'utf8');
    } catch (err) {
        console.error('[QualityTracker] Sync write error:', err.message);
    }
}

export default {
    setSessionConfig,
    trackDEInput,
    trackFilterAction,
    trackEmission,
    trackPipelineBlock,
    trackFallback,
    flushSessionSummary,
    resetPendingFilters,
    flushSync,
    computeObjectiveScore, // exported for unit tests / replay
    deriveEffectiveRepetitions,
};
