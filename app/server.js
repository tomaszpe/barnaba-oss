/**
 * BARNABAS - Translation Server for Azure Container Apps
 *
 * Pipeline:
 * Web Speech API (browser) → WebSocket → Sentence Boundary Detection
 * → Swiss German Normalization → Liturgical Cache Check
 * → Glossary Term Extraction → GPT-4.1-mini (Azure OpenAI)
 * → WebSocket → Authenticated Clients
 *
 * Features:
 * - GPT-4.1-mini via Azure OpenAI for translations
 * - 252-term theological glossary with 5 languages
 * - 85 Swiss German → Hochdeutsch mappings
 * - 55+ liturgical phrase cache
 * - Translation context continuity
 * - User authentication via QR codes and 6-digit PINs
 * - Broadcaster master password protection
 * - Sentence boundary detection for natural translation chunks
 * - Audio quality monitoring with VAD
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenAI } from 'openai';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
import qualityTracker from './qualityTracker.js';
import { cleanupQaReplay, decodeQaChunkKey, renderQaReplay } from './qaReplayRenderer.js';
import {
    isConnectionScopedListenerTelemetry,
    takeRateLimitSlot,
    WS_IP_RATE_LIMIT,
    WS_LISTENER_TELEMETRY_RATE_LIMIT,
} from './wsRateLimit.js';
import { bearerSessionToken } from './sessionTransportAuth.js';

// Phase C: Whisper ASR for Swiss German.
// Barnaba runs exclusively against the remote Python Whisper service.
if (!process.env.WHISPER_SERVICE_URL) {
    throw new Error('WHISPER_SERVICE_URL is required. Local Whisper mode has been removed; start the Python Whisper service and configure its URL.');
}
console.log(`[Config] Using REMOTE Whisper service: ${process.env.WHISPER_SERVICE_URL}`);
const whisperModule = await import('./whisperClient.js');

const {
    initWhisper,
    transcribeSwissGerman,
    transcribeStream,
    accumulateAudio,
    flushAudioBuffer,
    clearAudioBuffer,
    getWhisperStatus,
    getWhisperStats,
    // Streaming session API with LocalAgreement (remote mode only)
    sendStreamingChunk,
    createStreamingSession,
    // Reads the state of OPEN REQUESTS to Whisper (not: decodes in progress).
    getWhisperRequestsInFlight,
} = whisperModule;

import { buildWhisperRequestEvidence } from './whisperRequestTracker.js';
import { createRepE3FallbackGuard } from './repE3FallbackGuard.js';
const REP_E3_FALLBACK_GUARD_ENABLED = process.env.REP_E3_FALLBACK_GUARD_ENABLED === 'true';
console.log(`[Config] REP_E3_FALLBACK_GUARD_ENABLED=${REP_E3_FALLBACK_GUARD_ENABLED}`);
import {
    missingSourceLineage,
    projectSourceLineage,
    sourceLineageFromWhisper,
    sourceLineageTelemetry,
    sourceWordCount,
} from './sourceLineage.js';
import { createRepObserver } from './repObserver.js';

/**
 * The ONLY place where `server.js` reads in-flight request state.
 *
 * EXACTLY ONE snapshot per decision. Assembling fields from several reads would produce a
 * record describing several different moments - the same defect for which inherited provenance
 * was discarded on the Whisper side. The read is fail-open (`unavailable` rather than a number
 * impersonating a measurement), does not wait, and CHANGES no emission branch.
 */
function whisperRequestEvidence(churchId, options = {}) {
    return buildWhisperRequestEvidence(getWhisperRequestsInFlight(churchId), options);
}

/**
 * Request-completion event. `completion` arrives ALREADY SANITISED from the tracker (without
 * the delta words and without a raw error body), so this is a pure re-mapping.
 * Join: on `request_id`, and with `decode_proof=present` additionally on the pair
 * `(whisper_session_id, decode_id)` - `decode_id` alone is unique only within a session.
 */
function logWhisperRequestCompleted(churchId, completion) {
    evalLog({ stage: 'whisper_request_completed', churchId, ...completion });
}

// Translation Service (GPT-4.1-mini) with Liturgical Caching
import {
    initTranslationService,
    translateToAllLanguages,
    translateText,
    isPromptInjection,
    clearContextBuffer,
    clearCommittedTranslations,
    commitTranslation,
    preWarmContextBuffer,
    getServiceStatus,
    LANGUAGE_NAMES
} from './translationService.js';

import { getCacheStats } from './cacheService.js';
import { evalLog as writeEvalLog, flushEvalLog, getEvalLogStats } from './evalLogService.js';
import { createTranslationRequestTelemetry } from './translationProviderTelemetry.js';
import {
    buildPipelineObserverMessage,
    buildSourceActivityMessage,
} from './pipelineObserverContract.js';
import { appendFeedback } from './feedbackLogService.js';
import { dispatchPerLanguage } from './translationDispatch.js';
import { logEmissionDecision } from './emissionDecisionMetrics.js';
import { decideEmission, logEmissionControllerDecision } from './emissionController.js';
import { LiveQualityState } from './liveQualityState.js';
import { decideAutopilotProfile, logAutopilotShadowDecision } from './autopilotPolicy.js';
import { logFlowGovernorShadowDecision, decideFlowGovernor } from './flowGovernor.js';
import { confirmTerminalBoundary, endsWithTerminal, endsOnOpenWord, splitAtSafeBoundary } from './boundaryConfirmation.js';
import { decideNoOpenCutAction, clearHeldTail } from './noOpenCut.js';
// Deadline provisional emission with a source-span ledger.
// Emits a new stable DELTA (not the raw partial), and supersedes finals that only repeat a
// provisional. See deadlineProvisional.js.
import { normWords as dpNormWords, buildDeadlinePayload, supersedeDecisionFor } from './deadlineProvisional.js';
import { clearBoundaryLedger, commitBoundaryText, processBoundaryCommit } from './boundaryCommitLedger.js';
import { createHGDedupService } from './hgDedupService.js';
import { decideAgeBudget } from './ageBudgetService.js';
import { buildClientFeatureConfig } from './clientFeatureConfig.js';
import {
    buildTtsChunkIdentity,
    stampEmittedSourceIdentity,
} from './emittedSourceIdentity.js';
import { protectRhetoricalRepeat } from './b4RhetoricalRepeatPolicy.js';
import { createB4CadencePolicy } from './b4CadencePolicy.js';
import {
    allowedDropReasons,
    sanitizeDeliveryOutcomeBatch,
    sanitizeListenerMeasurementAgeMs,
    sanitizePendingDropSample,
} from './listenerTelemetryContract.js';
import {
    ListenerPlayoutLedger,
    listenerSessionIdFrom,
} from './listenerPlayoutLedger.js';
import { resegmentSourceAtWord } from './sourceResegmentation.js';
import { sourceMapFromLineage, sourceMapTelemetry } from './sourceMap.js';
import { planT4CommittedPrefix } from './t4CommittedPrefixPlanner.js';
import { evaluateT4CommittedPrefixApply } from './t4CommittedPrefixApply.js';
import { safeSourceBoundaryWordIndexes } from './sourceBoundaryMap.js';
import { DEFAULT_CONFIG as INTRA_DEDUP_DEFAULTS, cleanupIntraEmissionAsync } from './intraEmissionDedupService.js';
import {
    DEFAULT_SHADOW_CONFIG as SHADOW_DEFAULTS,
    buildSourceUnits,
    createSourceSemanticRepeatShadow,
} from './sourceSemanticRepeatShadow.js';
import {
    acknowledgeFallbackHistoryCommit,
    acknowledgeFallbackFirstBroadcast,
    cancelFallbackAcceptedEnqueue,
    fallbackCoordinatorShadowConfigErrors,
    observeFallbackAcceptedEnqueue,
} from './fallbackCoordinatorShadow.js';
import { classifyFallbackReevaluation } from './fallbackReevaluationProjection.js';
import {
    conservativeFallbackApplyDecision,
    FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS,
    fallbackEmissionOriginForTelemetry,
    fallbackEmissionSessionEpochForTelemetry,
    fallbackCoordinatorApplyConfigErrors,
    FallbackCoordinatorApplyWaiters,
    PerChurchEnqueueSequencer,
} from './fallbackCoordinatorApply.js';
import {
    createSourceTextLedgerShadow,
    DEFAULT_SOURCE_TEXT_LEDGER_CONFIG,
} from './sourceTextLedgerShadow.js';
import {
    createRevisionAdmissionShadow,
    DEFAULT_REVISION_ADMISSION_CONFIG,
    revisionAdmissionTelemetry,
} from './revisionAdmissionShadow.js';
import { TranslationQueue } from './translationQueue.js';
import { runDisconnectDrain } from './disconnectDrain.js';
import { resolveQueuedEmissionLanguages } from './languageRouting.js';
import {
    DEFAULT_T5_DEDUP_WINDOW,
    DEFAULT_T5_DEDUP_THRESHOLD,
    DEFAULT_T5_V2_OVERLAP_THRESHOLD,
    DEFAULT_T5_SHORT_TEXT_CHARS,
    DEFAULT_TRANSLATION_STOPWORDS,
    evaluatePostTranslationDedup,
    historyEntryFor,
} from './t5DedupPolicy.js';
import {
    createCsrfToken,
    setCsrfCookie,
    clearCsrfCookie,
    validateCsrfRequest,
    requireCsrf,
} from './csrfService.js';

// Phase 5: Authentication Service
import {
    verifyMasterPassword,
    generateJoinQR,
    verifyPIN,
    isValidChurchId,
    createBroadcasterSession,
    createListenerSession,
    validateSession,
    invalidateSession,
    getAuthStats
} from './authService.js';

// Phase 6: Sentence Boundary Detection
import {
    detectSentenceBoundaries,
    SentenceBuffer,
    SentenceAccumulator,
    getSentenceServiceStats
} from './sentenceService.js';
import { createHoldNEmitter } from './holdNPolicy.js';

// Phase 6: Audio Quality Monitoring
import {
    analyzeAudioQuality,
    detectVoiceActivity,
    getAudioServiceStats
} from './audioQualityService.js';

const UAT_PIPELINE_OBSERVER_ENABLED = process.env.UAT_PIPELINE_OBSERVER_ENABLED === 'true';
const UAT_SOURCE_VAD_DBFS = Number.parseFloat(process.env.UAT_SOURCE_VAD_DBFS || '-45');
const UAT_SOURCE_VAD_THRESHOLD = 10 ** (UAT_SOURCE_VAD_DBFS / 20);

function publishPipelineObserverEntry(entry) {
    if (!UAT_PIPELINE_OBSERVER_ENABLED) return;
    const message = buildPipelineObserverMessage(entry);
    if (!message) return;
    try {
        broadcastToChurch(entry.churchId, message);
    } catch {
        // Observer telemetry must never affect translation or startup.
    }
}

function evalLog(entry) {
    const written = writeEvalLog(entry);
    publishPipelineObserverEntry(entry);
    return written;
}

const REP_MODE = ['off', 'shadow'].includes(
    String(process.env.ASR_REP_MODE || 'off').toLowerCase(),
) ? String(process.env.ASR_REP_MODE || 'off').toLowerCase() : 'off';
const REP_SHADOW_ENABLED = REP_MODE === 'shadow';
const repObserver = createRepObserver({
    mode: REP_MODE,
    evalLog: (event) => {
        evalLog(event);
        // REP payload is already HMAC/anonymized unless the controlled DEV runner
        // explicitly enables protected text and stores stdout in its ignored run folder.
        console.log(`[REP_OBSERVER] ${JSON.stringify(event)}`);
    },
    ngramWords: process.env.ASR_REP_NGRAM_WORDS || '8',
    protectedTextEnabled: process.env.ASR_REP_PROTECTED_TEXT_ENABLED === 'true',
});

if (UAT_PIPELINE_OBSERVER_ENABLED) {
    console.log(`[UAT_OBSERVER] Enabled (source VAD ${UAT_SOURCE_VAD_DBFS} dBFS)`);
}

// Latency Tracking Service
import {
    startLatencyTracking,
    recordLatencyStage,
    completeLatencyTracking,
    completeWhisperOnlyTracking,
    recordListenerAck,
    getLatencyStats,
    resetLatencyStats,
    getAudioCapturedAt
} from './latencyService.js';

// Server-side TTS (Azure Cognitive Services Speech)
import {
    isTtsEnabled,
    getTtsStatus,
    synthesizeSpeech,
    synthesizeSpeechProgressive,
    estimateAudioDurationMsFromBase64
} from './ttsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Evaluation JSONL logging: see evalLogService.js (extracted in Project A Task A3.0)

// Project A (A3.2): per-emission telemetry counter
let _emissionCounter = 0;
function nextEmissionId() { return ++_emissionCounter; }

// source_release_audit - shadow-only open-cut attribution. Every
// processCompleteSentence entry logs origin + boundary/governor signals so we can
// see WHICH release path (smooth/warmup/pause/fallback) emits open clauses, not
// just partialFallback (the only path Q1b governs today). Pure logging.
const SOURCE_RELEASE_AUDIT_ENABLED = process.env.SOURCE_RELEASE_AUDIT_ENABLED !== 'false';
// DEV-only sealed replay capture. Full sermon text and word-level lineage are
// written only when the bounded operator explicitly enables this flag.
const B4_REPLAY_CAPTURE_ENABLED = process.env.B4_REPLAY_CAPTURE_ENABLED === 'true';
const B4_RHETORICAL_REPEAT_APPLY_ENABLED = process.env.B4_RHETORICAL_REPEAT_APPLY_ENABLED === 'true';
const B4_CADENCE_V2_SHADOW_ENABLED = process.env.B4_CADENCE_V2_SHADOW_ENABLED === 'true';
const B4_CADENCE_V2_APPLY_ENABLED = process.env.B4_CADENCE_V2_APPLY_ENABLED === 'true';
const FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED = process.env.FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED === 'true';
const FQF_FALLBACK_COORDINATOR_APPLY_ENABLED = process.env.FQF_FALLBACK_COORDINATOR_APPLY_ENABLED === 'true';
const FQF_SOURCE_LINEAGE_ENABLED = process.env.FQF_SOURCE_LINEAGE_ENABLED === 'true';
let _sourceReleaseSeq = 0;
const _sessionEpoch = crypto.randomUUID();

function releaseIdentityFields(releaseMeta) {
    return {
        session_epoch: releaseMeta?.sessionEpoch ?? null,
        release_seq: releaseMeta?.releaseSeq ?? null,
        source_hash: releaseMeta?.sourceHash ?? null,
        emitted_source_hash: releaseMeta?.emittedSourceHash ?? null,
        emitted_source_normalizer: releaseMeta?.emittedSourceNormalizer ?? null,
        emitted_word_count: releaseMeta?.emittedWordCount ?? null,
        ...revisionAdmissionTelemetry(releaseMeta),
    };
}

function sourceLineageFields(releaseMeta) {
    return {
        ...(releaseMeta?.sourceLineageEnabled
            ? sourceLineageTelemetry(releaseMeta.sourceLineage)
            : {}),
        ...revisionAdmissionTelemetry(releaseMeta),
    };
}

function buildSourceLineage(text, provenance) {
    return FQF_SOURCE_LINEAGE_ENABLED || REP_SHADOW_ENABLED
        ? sourceLineageFromWhisper(text, provenance)
        : null;
}

function buildProjectedSourceLineage(originalText, emittedText, provenance) {
    if (!FQF_SOURCE_LINEAGE_ENABLED && !REP_SHADOW_ENABLED) return null;
    const originalLineage = sourceLineageFromWhisper(originalText, provenance);
    return projectSourceLineage(originalText, emittedText, originalLineage);
}

function logBroadcastStage({ emissionId, churchId, lang, gender, listenersServed, sourceEmitMs, drainMeta = null, emissionCompleteness = null, releaseMeta = null }) {
    const broadcastSentMs = Date.now();
    evalLog({
        stage: 'broadcast',
        churchId,
        emissionId,
        ...releaseIdentityFields(releaseMeta),
        ...sourceLineageFields(releaseMeta),
        lang,
        gender,
        listeners_served: listenersServed,
        source_emit_ms: sourceEmitMs,
        broadcast_sent_ms: broadcastSentMs,
        duration_ms: broadcastSentMs - sourceEmitMs,
        // P-B: tag drain emissions so the analyzer can confirm delivery per tailItemId.
        ...(drainMeta ? { source: 'disconnect_drain', drainId: drainMeta.drainId, tailItemId: drainMeta.tailItemId } : {}),
        // Q1b BUG1: carry no-open-cut completeness tag onto broadcast records so D1 can
        // measure per-language open-cut exposure on the broadcast stage too.
        ...(emissionCompleteness ? { emission_completeness: emissionCompleteness } : {}),
    });
    if (listenersServed > 0) {
        evalLog({
            stage: 'source_release_outcome',
            churchId,
            ...releaseIdentityFields(releaseMeta),
            outcome: 'broadcasted',
            block_stage: null,
            lang,
            emissionId,
            listeners_served: listenersServed,
        });
        markListenerBoundEmission(churchId, lang, gender, broadcastSentMs);
        acknowledgeFallbackCoordinatorShadowBroadcast({ churchId, releaseMeta, broadcastSentMs });
    }
}


function listenerRouteKey(lang, gender) {
    return `${lang || 'unknown'}:${gender || 'unknown'}`;
}

function ensureFallbackState(churchId) {
    let fb = state.fallbackState.get(churchId);
    if (!fb) {
        fb = createFallbackState();
        state.fallbackState.set(churchId, fb);
    }
    return fb;
}

function createFallbackState() {
    return {
        repE3Guard: createRepE3FallbackGuard({ enabled: REP_E3_FALLBACK_GUARD_ENABLED }),
        lastConfirmedAt: Date.now(),
        lastFallbackText: '',
        lastPartial: '',
        firstHeldAt: null,
        trackedTail: '',
        repairShadowCycles: 0,
        lastRepairPartial: '',
        listenerBoundEmissionAtByRoute: new Map(),
        deadlineCooldownUntilByRoute: new Map(),
        latestPartial: '',
        latestPartialAt: null,
        latestStable: '',
        latestPartialProvenance: null,
        latestStableProvenance: null,
        latestLatencyTxId: null,
        deadlineFallbackInFlight: false,
        // Refined A2.7 (10.07.2026): source-span state for provisional deadline emissions.
        // Which field the supersede actually MATCHES ON depends on the arm - see the
        // arm description below. Do not describe either field as inert:
        //
        //   reviewFixes=false (LOAD-BEARING = the validated listening-review configuration):
        //     deadlineLedger  = per-provisional entries {norm, text, at, superseded} — the
        //                       supersede MATCH SET. Entries expire by their own `at` (per-entry
        //                       TTL) and are marked `superseded` once consumed. NOT observability.
        //     emittedSourceNorm = cumulative words, used for the deadline's stable-delta only.
        //     lastDeadlineEmitAt = UNUSED (does not exist in the pinned baseline image).
        //
        //   reviewFixes=true (candidate arm, default OFF — shipped in the 3.6 batch):
        //     emittedSourceNorm = CUMULATIVE match set — supersede matches the final against the
        //                       whole span (finding #2), not per-payload entries.
        //     deadlineLedger  = observability only.
        //     lastDeadlineEmitAt = staleness clock so a never-closed span does not supersede a
        //                       much-later unrelated final.
        //
        // Both arms: emittedSourceNorm resets on any real non-deadline emission (that reset is
        // BASELINE behavior too - not a review-fix; do not "fix" it).
        emittedSourceNorm: [],
        deadlineLedger: [],
        lastDeadlineEmitAt: 0,
    };
}

function markListenerBoundEmission(churchId, lang, gender, tsMs = Date.now()) {
    const fb = state.fallbackState.get(churchId);
    if (!fb) return;
    if (!fb.listenerBoundEmissionAtByRoute) fb.listenerBoundEmissionAtByRoute = new Map();
    fb.listenerBoundEmissionAtByRoute.set(listenerRouteKey(lang, gender), tsMs);
}

function activeListenerRoutes(churchId) {
    const langMap = state.subscriptions.get(churchId);
    if (!langMap) return [];
    const routes = new Map();
    for (const [lang, clients] of langMap.entries()) {
        for (const ws of clients || []) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            const gender = state.clientVoiceGenders.get(ws) || 'unknown';
            routes.set(listenerRouteKey(lang, gender), { lang, gender, routeKey: listenerRouteKey(lang, gender) });
        }
    }
    return Array.from(routes.values());
}

function routeDeadlineAgeMs(fb, routeKey, nowMs) {
    const routeTs = fb.listenerBoundEmissionAtByRoute?.get(routeKey);
    return routeTs ? nowMs - routeTs : nowMs - fb.lastConfirmedAt;
}

async function emitDeadlineFallback(churchId, fb, overdueRoutes, nowMs) {
    const phaseState = state.smoothPhases.get(churchId);
    if (phaseState?.phase !== 'streaming') return false;
    const maxRouteAgeMs = Math.max(...overdueRoutes.map(r => r.ageMs));

    // ---- Refined A2.7 (10.07.2026): stable-delta ladder + provisional ledger ----
    if (config.deadlineFallback.provisionalEnabled) {
        const payload = buildDeadlinePayload({
            latestStable: fb.latestStable || '',
            latestPartial: fb.latestPartial || '',
            emittedNorm: fb.emittedSourceNorm || [],
            minWords: config.deadlineFallback.minDeltaWords,
        });
        if (payload.mode === 'deadline_no_safe_payload' || !payload.text) {
            // Short silence < garble: log so we can see whether the cap re-breaks (gate metric).
            evalLog({
                stage: 'deadline_no_safe_payload', churchId,
                stall_ms: maxRouteAgeMs,
                stable_len: (fb.latestStable || '').length,
                partial_len: (fb.latestPartial || '').length,
                overdue_routes: overdueRoutes.map(r => r.routeKey),
                // A NEGATIVE decision needs evidence too: without it the denominator would come
                // only from publications, and "how often waiting would have helped" could not be
                // computed.
                ...whisperRequestEvidence(churchId),
            });
            return false;
        }
        const accumulator = state.smoothAccumulators.get(churchId);
        if (!accumulator) return false;
        const lineageSourceText = payload.mode === 'deadline_stable'
            ? fb.latestStable
            : fb.latestPartial;
        const lineageProvenance = payload.mode === 'deadline_stable'
            ? fb.latestStableProvenance
            : fb.latestPartialProvenance;
        const e3Decision = fb.repE3Guard.deadlineDecision({ text: payload.text, provenance: lineageProvenance });
        if (REP_E3_FALLBACK_GUARD_ENABLED) {
            evalLog({ stage: 'rep_e3_fallback_guard', churchId, ...e3Decision,
                origin: 'deadline_fallback', decode_id: lineageProvenance?.decodeId ?? null });
        }
        if (e3Decision.applied) return false;
        let release = accumulator.add(payload.text, false,
            buildProjectedSourceLineage(lineageSourceText, payload.text, lineageProvenance));
        if (!release) release = accumulator.flush();
        if (!release) return false;

        recordLiveQualityMetric(churchId, {
            stage: 'pause_deadline_fallback',
            stall_ms: maxRouteAgeMs, pause_ms: maxRouteAgeMs, fallback_stall_ms: maxRouteAgeMs,
            listener_clock_enabled: true, overdue_routes: overdueRoutes.map(r => r.routeKey),
        });
        evalLog({
            stage: 'pause_deadline_fallback', churchId,
            emit_mode: payload.mode,            // deadline_stable | deadline_safe_prefix
            deadline_raw_partial: 0,            // refined path never emits raw mid-clause
            stall_ms: maxRouteAgeMs, timeout_ms: config.deadlineFallback.timeoutMs,
            overdue_routes: overdueRoutes.map(r => r.routeKey),
            delta_words: payload.deltaWords, emitted_len: payload.text.length,
            // Publication: evidence plus `premature_publication_candidate` (a CANDIDATE, not
            // evidence - see the field contract above).
            ...whisperRequestEvidence(churchId, { publication: true }),
        });

        // reviewFixes ON: the ledger is advanced INSIDE processCompleteSentence at the true
        // 'queued' point (findings #1 phantom-ledger + #2 payload-vs-release) - only
        // actually-emitted, post-filter text is recorded.
        // reviewFixes OFF (4.52 baseline): advanced HERE, right after the emission, from the
        // PAYLOAD text. Records a phantom entry if the payload is blocked downstream - that is
        // the validated 4.52 behavior and must not be "fixed" inside P0.1.
        await processCompleteSentence(churchId, release.text, fb.latestLatencyTxId,
            { emissionCompleteness: 'deadline_fallback', origin: 'deadline_fallback', releaseReason: 'listener_pause_deadline', sourceLineage: release.sourceLineage });

        if (!config.deadlineFallback.reviewFixesEnabled) {
            const emittedNorm = dpNormWords(payload.text);
            fb.emittedSourceNorm = [...(fb.emittedSourceNorm || []), ...emittedNorm];
            fb.deadlineLedger = (fb.deadlineLedger || []).filter(
                e => nowMs - e.at <= config.deadlineFallback.supersedeTtlMs);
            fb.deadlineLedger.push({ norm: emittedNorm, text: payload.text, at: nowMs, superseded: false });
        }

        fb.lastFallbackText = payload.text;
        fb.lastFallbackAt = nowMs;
        fb.lastConfirmedAt = nowMs;
        fb.repairShadowCycles = 0;
        fb.lastRepairPartial = '';
        for (const route of overdueRoutes) {
            fb.deadlineCooldownUntilByRoute.set(route.routeKey, nowMs + config.deadlineFallback.timeoutMs);
        }
        return true;
    }

    // ---- Legacy path: raw partial (flag-gated, pre-10.07 behavior) ----
    if (!fb.latestPartial || fb.latestPartial.length < config.partialFallback.minPartialLength) return false;
    const similarity = jaccardSimilarity(fb.latestPartial, fb.lastFallbackText || '');
    if (similarity >= config.partialFallback.similarityThreshold) {
        evalLog({ stage: 'deadline_fallback_blocked', churchId, reason: 'similarity', similarity,
            overdue_routes: overdueRoutes.map(r => r.routeKey),
            ...whisperRequestEvidence(churchId) });
        return false;
    }

    recordLiveQualityMetric(churchId, {
        stage: 'pause_deadline_fallback',
        stall_ms: maxRouteAgeMs,
        pause_ms: maxRouteAgeMs,
        fallback_stall_ms: maxRouteAgeMs,
        listener_clock_enabled: true,
        overdue_routes: overdueRoutes.map(r => r.routeKey),
    });
    evalLog({
        stage: 'pause_deadline_fallback',
        churchId,
        emit_mode: 'raw_partial',
        deadline_raw_partial: 1,
        stall_ms: maxRouteAgeMs,
        timeout_ms: config.deadlineFallback.timeoutMs,
        overdue_routes: overdueRoutes.map(r => r.routeKey),
        partial_len: fb.latestPartial.length,
        similarity,
        ...whisperRequestEvidence(churchId, { publication: true }),
    });

    const accumulator = state.smoothAccumulators.get(churchId);
    if (!accumulator) return false;
    let release = accumulator.add(fb.latestPartial, false,
        buildSourceLineage(fb.latestPartial, fb.latestPartialProvenance));
    if (!release) release = accumulator.flush();
    if (!release) return false;

    await processCompleteSentence(churchId, release.text, fb.latestLatencyTxId,
        { emissionCompleteness: 'deadline_fallback', origin: 'deadline_fallback', releaseReason: 'listener_pause_deadline', sourceLineage: release.sourceLineage });

    fb.lastFallbackText = fb.latestPartial;
    fb.lastFallbackAt = Date.now();
    fb.lastConfirmedAt = fb.lastFallbackAt;
    fb.repairShadowCycles = 0;
    fb.lastRepairPartial = '';
    for (const route of overdueRoutes) {
        fb.deadlineCooldownUntilByRoute.set(route.routeKey, fb.lastFallbackAt + config.deadlineFallback.timeoutMs);
    }
    return true;
}

async function checkDeadlineFallbacks() {
    if (!config.deadlineFallback.enabled || !config.partialFallback.enabled) return;
    const nowMs = Date.now();
    for (const [churchId, fb] of state.fallbackState.entries()) {
        if (fb.deadlineFallbackInFlight) continue;
        const overdueRoutes = activeListenerRoutes(churchId)
            .map(route => ({ ...route, ageMs: routeDeadlineAgeMs(fb, route.routeKey, nowMs) }))
            .filter(route => route.ageMs >= config.deadlineFallback.timeoutMs)
            .filter(route => nowMs >= (fb.deadlineCooldownUntilByRoute?.get(route.routeKey) || 0));
        if (overdueRoutes.length === 0) continue;
        fb.deadlineFallbackInFlight = true;
        try {
            await emitDeadlineFallback(churchId, fb, overdueRoutes, nowMs);
        } catch (err) {
            console.error(`[DEADLINE_FALLBACK] ${churchId}:`, err && err.message);
        } finally {
            fb.deadlineFallbackInFlight = false;
        }
    }
}

// Project A (A3.3): feature flag for parallel broadcast (Scenario A)
const BROADCAST_PARALLEL = process.env.BROADCAST_PARALLEL === 'true';

// projectTTS Phase 3a.2 (Option H): progressive TTS — split text into sentences,
// synthesize in parallel, broadcast per-sentence tts_chunk messages.
// Requires BROADCAST_PARALLEL=true (not supported in legacy Promise.all path).
const TTS_PROGRESSIVE_ENABLED = process.env.TTS_PROGRESSIVE_ENABLED === 'true';
if (TTS_PROGRESSIVE_ENABLED && !BROADCAST_PARALLEL) {
    console.warn('[TTS] TTS_PROGRESSIVE_ENABLED=true requires BROADCAST_PARALLEL=true; progressive mode will be IGNORED in legacy dispatch path.');
}

// N3 (02.06.2026): per-language independent translation dispatch. Removes the
// translateToAllLanguages Promise.all barrier so each language emits as soon as ITS
// OWN GPT call resolves (no waiting for the slowest lang). Requires BROADCAST_PARALLEL=true.
// Default ON (after DEV A/B validation 02.06.2026) so DEV→PROD migration needs no extra
// flag — set TRANSLATION_DISPATCH_INDEPENDENT=false to fall back to the legacy barrier path.
const TRANSLATION_DISPATCH_INDEPENDENT = process.env.TRANSLATION_DISPATCH_INDEPENDENT !== 'false';
if (TRANSLATION_DISPATCH_INDEPENDENT && !BROADCAST_PARALLEL) {
    console.warn('[N3] independent dispatch requires BROADCAST_PARALLEL=true; will be IGNORED (legacy barrier path used).');
}
const FQF_T4_SOURCE_RESEGMENTATION_ENABLED =
    process.env.FQF_T4_SOURCE_RESEGMENTATION_ENABLED === 'true';
const FQF_T1_REVISION_ADMISSION_SHADOW_ENABLED =
    process.env.FQF_T1_REVISION_ADMISSION_SHADOW_ENABLED === 'true';
const FQF_SOURCE_MAP_V2_SHADOW_ENABLED =
    FQF_T1_REVISION_ADMISSION_SHADOW_ENABLED
    && FQF_SOURCE_LINEAGE_ENABLED;
const FQF_T4_SOURCE_RESEGMENTATION_V2_SHADOW_ENABLED = FQF_SOURCE_MAP_V2_SHADOW_ENABLED;
const FQF_T4_SOURCE_RESEGMENTATION_V2_APPLY_ENABLED =
    process.env.FQF_T4_SOURCE_RESEGMENTATION_V2_APPLY_ENABLED === 'true';
const FQF_T4_SINGLE_REPLICA_CONFIRMED =
    process.env.FQF_T4_SINGLE_REPLICA_CONFIRMED === 'true';
if (FQF_T4_SOURCE_RESEGMENTATION_ENABLED
    && FQF_T4_SOURCE_RESEGMENTATION_V2_APPLY_ENABLED) {
    throw new Error('[FQF_T4] Legacy APPLY and V2 APPLY are mutually exclusive');
}
if (FQF_T4_SOURCE_RESEGMENTATION_ENABLED
    && (!TRANSLATION_DISPATCH_INDEPENDENT || !BROADCAST_PARALLEL || !TTS_PROGRESSIVE_ENABLED)) {
    console.error('[FQF_T4] DISABLED: source resegmentation requires independent + parallel + progressive delivery');
}
const FQF_T4_SOURCE_RESEGMENTATION_RUNTIME_ENABLED =
    FQF_T4_SOURCE_RESEGMENTATION_ENABLED
    && TRANSLATION_DISPATCH_INDEPENDENT
    && BROADCAST_PARALLEL
    && TTS_PROGRESSIVE_ENABLED;
const FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED =
    FQF_T4_SOURCE_RESEGMENTATION_V2_APPLY_ENABLED
    && FQF_T4_SOURCE_RESEGMENTATION_V2_SHADOW_ENABLED
    && FQF_T4_SINGLE_REPLICA_CONFIRMED
    && TRANSLATION_DISPATCH_INDEPENDENT
    && BROADCAST_PARALLEL
    && TTS_PROGRESSIVE_ENABLED;
if (FQF_T4_SOURCE_RESEGMENTATION_V2_APPLY_ENABLED
    && !FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED) {
    console.error('[FQF_T4_V2] DISABLED: APPLY requires SourceMap V2, single-replica confirmation, independent + parallel + progressive delivery');
}

// Project B (B3.2): HG-level semantic dedup — Path C
const HG_DEDUP_ENABLED = process.env.HG_DEDUP_ENABLED === 'true';
const HG_DEDUP_SIMILARITY = parseFloat(process.env.HG_DEDUP_SIMILARITY) || 0.70;
const HG_DEDUP_JACCARD_MAX = parseFloat(process.env.HG_DEDUP_JACCARD_MAX) || 0.50;

let _embeddingClient = null;
function _getEmbeddingClient() {
    if (!_embeddingClient) {
        _embeddingClient = new OpenAI({
            apiKey: process.env.AZURE_OPENAI_KEY,
            baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_EMBEDDING_DEPLOYMENT || 'text-embedding-3-large'}`,
            defaultQuery: { 'api-version': '2024-02-01' },
            defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
        });
    }
    return _embeddingClient;
}

async function embedTextForDedup(text) {
    const resp = await _getEmbeddingClient().embeddings.create({ model: 'unused', input: text });
    return resp.data[0].embedding;
}

const hgDedupService = HG_DEDUP_ENABLED
    ? createHGDedupService({
          similarityThreshold: HG_DEDUP_SIMILARITY,
          tokenJaccardMax: HG_DEDUP_JACCARD_MAX,
          embedFn: embedTextForDedup,
          logFn: (entry) => evalLog(entry),
      })
    : null;

if (HG_DEDUP_ENABLED) {
    console.log(`[HG_DEDUP] Enabled (similarity=${HG_DEDUP_SIMILARITY}, jaccard_max=${HG_DEDUP_JACCARD_MAX})`);
}

// Intra-emission semantic cleanup: catches SmoothMode-batched P1 corrections
// before translation. Default off; Path C stays disabled because it is inter-emission.
const INTRA_EMISSION_DEDUP_CONFIG = {
    enabled: process.env.INTRA_EMISSION_DEDUP_ENABLED === 'true',
    minContentTokens: parseInt(process.env.INTRA_DEDUP_MIN_CONTENT_TOKENS || `${INTRA_DEDUP_DEFAULTS.minContentTokens}`, 10),
    containmentThreshold: parseFloat(process.env.INTRA_DEDUP_CONTAINMENT || `${INTRA_DEDUP_DEFAULTS.containmentThreshold}`),
    prefixTokenThreshold: parseInt(process.env.INTRA_DEDUP_PREFIX_TOKENS || `${INTRA_DEDUP_DEFAULTS.prefixTokenThreshold}`, 10),
    minNewContentTokens: parseInt(process.env.INTRA_DEDUP_MIN_NEW_TOKENS || `${INTRA_DEDUP_DEFAULTS.minNewContentTokens}`, 10),
    maxRemovalRatio: parseFloat(process.env.INTRA_DEDUP_MAX_REMOVAL_RATIO || `${INTRA_DEDUP_DEFAULTS.maxRemovalRatio}`),
    maxLookahead: parseInt(process.env.INTRA_DEDUP_MAX_LOOKAHEAD || `${INTRA_DEDUP_DEFAULTS.maxLookahead}`, 10),
    semanticEnabled: process.env.INTRA_EMISSION_DEDUP_SEMANTIC === 'true',
    semanticDryRun: process.env.INTRA_SEMANTIC_DRY_RUN !== 'false',
    semanticSimilarityThreshold: parseFloat(process.env.INTRA_SEMANTIC_SIMILARITY || `${INTRA_DEDUP_DEFAULTS.semanticSimilarityThreshold}`),
    semanticContainmentThreshold: parseFloat(process.env.INTRA_SEMANTIC_CONTAINMENT || `${INTRA_DEDUP_DEFAULTS.semanticContainmentThreshold}`),
    semanticMinPreviousTokens: parseInt(process.env.INTRA_SEMANTIC_MIN_PREV_TOKENS || `${INTRA_DEDUP_DEFAULTS.semanticMinPreviousTokens}`, 10),
    semanticMinCurrentTokens: parseInt(process.env.INTRA_SEMANTIC_MIN_CURRENT_TOKENS || `${INTRA_DEDUP_DEFAULTS.semanticMinCurrentTokens}`, 10),
};
if (INTRA_EMISSION_DEDUP_CONFIG.enabled) {
    console.log(`[INTRA_DEDUP] Enabled (containment=${INTRA_EMISSION_DEDUP_CONFIG.containmentThreshold}, max_removal=${INTRA_EMISSION_DEDUP_CONFIG.maxRemovalRatio}, semantic=${INTRA_EMISSION_DEDUP_CONFIG.semanticEnabled}, semantic_dry_run=${INTRA_EMISSION_DEDUP_CONFIG.semanticDryRun})`);
}

// P2.7 (05.08.2026): cross-emission semantic repeats — SHADOW ONLY.
// Scoring runs off the hot path; the flag gates ONLY the scoring, never the
// `source_semantic_reference` event, which is the pre-policy denominator R and must
// exist whether or not anything is being measured on top of it.
const SOURCE_SEMANTIC_REPEAT_SHADOW_CONFIG = {
    enabled: process.env.SOURCE_SEMANTIC_REPEAT_SHADOW_ENABLED === 'true',
    windowSec: parseFloat(process.env.P27_SHADOW_WINDOW_SEC || `${SHADOW_DEFAULTS.windowSec}`),
    maxHistoryUnits: parseInt(process.env.P27_SHADOW_MAX_HISTORY || `${SHADOW_DEFAULTS.maxHistoryUnits}`, 10),
    tauHighPrecision: parseFloat(process.env.P27_SHADOW_TAU_HIGH || `${SHADOW_DEFAULTS.tauHighPrecision}`),
    tauExploratory: parseFloat(process.env.P27_SHADOW_TAU_EXPLORATORY || `${SHADOW_DEFAULTS.tauExploratory}`),
    maxNewLexicalTokens: parseInt(process.env.P27_SHADOW_MAX_NEW_TOKENS || `${SHADOW_DEFAULTS.maxNewLexicalTokens}`, 10),
    maxQueueDepth: parseInt(process.env.P27_SHADOW_MAX_QUEUE || `${SHADOW_DEFAULTS.maxQueueDepth}`, 10),
};

const sourceSemanticRepeatShadow = createSourceSemanticRepeatShadow({
    embedFn: embedTextForDedup,
    logFn: (entry) => evalLog(entry),
    config: SOURCE_SEMANTIC_REPEAT_SHADOW_CONFIG,
});

const SOURCE_TEXT_LEDGER_SHADOW_CONFIG = {
    enabled: process.env.FQF_SOURCE_TEXT_LEDGER_SHADOW_ENABLED === 'true',
    windowSec: parseFloat(process.env.FQF_SOURCE_TEXT_LEDGER_WINDOW_SEC || `${DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.windowSec}`),
    maxHistoryReleases: parseInt(process.env.FQF_SOURCE_TEXT_LEDGER_MAX_HISTORY || `${DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.maxHistoryReleases}`, 10),
    minOverlapWords: parseInt(process.env.FQF_SOURCE_TEXT_LEDGER_MIN_OVERLAP_WORDS || `${DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.minOverlapWords}`, 10),
    maxWordsPerRelease: parseInt(process.env.FQF_SOURCE_TEXT_LEDGER_MAX_WORDS || `${DEFAULT_SOURCE_TEXT_LEDGER_CONFIG.maxWordsPerRelease}`, 10),
};

const sourceTextLedgerShadow = createSourceTextLedgerShadow({
    config: SOURCE_TEXT_LEDGER_SHADOW_CONFIG,
    logFn: (entry) => evalLog(entry),
});

if (sourceTextLedgerShadow.configErrors.length > 0) {
    console.error(`[FQF3A_SHADOW] INVALID/DISABLED — ${sourceTextLedgerShadow.configErrors.join('; ')}`);
} else if (sourceTextLedgerShadow.enabled) {
    const cfg = sourceTextLedgerShadow.config;
    console.log(`[FQF3A_SHADOW] Enabled (window=${cfg.windowSec}s, max_history=${cfg.maxHistoryReleases}, max_words=${cfg.maxWordsPerRelease}, min_overlap=${cfg.minOverlapWords}, SHADOW ONLY — no suppression)`);
}

const REVISION_ADMISSION_SHADOW_CONFIG = {
    enabled: FQF_T1_REVISION_ADMISSION_SHADOW_ENABLED,
    sourceMapV2ShadowEnabled: FQF_SOURCE_MAP_V2_SHADOW_ENABLED,
    windowSec: parseInt(process.env.FQF_T1_REVISION_WINDOW_SEC || `${DEFAULT_REVISION_ADMISSION_CONFIG.windowSec}`, 10),
    maxFamilies: parseInt(process.env.FQF_T1_REVISION_MAX_FAMILIES || `${DEFAULT_REVISION_ADMISSION_CONFIG.maxFamilies}`, 10),
    minLexicalAnchorWords: parseInt(process.env.FQF_T1_REVISION_MIN_LEXICAL_ANCHOR_WORDS || `${DEFAULT_REVISION_ADMISSION_CONFIG.minLexicalAnchorWords}`, 10),
    maxWordsPerRelease: parseInt(process.env.FQF_T1_REVISION_MAX_WORDS || `${DEFAULT_REVISION_ADMISSION_CONFIG.maxWordsPerRelease}`, 10),
};

const revisionAdmissionShadow = createRevisionAdmissionShadow({
    config: REVISION_ADMISSION_SHADOW_CONFIG,
    logFn: (entry) => evalLog(entry),
});

if (revisionAdmissionShadow.configErrors.length > 0) {
    console.error(`[FQF_T1_SHADOW] INVALID/DISABLED — ${revisionAdmissionShadow.configErrors.join('; ')}`);
} else if (revisionAdmissionShadow.enabled) {
    const cfg = revisionAdmissionShadow.config;
    console.log(`[FQF_T1_SHADOW] Enabled (window=${cfg.windowSec}s, max_families=${cfg.maxFamilies}, lexical_anchor=${cfg.minLexicalAnchorWords}, source_map_v2=${cfg.sourceMapV2ShadowEnabled}, SHADOW ONLY — no admission changes)`);
}

// A malformed env value (P27_SHADOW_MAX_QUEUE=abc -> NaN) must disable the shadow, not
// half-configure it: `queue.length >= NaN` is false forever, i.e. an unbounded queue.
if (sourceSemanticRepeatShadow.configErrors.length > 0) {
    console.error(`[P27_SHADOW] INVALID/DISABLED — ${sourceSemanticRepeatShadow.configErrors.join('; ')}`);
} else if (sourceSemanticRepeatShadow.config.enabled) {
    const cfg = sourceSemanticRepeatShadow.config;
    console.log(`[P27_SHADOW] Enabled (window=${cfg.windowSec}s, max_history=${cfg.maxHistoryUnits}, queue=${cfg.maxQueueDepth}, tau=${cfg.tauExploratory}/${cfg.tauHighPrecision}, SHADOW ONLY — no suppression)`);
}

function logTTSError({ emissionId, churchId, lang, gender, reason, error, releaseMeta = null }) {
    console.error(`[TTS] ❌ ${churchId}/${lang}/${gender}: ${reason}${error ? ' — ' + error : ''}`);
    evalLog({
        stage: 'tts_error',
        churchId,
        emissionId,
        ...releaseIdentityFields(releaseMeta),
        lang,
        gender,
        reason: reason || 'exception',
        error: error || null,
    });
}

function ttsRequestTelemetry({ churchId, emissionId, releaseMeta = null }) {
    return {
        onRequestStart: ({ language, gender, sentenceIndex, startedAtMs }) => evalLog({
            ts: new Date(startedAtMs).toISOString(),
            stage: 'tts_request_started',
            churchId,
            emissionId,
            ...releaseIdentityFields(releaseMeta),
            lang: language,
            gender,
            sentence_index: sentenceIndex,
        }),
    };
}

function translationRequestTelemetry({ churchId, emissionId, releaseMeta = null, queuedAt = null }) {
    return createTranslationRequestTelemetry({
        evalLog,
        churchId,
        emissionId,
        releaseFields: releaseIdentityFields(releaseMeta),
        queuedAt,
    });
}

function broadcastProgressiveTtsChunk({
    churchId,
    emissionId,
    releaseMeta,
    language,
    gender,
    sentenceIndex,
    totalSentences,
    sentenceText,
    audioBase64,
    isLast,
    latencyTxId,
    emissionMode,
    emissionReason,
    targetListenerSessionIds = null,
    excludeListenerSessionIds = null,
}) {
    const identity = buildTtsChunkIdentity({
        releaseMeta,
        language,
        sentenceIndex,
        sentenceText,
    });
    const chunkMsg = {
        type: 'tts_chunk',
        emissionId,
        source_hash: releaseMeta?.sourceHash ?? null,
        ...identity,
        gender,
        total_sentences: totalSentences,
        audioBase64: audioBase64 || null,
        audioFormat: 'mp3',
        is_last: isLast,
        emissionMode: emissionMode || null,
        emissionReason: emissionReason || null,
        ...revisionAdmissionTelemetry(releaseMeta),
        ...(releaseMeta?.sourceLineageEnabled
            ? { source_lineage_status: releaseMeta?.sourceLineage?.status || 'missing' }
            : {}),
    };
    if (latencyTxId) {
        chunkMsg.txId = latencyTxId;
        const audioCapturedAtSrv = getAudioCapturedAt(latencyTxId);
        if (audioCapturedAtSrv) chunkMsg.audioCapturedAt = audioCapturedAtSrv;
    }
    const listenersServed = broadcastToLanguageGender(
        churchId,
        language,
        gender,
        chunkMsg,
        {
            releaseMeta,
            synthesized: Boolean(audioBase64),
            targetListenerSessionIds,
            excludeListenerSessionIds,
        },
    );
    evalLog({
        stage: 'tts_chunk_sent',
        churchId,
        emissionId,
        source_hash: releaseMeta?.sourceHash ?? null,
        ...identity,
        ...sourceLineageFields(releaseMeta),
        gender,
        listeners_served: listenersServed,
        null_audio: !audioBase64,
        // Seconds of audio this chunk demands, for EVERY sent chunk — including the ones the
        // listener later drops. Only completed chunks ever reported a duration, so without
        // this `demand_sec` was an extrapolation and the falsification condition of the
        // Early Catch-up spec (§6) was undecidable. Estimate, validated against the client
        // decoder (`decoder_duration_ms`) before it feeds a gate.
        audio_duration_estimate_ms: estimateAudioDurationMsFromBase64(audioBase64),
    });
    return listenersServed;
}

// ============================================================
// Configuration
// ============================================================
const config = {
    port: process.env.PORT || 8080,
    appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`,
    clientFeatures: buildClientFeatureConfig(process.env),
    // Azure OpenAI for GPT-4.1-mini (translations)
    openai: {
        key: process.env.AZURE_OPENAI_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    },
    targetLanguages: ['ar', 'de', 'en', 'es', 'fr', 'it', 'pl', 'pt', 'ru', 'sw', 'tr', 'uk'],
    languageNames: {
        'ar': 'العربية',
        'de': 'Deutsch',
        'en': 'English',
        'es': 'Español',
        'fr': 'Français',
        'it': 'Italiano',
        'pl': 'Polski',
        'pt': 'Português',
        'ru': 'Русский',
        'sw': 'Kiswahili',
        'tr': 'Türkçe',
        'uk': 'Українська'
    },
    // Whisper Auto-Shutdown Configuration (05.02.2026)
    // Automatically stops Whisper container after inactivity to save costs
    whisperAutoShutdown: {
        enabled: process.env.WHISPER_AUTO_SHUTDOWN !== 'false',  // Default: enabled
        inactivityMinutes: parseInt(process.env.WHISPER_INACTIVITY_MINUTES || '15'),
        checkIntervalMs: 60000,  // Check every 1 minute
        azureResourceGroup: process.env.AZURE_RESOURCE_GROUP || 'barnaba-rg',
        azureContainerName: process.env.WHISPER_CONTAINER_NAME || 'barnaba-whisper',
    },
    // Smooth Mode Configuration (26.01.2026)
    // Provides smoother translations by accumulating sentences before release
    smoothMode: {
        enabled: process.env.SMOOTH_MODE_ENABLED !== 'false',  // Default: enabled
        initialBufferSec: parseFloat(process.env.SMOOTH_INITIAL_BUFFER_SEC || '5'),  // Warm-up (02.03.2026): 10→5
        minSentences: parseInt(process.env.SMOOTH_MIN_SENTENCES || '2'),
        minChars: parseInt(process.env.SMOOTH_MIN_CHARS || '50'),
        earlyReleaseMs: parseFloat(process.env.SMOOTH_EARLY_RELEASE_SEC || '7') * 1000,
        maxHoldMs: parseFloat(process.env.SMOOTH_MAX_HOLD_SEC || '10') * 1000,
        catchupThresholdSec: parseFloat(process.env.SMOOTH_CATCHUP_THRESHOLD_SEC || '25'),
        catchupMinSentences: parseInt(process.env.SMOOTH_CATCHUP_MIN_SENTENCES || '3'),
        // Warm-up (02.03.2026): relaxed thresholds for first emission only
        warmupMinSentences: parseInt(process.env.SMOOTH_WARMUP_MIN_SENTENCES || '1'),
        warmupMinChars: parseInt(process.env.SMOOTH_WARMUP_MIN_CHARS || '30'),
    },
    // Partial Fallback (11.03.2026): emit partial text when LocalAgreement stalls
    // Addresses 42% gap problem — Swiss German causes LA to rarely confirm
    partialFallback: {
        enabled: process.env.PARTIAL_FALLBACK_ENABLED !== 'false',  // Default: enabled
        timeoutMs: parseFloat(process.env.PARTIAL_FALLBACK_SEC || '10') * 1000,
        minPartialLength: 20,       // Ignore short fragments
        similarityThreshold: 0.7,   // Jaccard: don't re-emit if >70% overlap with last fallback
        listenerClockEnabled: process.env.PARTIAL_FALLBACK_LISTENER_CLOCK_ENABLED === 'true',
        repairShadowEnabled: process.env.A5_3_REPAIR_SHADOW_ENABLED === 'true',
        repairShadowBufferSec: parseFloat(process.env.A5_3_REPAIR_BUFFER_SEC || '6'),
        repairShadowCycles: parseInt(process.env.A5_3_REPAIR_CYCLES || '2', 10),
        repairShadowCooldownMs: parseFloat(process.env.A5_3_REPAIR_COOLDOWN_SEC || '10') * 1000
    },
    deadlineFallback: {
        enabled: process.env.LISTENER_DEADLINE_FALLBACK_ENABLED === 'true',
        timeoutMs: parseFloat(process.env.LISTENER_DEADLINE_FALLBACK_SEC || '6.5') * 1000,
        checkIntervalMs: parseFloat(process.env.LISTENER_DEADLINE_FALLBACK_CHECK_SEC || '1') * 1000,
        // Refined A2.7 (10.07.2026): when ON, the deadline emits the new STABLE DELTA via the
        // fallback ladder (stable -> safe-prefix -> skip) instead of the raw partial, and finals
        // that only repeat a provisional are superseded server-side. Default OFF -> legacy
        // raw-partial behavior (flag-gated).
        provisionalEnabled: process.env.LISTENER_DEADLINE_PROVISIONAL_ENABLED === 'true',
        // Finding #5 (10.07) turned out to REGRESS the cap: suppressing the age_budget backstop
        // wholesale left the deadline's rung-3 skip (deadline_no_safe_payload) with no gap-filler
        // -> 41 skips, pauses 11-26s, listening review 3.68 NO-GO. The suppression is now
        // OPT-IN behind its own flag (default OFF) so age_budget stays as the backstop; the
        // ledger/cumulative-supersede/tail-rescue/telemetry fixes stay behind provisionalEnabled.
        suppressAgeBudget: process.env.LISTENER_DEADLINE_SUPPRESS_AGE_BUDGET_ENABLED === 'true',
        // The review findings used to ride on provisionalEnabled itself, so a rebuild from master
        // with the 4.52 env reproduced the alternative arm (listening review 3.6) rather than the
        // pinned baseline (4.52). They now need their own opt-in:
        // provisionalEnabled alone == refined A2.7 == 4.52. Both conditions stay explicit at
        // every call site - this flag NEVER replaces provisionalEnabled.
        // Gated: per-entry ledger -> cumulative span, ledger write moved to 'queued',
        // whole-span stale-clear, deadlineLedger clearing. NOT gated: the finding #6 telemetry
        // whitelist (records beacons, does not change what a listener hears - equivalence here
        // is defined as user-observable behavior).
        reviewFixesEnabled: process.env.LISTENER_DEADLINE_REVIEW_FIXES_ENABLED === 'true',
        minDeltaWords: parseInt(process.env.LISTENER_DEADLINE_MIN_DELTA_WORDS || '3', 10),
        // Finding #5 (10.07): separate min for the supersede emit-tail decision. Tails below it
        // are emitted ONLY when significant (digit/negation) so short-but-critical tails
        // ("Hiob 42", "...nicht") are not lost. Defaults to minDeltaWords.
        minEmitTailWords: parseInt(process.env.LISTENER_DEADLINE_MIN_EMIT_TAIL_WORDS || process.env.LISTENER_DEADLINE_MIN_DELTA_WORDS || '3', 10),
        supersedeTtlMs: parseFloat(process.env.LISTENER_DEADLINE_SUPERSEDE_TTL_SEC || '25') * 1000,
    },
    fallbackCoordinatorShadow: {
        enabled: process.env.FQF_FALLBACK_COORDINATOR_SHADOW_ENABLED === 'true',
        applyEnabled: FQF_FALLBACK_COORDINATOR_APPLY_ENABLED,
    },
    holdN: {
        enabled: process.env.HOLD_N_ENABLED === 'true',
        words: parseInt(process.env.HOLD_N_WORDS || '0')
    },
    // P-B (disconnect drain, 21.06): flush pending tail (final transcription + smooth accumulator
    // + HOLD_N) and drain the queue BEFORE flushSessionSummary + state cleanup, so the last
    // sentence reaches listeners instead of being discarded at teardown. Default OFF (flag).
    // Default OFF (flag).
    disconnectDrain: {
        enabled: process.env.DISCONNECT_FLUSH_ENABLED === 'true',
        // Split per-stage caps bound the whole drain (no separate "total" knob — it would
        // suggest a guarantee the runtime doesn't enforce). Worst case ~= final + queue.
        finalTranscribeTimeoutMs: parseFloat(process.env.DISCONNECT_FINAL_TRANSCRIBE_TIMEOUT_SEC || '4') * 1000,
        queueDrainTimeoutMs: parseFloat(process.env.DISCONNECT_QUEUE_DRAIN_TIMEOUT_SEC || '6') * 1000,
    },
    // Age Budget (22.05.2026): avoid producing late audio that increases audible drift.
    // Default off; enabled only after Smooth Mode tuning baseline is measured.
    ageBudget: {
        enabled: process.env.AGE_BUDGET_ENABLED === 'true',
        cautiousAfterMs: parseFloat(process.env.AGE_BUDGET_CAUTION_SEC || '8') * 1000,
        textOnlyAfterMs: parseFloat(process.env.AGE_BUDGET_TEXT_ONLY_SEC || '12') * 1000,
        dropAfterMs: parseFloat(process.env.AGE_BUDGET_DROP_SEC || '20') * 1000,
        unhealthyQueueDepth: parseInt(process.env.AGE_BUDGET_UNHEALTHY_QUEUE_DEPTH || '4')
    },
    emissionController: {
        enabled: process.env.EMISSION_CONTROLLER_ENABLED !== 'false',
        shadowLoggingEnabled: process.env.EMISSION_CONTROLLER_SHADOW_LOGGING !== 'false',
        qualityMaxAgeMs: parseFloat(process.env.EMISSION_CONTROLLER_QUALITY_SEC || '3') * 1000,
        fastMaxAgeMs: parseFloat(process.env.EMISSION_CONTROLLER_FAST_SEC || '7') * 1000,
        catchupMaxAgeMs: parseFloat(process.env.EMISSION_CONTROLLER_CATCHUP_SEC || '12') * 1000,
        dropAfterMs: parseFloat(process.env.EMISSION_CONTROLLER_DROP_SEC || '20') * 1000,
        unhealthyQueueDepth: parseInt(process.env.EMISSION_CONTROLLER_UNHEALTHY_QUEUE_DEPTH || '4'),
        overloadedQueueDepth: parseInt(process.env.EMISSION_CONTROLLER_OVERLOADED_QUEUE_DEPTH || '8')
    },
    liveQuality: {
        enabled: process.env.LIVE_QUALITY_STATE_ENABLED !== 'false',
        windowMs: parseFloat(process.env.LIVE_QUALITY_WINDOW_SEC || '60') * 1000,
        listenerMeasurementMaxAgeMs: parseFloat(
            process.env.LIVE_QUALITY_LISTENER_MAX_AGE_SEC || '30'
        ) * 1000
    },
    liveQualityAutopilot: {
        enabled: process.env.LIVE_QUALITY_AUTOPILOT_ENABLED !== 'false',
        shadowLoggingEnabled: process.env.LIVE_QUALITY_AUTOPILOT_SHADOW_LOGGING !== 'false',
        applyEnabled: process.env.LIVE_QUALITY_AUTOPILOT_APPLY === 'true',
        minConfidenceToAct: parseFloat(process.env.LIVE_QUALITY_AUTOPILOT_MIN_CONFIDENCE || '0.4')
    },
    flowGovernor: {
        enabled: process.env.FLOW_GOVERNOR_ENABLED !== 'false',
        shadowLoggingEnabled: process.env.FLOW_GOVERNOR_SHADOW_LOGGING !== 'false',
        applyEnabled: process.env.FLOW_GOVERNOR_APPLY === 'true',
        minStableWords: parseInt(process.env.FLOW_GOVERNOR_MIN_STABLE_WORDS || '5'),
        minStableChars: parseInt(process.env.FLOW_GOVERNOR_MIN_STABLE_CHARS || '28'),
        fastSoftCommitAgeMs: parseFloat(process.env.FLOW_GOVERNOR_FAST_SOFT_COMMIT_SEC || '5') * 1000,
        catchupSoftCommitAgeMs: parseFloat(process.env.FLOW_GOVERNOR_CATCHUP_SOFT_COMMIT_SEC || '3.5') * 1000,
        criticalSoftCommitAgeMs: parseFloat(process.env.FLOW_GOVERNOR_CRITICAL_SOFT_COMMIT_SEC || '2.5') * 1000,
        forceFallbackAgeMs: parseFloat(process.env.FLOW_GOVERNOR_FORCE_FALLBACK_SEC || '7') * 1000,
        criticalForceFallbackAgeMs: parseFloat(process.env.FLOW_GOVERNOR_CRITICAL_FORCE_FALLBACK_SEC || '4.5') * 1000
    },
    boundaryCommitLedger: {
        enabled: process.env.BOUNDARY_COMMIT_LEDGER_ENABLED === 'true',
        applyExact: process.env.BOUNDARY_COMMIT_LEDGER_APPLY === 'true',
        shadowSemantic: process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_SHADOW !== 'false',
        applySemantic: process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_APPLY === 'true',
        semanticApplyRatio: parseFloat(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_APPLY_RATIO || '0.8'),
        semanticHighConfidenceSpanRatio: parseFloat(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_HIGH_CONFIDENCE_SPAN_RATIO || '0.8'),
        semanticApplyRatioLong: parseFloat(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_APPLY_RATIO_LONG || '0.7'),
        semanticLongMinTokens: parseInt(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_LONG_MIN_TOKENS || '5'),
        semanticLexicalConfirm: parseFloat(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_LEXICAL_CONFIRM || '0.6'),
        minExactTokens: parseInt(process.env.BOUNDARY_COMMIT_LEDGER_MIN_EXACT_TOKENS || '2'),
        maxExactTokens: parseInt(process.env.BOUNDARY_COMMIT_LEDGER_MAX_EXACT_TOKENS || '8'),
        maxTailTokens: parseInt(process.env.BOUNDARY_COMMIT_LEDGER_MAX_TAIL_TOKENS || '14'),
        maxHeadTokens: parseInt(process.env.BOUNDARY_COMMIT_LEDGER_MAX_HEAD_TOKENS || '14'),
        semanticThreshold: parseFloat(process.env.BOUNDARY_COMMIT_LEDGER_SEMANTIC_THRESHOLD || '0.72')
    },
    boundaryConfirmation: {
        // Iteration 1 (18.06.2026): look-ahead terminal boundary confirmation.
        // Whisper ends ~98% of partials with a period; confirm a boundary only via VAD pause
        // or prefix-survival into the next update before trusting it.
        shadowEnabled: process.env.BOUNDARY_CONFIRMATION_SHADOW !== 'false',  // default ON: measure only
        applyEnabled: process.env.BOUNDARY_CONFIRMATION_APPLY === 'true',     // default OFF: wired in iteration 2
    },
    // Q1b no-open-cut (22.06.2026): WIRING of existing flowGovernor decisions to real
    // partial-fallback emission, so open or truncated partials ("...wchodzimy w") are no longer
    // flushed raw. This is NOT a new boundary heuristic — it maps already-produced governor
    // decisions (would_hold / would_soft_commit_prefix / would_merge_to_next / would_force_fallback /
    // would_micro_emit) onto the emission, reusing splitAtSafeBoundary for safe-prefix split.
    // DECISION: default ON (no env var => no-open-cut active). Set NO_OPEN_CUT_ENABLED=false to disable.
    // Hard cap counted from firstHeldAt (first held tail), NOT reset on every partial update.
    // Hard cap counted from firstHeldAt (first held tail), NOT reset on every partial update.
    noOpenCut: {
        enabled: process.env.NO_OPEN_CUT_ENABLED !== 'false',  // Default: ENABLED (project decision)
        maxHoldMs: parseFloat(process.env.NO_OPEN_CUT_MAX_HOLD_MS || '8000'),
    }
};

const FQF_FALLBACK_COORDINATOR_SHADOW_CONFIG_ERRORS = fallbackCoordinatorShadowConfigErrors({
    enabled: config.fallbackCoordinatorShadow.enabled,
    ttlMs: config.deadlineFallback.timeoutMs,
    minTailWords: config.deadlineFallback.minEmitTailWords,
    historyCommitOnAcceptEnabled: FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED,
});
const FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED =
    config.fallbackCoordinatorShadow.enabled
    && FQF_FALLBACK_COORDINATOR_SHADOW_CONFIG_ERRORS.length === 0;
const FQF_FALLBACK_COORDINATOR_APPLY_CONFIG_ERRORS = fallbackCoordinatorApplyConfigErrors({
    enabled: config.fallbackCoordinatorShadow.applyEnabled,
    shadowEnabled: FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED,
    historyCommitOnAcceptEnabled: FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED,
});
const FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED =
    config.fallbackCoordinatorShadow.applyEnabled
    && FQF_FALLBACK_COORDINATOR_APPLY_CONFIG_ERRORS.length === 0;
const fallbackCoordinatorApplyWaiters = new FallbackCoordinatorApplyWaiters();
const fallbackCoordinatorApplyEnqueueSequencer = new PerChurchEnqueueSequencer();
if (FQF_FALLBACK_COORDINATOR_SHADOW_CONFIG_ERRORS.length > 0) {
    console.error(`[FQF2_SHADOW] INVALID/DISABLED — ${FQF_FALLBACK_COORDINATOR_SHADOW_CONFIG_ERRORS.join('; ')}`);
} else if (FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED) {
    console.log(`[FQF2_SHADOW] Enabled (accepted-enqueue window=${config.deadlineFallback.timeoutMs}ms, apply=${FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED})`);
}
if (FQF_FALLBACK_COORDINATOR_APPLY_CONFIG_ERRORS.length > 0) {
    console.error(`[FQF2_APPLY] INVALID/DISABLED — ${FQF_FALLBACK_COORDINATOR_APPLY_CONFIG_ERRORS.join('; ')}`);
}

const isDevEnvironment =
    process.env.DEV_BADGE === 'true' ||
    process.env.NODE_ENV === 'development' ||
    /(^|[-_])dev($|[-_])/i.test(process.env.AZURE_RESOURCE_GROUP || '') ||
    /(^|[-_])dev($|[-_])/i.test(process.env.GATEWAY_CONTAINER_NAME || '');

const isLocalAppUrl = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.appUrl);
const secureCookies = process.env.COOKIE_SECURE === 'true'
    || (process.env.COOKIE_SECURE !== 'false' && !isLocalAppUrl);

function normalizePublicOrigin(value) {
    if (!value) return null;
    try {
        const parsed = new URL(String(value));
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

function getRequestPublicOrigin(req) {
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host');
    return normalizePublicOrigin(host ? `${proto}://${host}` : null);
}

// Log Smooth Mode config
console.log(`[Config] Smooth Mode: ${config.smoothMode.enabled ? 'ENABLED' : 'DISABLED'}`);
if (config.smoothMode.enabled) {
    console.log(`[Config] - Initial buffer: ${config.smoothMode.initialBufferSec}s`);
    console.log(`[Config] - Min sentences: ${config.smoothMode.minSentences}`);
    console.log(`[Config] - Early release: ${config.smoothMode.earlyReleaseMs}ms`);
    console.log(`[Config] - Max hold: ${config.smoothMode.maxHoldMs}ms`);
}
console.log(`[Config] Partial Fallback: ${config.partialFallback.enabled ? 'ENABLED' : 'DISABLED'}`);
if (config.partialFallback.enabled) {
    console.log(`[Config] - Fallback timeout: ${config.partialFallback.timeoutMs}ms`);
    console.log(`[Config] - Min partial length: ${config.partialFallback.minPartialLength} chars`);
    console.log(`[Config] - Similarity threshold: ${config.partialFallback.similarityThreshold}`);
}
console.log(`[Config] Hold-N: ${config.holdN.enabled ? 'ENABLED' : 'DISABLED'} (${config.holdN.words} words)`);
console.log(`[Config] No-Open-Cut: ${config.noOpenCut.enabled ? 'ENABLED' : 'DISABLED'} (max hold from firstHeldAt: ${config.noOpenCut.maxHoldMs}ms)`);

// clearHeldTail (Q1b OPT1) is imported from ./noOpenCut.js - pure, unit-tested helper that
// resets the diagnostics-only trackedTail + hard-cap clock on a fallbackState entry.

function logEmissionControllerShadow(payload) {
    if (!config.emissionController.shadowLoggingEnabled) return null;
    recordLiveQualityMetric(payload.churchId, {
        stage: 'emission_controller_shadow',
        age_ms: payload.signals?.ageMs,
        queue_depth: payload.signals?.queueDepth,
        action: payload.runtimeDecision,
    });
    logAutopilotShadow(payload.churchId, { source: payload.source });
    return logEmissionControllerDecision(evalLog, {
        ...payload,
        config: {
            ...config.emissionController,
            enabled: true,
        },
    });
}

function decideEmissionControllerRuntime(payload) {
    if (!config.emissionController.enabled) return null;
    const effectiveConfig = getEffectiveEmissionControllerConfig(payload.churchId);
    const autopilotDecision = getAutopilotDecision(payload.churchId);
    if (config.liveQualityAutopilot.applyEnabled && autopilotDecision?.profile === 'text_only') {
        const ageMs = Math.max(0, Number(payload.signals?.ageMs) || 0);
        const queueDepth = Math.max(0, Number(payload.signals?.queueDepth) || 0);
        const audioSkipDecision = {
            action: 'audio_skip',
            mode: 'audio_skip',
            reason: autopilotDecision.reason,
            ageMs,
            queueDepth,
        };
        evalLog({
            stage: 'emission_controller_runtime',
            churchId: payload.churchId,
            emissionId: payload.emissionId ?? null,
            lang: payload.language ?? null,
            source: payload.source ?? null,
            origin: payload.origin ?? null,
            session_epoch: payload.sessionEpoch ?? null,
            release_seq: payload.releaseSeq ?? null,
            runtime_action: audioSkipDecision.action,
            runtime_mode: audioSkipDecision.mode,
            runtime_reason: audioSkipDecision.reason,
            age_ms: audioSkipDecision.ageMs,
            queue_depth: audioSkipDecision.queueDepth,
            autopilot_profile: autopilotDecision.profile,
        });
        return audioSkipDecision;
    }
    const controllerDecision = decideEmission(payload.signals, {
        ...effectiveConfig,
        enabled: true,
    });
    recordLiveQualityMetric(payload.churchId, {
        stage: 'emission_controller_runtime',
        age_ms: controllerDecision.ageMs,
        queue_depth: controllerDecision.queueDepth,
        action: controllerDecision.action,
    });
    evalLog({
        stage: 'emission_controller_runtime',
        churchId: payload.churchId,
        emissionId: payload.emissionId ?? null,
        lang: payload.language ?? null,
        source: payload.source ?? null,
        origin: payload.origin ?? null,
        session_epoch: payload.sessionEpoch ?? null,
        release_seq: payload.releaseSeq ?? null,
        runtime_action: controllerDecision.action,
        runtime_mode: controllerDecision.mode,
        runtime_reason: controllerDecision.reason,
        age_ms: controllerDecision.ageMs,
        queue_depth: controllerDecision.queueDepth,
        autopilot_profile: autopilotDecision?.profile ?? null,
    });
    return controllerDecision;
}

function getOrCreateLiveQualityState(churchId) {
    if (!config.liveQuality.enabled || !churchId) return null;
    if (!state.liveQualityStates.has(churchId)) {
        state.liveQualityStates.set(churchId, new LiveQualityState({
            windowMs: config.liveQuality.windowMs,
            listenerMeasurementMaxAgeMs: config.liveQuality.listenerMeasurementMaxAgeMs,
        }));
    }
    return state.liveQualityStates.get(churchId);
}

function recordLiveQualityMetric(churchId, metric = {}) {
    const liveState = getOrCreateLiveQualityState(churchId);
    if (!liveState) return null;
    return liveState.record(metric);
}

function recordLiveQualityFromEvalEntry(entry = {}) {
    if (!entry.churchId) return null;
    return recordLiveQualityMetric(entry.churchId, entry);
}

function getLiveQualitySnapshot(churchId) {
    const liveState = getOrCreateLiveQualityState(churchId);
    return liveState ? liveState.snapshot() : null;
}

function getAutopilotDecision(churchId) {
    if (!config.liveQualityAutopilot.enabled) return null;
    const snapshot = getLiveQualitySnapshot(churchId);
    if (!snapshot) return null;
    return decideAutopilotProfile(snapshot, {
        enabled: true,
        minConfidenceToAct: config.liveQualityAutopilot.minConfidenceToAct,
    });
}

function logAutopilotShadow(churchId, extra = {}) {
    if (!config.liveQualityAutopilot.enabled || !config.liveQualityAutopilot.shadowLoggingEnabled) return null;
    const snapshot = getLiveQualitySnapshot(churchId);
    if (!snapshot) return null;
    return logAutopilotShadowDecision(evalLog, {
        churchId,
        snapshot,
        source: extra.source || null,
        config: {
            enabled: true,
            minConfidenceToAct: config.liveQualityAutopilot.minConfidenceToAct,
        },
    });
}

function getEffectiveEmissionControllerConfig(churchId) {
    if (!config.liveQualityAutopilot.applyEnabled) return config.emissionController;
    const decision = getAutopilotDecision(churchId);
    if (!decision) return config.emissionController;
    return applyAutopilotProfileToEmissionConfig(config.emissionController, decision.profile);
}

function getFlowGovernorProfile(churchId) {
    const decision = getAutopilotDecision(churchId);
    return decision?.flowGovernorProfile || 'normal';
}

function logFlowGovernorShadow(churchId, signals = {}, extra = {}) {
    if (!config.flowGovernor.enabled || !config.flowGovernor.shadowLoggingEnabled) return null;
    return logFlowGovernorShadowDecision(evalLog, {
        churchId,
        source: extra.source || null,
        signals: {
            ...signals,
            profile: signals.profile || getFlowGovernorProfile(churchId),
        },
        config: {
            ...config.flowGovernor,
            enabled: true,
        },
    });
}

// Shadow audit at every processCompleteSentence entry. The emissionId
// hard-link is deferred to the chokepoint refactor - offline join is by
// source_hash + ts + release_seq (validated earlier). Never throws into the
// emission flow. resurface_*/cadence_percentile are computed offline from the sequence.
// NOTE: origin is precise only for the 6 tagged call-sites; everything else is the
// conscious 'legacy' bucket (handleSpeechText, PCM sentence buffer, disconnect cleanup...).
function logSourceReleaseAudit(churchId, text, origin, releaseReason, ctx = {}) {
    const t = String(text || '').trim();
    if (!t) return null;
    const releaseMeta = {
        sessionEpoch: _sessionEpoch,
        releaseSeq: ++_sourceReleaseSeq,
        sourceHash: crypto.createHash('sha1').update(t).digest('hex').slice(0, 12),
        sourceLen: t.length,
        origin: origin || ctx.source || 'legacy',
        releaseReason: releaseReason || null,
    };
    if (!SOURCE_RELEASE_AUDIT_ENABLED) return releaseMeta;
    try {
        // disconnect drain passes options.source (kept for drainMeta) instead of origin.
        const resolvedOrigin = origin || ctx.source || 'legacy';
        // Most call-sites don't pass a real semantic judge -> mark whether it was explicit
        // so the first session isn't misread as "everything semantically incomplete".
        const scSource = typeof ctx.semanticComplete === 'boolean' ? 'explicit' : 'default_false';
        const dec = decideFlowGovernor(
            {
                text: t,
                profile: ctx.profile || getFlowGovernorProfile(churchId),
                ageMs: Number(ctx.ageMs) || 0,
                semanticComplete: ctx.semanticComplete === true,
                stablePrefixWords: Number(ctx.stablePrefixWords) || 0,
            },
            { ...config.flowGovernor, enabled: true },
        );
        const closed = endsWithTerminal(t) && !endsOnOpenWord(t);
        const { head: safePrefix, tail: heldTail } = splitAtSafeBoundary(t);
        // SHADOW approximation of the no-open-cut action (computed from splitAtSafeBoundary,
        // NOT the stateful decideNoOpenCutAction) — hence audit_only + shadow_ prefix.
        let action; let completeness;
        if (closed) { action = 'emit_full'; completeness = 'closed'; }
        else if (safePrefix && heldTail) { action = 'emit_prefix_hold'; completeness = 'closed_prefix_held_tail'; }
        else if (safePrefix) { action = 'emit_full'; completeness = 'closed'; }
        else { action = 'hold'; completeness = 'open'; }
        evalLog({
            stage: 'source_release_audit',
            churchId,
            audit_only: true,
            release_seq: releaseMeta.releaseSeq,
            origin: resolvedOrigin,
            release_reason: releaseReason || null,
            source_hash: releaseMeta.sourceHash,
            source_preview: t.slice(0, 200),
            source_tail: t.slice(-80),
            source_len: t.length,
            terminal_boundary: dec.terminalBoundary,
            soft_boundary: dec.softBoundary,
            ends_open_word: endsOnOpenWord(t),
            boundary_quality: closed ? 'closed' : 'open',
            semantic_complete: dec.semanticComplete,
            semantic_complete_source: scSource,
            completeness_score: dec.completenessScore,
            flow_governor_decision: dec.decision,
            flow_governor_reason: dec.reason,
            word_count: dec.wordCount,
            safe_prefix_len: safePrefix.length,
            safe_prefix_ratio: t.length ? Number((safePrefix.length / t.length).toFixed(3)) : 0,
            held_tail_len: heldTail.length,
            shadow_no_open_cut_action: action,
            emission_completeness: completeness,
        });
    } catch (err) {
        // Shadow audit must NEVER break emission flow.
    }
    return releaseMeta;
}

function logFallbackCoordinatorShadow(event) {
    try { evalLog(event); } catch { /* shadow logging must never affect emission */ }
}

function observeFallbackCoordinatorShadowAtAcceptedEnqueue({
    churchId,
    origin,
    text,
    releaseMeta,
    policyApplied = false,
}) {
    if (!FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED) return null;
    try {
        const previousState = state.fallbackState.get(churchId)?.fqf2CoordinatorShadow ?? null;
        const result = observeFallbackAcceptedEnqueue({
            state: previousState,
            churchId,
            origin,
            text,
            releaseMeta,
            nowMs: Date.now(),
            ttlMs: config.deadlineFallback.timeoutMs,
            policyApplied,
        });
        if (!result.observed) return result;

        const fallbackState = state.fallbackState.get(churchId);
        if (!fallbackState) {
            logFallbackCoordinatorShadow({
                stage: 'fqf_fallback_coordinator_shadow',
                churchId,
                policy_applied: policyApplied,
                decision: 'shadow_error',
                requires_reevaluation: false,
                reason: 'missing_fallback_state',
            });
            return null;
        }
        fallbackState.fqf2CoordinatorShadow = result.state;
        if (result.event) logFallbackCoordinatorShadow(result.event);
        if (result.reevaluationCandidate) {
            evaluateFallbackCoordinatorShadowCandidate(churchId, result.reevaluationCandidate);
        }
        return result;
    } catch {
        // Measurement must be fail-open and must not surface source text in an error.
        logFallbackCoordinatorShadow({
            stage: 'fqf_fallback_coordinator_shadow',
            churchId,
            policy_applied: policyApplied,
            decision: 'shadow_error',
            requires_reevaluation: false,
            reason: 'invalid_observation',
        });
        return null;
    }
}

function evaluateFallbackCoordinatorShadowCandidate(churchId, candidate) {
    try {
        const p2Result = crossEmissionDedup(candidate.payloadText, churchId, {
            deferCommit: true,
            silent: true,
        });
        const b4Result = p2Result.action === 'skip'
            ? { text: '', action: 'not_run' }
            : jaccardOverlapGuard(p2Result.text, churchId, {
                deferCommit: true,
                silent: true,
            });
        const projection = classifyFallbackReevaluation({
            originalText: candidate.payloadText,
            p2Result,
            b4Result,
            minTailWords: config.deadlineFallback.minEmitTailWords,
        });
        logFallbackCoordinatorShadow({
            stage: 'fqf_fallback_coordinator_reevaluation_shadow',
            churchId,
            policy_applied: false,
            projected_action: projection.action,
            original_payload_chars: candidate.payloadChars,
            original_payload_words: candidate.payloadWords,
            projected_payload_chars: projection.projectedText.length,
            projected_payload_words: projection.projectedWords,
            p2_action: p2Result.action,
            b4_action: b4Result.action,
            loser_origin: candidate.origin,
            loser_session_epoch: candidate.sessionEpoch,
            loser_release_seq: candidate.releaseSeq,
            loser_source_hash: candidate.sourceHash,
            loser_emitted_source_hash: candidate.emittedSourceHash,
        });
        fallbackCoordinatorApplyWaiters.resolve({ churchId, candidate, projection });
        return projection;
    } catch {
        const projection = { action: 'shadow_error' };
        logFallbackCoordinatorShadow({
            stage: 'fqf_fallback_coordinator_reevaluation_shadow',
            churchId,
            policy_applied: false,
            projected_action: 'shadow_error',
            loser_origin: candidate?.origin ?? null,
            loser_session_epoch: candidate?.sessionEpoch ?? null,
            loser_release_seq: candidate?.releaseSeq ?? null,
        });
        fallbackCoordinatorApplyWaiters.resolve({ churchId, candidate, projection });
        return projection;
    }
}

function logFallbackCoordinatorApply({ churchId, candidate, decision, waitMs, winnerGeneration }) {
    logFallbackCoordinatorShadow({
        stage: 'fqf_fallback_coordinator_apply',
        churchId,
        policy_applied: true,
        decision: decision.action,
        reason: decision.reason,
        wait_ms: Math.max(0, Number(waitMs) || 0),
        max_wait_ms: FALLBACK_COORDINATOR_APPLY_MAX_WAIT_MS,
        winner_accepted_enqueue_order: winnerGeneration ?? null,
        loser_origin: candidate?.origin ?? null,
        loser_payload_chars: candidate?.payloadChars ?? null,
        loser_payload_words: candidate?.payloadWords ?? null,
        loser_session_epoch: candidate?.sessionEpoch ?? null,
        loser_release_seq: candidate?.releaseSeq ?? null,
        loser_source_hash: candidate?.sourceHash ?? null,
        loser_emitted_source_hash: candidate?.emittedSourceHash ?? null,
    });
}

async function coordinateFallbackCoordinatorApplyBeforeEnqueue({
    churchId,
    origin,
    text,
    releaseMeta,
}) {
    if (!FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) {
        return { action: 'enqueue_full', reason: 'apply_disabled', observedBeforeEnqueue: false };
    }

    const startedAtMs = Date.now();
    const observation = observeFallbackCoordinatorShadowAtAcceptedEnqueue({
        churchId,
        origin,
        text,
        releaseMeta,
        policyApplied: true,
    });
    if (!observation?.observed) {
        return { action: 'enqueue_full', reason: 'observation_unavailable', observedBeforeEnqueue: false };
    }
    if (!observation.requiresReevaluation) {
        return { action: 'enqueue_full', reason: observation.event?.decision || 'not_a_collision', observedBeforeEnqueue: true };
    }

    const candidate = observation.candidate;
    const winnerGeneration = observation.state?.winner?.acceptedEnqueueOrder;
    let waitResult;
    if (observation.reevaluationCandidate) {
        waitResult = {
            status: 'evaluated',
            projection: evaluateFallbackCoordinatorShadowCandidate(churchId, candidate),
        };
    } else {
        waitResult = await fallbackCoordinatorApplyWaiters.wait({
            churchId,
            candidate,
            deadlineMs: observation.state?.winner?.armedUntilMs,
            generation: winnerGeneration,
        });
    }

    const decision = waitResult.status === 'evaluated'
        ? conservativeFallbackApplyDecision(waitResult.projection)
        : { action: 'enqueue_full', reason: waitResult.reason || 'evaluation_unavailable' };
    logFallbackCoordinatorApply({
        churchId,
        candidate,
        decision,
        waitMs: Date.now() - startedAtMs,
        winnerGeneration,
    });
    return { ...decision, observedBeforeEnqueue: true };
}

function cancelFallbackCoordinatorObservation(churchId, releaseMeta) {
    const fallbackState = state.fallbackState.get(churchId);
    if (!fallbackState?.fqf2CoordinatorShadow) return;
    const previousCoordinatorState = fallbackState.fqf2CoordinatorShadow;
    const nextCoordinatorState = cancelFallbackAcceptedEnqueue({
        state: previousCoordinatorState,
        releaseMeta,
    });
    if (previousCoordinatorState.winner && !nextCoordinatorState.winner) {
        fallbackCoordinatorApplyWaiters.failOpenChurch(
            churchId,
            'winner_enqueue_rejected',
            previousCoordinatorState.winner.acceptedEnqueueOrder,
        );
    }
    fallbackState.fqf2CoordinatorShadow = nextCoordinatorState;
}

function acknowledgeFallbackCoordinatorShadowHistoryCommit({ churchId, releaseMeta, committedAtMs }) {
    if (!FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED) return null;
    try {
        const fallbackState = state.fallbackState.get(churchId);
        if (!fallbackState?.fqf2CoordinatorShadow) return null;
        const hasLineage = typeof releaseMeta?.sessionEpoch === 'string'
            && releaseMeta.sessionEpoch.trim().length > 0
            && releaseMeta.releaseSeq !== null
            && releaseMeta.releaseSeq !== undefined;
        if (!hasLineage) {
            const shadowState = fallbackState.fqf2CoordinatorShadow;
            const winner = shadowState.winner;
            logFallbackCoordinatorShadow({
                stage: 'fqf_fallback_coordinator_shadow',
                churchId,
                policy_applied: false,
                decision: 'missing_lineage_ack_skipped',
                requires_reevaluation: (shadowState.pendingReevaluations?.length || 0) > 0,
                pending_reevaluation_count: shadowState.pendingReevaluations?.length || 0,
                pending_overflow_count: shadowState.pendingOverflowCount || 0,
                winner_origin: winner?.origin ?? null,
                winner_session_epoch: winner?.sessionEpoch ?? null,
                winner_release_seq: winner?.releaseSeq ?? null,
            });
            return {
                state: shadowState,
                event: null,
                acknowledged: false,
                reevaluationCandidates: [],
                missingLineage: true,
            };
        }
        const result = acknowledgeFallbackHistoryCommit({
            state: fallbackState.fqf2CoordinatorShadow,
            churchId,
            releaseMeta,
            nowMs: committedAtMs,
        });
        if (!result.acknowledged) return result;

        fallbackState.fqf2CoordinatorShadow = result.state;
        if (result.event) logFallbackCoordinatorShadow(result.event);
        for (const candidate of result.reevaluationCandidates) {
            evaluateFallbackCoordinatorShadowCandidate(churchId, candidate);
        }
        return result;
    } catch {
        logFallbackCoordinatorShadow({
            stage: 'fqf_fallback_coordinator_shadow',
            churchId,
            policy_applied: false,
            decision: 'shadow_error',
            requires_reevaluation: false,
            reason: 'invalid_history_commit_observation',
        });
        return null;
    }
}

function acknowledgeFallbackCoordinatorShadowBroadcast({ churchId, releaseMeta, broadcastSentMs }) {
    if (!FQF_FALLBACK_COORDINATOR_SHADOW_RUNTIME_ENABLED) return null;
    try {
        const fallbackState = state.fallbackState.get(churchId);
        if (!fallbackState?.fqf2CoordinatorShadow) return null;
        const result = acknowledgeFallbackFirstBroadcast({
            state: fallbackState.fqf2CoordinatorShadow,
            churchId,
            releaseMeta,
            nowMs: broadcastSentMs,
        });
        if (!result.acknowledged) return result;

        fallbackState.fqf2CoordinatorShadow = result.state;
        if (result.event) logFallbackCoordinatorShadow(result.event);
        return result;
    } catch {
        logFallbackCoordinatorShadow({
            stage: 'fqf_fallback_coordinator_shadow',
            churchId,
            policy_applied: false,
            decision: 'shadow_error',
            requires_reevaluation: false,
            reason: 'invalid_broadcast_observation',
        });
        return null;
    }
}

function applyBoundaryCommitLedger({ churchId, lang, text, sourceText, emissionId, deliveryScope = null }) {
    const ledgerLang = deliveryScope ? `${lang}#${deliveryScope}` : lang;
    const result = processBoundaryCommit({
        churchId,
        lang: ledgerLang,
        text,
        sourceText,
        emissionId,
        config: config.boundaryCommitLedger,
        now: Date.now,
        deferCommit: FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED,
    });
    if (result.metrics?.length) {
        for (const metric of result.metrics) {
            evalLog({ ...metric, lang, delivery_scope: deliveryScope });
            if (metric.action === 'would_semantic_trim') {
                qualityTracker.trackFilterAction(churchId, 'BCL', 'semantic_shadow');
            } else if (metric.reason === 'protected_full_overlap') {
                qualityTracker.trackFilterAction(churchId, 'BCL', 'protected');
            }
        }
    }
    return { ...result, metrics: [] };
}

function createDedupHistoryCommitter({
    churchId,
    sourceCandidates = [],
    releaseMeta = null,
    deliveryScope = null,
}) {
    let sourceHistoryCommitted = false;
    return ({ lang, t5Text, bclText, emissionId }) => {
        if (!FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED) return false;
        if (!sourceHistoryCommitted) {
            for (const candidate of sourceCandidates) {
                commitP2History(candidate.p2Text, churchId);
                commitB4History(candidate.b4Text, churchId);
                if (candidate.b4CadenceText) {
                    commitB4CadenceHistory(
                        candidate.b4CadenceText,
                        churchId,
                        candidate.b4CadenceAtMs,
                    );
                }
                // Queue merges preserve candidates in FIFO order. Acknowledge each
                // release immediately after its own P2/B4 commit so a pending fallback
                // is projected against the winner, not a history containing the loser.
                acknowledgeFallbackCoordinatorShadowHistoryCommit({
                    churchId,
                    releaseMeta: candidate.releaseMeta || (sourceCandidates.length === 1 ? releaseMeta : null),
                    committedAtMs: Date.now(),
                });
            }
            sourceHistoryCommitted = true;
        }
        if (deliveryScope) commitT5History(t5Text, lang, churchId, deliveryScope);
        else commitT5History(t5Text, lang, churchId);
        commitBoundaryText(churchId, deliveryScope ? `${lang}#${deliveryScope}` : lang, bclText, {
            sourceText: sourceCandidates.map(candidate => candidate.emittedSourceText).filter(Boolean).join(' '),
            emissionId,
            config: config.boundaryCommitLedger,
        });
        return true;
    };
}

function applyAutopilotProfileToEmissionConfig(base, profile) {
    if (profile === 'fast') {
        return {
            ...base,
            qualityMaxAgeMs: Math.min(base.qualityMaxAgeMs, 2000),
            fastMaxAgeMs: Math.min(base.fastMaxAgeMs, 5000),
            catchupMaxAgeMs: Math.min(base.catchupMaxAgeMs, 9000),
            dropAfterMs: Math.min(base.dropAfterMs, 16000),
        };
    }
    if (profile === 'catchup') {
        return {
            ...base,
            qualityMaxAgeMs: Math.min(base.qualityMaxAgeMs, 1500),
            fastMaxAgeMs: Math.min(base.fastMaxAgeMs, 4000),
            catchupMaxAgeMs: Math.min(base.catchupMaxAgeMs, 8000),
            dropAfterMs: Math.min(base.dropAfterMs, 14000),
            unhealthyQueueDepth: Math.min(base.unhealthyQueueDepth, 3),
            overloadedQueueDepth: Math.min(base.overloadedQueueDepth, 6),
        };
    }
    if (profile === 'critical') {
        return {
            ...base,
            qualityMaxAgeMs: Math.min(base.qualityMaxAgeMs, 1000),
            fastMaxAgeMs: Math.min(base.fastMaxAgeMs, 3000),
            catchupMaxAgeMs: Math.min(base.catchupMaxAgeMs, 6000),
            dropAfterMs: Math.min(base.dropAfterMs, 10000),
            unhealthyQueueDepth: Math.min(base.unhealthyQueueDepth, 2),
            overloadedQueueDepth: Math.min(base.overloadedQueueDepth, 4),
        };
    }
    return base;
}

function deriveRuntimeEmissionMetadata({ decision, ageDecision, runtimeDecision }) {
    const reason = runtimeDecision?.reason || ageDecision?.reason || (decision === 'tts' ? 'normal_tts' : 'unspecified');
    if (runtimeDecision?.mode) return { emissionMode: runtimeDecision.mode, emissionReason: reason };
    if (decision === 'audio_skip' || ageDecision?.action === 'text_only_stale') {
        return { emissionMode: 'audio_skip', emissionReason: reason };
    }
    if (decision === 'drop' || ageDecision?.action === 'drop_stale') {
        return { emissionMode: 'drop', emissionReason: reason };
    }
    const ageMs = Math.max(0, Number(ageDecision?.ageMs) || 0);
    if (ageMs <= 3000) return { emissionMode: 'quality', emissionReason: reason };
    if (ageMs <= 7000) return { emissionMode: 'fast', emissionReason: reason };
    if (ageMs <= 12000) return { emissionMode: 'catchup', emissionReason: reason };
    return { emissionMode: 'audio_skip', emissionReason: reason };
}

function areProvidersHealthyForEmission(ttsEnabled) {
    const translationStatus = getServiceStatus();
    const ttsStatus = getTtsStatus();
    const gptOpen = translationStatus.circuitBreaker?.open === true;
    const ttsOpen = ttsEnabled && ttsStatus.circuitBreaker?.open === true;
    return !gptOpen && !ttsOpen;
}

// Validate config - translation backend must be configured
const hasOpenAI = config.openai.key && config.openai.endpoint;

if (!hasOpenAI) {
    console.error('ERROR: Translation backend not configured.');
    console.error('Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY');
    process.exit(1);
}

console.log('[Config] Azure OpenAI GPT-4.1-mini: CONFIGURED');

// ============================================================
// Initialize Services
// ============================================================
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Baseline security headers plus a policy tailored to the existing listener,
// broadcaster and admin pages. Their scripts/styles are currently inline, audio uses
// data/blob URLs, and a deployment may expose the gateway under a separate HTTPS/WSS
// origin. The policy still denies plugins, framing and unlisted script origins. Twemoji
// is the only remote script and also carries SRI in public/index.html.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.jsdelivr.net'],
            connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
            mediaSrc: ["'self'", 'data:', 'blob:'],
            fontSrc: ["'self'", 'data:'],
            workerSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: null,
        },
    },
}));

const AUTH_COOKIE_NAME = 'barnaba_session';
const ADMIN_COOKIE_NAME = 'barnaba_admin_session';
const CONFIG_SESSION_MAX_AGE_SECONDS = Math.max(
    300,
    Number.parseInt(process.env.AUTH_COOKIE_MAX_AGE_SECONDS || String(12 * 60 * 60), 10) || (12 * 60 * 60)
);
const adminSessions = new Map();

function parseCookies(header = '') {
    return String(header || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const idx = part.indexOf('=');
            if (idx === -1) return cookies;
            const key = decodeURIComponent(part.slice(0, idx).trim());
            const value = decodeURIComponent(part.slice(idx + 1).trim());
            cookies[key] = value;
            return cookies;
        }, {});
}

function cookieOptions({ maxAgeSeconds = null } = {}) {
    const parts = [
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (secureCookies) parts.push('Secure');
    if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
    return parts.join('; ');
}

function setSessionCookie(res, token) {
    const maxAgeSeconds = CONFIG_SESSION_MAX_AGE_SECONDS;
    res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions({ maxAgeSeconds })}`);
}

function clearSessionCookie(res) {
    res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=; ${cookieOptions({ maxAgeSeconds: 0 })}`);
}

function setAdminSessionCookie(res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CONFIG_SESSION_MAX_AGE_SECONDS * 1000;
    adminSessions.set(token, expiresAt);
    res.append('Set-Cookie', `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions({ maxAgeSeconds: CONFIG_SESSION_MAX_AGE_SECONDS })}`);
    setCsrfCookie(res, createCsrfToken(), {
        secure: secureCookies,
        maxAgeSeconds: CONFIG_SESSION_MAX_AGE_SECONDS,
    });
}

function clearAdminSessionCookie(req, res) {
    const token = parseCookies(req.headers.cookie || '')[ADMIN_COOKIE_NAME];
    if (token) adminSessions.delete(token);
    res.append('Set-Cookie', `${ADMIN_COOKIE_NAME}=; ${cookieOptions({ maxAgeSeconds: 0 })}`);
    clearCsrfCookie(res, { secure: secureCookies });
}

function getSessionTokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[AUTH_COOKIE_NAME] || null;
}

function getListenerTelemetrySessionToken(req) {
    return bearerSessionToken(req.headers.authorization)
        || getSessionTokenFromRequest(req);
}

function hasAdminSession(req) {
    const token = parseCookies(req.headers.cookie || '')[ADMIN_COOKIE_NAME];
    const expiresAt = token ? adminSessions.get(token) : null;
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

function isAdminRequestAuthorized(req) {
    return hasAdminSession(req);
}

function requireAdminAuth(req, res, next) {
    if (isAdminRequestAuthorized(req)) {
        next();
        return;
    }
    res.status(401).json({ success: false, error: 'Unauthorized' });
}

function requireAdminCsrf(req, res, next) {
    requireCsrf(req, res, next, parseCookies);
}

// Multer configuration for audio uploads (Phase 1)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

const QA_REPLAY_MAX_FILE_BYTES = 512 * 1024;
const QA_REPLAY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const qaReplayStorage = {
    _handleFile(req, file, callback) {
        const chunks = [];
        let fileBytes = 0;
        let settled = false;
        req.qaReplayUploadBytes ||= 0;
        file.stream.on('data', chunk => {
            if (settled) return;
            fileBytes += chunk.length;
            req.qaReplayUploadBytes += chunk.length;
            if (fileBytes > QA_REPLAY_MAX_FILE_BYTES || req.qaReplayUploadBytes > QA_REPLAY_MAX_TOTAL_BYTES) {
                settled = true;
                const error = new Error('QA replay upload exceeds size limit');
                error.statusCode = 413;
                callback(error);
                return;
            }
            chunks.push(chunk);
        });
        file.stream.on('error', error => { if (!settled) { settled = true; callback(error); } });
        file.stream.on('end', () => {
            if (settled) return;
            settled = true;
            callback(null, { buffer: Buffer.concat(chunks), size: fileBytes });
        });
    },
    _removeFile(_req, file, callback) { delete file.buffer; callback(null); }
};
const qaReplayUpload = multer({
    storage: qaReplayStorage,
    limits: { fileSize: QA_REPLAY_MAX_FILE_BYTES, files: 500, fields: 1, parts: 502 }
});

function getRecordingRenderToken(req) {
    return req.headers['x-session-token'] || getSessionTokenFromRequest(req);
}

function requireBroadcasterSession(req, res, next) {
    const sessionResult = validateSession(getRecordingRenderToken(req));
    if (!sessionResult.valid || sessionResult.session.role !== 'broadcaster') {
        res.status(401).json({ success: false, error: 'Unauthorized broadcaster session' });
        return;
    }
    req.broadcasterSession = sessionResult.session;
    next();
}

function parseQaReplayUpload(req, res, next) {
    qaReplayUpload.array('audio', 500)(req, res, error => {
        if (!error) { next(); return; }
        const tooLarge = error.statusCode === 413 || error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT';
        res.status(tooLarge ? 413 : 400).json({ success: false, error: error.message });
    });
}

// Multer for sermon preparation uploads (02.03.2026) — restricted MIME/extension
const SERMON_ALLOWED_EXTS = ['.txt', '.md', '.jpg', '.jpeg', '.png'];
const SERMON_IMAGE_MIMES = ['image/jpeg', 'image/png'];
const sermonUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!SERMON_ALLOWED_EXTS.includes(ext)) {
            cb(new Error(`Invalid file extension: ${ext}. Allowed: .txt, .md, .jpg, .png`));
        } else if (['.jpg', '.jpeg', '.png'].includes(ext) && !SERMON_IMAGE_MIMES.includes(file.mimetype)) {
            cb(new Error(`Invalid image MIME: ${file.mimetype}. Allowed: image/jpeg, image/png`));
        } else {
            // .txt/.md: accept any text/* or application/octet-stream (browsers vary for .md)
            cb(null, true);
        }
    }
});

// Initialize Translation Service (GPT-4.1-mini via Azure OpenAI)
try {
    initTranslationService();
    console.log('[Server] Translation service initialized');
} catch (error) {
    console.error('[Server] Translation service initialization failed:', error.message);
    // Continue anyway - the service has its own error handling
}

// Initialize Whisper ASR Service (Phase 1) - async, non-blocking
// Model will be loaded in background; first transcription will wait if needed
const whisperEnabled = process.env.WHISPER_ENABLED !== 'false';
if (whisperEnabled) {
    initWhisper()
        .then(() => console.log('[Server] Whisper ASR service initialized'))
        .catch(err => console.warn('[Server] Whisper ASR initialization deferred:', err.message));
} else {
    console.log('[Server] Whisper ASR disabled (WHISPER_ENABLED=false)');
}

// Translation handled by translationService.js (removed legacy OpenAI client)

// ============================================================
// Sermon Context: GPT-4.1-mini Vision client (02.03.2026)
// Separate from translationClient — vision may need different api-version
// ============================================================
const SERMON_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let visionClient = null;
if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    visionClient = new OpenAI({
        apiKey: process.env.AZURE_OPENAI_KEY,
        baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/gpt-4.1-mini`,
        defaultQuery: { 'api-version': '2024-02-15-preview' },
        defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY }
    });
}

/**
 * Extract text from sermon preparation image (mind map, notes photo)
 * Uses GPT-4.1-mini vision for semantic extraction (better than OCR for mind maps)
 *
 * @param {Buffer} buffer - Image file buffer
 * @param {string} mimeType - MIME type (image/jpeg or image/png)
 * @returns {Promise<string>} - Extracted text
 */
async function extractSermonFromImage(buffer, mimeType) {
    if (!visionClient) {
        throw new Error('Vision client not configured');
    }

    const base64 = buffer.toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s max

    try {
        const response = await visionClient.chat.completions.create({
            model: 'gpt-4.1-mini',
            max_tokens: 2000,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Extract ALL text from this sermon preparation image. Structure the output as:\n- Topic/Title\n- Scripture references (book, chapter, verses)\n- Key theological terms and concepts\n- Sermon outline/points\n\nReturn ONLY the extracted content, no commentary.'
                    },
                    {
                        type: 'image_url',
                        image_url: { url: `data:${mimeType};base64,${base64}` }
                    }
                ]
            }]
        }, { signal: controller.signal });

        return response.choices[0]?.message?.content?.trim() || '';
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('Image extraction timed out (15s). Upload a .txt file instead.');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Set sermon context with TTL cleanup (6h fallback)
 */
function setSermonContext(churchId, text, fileName) {
    // Clear existing TTL timer if any
    const existingTimer = state.sermonContextTimers.get(churchId);
    if (existingTimer) clearTimeout(existingTimer);

    const replaced = state.sermonContext.has(churchId);
    state.sermonContext.set(churchId, { text, fileName, uploadedAt: new Date().toISOString() });

    // TTL fallback — auto-cleanup after 6 hours
    const timer = setTimeout(() => {
        state.sermonContext.delete(churchId);
        state.sermonContextTimers.delete(churchId);
        console.log(`[SermonCtx] TTL cleanup for ${churchId}`);
    }, SERMON_CONTEXT_TTL_MS);
    state.sermonContextTimers.set(churchId, timer);

    return replaced;
}

// ============================================================
// State
// ============================================================
const state = {
    churches: new Map(),        // churchId -> { ws, name }
    subscriptions: new Map(),   // churchId -> language -> Set<WebSocket>
    clientVoiceGenders: new Map(), // WebSocket -> 'male'|'female' (for server-side TTS)
    clientListenerSessionIds: new Map(), // WebSocket -> opaque per-page listener identity
    sentenceBuffers: new Map(), // churchId -> SentenceBuffer (Phase 6)
    // Smooth Mode state (26.01.2026)
    smoothAccumulators: new Map(),  // churchId -> SentenceAccumulator
    smoothPhases: new Map(),        // churchId -> { phase: 'initial_buffer'|'streaming', startTime, totalAudioSec }
    holdNEmitters: new Map(),       // churchId -> hold-n emitter
    // B3 (17.02.2026): Inter-segment dedup - last sent words per church
    lastSentTexts: new Map(),       // churchId -> string (last 20 words sent)
    // P2 (17.02.2026): Cross-emission N-gram dedup - tracks recent content per church
    emissionNgramHistory: new Map(),  // churchId -> Set of 6-gram stem hashes (cap 500)
    // T5 (30.03.2026): Post-translation dedup - catches paraphrased repeats per language
    translationEmissionHistory: new Map(), // churchId -> Map<lang, Array<{words: Set}>>
    // T6 (30.03.2026): Pause-triggered flush - silence counter per church
    silenceChunks: new Map(), // churchId -> number (consecutive non-speech chunks)
    // Partial Fallback state (11.03.2026): tracks LA stall duration per church
    fallbackState: new Map(),        // churchId -> { lastConfirmedAt, lastFallbackText }
    // 3A/3B (09.06.2026): rolling live quality state for Autopilot shadow decisions
    liveQualityStates: new Map(),    // churchId -> LiveQualityState
    // Sermon Preparation Context (02.03.2026): proactive topic priming for GPT-4.1-mini
    sermonContext: new Map(),         // churchId -> { text, fileName, uploadedAt }
    sermonContextTimers: new Map(),   // churchId -> TTL timeout handle (6h fallback)
    // B4 (18.02.2026): Jaccard overlap guard - full emission history per church
    emissionFullHistory: new Map(),   // churchId -> [{stems: Set, words: string[]}] (last 3)
    // WebSocket rate limiting (28.01.2026)
    wsRateLimits: new Map(),    // clientIp -> { count, resetTime, warned }
    stats: {
        translations: 0,
        sentencesProcessed: 0,
        whisperTranscriptions: 0,  // Phase 1: Whisper ASR counter
        startTime: Date.now()
    },
    // Whisper Auto-Shutdown tracking (05.02.2026)
    // State machine: 'active' | 'shutting_down' | 'stopped' | 'shutdown_failed'
    whisperActivity: {
        lastActivityTime: null,      // Timestamp of last Whisper transcription
        status: 'active',            // State machine status
        lastShutdownAttempt: null,   // Timestamp of last shutdown attempt
        failureCount: 0,             // Consecutive failure count
        lastError: null              // Last error message
    }
};
const listenerPlayoutLedger = new ListenerPlayoutLedger();

// ============================================================
// R1.4: Translation Queue — decouples Whisper from GPT.
// Class extracted to ./translationQueue.js (29.05.2026) for unit-testability
// (server.js has side effects on import; the queue must be testable standalone).
// ============================================================

// Per-church translation queues + workers
const translationQueues = new Map(); // churchId -> TranslationQueue

function getOrCreateTranslationQueue(churchId) {
    if (!translationQueues.has(churchId)) {
        const queue = new TranslationQueue();
        translationQueues.set(churchId, queue);
        // Start worker for this church
        startTranslationWorker(churchId, queue);
    }
    return translationQueues.get(churchId);
}

function buildT4DeliveryVariants(item, liveLanguages) {
    if (!FQF_T4_SOURCE_RESEGMENTATION_RUNTIME_ENABLED
        && !FQF_T4_SOURCE_RESEGMENTATION_V2_SHADOW_ENABLED
        && !FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED) return null;
    const ticket = item.releaseMeta?.revisionTicket || item.revisionTicket;
    const sourceLineage = item.sourceLineage || item.releaseMeta?.sourceLineage;
    if (ticket?.kind !== 'single' || !ticket.familyId) return null;
    const sessionEpoch = item.releaseMeta?.sessionEpoch ?? ticket.sessionEpoch;
    const releaseSeq = item.releaseMeta?.releaseSeq ?? ticket.releaseSeq;
    if (!sessionEpoch || !Number.isSafeInteger(releaseSeq)) return null;
    const liveV1Eligible = FQF_T4_SOURCE_RESEGMENTATION_RUNTIME_ENABLED
        && ticket.applyEligible === true
        && sourceLineage?.status === 'complete';
    const liveV2Eligible = FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED
        && sourceLineage?.status === 'complete';
    let sourceMap = null;
    if (FQF_T4_SOURCE_RESEGMENTATION_V2_SHADOW_ENABLED || liveV2Eligible) {
        try {
            sourceMap = sourceMapFromLineage(sourceLineage, {
                expectedWordCount: sourceWordCount(item.text),
            });
        } catch {
            // Measurement-only code must never affect translation or delivery.
            sourceMap = null;
        }
    }
    if (!liveV1Eligible && !liveV2Eligible && !sourceMap) return null;

    const groups = new Map();
    const plannedListenersByLanguage = new Map();
    let affectedListeners = 0;
    for (const language of liveLanguages) {
        const clients = state.subscriptions.get(item.churchId)?.get(language) || new Set();
        const plannedListeners = new Set();
        plannedListenersByLanguage.set(language, plannedListeners);
        for (const client of clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            const listenerSessionId = state.clientListenerSessionIds.get(client);
            // Old PWA/recorder sockets remain compatible. If any route cannot be bound to
            // a ledger identity, keep the ordinary shared broadcast for the whole release.
            if (!listenerSessionId) {
                if (liveV1Eligible || liveV2Eligible) evalLog({
                    stage: 'fqf_t4_source_resegmentation',
                    churchId: item.churchId,
                    session_epoch: sessionEpoch,
                    release_seq: releaseSeq,
                    revision_family_id: ticket.familyId,
                    policy_applied: false,
                    action: 'unchanged',
                    reason: 'untracked_active_listener',
                });
                if (liveV1Eligible || liveV2Eligible) return null;
                continue;
            }
            plannedListeners.add(listenerSessionId);
            const plannedAt = Date.now();
            let proofSnapshot;
            try {
                proofSnapshot = listenerPlayoutLedger.committedSourceProofs({
                    churchId: item.churchId,
                    listenerSessionId,
                    sessionEpoch,
                    language,
                    beforeReleaseSeq: releaseSeq,
                });
            } catch {
                evalLog({
                    stage: 'fqf_t4_source_resegmentation_v2_shadow',
                    churchId: item.churchId,
                    listener_session_id: listenerSessionId,
                    session_epoch: sessionEpoch,
                    release_seq: releaseSeq,
                    revision_family_id: ticket.familyId,
                    policy_applied: false,
                    action: 'unchanged',
                    t4_resegment_v2_reason: 'proof_snapshot_error',
                });
                return null;
            }
            const committedSourceRanges = proofSnapshot.proofs.flatMap((proof) => proof.ranges);
            let v2Plan = null;
            let v2ApplyResult = null;
            if (sourceMap) {
                try {
                    const evaluation = evaluateT4CommittedPrefixApply({
                        text: item.text,
                        sourceLineage,
                        sourceMap,
                        proofs: proofSnapshot.proofs,
                        safeBoundaryWordIndexes:
                            item.releaseMeta?.safeSourceBoundaryWordIndexes || [],
                        ledgerVersion: proofSnapshot.ledgerVersion,
                    });
                    v2Plan = evaluation.plan;
                    v2ApplyResult = evaluation.result;
                    if (!evaluation.actionConsistent && liveV2Eligible) return null;
                    evalLog({
                        stage: 'fqf_t4_source_resegmentation_v2_shadow',
                        churchId: item.churchId,
                        listener_session_id: listenerSessionId,
                        session_epoch: sessionEpoch,
                        release_seq: releaseSeq,
                        revision_family_id: ticket.familyId,
                        policy_applied: false,
                        t4_resegment_v2_eligible: v2Plan.eligible,
                        t4_resegment_v2_reason: v2Plan.reason,
                        topology: v2Plan.topology,
                        proved_prefix_words: v2Plan.provedPrefixWords,
                        committed_word_count: v2Plan.committedWordCount || 0,
                        source_start_word: v2Plan.safeBoundaryWord,
                        bridge_words: v2Plan.bridgeWords,
                        committed_source_range_count: committedSourceRanges.length,
                        committed_proof_count: proofSnapshot.proofs.length,
                        proof_contributor_count: v2Plan.contributorReleaseSeqs?.length || 0,
                        ledger_version: proofSnapshot.ledgerVersion,
                        planned_at_ms: plannedAt,
                        ...sourceMapTelemetry(sourceMap),
                    });
                } catch {
                    // Shadow evaluation is deliberately fail-open for the live path.
                    if (liveV2Eligible) return null;
                }
            }
            if (!liveV1Eligible && !liveV2Eligible) continue;

            let result;
            if (liveV2Eligible) {
                result = v2ApplyResult || {
                    action: 'unchanged',
                    reason: v2Plan?.reason || 'source_not_provable',
                    text: item.text,
                    sourceLineage,
                };
                if (v2Plan?.eligible && result.action !== v2Plan.action) return null;
            } else {
                const committedPrefixWords = listenerPlayoutLedger.committedPrefixWordCount({
                    churchId: item.churchId,
                    listenerSessionId,
                    sessionEpoch,
                    language,
                    beforeReleaseSeq: releaseSeq,
                    sourceLineage,
                });
                result = resegmentSourceAtWord(item.text, sourceLineage, committedPrefixWords);
            }
            if (result.action === 'unchanged') {
                evalLog({
                    stage: 'fqf_t4_source_resegmentation',
                    churchId: item.churchId,
                    session_epoch: sessionEpoch,
                    release_seq: releaseSeq,
                    revision_family_id: ticket.familyId,
                    policy_applied: false,
                    action: 'unchanged',
                    reason: result.reason,
                    committed_source_range_count: committedSourceRanges.length,
                    source_start_word: 0,
                    remaining_words: sourceLineage.wordCount,
                    target_listener_count: 1,
                });
            }
            if (result.action === 'resegment' || result.action === 'suppress') {
                affectedListeners++;
            }
            const key = `${language}|${result.startWord || 0}|${result.action}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    language,
                    result,
                    v2Plan,
                    targetListenerSessionIds: new Set(),
                    excludeListenerSessionIds: null,
                    committedSourceRangeCount: 0,
                    planAudits: [],
                });
            }
            const group = groups.get(key);
            group.targetListenerSessionIds.add(listenerSessionId);
            group.committedSourceRangeCount += committedSourceRanges.length;
            if (v2Plan && sourceMap) {
                group.planAudits.push(Object.freeze({
                    listenerSessionId,
                    plannedAt,
                    ledgerVersion: proofSnapshot.ledgerVersion,
                    sourceMap,
                    safeBoundaryWordIndexes: Object.freeze([
                        ...(item.releaseMeta?.safeSourceBoundaryWordIndexes || []),
                    ]),
                    proofKeys: Object.freeze(proofSnapshot.proofs.map((proof) => (
                        `${proof.releaseSeq}:${proof.deliveryUnitId || 'legacy'}:${proof.sourceMapDigest}`
                    ))),
                    plan: v2Plan,
                }));
            }
        }
    }
    if (!liveV1Eligible && !liveV2Eligible) return null;
    if (affectedListeners === 0) return null;

    // A listener can join while residual GPT/TTS is in flight. Planned listeners receive
    // exactly one planned variant; listeners outside that snapshot receive a whole fallback.
    for (const language of liveLanguages) {
        const excludeListenerSessionIds = plannedListenersByLanguage.get(language) || new Set();
        groups.set(`${language}|fallback_whole`, {
            language,
            result: {
                action: 'unchanged',
                reason: 'listener_joined_after_t4_plan',
                text: item.text,
                sourceLineage,
                startWord: 0,
                remainingWords: sourceLineage.wordCount,
            },
            v2Plan: null,
            targetListenerSessionIds: null,
            excludeListenerSessionIds,
            committedSourceRangeCount: 0,
            planAudits: [],
        });
    }

    return [...groups.values()].map((group) => {
        const sourceLineageForVariant = group.result.sourceLineage || sourceLineage;
        const sourceStartWord = group.result.startWord || 0;
        const residualTicket = group.result.action === 'resegment'
            ? {
                ...ticket,
                ticketId: `${ticket.ticketId || 'ticket'}:t4v2:${sourceStartWord}`.slice(0, 64),
                applyEligible: false,
                t1DropWholeV2Eligible: false,
                t2SupersedePendingV2Eligible: false,
                supersedesGenerationsV2: [],
                evidence: 't4_residual',
            }
            : ticket;
        const originalBoundaries = item.releaseMeta?.safeSourceBoundaryWordIndexes || [];
        const releaseMeta = stampEmittedSourceIdentity({
            ...item.releaseMeta,
            sourceLineage: sourceLineageForVariant,
            revisionTicket: residualTicket,
            safeSourceBoundaryWordIndexes: sourceStartWord > 0
                ? originalBoundaries
                    .filter((boundary) => boundary > sourceStartWord)
                    .map((boundary) => boundary - sourceStartWord)
                : originalBoundaries,
            t4SourceStartWord: sourceStartWord,
            t4Action: group.result.action,
        }, group.result.text);
        return {
            ...group,
            releaseMeta,
            deliveryScope: `t4v2:${ticket.familyId}:${group.language}:${sourceStartWord}:${group.result.action}`,
        };
    });
}

function measureT4LateCommits(item, variant) {
    if (!Array.isArray(variant?.planAudits) || variant.planAudits.length === 0) return;
    const sessionEpoch = item.releaseMeta?.sessionEpoch ?? null;
    const releaseSeq = item.releaseMeta?.releaseSeq ?? null;
    for (const audit of variant.planAudits) {
        try {
            const snapshot = listenerPlayoutLedger.committedSourceProofs({
                churchId: item.churchId,
                listenerSessionId: audit.listenerSessionId,
                sessionEpoch,
                language: variant.language,
                beforeReleaseSeq: releaseSeq,
            });
            if (snapshot.ledgerVersion === audit.ledgerVersion) continue;
            const plannedProofKeys = new Set(audit.proofKeys);
            const lateProofs = snapshot.proofs.filter((proof) => !plannedProofKeys.has(
                `${proof.releaseSeq}:${proof.deliveryUnitId || 'legacy'}:${proof.sourceMapDigest}`,
            ));
            if (lateProofs.length === 0) continue;
            const updatedPlan = planT4CommittedPrefix({
                sourceMap: audit.sourceMap,
                proofs: snapshot.proofs,
                safeBoundaryWordIndexes: audit.safeBoundaryWordIndexes,
                ledgerVersion: snapshot.ledgerVersion,
            });
            evalLog({
                stage: 'fqf_t4_late_commit_after_plan',
                churchId: item.churchId,
                listener_session_id: audit.listenerSessionId,
                session_epoch: sessionEpoch,
                release_seq: releaseSeq,
                language: variant.language,
                policy_applied: false,
                planned_action: audit.plan.action,
                updated_action: updatedPlan.action,
                planned_prefix_words: audit.plan.provedPrefixWords,
                updated_prefix_words: updatedPlan.provedPrefixWords,
                planned_boundary_word: audit.plan.safeBoundaryWord,
                updated_boundary_word: updatedPlan.safeBoundaryWord,
                late_commit_count: lateProofs.length,
                late_commit_after_plan_ms: Math.max(
                    ...lateProofs.map((proof) => Math.max(0, proof.committedAt - audit.plannedAt)),
                ),
                observed_after_plan_ms: Math.max(0, Date.now() - audit.plannedAt),
                planned_ledger_version: audit.ledgerVersion,
                observed_ledger_version: snapshot.ledgerVersion,
            });
        } catch {
            evalLog({
                stage: 'fqf_t4_late_commit_after_plan',
                churchId: item.churchId,
                listener_session_id: audit.listenerSessionId,
                session_epoch: sessionEpoch,
                release_seq: releaseSeq,
                language: variant.language,
                policy_applied: false,
                reason: 'late_commit_measurement_error',
            });
        }
    }
}

async function startTranslationWorker(churchId, queue) {
    console.log(`[TranslationWorker] ${churchId}: Started`);
    while (true) {
        const item = await queue.dequeue();
        if (item === null) break; // stopped

        try {
            const ageMs = item.createdAt ? Date.now() - item.createdAt : 0;
            const emissionOrigin = fallbackEmissionOriginForTelemetry(
                item.releaseMeta,
                item.dedupHistoryCandidates || [],
            );
            const emissionSessionEpoch = fallbackEmissionSessionEpochForTelemetry(
                item.releaseMeta,
                item.dedupHistoryCandidates || [],
            );
            const liveLanguages = resolveQueuedEmissionLanguages(getActiveLanguages(item.churchId));
            recordLiveQualityMetric(churchId, {
                stage: 'emission_decision',
                age_ms: ageMs,
                queue_depth: queue.depth,
                action: 'queue_dequeue',
            });
            const autopilotDecision = logAutopilotShadow(churchId, { source: 'translation_worker_queue' });

            if (liveLanguages.length === 0) {
                evalLog({
                    stage: 'translation_queue',
                    churchId: item.churchId,
                    latencyTxId: item.latencyTxId || null,
                    action: 'drop_no_active_languages',
                    age_ms: ageMs,
                    queue_depth: queue.depth,
                    queued_languages: item.languages || [],
                });
                logEmissionDecision(evalLog, {
                    churchId: item.churchId,
                    decision: 'drop',
                    reason: 'no_active_languages_at_dequeue',
                    ageMs,
                    queueDepth: queue.depth,
                    source: 'translation_worker_live_language_routing',
                    latencyTxId: item.latencyTxId,
                });
                if (item.latencyTxId) completeWhisperOnlyTracking(item.latencyTxId);
                queue.drop(item);
                continue;
            }

            const queueDecision = decideEmission({
                ageMs,
                queueDepth: queue.depth,
                asrStable: true,
                semanticComplete: true,
                providerHealthy: areProvidersHealthyForEmission(isTtsEnabled()),
                ttsEnabled: isTtsEnabled(),
                activeLanguages: liveLanguages.length,
                activeGenders: 0,
            }, {
                ...getEffectiveEmissionControllerConfig(churchId),
                enabled: config.emissionController.enabled,
            });

            evalLog({
                stage: 'emission_controller_queue',
                churchId,
                latencyTxId: item.latencyTxId || null,
                controller_action: queueDecision.action,
                controller_mode: queueDecision.mode,
                controller_reason: queueDecision.reason,
                origin: emissionOrigin,
                session_epoch: emissionSessionEpoch,
                release_seq: item.releaseMeta?.releaseSeq ?? null,
                age_ms: queueDecision.ageMs,
                queue_depth: queueDecision.queueDepth,
                autopilot_profile: autopilotDecision?.profile ?? null,
            });

            if (queueDecision.action === 'drop') {
                queue.drop(item);
                logEmissionDecision(evalLog, {
                    churchId,
                    decision: 'drop',
                    reason: queueDecision.reason,
                    ageMs: queueDecision.ageMs,
                    queueDepth: queueDecision.queueDepth,
                    source: 'translation_worker_emission_controller',
                    latencyTxId: item.latencyTxId,
                });
                continue;
            }

            if (queueDecision.action === 'merge' && queue.mergeIntoNext(item)) {
                logEmissionDecision(evalLog, {
                    churchId,
                    decision: 'merge',
                    reason: queueDecision.reason,
                    ageMs: queueDecision.ageMs,
                    queueDepth: queueDecision.queueDepth,
                    source: 'translation_worker_emission_controller',
                    latencyTxId: item.latencyTxId,
                });
                continue;
            }

            const baseReleaseMeta = item.releaseMeta
                ? {
                    ...item.releaseMeta,
                    sourceLineage: item.sourceLineage || item.releaseMeta.sourceLineage,
                    revisionTicket: item.revisionTicket || item.releaseMeta.revisionTicket || null,
                }
                : null;
            const t4Variants = buildT4DeliveryVariants(
                { ...item, releaseMeta: baseReleaseMeta },
                liveLanguages,
            );
            if (t4Variants) {
                let firstVariant = true;
                let dispatchedVariant = false;
                for (const variant of t4Variants) {
                    evalLog({
                        stage: 'fqf_t4_source_resegmentation',
                        churchId: item.churchId,
                        session_epoch: variant.releaseMeta?.sessionEpoch ?? null,
                        release_seq: variant.releaseMeta?.releaseSeq ?? null,
                        revision_family_id: variant.releaseMeta?.revisionTicket?.familyId ?? null,
                        policy_applied: variant.result.action !== 'unchanged',
                        action: variant.result.action,
                        reason: variant.result.reason,
                        source_start_word: variant.result.startWord || 0,
                        remaining_words: variant.result.remainingWords
                            ?? variant.releaseMeta?.sourceLineage?.wordCount
                            ?? 0,
                        committed_source_range_count: variant.committedSourceRangeCount,
                        target_listener_count: variant.targetListenerSessionIds?.size ?? 0,
                    });
                    if (variant.result.action === 'suppress') continue;
                    if (!hasDeliveryRecipients(
                        item.churchId,
                        variant.language,
                        variant.targetListenerSessionIds,
                        variant.excludeListenerSessionIds,
                    )) {
                        evalLog({
                            stage: 'fqf_t4_source_resegmentation',
                            churchId: item.churchId,
                            session_epoch: variant.releaseMeta?.sessionEpoch ?? null,
                            release_seq: variant.releaseMeta?.releaseSeq ?? null,
                            policy_applied: false,
                            action: 'skip_delivery',
                            reason: 'no_listener_in_delivery_scope',
                            target_listener_count: 0,
                        });
                        continue;
                    }
                    measureT4LateCommits(item, variant);
                    await translateAndBroadcast(
                        item.churchId,
                        variant.result.text,
                        [variant.language],
                        firstVariant ? item.latencyTxId : null,
                        item.sourceContext,
                        item.sermonContext,
                        item.createdAt,
                        queue.depth,
                        item.drainMeta || null,
                        item.emissionCompleteness || null,
                        variant.releaseMeta,
                        firstVariant ? (item.dedupHistoryCandidates || []) : [],
                        {
                            targetListenerSessionIds: variant.targetListenerSessionIds,
                            excludeListenerSessionIds: variant.excludeListenerSessionIds,
                            deliveryScope: variant.deliveryScope,
                        },
                    );
                    dispatchedVariant = true;
                    firstVariant = false;
                }
                if (!dispatchedVariant && item.latencyTxId) {
                    completeWhisperOnlyTracking(item.latencyTxId);
                }
            } else {
                await translateAndBroadcast(
                    item.churchId,
                    item.text,
                    liveLanguages,
                    item.latencyTxId,
                    item.sourceContext,
                    item.sermonContext,
                    item.createdAt,
                    queue.depth,
                    item.drainMeta || null,
                    item.emissionCompleteness || null,
                    baseReleaseMeta,
                    item.dedupHistoryCandidates || [],
                );
            }
            queue.stats.processed++;
        } catch (err) {
            console.error(`[TranslationWorker] ${churchId}: Error:`, err.message);
        } finally {
            // P-B fix #5: decrement in-flight + check drain on EVERY path (drop/merge/emit/error)
            // so drainTranslationQueue() resolves only after the worker truly finished this item.
            queue.taskDone();
        }
    }
    console.log(`[TranslationWorker] ${churchId}: Stopped (processed=${queue.stats.processed}, merged=${queue.stats.merged}, dropped=${queue.stats.dropped})`);
}

function stopTranslationQueue(churchId) {
    const queue = translationQueues.get(churchId);
    if (queue) {
        queue.stop();
        translationQueues.delete(churchId);
    }
}

function getTranslationQueueStats() {
    return [...translationQueues.entries()].map(([churchId, queue]) => ({
        churchId,
        depth: queue.depth,
        ...queue.stats,
    }));
}

// ============================================================
// Whisper Auto-Shutdown Functions (05.02.2026)
// Security fixes: execFile instead of exec, timeout, state machine
// ============================================================

// Timer ID for cleanup
let whisperInactivityTimerId = null;

/**
 * Update Whisper activity timestamp (call on every transcription)
 * Resets status to 'active' if container was stopped
 */
function updateWhisperActivity() {
    state.whisperActivity.lastActivityTime = Date.now();
    // Reset to active state on new activity (container must be running)
    if (state.whisperActivity.status === 'stopped' || state.whisperActivity.status === 'shutdown_failed') {
        state.whisperActivity.status = 'active';
        state.whisperActivity.failureCount = 0;
        state.whisperActivity.lastError = null;
    }
    console.log(`[WhisperAutoShutdown] Activity recorded @ ${new Date().toISOString()}`);
}

/**
 * Check if Whisper has been inactive and should be shut down
 * @returns {boolean} True if shutdown should proceed
 */
function shouldShutdownWhisper() {
    const { lastActivityTime, status } = state.whisperActivity;
    const { enabled, inactivityMinutes } = config.whisperAutoShutdown;

    // Only shutdown from 'active' state
    if (!enabled || status !== 'active') {
        return false;
    }

    // No activity recorded yet - don't shutdown
    if (!lastActivityTime) {
        return false;
    }

    const inactiveMs = Date.now() - lastActivityTime;
    const thresholdMs = inactivityMinutes * 60 * 1000;

    return inactiveMs >= thresholdMs;
}

/**
 * Stop the Whisper container via Control Plane API
 * HOTFIX 7.5: Gateway has no az CLI — delegates to Control Plane (which has proper Azure auth)
 * @returns {Promise<boolean>} True if stopped successfully
 */
async function stopWhisperContainer() {
    const controlPlaneUrl = process.env.APP_URL;
    const password = process.env.BROADCASTER_PASSWORD;

    if (!controlPlaneUrl) {
        console.error('[WhisperAutoShutdown] Cannot stop: APP_URL (Control Plane URL) not configured');
        state.whisperActivity.status = 'shutdown_failed';
        state.whisperActivity.lastError = 'APP_URL not configured';
        return false;
    }

    if (state.whisperActivity.status === 'shutting_down') {
        console.log('[WhisperAutoShutdown] Shutdown already in progress');
        return false;
    }

    state.whisperActivity.status = 'shutting_down';
    state.whisperActivity.lastShutdownAttempt = Date.now();

    const inactiveMinutes = Math.floor((Date.now() - state.whisperActivity.lastActivityTime) / 60000);
    console.log(`[WhisperAutoShutdown] Stopping Whisper via Control Plane after ${inactiveMinutes} min inactivity...`);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(`${controlPlaneUrl}/api/control/stop-whisper`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'unknown');
            state.whisperActivity.status = 'shutdown_failed';
            state.whisperActivity.failureCount++;
            state.whisperActivity.lastError = `HTTP ${response.status}: ${errorText}`;
            console.error(`[WhisperAutoShutdown] ✗ Control Plane returned ${response.status}: ${errorText}`);
            return false;
        }

        const result = await response.json();
        if (result.success) {
            state.whisperActivity.status = 'stopped';
            state.whisperActivity.failureCount = 0;
            state.whisperActivity.lastError = null;
            console.log('[WhisperAutoShutdown] ✓ Whisper stopped via Control Plane');
            return true;
        } else {
            state.whisperActivity.status = 'shutdown_failed';
            state.whisperActivity.failureCount++;
            state.whisperActivity.lastError = result.error || 'Control Plane returned success=false';
            console.error(`[WhisperAutoShutdown] ✗ Control Plane error: ${result.error}`);
            return false;
        }
    } catch (error) {
        state.whisperActivity.status = 'shutdown_failed';
        state.whisperActivity.failureCount++;
        state.whisperActivity.lastError = error.name === 'AbortError' ? 'Timeout after 30s' : error.message;
        console.error(`[WhisperAutoShutdown] ✗ Failed (attempt #${state.whisperActivity.failureCount}): ${state.whisperActivity.lastError}`);

        if (state.whisperActivity.failureCount >= 3) {
            console.error('[WhisperAutoShutdown] ⚠️ ALERT: 3+ consecutive failures — check Control Plane availability');
        }
        return false;
    }
}

/**
 * Check Whisper inactivity and trigger shutdown if needed
 */
function checkWhisperInactivity() {
    if (shouldShutdownWhisper()) {
        const inactiveMinutes = Math.floor((Date.now() - state.whisperActivity.lastActivityTime) / 60000);
        console.log(`[WhisperAutoShutdown] Inactivity check: ${inactiveMinutes}m idle (threshold: ${config.whisperAutoShutdown.inactivityMinutes}m)`);

        stopWhisperContainer().catch(err => {
            console.error('[WhisperAutoShutdown] Shutdown failed:', err.message);
        });
    }
}

/**
 * Start the inactivity monitoring timer
 */
function startWhisperInactivityMonitoring() {
    if (whisperInactivityTimerId) {
        clearInterval(whisperInactivityTimerId);
    }

    whisperInactivityTimerId = setInterval(() => {
        checkWhisperInactivity();
    }, config.whisperAutoShutdown.checkIntervalMs);

    console.log(`[WhisperAutoShutdown] ✓ Monitoring started (check every ${config.whisperAutoShutdown.checkIntervalMs / 1000}s, threshold: ${config.whisperAutoShutdown.inactivityMinutes}m)`);
}

// ============================================================
// Express
// ============================================================
function parseAllowedOrigins(value) {
    return String(value || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

const allowedCorsOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const devCorsOrigins = [
    /^https?:\/\/localhost(?::\d+)?$/i,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
    /^https?:\/\/\[::1\](?::\d+)?$/i,
];

function isAllowedCorsOrigin(origin) {
    if (!origin) return true;
    if (allowedCorsOrigins.includes(origin)) return true;
    if (isDevEnvironment && devCorsOrigins.some(pattern => pattern.test(origin))) return true;
    return false;
}

app.use(cors({
    origin(origin, callback) {
        if (isAllowedCorsOrigin(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error('CORS origin not allowed'));
    },
    credentials: true,
}));
app.use(express.json());

// Prevent stale PWA shell/service worker after deployments
app.use((req, res, next) => {
    const isHtml = req.path === '/' || req.path.endsWith('.html');
    const isServiceWorker = req.path === '/sw.js';

    if (isHtml || isServiceWorker) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }

    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Health Endpoints — PUBLIC (Azure probe) + PRIVATE (details)
// Security: 13.03.2026 — split to prevent information disclosure (OWASP A01)
// ============================================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Client runtime configuration when the PWA is served directly by the gateway.
// Control Plane exposes the same shape for its normal listener-PWA ingress.
app.get('/api/control/config', (req, res) => {
    // No-store, not merely no-cache: the value decides which arm the listener is in, so a
    // revalidated 304 from any intermediary would be indistinguishable from a fresh read.
    res.set('Cache-Control', 'no-store');
    res.json({
        preserveTtsPitch: config.clientFeatures.preserveTtsPitch,
        instantFeedback: config.clientFeatures.instantFeedback,
        listenerPlaybackPolicyV2: config.clientFeatures.listenerPlaybackPolicyV2,
        listenerBoundedScheduler: config.clientFeatures.listenerBoundedScheduler,
        listenerCatchupMaxRate: config.clientFeatures.listenerCatchupMaxRate,
        listenerCatchupChunkAgeMs: config.clientFeatures.listenerCatchupChunkAgeMs,
        listenerBacklogBudgetMs: config.clientFeatures.listenerBacklogBudgetMs,
        listenerEarlyCatchup: config.clientFeatures.listenerEarlyCatchup,
        listenerEarlyCatchupEnterMs: config.clientFeatures.listenerEarlyCatchupEnterMs,
        listenerEarlyCatchupExitMs: config.clientFeatures.listenerEarlyCatchupExitMs,
        listenerEarlyCatchupDwellMs: config.clientFeatures.listenerEarlyCatchupDwellMs,
        listenerEarlyCatchupRate: config.clientFeatures.listenerEarlyCatchupRate,
        fqfT2SupersessionShadow: config.clientFeatures.fqfT2SupersessionShadow,
        fqfT2SupersessionApply: config.clientFeatures.fqfT2SupersessionApply,
    });
});

app.get('/health/details', requireAdminAuth, (req, res) => {
    const translationStatus = getServiceStatus();
    const cacheStats = getCacheStats();
    const authStats = getAuthStats();
    const sentenceStats = getSentenceServiceStats();
    const audioStats = getAudioServiceStats();
    const whisperStatus = getWhisperStatus();

    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - state.stats.startTime) / 1000),
        churches: state.churches.size,
        translations: state.stats.translations,
        sentencesProcessed: state.stats.sentencesProcessed,
        whisperTranscriptions: state.stats.whisperTranscriptions || 0,
        whisperService: {
            enabled: whisperEnabled,
            mode: 'remote',
            initialized: whisperStatus.initialized,
            initializing: whisperStatus.initializing,
            activeBuffers: whisperStatus.activeBuffers
        },
        translationService: {
            available: translationStatus.available,
            endpoint: translationStatus.endpoint ? 'configured' : 'not configured',
            activeContextBuffers: translationStatus.activeContextBuffers,
            concurrency: translationStatus.concurrency,
        },
        translationQueues: getTranslationQueueStats(),
        liturgicalCache: {
            initialized: cacheStats.initialized,
            totalPhrases: cacheStats.totalPhrases,
            mode: cacheStats.mode,
            categories: Object.keys(cacheStats.categories || {}).length
        },
        authentication: {
            sessionModel: authStats.sessionModel,
            issuedSessions: authStats.issuedSessions,
            revokedSessions: authStats.revokedSessions,
            rateLimitedIps: authStats.rateLimitedIps
        },
        phase6Services: {
            sentenceBoundaryDetection: {
                version: sentenceStats.version,
                maxChunkLength: sentenceStats.config.maxChunkLength,
                thoughtStarters: sentenceStats.thoughtStarters
            },
            audioQualityMonitoring: {
                version: audioStats.version,
                vadThreshold: audioStats.config.vadThreshold
            },
            activeSentenceBuffers: state.sentenceBuffers.size
        },
        evalLogging: getEvalLogStats(),
        tts: getTtsStatus()
    });
});

app.get('/api/churches', (req, res) => {
    const churches = [];
    for (const [id, church] of state.churches) {
        churches.push({ id, name: church.name, listeners: getListenerCount(id) });
    }
    res.json(churches);
});

// ============================================================
// Whisper Transcription Endpoint (Phase 1)
// ============================================================

/**
 * Security H1 (24.07.2026): /api/transcribe triggers a costly Whisper call (wakes the
 * A100). Require the broadcaster password as an explicit credential in a header —
 * mirroring the control-plane stop-whisper route (P0.2): an explicit secret is not an
 * ambient cookie, so the endpoint is not CSRF-able, and it needs no session/CSRF flow for
 * the only caller (the offline evaluation tooling, which is not part of this repository).
 * Runs BEFORE multer so unauthenticated requests are rejected without buffering the upload.
 */
function requireTranscribeAuth(req, res, next) {
    const provided = req.get('x-broadcaster-password');
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (typeof provided === 'string' && verifyMasterPassword(provided, clientIp)) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized' });
}

/**
 * POST /api/transcribe - Transcribe audio file using Whisper
 * Accepts audio file upload (webm, wav, mp3, etc.)
 * Returns Swiss German → Hochdeutsch transcription
 */
app.post('/api/transcribe', requireTranscribeAuth, upload.single('audio'), async (req, res) => {
    if (!whisperEnabled) {
        return res.status(503).json({
            success: false,
            error: 'Whisper ASR is disabled on this server'
        });
    }

    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No audio file provided'
            });
        }

        console.log(`[Whisper] Transcribing ${req.file.size} bytes of audio...`);

        const result = await transcribeSwissGerman(req.file.buffer, {
            returnTimestamps: req.query.timestamps === 'true'
        });

        state.stats.whisperTranscriptions++;
                updateWhisperActivity(); // Auto-shutdown tracking

        console.log(`[Whisper] Transcription completed (${result.text.length} characters)`);

        res.json({
            success: true,
            text: result.text,
            chunks: result.chunks,
            language: result.language,
            model: result.model
        });

    } catch (error) {
        console.error('[Whisper] Transcription error:', error.message);
        // Security M4 (24.07.2026): return a generic error to the client; details stay
        // server-side (logged above) to avoid leaking internal paths/service info.
        res.status(500).json({
            success: false,
            error: 'Transcription failed'
        });
    }
});

/**
 * GET /api/whisper/status - Get Whisper service status
 */
app.get('/api/whisper/status', requireBroadcasterSession, (req, res) => {
    res.json(getWhisperStatus());
});

// ============================================================
// Admin Rate Limiting — 13.03.2026 (no external dependency)
// Max 10 requests per 15 min per IP on /api/admin/*
// ============================================================
const adminRateLimits = new Map();
const ADMIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 10 };

app.use('/api/admin', (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    let entry = adminRateLimits.get(ip);

    if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + ADMIN_RATE_LIMIT.windowMs };
        adminRateLimits.set(ip, entry);
    }

    entry.count++;

    if (entry.count > ADMIN_RATE_LIMIT.max) {
        console.log(`[Security] Admin rate limit exceeded for ${ip}`);
        return res.status(429).json({ error: 'Too many admin requests. Try again later.' });
    }

    next();
});

/**
 * POST /api/admin/start-whisper - Start the Whisper container (05.02.2026)
 * Requires master password for security
 */
app.post('/api/admin/start-whisper', requireAdminAuth, requireAdminCsrf, async (req, res) => {
    const { azureResourceGroup, azureContainerName } = config.whisperAutoShutdown;

    console.log(`[Admin] Starting Whisper container: ${azureContainerName}`);

    try {
        const { execFile } = await import('child_process');

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                console.error('[Admin] Whisper start timeout after 60s');
                res.status(504).json({ success: false, error: 'Timeout starting container (60s)' });
                resolve();
            }, 60000);

            execFile('az', [
                'containerapp', 'start',
                '--name', azureContainerName,
                '--resource-group', azureResourceGroup
            ], (error, stdout, stderr) => {
                clearTimeout(timeoutId);

                if (error) {
                    console.error('[Admin] Whisper start failed:', error.message);
                    res.status(500).json({ success: false, error: 'Failed to start Whisper container' });
                    resolve();
                    return;
                }

                // Reset auto-shutdown state
                state.whisperActivity.status = 'active';
                state.whisperActivity.lastActivityTime = Date.now();
                state.whisperActivity.failureCount = 0;
                state.whisperActivity.lastError = null;

                console.log(`[Admin] Whisper container ${azureContainerName} started`);
                res.json({ success: true, message: 'Whisper container started' });
                resolve();
            });
        });
    } catch (error) {
        console.error('[Admin] Start error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to start Whisper container' });
    }
});

/**
 * POST /api/admin/stop-whisper - Stop the Whisper container (05.02.2026)
 * Requires master password for security
 */
app.post('/api/admin/stop-whisper', requireAdminAuth, requireAdminCsrf, async (req, res) => {
    console.log('[Admin] Manual stop requested');

    const success = await stopWhisperContainer();

    if (success) {
        res.json({ success: true, message: 'Whisper container stopped' });
    } else {
        res.status(500).json({
            success: false,
            error: 'Failed to stop Whisper container'
        });
    }
});

/**
 * GET /api/admin/whisper-health - Check if Whisper service is responsive
 * Pings the Whisper service URL to verify it's running
 * Security: 13.03.2026 — requires master password
 */
app.get('/api/admin/whisper-health', requireAdminAuth, async (req, res) => {
    const whisperUrl = process.env.WHISPER_SERVICE_URL;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${whisperUrl}/health`, {
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok) {
            const data = await response.json();
            res.json({
                healthy: true,
                mode: 'remote',
                serviceUrl: whisperUrl,
                serviceStatus: data
            });
        } else {
            res.json({
                healthy: false,
                mode: 'remote',
                error: `Service returned ${response.status}`
            });
        }
    } catch (error) {
        res.json({
            healthy: false,
            mode: 'remote',
            error: error.name === 'AbortError' ? 'Timeout (10s)' : error.message
        });
    }
});

/**
 * GET /api/admin/gateway-health - Check Gateway health (simple ping)
 * Security: 13.03.2026 — requires master password
 */
app.get('/api/admin/gateway-health', requireAdminAuth, (req, res) => {
    res.json({
        healthy: true,
        uptime: Math.floor((Date.now() - state.stats.startTime) / 1000),
        whisperEnabled,
        whisperMode: 'remote'
    });
});

/**
 * GET /api/whisper/auto-shutdown - Get auto-shutdown status (05.02.2026)
 */
app.get('/api/whisper/auto-shutdown', (req, res) => {
    const { lastActivityTime, status, lastShutdownAttempt, failureCount, lastError } = state.whisperActivity;
    const { enabled, inactivityMinutes } = config.whisperAutoShutdown;

    let inactiveMinutes = null;
    let shutdownIn = null;

    if (lastActivityTime) {
        inactiveMinutes = Math.floor((Date.now() - lastActivityTime) / 60000);
        shutdownIn = Math.max(0, inactivityMinutes - inactiveMinutes);
    }

    res.json({
        enabled,
        inactivityThresholdMinutes: inactivityMinutes,
        lastActivityTime: lastActivityTime ? new Date(lastActivityTime).toISOString() : null,
        inactiveMinutes,
        shutdownInMinutes: enabled && status === 'active' ? shutdownIn : null,
        status: !enabled ? 'disabled' : status,
        lastShutdownAttempt: lastShutdownAttempt ? new Date(lastShutdownAttempt).toISOString() : null,
        failureCount,
        lastError,
        // Human-readable status message
        message: !enabled ? 'Auto-shutdown disabled' :
                 status === 'active' && !lastActivityTime ? 'Waiting for first transcription' :
                 status === 'active' ? `Active - shutdown in ${shutdownIn} min if idle` :
                 status === 'shutting_down' ? 'Shutdown in progress...' :
                 status === 'stopped' ? 'Container stopped' :
                 status === 'shutdown_failed' ? `Shutdown failed: ${lastError}` : status
    });
});

// ============================================================
// Authentication Endpoints (Phase 5)
// ============================================================

/**
 * Broadcaster authentication - verify master password and create session
 * POST /api/auth/broadcaster
 */
app.post('/api/auth/broadcaster', async (req, res) => {
    const { password, churchId } = req.body;

    if (!password || !churchId) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: password, churchId'
        });
    }

    if (!isValidChurchId(churchId)) {
        return res.status(400).json({
            success: false,
            error: 'Unknown churchId — not in whitelist'
        });
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!verifyMasterPassword(password, clientIp)) {
        console.log(`[Auth] Failed broadcaster auth attempt for ${churchId}`);
        return res.status(401).json({
            success: false,
            error: 'Invalid password'
        });
    }

    try {
        const qrBaseUrl = normalizePublicOrigin(req.get('x-barnaba-public-origin'))
            || getRequestPublicOrigin(req)
            || normalizePublicOrigin(config.appUrl)
            || config.appUrl;
        const qrData = await generateJoinQR(churchId, qrBaseUrl);
        const sessionToken = createBroadcasterSession(churchId, qrData.churchName);
        setSessionCookie(res, sessionToken);
        setAdminSessionCookie(res);

        console.log(`[Auth] Broadcaster authenticated: ${qrData.churchName} (${churchId})`);

        res.json({
            success: true,
            sessionToken,
            churchId,
            churchName: qrData.churchName,
            qrCode: qrData.qrCode,
            pin: qrData.pin,
            joinUrl: qrData.joinUrl
        });
    } catch (error) {
        console.error('[Auth] Broadcaster auth error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Authentication failed'
        });
    }
});

/**
 * Listener PIN verification
 * POST /api/auth/verify-pin
 */
app.post('/api/auth/verify-pin', (req, res) => {
    const { churchId, pin } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!churchId || !pin) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: churchId, pin'
        });
    }

    const result = verifyPIN(churchId, pin, clientIp);

    if (!result.valid) {
        return res.status(401).json({
            success: false,
            error: result.error
        });
    }

    console.log(`[Auth] Listener authenticated for ${result.churchName} (${churchId})`);
    const sessionToken = createListenerSession(churchId, result.churchName);
    setSessionCookie(res, sessionToken);
    setCsrfCookie(res, createCsrfToken(), {
        secure: secureCookies,
        maxAgeSeconds: CONFIG_SESSION_MAX_AGE_SECONDS,
    });

    res.json({
        success: true,
        churchId,
        churchName: result.churchName,
        sessionToken,
        languages: config.targetLanguages,
        languageNames: config.languageNames
    });
});

/**
 * Validate broadcaster session token
 * POST /api/auth/validate-session
 */
app.post('/api/auth/validate-session', (req, res) => {
    const token = getSessionTokenFromRequest(req);

    const result = validateSession(token);

    if (!result.valid) {
        return res.status(401).json({
            success: false,
            error: result.error
        });
    }

    res.json({
        success: true,
        churchId: result.session.churchId,
        churchName: result.session.churchName,
        role: result.session.role
    });
});

/**
 * Logout / invalidate session
 * POST /api/auth/logout
 */
app.post('/api/auth/logout', (req, res) => {
    const token = getSessionTokenFromRequest(req);

    if (token) {
        if (!validateCsrfRequest(req, parseCookies)) {
            return res.status(403).json({ success: false, error: 'CSRF token required' });
        }
        invalidateSession(token);
    }

    clearSessionCookie(res);
    clearAdminSessionCookie(req, res);
    res.json({ success: true });
});

/**
 * Get auth statistics (for admin/debug)
 * GET /api/auth/stats
 */
app.get('/api/auth/stats', requireAdminAuth, (req, res) => {
    res.json(getAuthStats());
});

// ============================================================
// Sermon Preparation Context Endpoints (02.03.2026)
// ============================================================

/**
 * POST /api/sermon-context - Upload sermon preparation file
 * Accepts .txt/.md (text) or .jpg/.png (image → GPT-4.1-mini vision extraction)
 * Requires valid session token. churchId derived from session, not body.
 */
app.post('/api/sermon-context', (req, res, next) => {
    sermonUpload.single('file')(req, res, (err) => {
        if (err) {
            console.error('[SermonCtx] Multer error:', err.message);
            return res.status(400).json({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!validateCsrfRequest(req, parseCookies)) {
            return res.status(403).json({ success: false, error: 'CSRF token required' });
        }
        const sessionToken = getSessionTokenFromRequest(req);
        if (!sessionToken) {
            return res.status(401).json({ success: false, error: 'Session token required' });
        }

        const session = validateSession(sessionToken);
        if (!session.valid) {
            return res.status(401).json({ success: false, error: session.error });
        }

        const churchId = session.session.churchId;

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        let text;
        const isImage = req.file.mimetype.startsWith('image/');

        if (isImage) {
            text = await extractSermonFromImage(req.file.buffer, req.file.mimetype);
            if (!text || text.trim().length === 0) {
                return res.status(422).json({
                    success: false,
                    error: 'Could not extract text from image. Try uploading a .txt file instead.'
                });
            }
            // Security H2 (24.07.2026): OCR output is attacker-influenceable (adversarial
            // text embedded in an uploaded image). It is stored as sermon context and
            // injected into the GPT prompt, so it must pass the same injection filter as
            // ASR text before storage.
            if (isPromptInjection(text)) {
                console.warn(`[SermonCtx] Rejected image upload for ${churchId}: prompt injection detected in OCR output`);
                return res.status(422).json({
                    success: false,
                    error: 'Could not use this image (failed a content safety check).'
                });
            }
        } else {
            text = req.file.buffer.toString('utf8').trim();
            if (!text || text.length === 0) {
                return res.status(400).json({ success: false, error: 'File is empty' });
            }
        }

        // Trim to 2000 words max
        const words = text.split(/\s+/);
        if (words.length > 2000) {
            text = words.slice(0, 2000).join(' ');
        }

        const replaced = setSermonContext(churchId, text, req.file.originalname);
        const wordCount = text.split(/\s+/).length;
        const preview = text.substring(0, 200) + (text.length > 200 ? '...' : '');

        console.log(`[SermonCtx] ${replaced ? 'Replaced' : 'Set'} context for ${churchId}: ${wordCount} words`);

        res.json({
            success: true,
            replaced,
            wordCount,
            preview,
            fileName: req.file.originalname
        });
    } catch (error) {
        console.error('[SermonCtx] Upload failed:', error.message);
        res.status(500).json({ success: false, error: 'Unable to process sermon context' });
    }
});

/**
 * GET /api/sermon-context - Check current sermon context status
 * Requires valid session token.
 */
app.get('/api/sermon-context', (req, res) => {
    const sessionToken = getSessionTokenFromRequest(req);
    if (!sessionToken) {
        return res.status(401).json({ success: false, error: 'Session token required' });
    }

    const session = validateSession(sessionToken);
    if (!session.valid) {
        return res.status(401).json({ success: false, error: session.error });
    }

    const churchId = session.session.churchId;
    const ctx = state.sermonContext.get(churchId);

    if (!ctx) {
        return res.json({ success: true, hasContext: false });
    }

    res.json({
        success: true,
        hasContext: true,
        wordCount: ctx.text.split(/\s+/).length,
        preview: ctx.text.substring(0, 200) + (ctx.text.length > 200 ? '...' : ''),
        fileName: ctx.fileName,
        uploadedAt: ctx.uploadedAt
    });
});

/**
 * DELETE /api/sermon-context - Clear sermon context
 * Requires valid session token.
 */
app.delete('/api/sermon-context', (req, res) => {
    if (!validateCsrfRequest(req, parseCookies)) {
        return res.status(403).json({ success: false, error: 'CSRF token required' });
    }
    const sessionToken = getSessionTokenFromRequest(req);
    if (!sessionToken) {
        return res.status(401).json({ success: false, error: 'Session token required' });
    }

    const session = validateSession(sessionToken);
    if (!session.valid) {
        return res.status(401).json({ success: false, error: session.error });
    }

    const churchId = session.session.churchId;
    const had = state.sermonContext.has(churchId);

    state.sermonContext.delete(churchId);
    const timer = state.sermonContextTimers.get(churchId);
    if (timer) {
        clearTimeout(timer);
        state.sermonContextTimers.delete(churchId);
    }

    console.log(`[SermonCtx] Cleared context for ${churchId} (had: ${had})`);
    res.json({ success: true, cleared: had });
});

// ============================================================
// Latency Statistics Endpoint
// ============================================================

/**
 * GET /api/latency-stats - Get end-to-end latency statistics
 *
 * Returns detailed breakdown of latency across pipeline stages:
 * - gateway_to_whisper: Audio forwarding time
 * - whisper_processing: ASR processing time
 * - whisper_to_translation: Time between ASR and translation
 * - translation_processing: GPT-4.1-mini processing time
 * - translation_to_broadcast: Delivery to clients
 * - end_to_end: Total latency
 *
 * Includes min, max, avg, p50, p95, p99 for each stage.
 */
app.get('/api/latency-stats', requireBroadcasterSession, (req, res) => {
    const stats = getLatencyStats();
    res.json(stats);
});

/**
 * POST /api/latency-stats/reset - Reset latency statistics
 */
app.post('/api/latency-stats/reset', requireAdminAuth, requireAdminCsrf, (req, res) => {
    resetLatencyStats();
    res.json({ success: true, message: 'Latency statistics reset' });
});

const feedbackRateLimits = new Map();
const FEEDBACK_RATE_LIMIT = { maxRequests: 10, windowMs: 60000 };

function allowFeedback(sessionId) {
    const now = Date.now();
    const current = feedbackRateLimits.get(sessionId);
    if (!current || now >= current.resetAt) {
        if (feedbackRateLimits.size > 1000) {
            for (const [key, value] of feedbackRateLimits) {
                if (now >= value.resetAt) feedbackRateLimits.delete(key);
            }
        }
        feedbackRateLimits.set(sessionId, { count: 1, resetAt: now + FEEDBACK_RATE_LIMIT.windowMs });
        return true;
    }
    current.count += 1;
    return current.count <= FEEDBACK_RATE_LIMIT.maxRequests;
}

/** POST /api/feedback - persist listener instant-feedback report to /app/logs. */
app.post('/api/feedback', async (req, res) => {
    if (!config.clientFeatures.instantFeedback) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    if (!allowFeedback(sessionId)) {
        return res.status(429).json({ success: false, error: 'Too many feedback reports' });
    }
    try {
        await appendFeedback(req.body);
        res.status(201).json({ success: true });
    } catch (error) {
        if (/required|invalid/.test(error.message)) {
            return res.status(400).json({ success: false, error: error.message });
        }
        console.error('[Feedback] Write error:', error.message);
        res.status(500).json({ success: false, error: 'Unable to save feedback' });
    }
});

/** Render the admin recorder's captured emission into ONE MP3 with real pauses baked in. */
app.post('/api/recording-render', requireBroadcasterSession, parseQaReplayUpload, async (req, res) => {
    let manifest;
    try {
        manifest = JSON.parse(String(req.body?.manifest || ''));
    } catch {
        return res.status(400).json({ success: false, error: 'Invalid manifest JSON' });
    }
    const sessionResult = validateRoleSession(getRecordingRenderToken(req), 'broadcaster', manifest.churchId);
    if (!sessionResult.valid) return res.status(401).json({ success: false, error: 'Unauthorized broadcaster session' });
    if (!Array.isArray(req.files) || req.files.length === 0) {
        return res.status(400).json({ success: false, error: 'Audio files are required' });
    }

    const chunks = new Map();
    try {
        for (const file of req.files) {
            if (!['audio/mpeg', 'audio/mp3'].includes(file.mimetype)) throw new Error('Only MP3 chunks are accepted');
            const chunkKey = decodeQaChunkKey(file.originalname);
            if (!chunkKey || chunks.has(chunkKey)) throw new Error('Invalid or duplicate chunk key');
            chunks.set(chunkKey, file.buffer);
        }
        const rendered = await renderQaReplay({ manifest, chunks });
        const safeLanguage = String(manifest.language || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'unknown';
        const filename = 'barnaba_' + safeLanguage + '_' + Date.now() + '.mp3';
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
        res.setHeader('X-Recording-Filename', filename);
        res.sendFile(rendered.outputPath, error => {
            cleanupQaReplay(rendered.tempDir).catch(cleanupError => console.warn('[Recording Render] Cleanup failed:', cleanupError.message));
            if (error && !res.headersSent) res.status(500).end();
        });
    } catch (error) {
        console.warn('[Recording Render] Render rejected:', error.message);
        const badRequest = error.statusCode === 400 || /required|missing|invalid|duplicate|accepted|finite|exceeds|after|overlap/.test(error.message.toLowerCase());
        return res.status(badRequest ? 400 : 500).json({
            success: false,
            error: badRequest ? error.message : 'Unable to render recording'
        });
    }
});
/**
 * POST /api/listener-telemetry — Listener-side queue depth + playback rate beacon.
 *
 * Listener PWA sends rolling snapshot every 10s (via navigator.sendBeacon when available).
 * Used by the offline evaluation pipeline to measure REAL drift: queue depth growth, chunk age
 * at play time, effective playback rate. No clock sync needed (all values are
 * listener-local except sessionId for grouping).
 *
 * Body shape (validated minimally — defensive defaults):
 *   {
 *     sessionId:  string (uuid-ish, generated client-side, stable per page load),
 *     churchId:   string,
 *     lang:       string,
 *     snapshot: {
 *       sessionAgeMs:                number,
 *       queueDepth:                  number,   // progressiveQueue.pending.size
 *       currentPlaybackRate:         number,   // ttsAudio.playbackRate at sample time
 *       chunksReceived:              number,
 *       chunksStarted:               number,
 *       chunksCompleted:             number,
 *       chunksSkipped:               number,
 *       chunksPlaybackErrors:        number,
 *       chunksNullAudio:             number,
 *       recentPlaysCount:            number,
 *       chunkAgeAtPlay_avg_ms:       number,   // avg (playStart - chunkReceived) over recent window
 *       chunkAgeAtPlay_max_ms:       number,
 *       source_coverage_lag_ms:      number?,  // now - latest heard source audio timestamp
 *       recentPlays_sample:          array     // last 5 plays raw (for distribution check)
 *       delivery_events_delta:       array     // persisted until acked by this endpoint
 *     }
 *   }
 *
 * Logged to eval-*.jsonl with stage='listener_telemetry' for post-mortem in
 * the offline evaluation report generator (drift section).
 */
app.post('/api/listener-telemetry', (req, res) => {
    const body = req.body || {};
    const snapshot = body.snapshot || {};
    if (typeof snapshot.queueDepth !== 'number' || typeof snapshot.chunksReceived !== 'number') {
        return res.status(400).json({ error: 'snapshot.queueDepth and snapshot.chunksReceived required' });
    }
    const churchId = String(body.churchId || 'unknown').slice(0, 64);
    const sessionId = String(body.sessionId || 'unknown').slice(0, 64);
    const lang = String(body.lang || 'unknown').slice(0, 8);
    const deliveryOutcomes = sanitizeDeliveryOutcomeBatch(snapshot.delivery_events_delta, 100);
    const safeListenerSessionId = listenerSessionIdFrom(sessionId);
    const listenerSession = getListenerTelemetrySessionToken(req);
    const listenerAuth = listenerSession
        ? validateRoleSession(listenerSession, 'listener', churchId)
        : { valid: false };
    const activeListener = safeListenerSessionId && [...state.clientListenerSessionIds.entries()]
        .some(([socket, activeId]) => (
            activeId === safeListenerSessionId
            && socket.readyState === WebSocket.OPEN
            && state.subscriptions.get(churchId)?.get(lang)?.has(socket)
        ));
    const acceptForPlayoutLedger = listenerAuth.valid && activeListener;
    const droppedByReason = {};
    if (snapshot.dropped_by_reason && typeof snapshot.dropped_by_reason === 'object') {
        for (const [reason, value] of Object.entries(snapshot.dropped_by_reason)) {
            if (allowedDropReasons.has(reason)) {
                droppedByReason[reason] = Number(value) || 0;
            }
        }
    }
    const pendingDropSample = sanitizePendingDropSample(snapshot.listener_pending_dropped_sample, 10);
    const listenerMeasurementAgeMs = sanitizeListenerMeasurementAgeMs(
        snapshot.listener_measurement_age_ms,
    );
    const listenerMetric = {
        stage: 'listener_telemetry',
        listener_buffer_depth: snapshot.queueDepth,
        // Autopilot needs the current source-coverage gauge. audibleDrift_max_ms is a
        // historical diagnostic over recent plays and can remain critical after recovery.
        listener_drift_ms: snapshot.source_coverage_lag_ms ?? null,
        audibleDriftMs: snapshot.source_coverage_lag_ms ?? null,
        realSilenceMaxMs: snapshot.realSilence_max_ms ?? null,
        realSilenceCountOver7s: snapshot.realSilence_count_over_7s ?? null,
        lastReleaseSeqPlayed: snapshot.last_release_seq_played ?? null,
        queue_depth: snapshot.queueDepth,
        age_ms: Number(snapshot.chunkAgeAtPlay_avg_ms) || 0,
        listener_measurement_age_ms: listenerMeasurementAgeMs,
    };
    recordLiveQualityMetric(churchId, listenerMetric);
    logAutopilotShadow(churchId, { source: 'listener_telemetry' });
    evalLog({
        stage: 'listener_telemetry',
        sessionId,
        churchId,
        lang,
        sessionAgeMs: Number(snapshot.sessionAgeMs) || 0,
        queueDepth: snapshot.queueDepth,
        currentPlaybackRate: Number(snapshot.currentPlaybackRate) || 1.0,
        chunksReceived: snapshot.chunksReceived,
        chunksPlayed: Number(snapshot.chunksPlayed) || 0,
        chunksStarted: Number(snapshot.chunksStarted ?? snapshot.chunksPlayed) || 0,
        chunksCompleted: Number(snapshot.chunksCompleted) || 0,
        chunksSkipped: Number(snapshot.chunksSkipped) || 0,
        chunksPlaybackErrors: Number(snapshot.chunksPlaybackErrors) || 0,
        chunksNullAudio: Number(snapshot.chunksNullAudio) || 0,
        chunksExplicitDrops: Number(snapshot.chunksExplicitDrops) || 0,
        chunksPending: Number(snapshot.chunksPending ?? snapshot.queueDepth) || 0,
        chunksUnexplained: Number(snapshot.chunksUnexplained) || 0,
        currentlyPlaying: Number(snapshot.currentlyPlaying) || 0,
        recentPlaysCount: Number(snapshot.recentPlaysCount) || 0,
        ageMs: Number(snapshot.chunkAgeAtPlay_avg_ms) || 0,
        chunkAgeAtPlay_avg_ms: Number(snapshot.chunkAgeAtPlay_avg_ms) || 0,
        chunkAgeAtPlay_max_ms: Number(snapshot.chunkAgeAtPlay_max_ms) || 0,
        // Full audible drift fields (listener-side: speaker spoke -> listener heard).
        // Null when clock sync is not ready or the server did not send audioCapturedAt.
        audibleDrift_samples_count: Number(snapshot.audibleDrift_samples_count) || 0,
        audibleDrift_avg_ms: (snapshot.audibleDrift_avg_ms == null) ? null : Number(snapshot.audibleDrift_avg_ms),
        audibleDrift_min_ms: (snapshot.audibleDrift_min_ms == null) ? null : Number(snapshot.audibleDrift_min_ms),
        audibleDrift_max_ms: (snapshot.audibleDrift_max_ms == null) ? null : Number(snapshot.audibleDrift_max_ms),
        listener_measurement_age_ms: listenerMeasurementAgeMs,
        // Source coverage lag answers "how far behind the speaker is the listener now?"
        // It advances with the newest source audio timestamp that has actually started playing.
        source_coverage_lag_ms: (snapshot.source_coverage_lag_ms == null) ? null : Number(snapshot.source_coverage_lag_ms),
        source_coverage_audioCapturedLocal_ms: (snapshot.source_coverage_audioCapturedLocal_ms == null)
            ? null
            : Number(snapshot.source_coverage_audioCapturedLocal_ms),
        source_coverage_lastPlayStart_ms: (snapshot.source_coverage_lastPlayStart_ms == null)
            ? null
            : Number(snapshot.source_coverage_lastPlayStart_ms),
        realSilence_max_ms: (snapshot.realSilence_max_ms == null) ? null : Number(snapshot.realSilence_max_ms),
        realSilence_count_over_7s: Number(snapshot.realSilence_count_over_7s) || 0,
        last_release_seq_played: (snapshot.last_release_seq_played == null) ? null : Number(snapshot.last_release_seq_played),
        last_source_hash_played: snapshot.last_source_hash_played == null ? null : String(snapshot.last_source_hash_played).slice(0, 64),
        listener_pending_dropped_count: Number(snapshot.listener_pending_dropped_count) || 0,
        dropped_by_reason: droppedByReason,
        listener_pending_dropped_sample: pendingDropSample,
        clockSkewMs: (snapshot.clockSkewMs == null) ? null : Number(snapshot.clockSkewMs),
        clockSamples: Number(snapshot.clockSamples) || 0,
        recentPlays_sample: Array.isArray(snapshot.recentPlays_sample)
            ? snapshot.recentPlays_sample.slice(0, 10)
            : []
    });
    const ackedOutcomeIds = [];
    const retryableOutcomeIds = [];
    const rejectedOutcomeIds = [];
    for (const event of deliveryOutcomes) {
        evalLog({
            ...event,
            churchId,
            lang,
            beacon_session_id: sessionId,
        });
        const ledgerResult = acceptForPlayoutLedger
            ? listenerPlayoutLedger.observeOutcome({
                churchId,
                listenerSessionId: safeListenerSessionId,
                event,
            })
            : {
                accepted: false,
                retryable: listenerAuth.valid,
                reason: listenerAuth.valid ? 'listener_not_active' : 'listener_not_authenticated',
            };
        if (ledgerResult.accepted) ackedOutcomeIds.push(event.outcome_id);
        else if (ledgerResult.retryable) retryableOutcomeIds.push(event.outcome_id);
        else rejectedOutcomeIds.push(event.outcome_id);
        evalLog({
            stage: 'listener_playout_ledger',
            churchId,
            lang,
            listener_session_id: safeListenerSessionId,
            chunk_key: event.chunk_key,
            session_epoch: event.session_epoch,
            outcome: event.outcome,
            accepted: ledgerResult.accepted === true,
            duplicate: ledgerResult.duplicate === true,
            committed: ledgerResult.committed === true,
            reason: ledgerResult.reason || null,
        });
    }
    res.json({
        ok: true,
        acked_outcome_ids: ackedOutcomeIds,
        retryable_outcome_ids: retryableOutcomeIds,
        rejected_outcome_ids: rejectedOutcomeIds,
    });
});

// ============================================================
// WebSocket Handler
// ============================================================
wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[WS] New connection from ${clientIp}`);

    const cookies = parseCookies(req.headers.cookie || '');
    let clientState = {
        type: null,
        churchId: null,
        language: null,
        authenticated: false,
        clientIp,
        clockSync: null,
        audioGeneration: 0,
        sessionToken: cookies[AUTH_COOKIE_NAME] || null,
    };

    // Clock synchronization (NTP-lite) — start immediately
    initiateClockSync(ws, clientState);

    ws.on('message', async (data) => {
        try {
            // Check if binary data (Phase B: PCM audio)
            let isBinaryPCM = false;
            if (Buffer.isBuffer(data) && data.length >= 4) {
                // Check if this looks like our PCM format (starts with flags uint32)
                // PCM format: [4 bytes flags][Float32 samples...]
                const firstByte = data[0];
                isBinaryPCM = (firstByte <= 3) && data.length >= 4;  // flags 0-3 (v1/v2/v3)
            }

            let message = null;
            if (!isBinaryPCM) {
                try {
                    message = JSON.parse(data.toString());
                } catch (error) {
                    if (!enforceWsRateLimit(ws, clientState, clientIp, null)) return;
                    throw error;
                }
            }

            if (!enforceWsRateLimit(ws, clientState, clientIp, message)) return;

            if (isBinaryPCM) {
                await handleBinaryPCMAudio(ws, data, clientState);
                return;
            }

            await handleMessage(ws, message, clientState);
        } catch (error) {
            console.error('[WS] Error:', error.message);
        }
    });

    ws.on('close', () => handleDisconnect(ws, clientState));
    ws.on('error', (error) => console.error('[WS] Error:', error.message));

    const activeChurches = [...state.churches.entries()].map(([churchId, church]) => ({
        churchId,
        name: church.name,
        listeners: getListenerCount(churchId)
    }));

    // Send welcome with the current church snapshot so late-joining listeners
    // do not miss the earlier broadcaster church_online broadcast.
    ws.send(JSON.stringify({
        type: 'welcome',
        languages: config.targetLanguages,
        churches: activeChurches
    }));

    // Backward-compatible events for clients that only listen for church_online.
    for (const church of activeChurches) {
        ws.send(JSON.stringify({
            type: 'church_online',
            churchId: church.churchId,
            name: church.name
        }));
    }
});

function enforceWsRateLimit(ws, clientState, clientIp, message) {
    const connectionScoped = isConnectionScopedListenerTelemetry(message, clientState);
    const config = connectionScoped ? WS_LISTENER_TELEMETRY_RATE_LIMIT : WS_IP_RATE_LIMIT;
    const previous = connectionScoped
        ? clientState.listenerTelemetryRateLimit
        : state.wsRateLimits.get(clientIp);
    const result = takeRateLimitSlot(previous, Date.now(), config);

    if (connectionScoped) {
        clientState.listenerTelemetryRateLimit = result.state;
    } else {
        state.wsRateLimits.set(clientIp, result.state);
    }

    if (result.shouldWarn) {
        const scope = connectionScoped ? 'listener telemetry' : 'shared IP';
        console.warn(`[WS] ${scope} rate limit exceeded for ${clientIp} (${result.state.count} msgs)`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded. Please slow down.' }));
        }
    }
    if (result.shouldClose && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'Rate limit exceeded');
    }
    return result.allowed;
}

async function handleMessage(ws, message, clientState) {
    switch (message.type) {
        // Keepalive ping from clients
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

        // Authentication handlers (Phase 5)
        case 'authenticate_broadcaster':
            await handleAuthenticateBroadcaster(ws, message, clientState);
            break;
        case 'authenticate_listener':
            handleAuthenticateListener(ws, message, clientState);
            break;

        // Node (broadcaster) handlers
        case 'register_node':
            handleNodeRegister(ws, message, clientState);
            break;
        case 'speech_text':
            await handleSpeechText(ws, message, clientState);
            break;

        // Phase 1: Whisper ASR audio streaming
        case 'audio_chunk':
            await handleAudioChunk(ws, message, clientState);
            break;

        // Client (listener) handlers
        case 'subscribe':
            handleSubscribe(ws, message, clientState);
            break;
        case 'unsubscribe':
            handleUnsubscribe(ws, clientState);
            break;

        // Recording handlers (multi-language subscription)
        case 'subscribe_recording':
            handleSubscribeRecording(ws, message, clientState);
            break;
        case 'unsubscribe_recording':
            handleUnsubscribeRecording(ws, clientState);
            break;

        // Clock synchronization (NTP-lite)
        case 'clock_sync_ack':
            handleClockSyncAck(ws, message, clientState);
            break;

        // Listener latency ACK (true end-to-end measurement)
        case 'latency_ack':
            handleLatencyAck(message, clientState);
            break;
    }
}

// ------------------------------------------------------------
// Clock Synchronization (NTP-lite) for true end-to-end latency
// ------------------------------------------------------------

function initiateClockSync(ws, clientState) {
    clientState.clockSync = { samples: [], bestRtt: Infinity, offset: 0, synced: false, probesSent: 0 };
    ws.send(JSON.stringify({ type: 'clock_sync', serverTime: Date.now() }));
    clientState.clockSync.probesSent++;
}

function handleClockSyncAck(ws, message, clientState) {
    if (!clientState.clockSync) return;

    const now = Date.now();
    const rtt = now - message.serverTime;
    const oneWay = rtt / 2;
    const offset = message.clientTime - message.serverTime - oneWay;

    clientState.clockSync.samples.push({ rtt, offset });

    if (rtt < clientState.clockSync.bestRtt) {
        clientState.clockSync.bestRtt = rtt;
        clientState.clockSync.offset = offset;
    }

    if (clientState.clockSync.probesSent < 3) {
        ws.send(JSON.stringify({ type: 'clock_sync', serverTime: Date.now() }));
        clientState.clockSync.probesSent++;
    } else {
        clientState.clockSync.synced = true;
        console.log(`[ClockSync] ${clientState.clientIp}: offset=${Math.round(clientState.clockSync.offset)}ms, bestRtt=${clientState.clockSync.bestRtt}ms`);
    }
}

function handleLatencyAck(message, clientState) {
    if (!message.txId || !message.receivedAt) return;

    // Adjust listener timestamp to server clock
    const offset = clientState.clockSync?.offset || 0;
    const listenerReceivedServerTime = message.receivedAt - offset;

    const result = recordListenerAck(message.txId, listenerReceivedServerTime);
    if (result && result.true_end_to_end !== null) {
        console.log(`[LATENCY] True E2E: ${result.true_end_to_end}ms | Upload: ${result.capture_to_gateway}ms | Download: ${result.gateway_to_listener}ms`);
    }
}

// ------------------------------------------------------------
// Quality Tracker: session config snapshot
// ------------------------------------------------------------
/**
 * Capture current filter config and register it with qualityTracker.
 * Called once per broadcaster session (auth or register).
 *
 * Contains all 14 GATEWAY filter parameters that affect dedup behavior.
 * Whisper-side params (VAD threshold, hallucination filter, model, beam size)
 * are NOT included here — they live in Python and are invisible to the JS gateway.
 *
 * Remote Whisper runtime metadata is recorded from the gateway-visible status;
 * add a Whisper→Gateway config handshake. Cleanest approach: Whisper sends its
 * active config as a field in the first `recognized` message after connection.
 * Gateway merges it into the configObject here. Until then, Whisper params must
 * be held constant during a gateway tuning campaign (see trackDEInput JSDoc).
 */
function registerQualityConfig(churchId) {
    const whisperStatus = getWhisperStatus();
    const whisperStats = getWhisperStats();
    qualityTracker.setSessionConfig(churchId, {
        // B1: Sanity gate
        B1_alphaRatioMin: 0.4,
        B1_minChars: 10,
        // punctGate
        punctGate_maxCharsNopunct: 100,
        // P2: Cross-emission N-gram dedup
        P2_ngramSize: 6,
        P2_gapTolerance: 4,
        P2_lowRepeat: 0.2,
        P2_highRepeat: 0.7,
        P2_historyCap: 500,
        // B4: Jaccard overlap guard
        B4_historySize: 3,
        B4_jaccardThreshold: 0.5,
        B4_minNewWords: 5,
        // B2: Inter-segment overlap (last 20 words, min overlap 4 stems)
        B2_lastWords: 20,
        B2_minOverlapStems: 4,
        // P3: Intra-line N-gram dedup
        P3_ngramSize: 6,
        P3_minDistance: 12,
        // INTRA: SmoothMode-batched P1 cleanup
        INTRA_enabled: INTRA_EMISSION_DEDUP_CONFIG.enabled,
        INTRA_minContentTokens: INTRA_EMISSION_DEDUP_CONFIG.minContentTokens,
        INTRA_containmentThreshold: INTRA_EMISSION_DEDUP_CONFIG.containmentThreshold,
        INTRA_prefixTokenThreshold: INTRA_EMISSION_DEDUP_CONFIG.prefixTokenThreshold,
        INTRA_minNewContentTokens: INTRA_EMISSION_DEDUP_CONFIG.minNewContentTokens,
        INTRA_maxRemovalRatio: INTRA_EMISSION_DEDUP_CONFIG.maxRemovalRatio,
        INTRA_maxLookahead: INTRA_EMISSION_DEDUP_CONFIG.maxLookahead,
        INTRA_semanticEnabled: INTRA_EMISSION_DEDUP_CONFIG.semanticEnabled,
        INTRA_semanticDryRun: INTRA_EMISSION_DEDUP_CONFIG.semanticDryRun,
        INTRA_semanticSimilarityThreshold: INTRA_EMISSION_DEDUP_CONFIG.semanticSimilarityThreshold,
        INTRA_semanticContainmentThreshold: INTRA_EMISSION_DEDUP_CONFIG.semanticContainmentThreshold,
        INTRA_semanticMinPreviousTokens: INTRA_EMISSION_DEDUP_CONFIG.semanticMinPreviousTokens,
        INTRA_semanticMinCurrentTokens: INTRA_EMISSION_DEDUP_CONFIG.semanticMinCurrentTokens,
        // T5: Post-translation dedup
        T5_dedupWindow: 5,
        T5_dedupThreshold: 0.30,
        T5_shortTextChars: 40,
        // BCL: Boundary Commit Ledger
        BCL_enabled: config.boundaryCommitLedger.enabled,
        BCL_applyExact: config.boundaryCommitLedger.applyExact,
        BCL_shadowSemantic: config.boundaryCommitLedger.shadowSemantic,
        BCL_applySemantic: config.boundaryCommitLedger.applySemantic,
        BCL_semanticApplyRatio: config.boundaryCommitLedger.semanticApplyRatio,
        BCL_semanticHighConfidenceSpanRatio: config.boundaryCommitLedger.semanticHighConfidenceSpanRatio,
        BCL_semanticApplyRatioLong: config.boundaryCommitLedger.semanticApplyRatioLong,
        BCL_semanticLongMinTokens: config.boundaryCommitLedger.semanticLongMinTokens,
        BCL_semanticLexicalConfirm: config.boundaryCommitLedger.semanticLexicalConfirm,
        BCL_minExactTokens: config.boundaryCommitLedger.minExactTokens,
        BCL_maxExactTokens: config.boundaryCommitLedger.maxExactTokens,
        BCL_maxTailTokens: config.boundaryCommitLedger.maxTailTokens,
        BCL_maxHeadTokens: config.boundaryCommitLedger.maxHeadTokens,
        BCL_semanticThreshold: config.boundaryCommitLedger.semanticThreshold,
        // PF: Partial fallback
        PF_enabled: config.partialFallback.enabled,
        PF_timeoutMs: config.partialFallback.timeoutMs,
        PF_similarityThreshold: config.partialFallback.similarityThreshold,
        // Runtime latency/backpressure knobs
        AGE_enabled: config.ageBudget.enabled,
        AGE_cautiousAfterMs: config.ageBudget.cautiousAfterMs,
        AGE_textOnlyAfterMs: config.ageBudget.textOnlyAfterMs,
        AGE_dropAfterMs: config.ageBudget.dropAfterMs,
        AGE_unhealthyQueueDepth: config.ageBudget.unhealthyQueueDepth,
        EMISSION_CONTROLLER_enabled: config.emissionController.enabled,
        EMISSION_CONTROLLER_shadowLoggingEnabled: config.emissionController.shadowLoggingEnabled,
        EMISSION_CONTROLLER_qualityMaxAgeMs: config.emissionController.qualityMaxAgeMs,
        EMISSION_CONTROLLER_fastMaxAgeMs: config.emissionController.fastMaxAgeMs,
        EMISSION_CONTROLLER_catchupMaxAgeMs: config.emissionController.catchupMaxAgeMs,
        EMISSION_CONTROLLER_dropAfterMs: config.emissionController.dropAfterMs,
        EMISSION_CONTROLLER_unhealthyQueueDepth: config.emissionController.unhealthyQueueDepth,
        EMISSION_CONTROLLER_overloadedQueueDepth: config.emissionController.overloadedQueueDepth,
        // Remote Whisper gateway-visible config
        WHISPER_enabled: whisperEnabled,
        WHISPER_mode: 'remote',
        WHISPER_serviceConfigured: Boolean(process.env.WHISPER_SERVICE_URL),
        WHISPER_initialized: Boolean(whisperStatus.initialized),
        WHISPER_streamingSessions: Number(whisperStats.streamingSessions || 0),
    }, {
        nodeEnv: process.env.NODE_ENV || 'unknown',
        appUrl: config.appUrl,
        whisperServiceHost: process.env.WHISPER_SERVICE_URL ? new URL(process.env.WHISPER_SERVICE_URL).host : null,
    });
}

// ------------------------------------------------------------
// Authentication handlers (Phase 5)
// ------------------------------------------------------------

function sendAuthError(ws, error) {
    ws.send(JSON.stringify({
        type: 'auth_error',
        error
    }));
}

function hasAuthenticatedRole(clientState, role, churchId = clientState.churchId) {
    if (!clientState.authenticated) return false;
    if (clientState.type !== role) return false;
    if (churchId && clientState.churchId !== churchId) return false;
    return true;
}

function requireBroadcasterClient(ws, clientState, churchId = clientState.churchId) {
    if (hasAuthenticatedRole(clientState, 'node', churchId)) return true;
    console.warn(`[WS Auth] Rejected broadcaster event from unauthenticated client for churchId=${churchId || 'unknown'}`);
    sendAuthError(ws, 'Broadcaster authentication required');
    return false;
}

function resetBroadcasterAudioGeneration(clientState, reason) {
    clientState.audioGeneration = (clientState.audioGeneration || 0) + 1;
    if (clientState.churchId) {
        console.log(`[PCM] ${clientState.churchId}: Audio generation ${clientState.audioGeneration} (${reason})`);
    }
    return clientState.audioGeneration;
}

function isCurrentBroadcasterAudio(ws, clientState, churchId, generation) {
    if (clientState.type !== 'node') return false;
    if (clientState.churchId !== churchId) return false;
    if ((clientState.audioGeneration || 0) !== generation) return false;
    if (ws.readyState !== WebSocket.OPEN) return false;
    return state.churches.get(churchId)?.ws === ws;
}

function requireListenerClient(ws, clientState, churchId) {
    if (hasAuthenticatedRole(clientState, 'client', churchId)) return true;
    console.warn(`[WS Auth] Rejected listener subscription from unauthenticated client for churchId=${churchId || 'unknown'}`);
    sendAuthError(ws, 'Listener authentication required');
    return false;
}

function validateRoleSession(sessionToken, role, churchId) {
    const sessionResult = validateSession(sessionToken);
    if (!sessionResult.valid) {
        return { valid: false, error: sessionResult.error || 'Invalid session' };
    }
    if (sessionResult.session.role !== role) {
        return { valid: false, error: `${role} session required` };
    }
    if (sessionResult.session.churchId !== churchId) {
        return { valid: false, error: 'Church ID mismatch' };
    }
    return sessionResult;
}

/**
 * Validates session token and sets up broadcaster state
 */
async function handleAuthenticateBroadcaster(ws, message, clientState) {
    const { sessionToken, churchId, churchName } = message;
    const token = sessionToken || clientState.sessionToken;

    console.log(`[DEBUG] 🔐 Broadcaster auth attempt: churchId="${churchId}", churchName="${churchName}"`);

    // Validate session token
    const sessionResult = validateRoleSession(token, 'broadcaster', churchId);
    if (!sessionResult.valid) {
        console.log(`[DEBUG] ❌ Session validation failed: ${sessionResult.error}`);
        ws.send(JSON.stringify({
            type: 'auth_error',
            error: sessionResult.error || 'Invalid session'
        }));
        return;
    }

    // Verify churchId matches session
    if (sessionResult.session.churchId !== churchId) {
        console.log(`[DEBUG] ❌ ChurchId mismatch: session has "${sessionResult.session.churchId}", message has "${churchId}"`);
        ws.send(JSON.stringify({
            type: 'auth_error',
            error: 'Church ID mismatch'
        }));
        return;
    }

    clientState.authenticated = true;
    clientState.type = 'node';
    clientState.churchId = churchId;
    resetBroadcasterAudioGeneration(clientState, 'broadcaster authenticated');

    // Register the church
    state.churches.set(churchId, { ws, name: churchName });
    // HOTFIX 7.1: Guard against wiping existing subscriptions on re-auth
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
        console.log(`[Broadcaster] New session for ${churchId}, empty subscription map initialized`);
    } else {
        const existing = state.subscriptions.get(churchId);
        const listenerCount = [...existing.values()].reduce((sum, s) => sum + s.size, 0);
        if (listenerCount > 0) {
            console.log(`[Broadcaster] Re-auth for ${churchId}, preserving ${existing.size} language(s) with ${listenerCount} listener(s)`);
        }
    }
    registerQualityConfig(churchId);

    console.log(`[WS Auth] ✅ Broadcaster authenticated: ${churchName}`);
    console.log(`[DEBUG] Broadcaster churchId: "${churchId}"`);
    console.log(`[DEBUG] Churches after auth:`, [...state.churches.keys()]);

    ws.send(JSON.stringify({
        type: 'authenticated',
        role: 'broadcaster',
        churchId,
        churchName
    }));

    broadcastToAll({ type: 'church_online', churchId, name: churchName });

    // Warm-up (02.03.2026): Pre-warm contextBuffer with sermon preparation context
    // This gives GPT-4.1-mini theological context from the very first translation
    const sermonCtx = state.sermonContext.get(churchId);
    if (sermonCtx?.text) {
        preWarmContextBuffer(churchId, sermonCtx.text);
        console.log(`[WARMUP] ${churchId}: Pre-warmed contextBuffer from sermon prep (${sermonCtx.text.split(/\s+/).length} words)`);
    }
}

/**
 * Handle listener authentication via WebSocket
 * Validates PIN and sets up listener state
 */
function handleAuthenticateListener(ws, message, clientState) {
    const { churchId, pin, sessionToken } = message;
    const token = sessionToken || clientState.sessionToken;

    if (token) {
        const sessionResult = validateRoleSession(token, 'listener', churchId);
        if (!sessionResult.valid) {
            sendAuthError(ws, sessionResult.error || 'Invalid listener session');
            return;
        }

        clientState.authenticated = true;
        clientState.type = 'client';
        clientState.churchId = churchId;

        console.log(`[WS Auth] Listener session authenticated for ${sessionResult.session.churchName} (${churchId})`);

        ws.send(JSON.stringify({
            type: 'authenticated',
            role: 'listener',
            churchId,
            churchName: sessionResult.session.churchName,
            languages: config.targetLanguages,
            languageNames: config.languageNames
        }));
        return;
    }

    const pinResult = verifyPIN(churchId, pin, clientState.clientIp);
    if (!pinResult.valid) {
        sendAuthError(ws, pinResult.error || 'Invalid PIN');
        return;
    }

    clientState.authenticated = true;
    clientState.type = 'client';
    clientState.churchId = churchId;

    console.log(`[WS Auth] Listener authenticated for ${pinResult.churchName} (${churchId})`);

    ws.send(JSON.stringify({
        type: 'authenticated',
        role: 'listener',
        churchId,
        churchName: pinResult.churchName,
        languages: config.targetLanguages,
        languageNames: config.languageNames
    }));
}

// ------------------------------------------------------------
// Node (broadcaster) handlers
// ------------------------------------------------------------
function handleNodeRegister(ws, message, clientState) {
    const churchId = message.churchId || clientState.churchId;
    if (!requireBroadcasterClient(ws, clientState, churchId)) return;

    const churchName = message.name || 'Church';

    console.log(`[NODE] 📡 Registering broadcaster: ${churchName}`);
    console.log(`[DEBUG] Broadcaster churchId: "${churchId}"`);

    state.churches.set(churchId, { ws, name: churchName });
    // HOTFIX 7.1: Guard against wiping existing subscriptions
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
    }
    registerQualityConfig(churchId);

    clientState.type = 'node';
    clientState.churchId = churchId;
    resetBroadcasterAudioGeneration(clientState, 'broadcaster registered');

    console.log(`[DEBUG] Churches after registration:`, [...state.churches.keys()]);

    ws.send(JSON.stringify({ type: 'registered', churchId, name: churchName }));
    broadcastToAll({ type: 'church_online', churchId, name: churchName });
}

async function handleSpeechText(ws, message, clientState) {
    if (!requireBroadcasterClient(ws, clientState)) return;

    const { text, isFinal } = message;
    const churchId = clientState.churchId;

    if (!text || !churchId) return;

    // Broadcast partial text
    if (!isFinal) {
        broadcastToChurch(churchId, { type: 'partial', text, language: 'de' });
        return;
    }

    // Get or create sentence buffer for this church (Phase 6)
    if (!state.sentenceBuffers.has(churchId)) {
        state.sentenceBuffers.set(churchId, new SentenceBuffer());
    }
    const sentenceBuffer = state.sentenceBuffers.get(churchId);

    // Add text to buffer and get complete sentences
    const completeSentences = sentenceBuffer.add(text, false);

    // Process each complete sentence
    for (const sentence of completeSentences) {
        await processCompleteSentence(churchId, sentence.text);
    }

    // Also broadcast current buffer state as partial (for real-time feedback)
    const pending = sentenceBuffer.peek();
    if (pending) {
        broadcastToChurch(churchId, { type: 'partial', text: pending, language: 'de' });
    }
}

/**
 * Handle audio chunk from broadcaster for Whisper transcription (Phase 1)
 * Receives base64 encoded audio, accumulates, and transcribes when ready
 */
async function handleAudioChunk(ws, message, clientState) {
    if (!requireBroadcasterClient(ws, clientState)) return;
    if (!whisperEnabled) return;

    const { audio, isFinal } = message;
    const churchId = clientState.churchId;

    if (!audio || !churchId) return;

    try {
        // Decode base64 audio to buffer
        const audioBuffer = Buffer.from(audio, 'base64');

        // Accumulate audio chunks
        const readyBuffer = accumulateAudio(churchId, audioBuffer);

        // If we have enough audio OR this is the final chunk, transcribe
        let bufferToTranscribe = readyBuffer;

        if (isFinal && !bufferToTranscribe) {
            // Flush remaining audio on final chunk
            bufferToTranscribe = flushAudioBuffer(churchId);
        }

        if (bufferToTranscribe) {
            console.log(`[Whisper] Transcribing ${bufferToTranscribe.length} bytes for ${churchId}`);

            const result = await transcribeStream(bufferToTranscribe);

            if (result.text) {
                state.stats.whisperTranscriptions++;
                updateWhisperActivity(); // Auto-shutdown tracking
                console.log(`[Whisper] ${churchId}: transcription completed (${result.text.length} characters)`);

                // Send transcription through sentence processing pipeline
                // Get or create sentence buffer for this church
                if (!state.sentenceBuffers.has(churchId)) {
                    state.sentenceBuffers.set(churchId, new SentenceBuffer());
                }
                const sentenceBuffer = state.sentenceBuffers.get(churchId);

                // Add text to buffer and get complete sentences
                const completeSentences = sentenceBuffer.add(result.text, isFinal);

                // Process each complete sentence
                for (const sentence of completeSentences) {
                    await processCompleteSentence(churchId, sentence.text);
                }

                // Broadcast current buffer state as partial (real-time feedback)
                const pending = sentenceBuffer.peek();
                if (pending) {
                    broadcastToChurch(churchId, { type: 'partial', text: pending, language: 'de' });
                }

                // Notify broadcaster of successful transcription
                ws.send(JSON.stringify({
                    type: 'transcription',
                    text: result.text,
                    language: 'de'
                }));
            }
        }
    } catch (error) {
        console.error(`[Whisper] Error processing audio for ${churchId}:`, error.message);
        ws.send(JSON.stringify({
            type: 'transcription_error',
            error: 'Audio transcription failed'
        }));
    }
}

/**
 * Handle binary PCM audio from AudioWorklet (Phase B: low-latency streaming)
 *
 * Binary format v2 from browser (with sample_rate):
 * - Bytes 0-3: flags (uint32 little-endian, 1 = isFinal)
 * - Bytes 4-7: sample_rate (uint32 little-endian, e.g., 48000)
 * - Bytes 8+: Float32 PCM samples at native browser rate
 *
 * Server-side Python uses high-quality torchaudio sinc resampling
 * to convert to 16kHz, avoiding aliasing from browser linear interpolation.
 *
 * @param {WebSocket} ws - WebSocket connection
 * @param {Buffer} data - Binary audio data
 * @param {object} clientState - Client state
 */
async function handleBinaryPCMAudio(ws, data, clientState) {
    if (!requireBroadcasterClient(ws, clientState)) return;
    if (!whisperEnabled) return;

    const churchId = clientState.churchId;
    if (!churchId) return;

    try {
        // Parse binary format: [4B flags][4B sample_rate][optional 8B capturedAt][Float32 samples]
        // v1: 4-byte header (legacy, 16kHz assumed)
        // v2: 8-byte header (flags + sample_rate)
        // v3: 16-byte header (flags + sample_rate + capturedAt timestamp)
        let flags, sampleRate, sampleBytes, capturedAt = null;

        // Detect format: v2/v3 has sample_rate in bytes 4-7 (typical values: 44100, 48000)
        const byte4Value = data.readUInt32LE(4);
        const isV2Plus = byte4Value >= 8000 && byte4Value <= 192000;

        if (isV2Plus && data.length >= 8) {
            flags = data.readUInt32LE(0);
            sampleRate = data.readUInt32LE(4);

            // v3: bit 1 of flags = has capturedAt timestamp
            if ((flags & 2) && data.length >= 16) {
                capturedAt = data.readDoubleLE(8);
                sampleBytes = data.slice(16);
            } else {
                sampleBytes = data.slice(8);
            }
        } else {
            // v1 format (legacy, assumes 16kHz)
            flags = data.readUInt32LE(0);
            sampleRate = 16000;
            sampleBytes = data.slice(4);
        }

        const isFinal = (flags & 1) === 1;
        const sampleCount = sampleBytes.length / 4;  // 4 bytes per Float32

        if (sampleCount === 0 && !isFinal) return;

        // Convert Buffer to Float32Array
        const samples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            samples[i] = sampleBytes.readFloatLE(i * 4);
        }

        // Log audio reception with sample rate
        const durationMs = (sampleCount / sampleRate * 1000).toFixed(0);
        console.log(`[PCM] ${churchId}: Received ${sampleCount} samples @ ${sampleRate}Hz (${durationMs}ms)${isFinal ? ' [FINAL]' : ''}`);
        if (UAT_PIPELINE_OBSERVER_ENABLED) {
            const vad = detectVoiceActivity(samples, UAT_SOURCE_VAD_THRESHOLD);
            broadcastToChurch(churchId, buildSourceActivityMessage({ isFinal, vad }));
        }
        const audioGeneration = clientState.audioGeneration || 0;
        if (isFinal) {
            resetBroadcasterAudioGeneration(clientState, 'final PCM chunk received');
        }

        // Start latency tracking for this audio chunk
        // v3: adjust broadcaster capturedAt to server clock using clock sync offset
        // FIX (26.03.2026, pair-coding): Use offset as soon as available (even partial sync).
        // Old code required synced=true (3 ACKs) — race condition left capture_to_gateway always null.
        // offset defaults to 0 at init, updated after each ACK — good enough for upload latency.
        let audioCapturedAt = null;
        if (capturedAt && clientState.clockSync) {
            audioCapturedAt = capturedAt - clientState.clockSync.offset;
        }
        const latencyTxId = startLatencyTracking(churchId, audioCapturedAt);
        recordLatencyStage(latencyTxId, 'audio_received', { audio_duration_ms: parseFloat(durationMs) });

        // Use streaming session API with LocalAgreement-2 (if available in remote mode)
        // This provides stable transcription output by confirming text only when
        // consecutive transcription passes agree
        if (sendStreamingChunk) {
            // Send chunk to streaming session (Python handles buffering + LocalAgreement)
            recordLatencyStage(latencyTxId, 'whisper_sent');
            const _evalWhisperStart = Date.now();
            const result = await sendStreamingChunk(churchId, samples, sampleRate, isFinal, {
                latencyTxId,
                onRequestCompleted: (completion) => logWhisperRequestCompleted(churchId, completion),
            });
            const _evalWhisperMs = Date.now() - _evalWhisperStart;
            recordLatencyStage(latencyTxId, 'whisper_done');

            if (!isCurrentBroadcasterAudio(ws, clientState, churchId, audioGeneration)) {
                console.log(`[PCM] ${churchId}: Dropping stale Whisper result for audio generation ${audioGeneration}`);
                return;
            }

            console.log(`[DEBUG] 🎤 LocalAgreement result: confirmed=${result.confirmed.length} chars, partial=${result.partial.length} chars, hasNew=${result.hasNew}`);

            // ============================================================
            // SMOOTH MODE PROCESSING (26.01.2026)
            // ============================================================
            // Phase 1: Initial buffer (collect 10s before first output)
            // Phase 2: Streaming with sentence accumulation (min 2 sentences)
            // ============================================================

            // Initialize Smooth Mode state for this church if needed
            if (config.smoothMode.enabled && !state.smoothPhases.has(churchId)) {
                state.smoothPhases.set(churchId, {
                    phase: 'initial_buffer',
                    startTime: Date.now(),
                    totalAudioSec: 0,
                    warmupDone: false  // Warm-up (02.03.2026): first emission uses relaxed thresholds
                });
                state.smoothAccumulators.set(churchId, new SentenceAccumulator({
                    minSentences: config.smoothMode.minSentences,
                    minChars: config.smoothMode.minChars,
                    earlyReleaseMs: config.smoothMode.earlyReleaseMs,
                    maxHoldMs: config.smoothMode.maxHoldMs,
                    catchupMinSentences: config.smoothMode.catchupMinSentences
                }));
                console.log(`[SmoothMode] ${churchId}: Initialized, starting initial_buffer phase`);
            }

            // Initialize Partial Fallback state for this church (11.03.2026)
            if (config.partialFallback.enabled && !state.fallbackState.has(churchId)) {
                ensureFallbackState(churchId);
            }

            // Update total audio time for Smooth Mode phase tracking
            const audioChunkSec = sampleCount / sampleRate;
            if (config.smoothMode.enabled && state.smoothPhases.has(churchId)) {
                const phaseState = state.smoothPhases.get(churchId);
                phaseState.totalAudioSec += audioChunkSec;

                // Check phase transition: initial_buffer -> streaming
                if (phaseState.phase === 'initial_buffer') {
                    const elapsedSec = (Date.now() - phaseState.startTime) / 1000;
                    const progress = Math.min(elapsedSec / config.smoothMode.initialBufferSec, 1.0);

                    // Broadcast buffer progress to listeners
                    broadcastToChurch(churchId, {
                        type: 'smooth_buffer_progress',
                        progress: progress,
                        phase: 'initial_buffer',
                        remainingSec: Math.max(0, config.smoothMode.initialBufferSec - elapsedSec)
                    });

                    if (elapsedSec >= config.smoothMode.initialBufferSec) {
                        phaseState.phase = 'streaming';
                        console.log(`[SmoothMode] ${churchId}: Transition to streaming phase after ${elapsedSec.toFixed(1)}s`);
                        broadcastToChurch(churchId, {
                            type: 'smooth_phase_change',
                            phase: 'streaming'
                        });
                    }
                }

                // Check for catch-up mode (buffer overflow)
                if (phaseState.phase === 'streaming') {
                    const accumulator = state.smoothAccumulators.get(churchId);
                    if (result.bufferDuration && result.bufferDuration > config.smoothMode.catchupThresholdSec) {
                        accumulator.setCatchupMode(true);
                    } else {
                        accumulator.setCatchupMode(false);
                    }
                }
            }

            // Process CONFIRMED text through translation pipeline
            // (LocalAgreement verified = stable, won't change)
            if (result.confirmed && result.hasNew) {
                const confirmedSourceLineage = buildSourceLineage(result.confirmed, result.provenance);
                if (typeof repObserver !== 'undefined') repObserver.observe({
                    stage: 'asr_gateway_ingress',
                    churchId,
                    text: result.confirmed,
                    lineage: confirmedSourceLineage,
                    decodeId: result.provenance?.decodeId ?? null,
                });
                state.stats.whisperTranscriptions++;
                updateWhisperActivity(); // Auto-shutdown tracking
                console.log(`[Whisper] ${churchId} CONFIRMED: ${result.confirmed.length} characters`);
                recordLiveQualityMetric(churchId, {
                    stage: 'whisper',
                    whisper_ms: _evalWhisperMs,
                    latency_ms: _evalWhisperMs,
                });
                logAutopilotShadow(churchId, { source: 'whisper_confirmed' });
                logFlowGovernorShadow(churchId, {
                    text: result.confirmed,
                    stablePrefix: result.confirmed,
                    ageMs: _evalWhisperMs,
                    isFinal,
                    semanticComplete: /[.!?]$/.test(String(result.confirmed).trim()),
                }, { source: 'whisper_confirmed' });
                evalLog({ stage: 'whisper', churchId, latencyTxId: latencyTxId || null, text: result.confirmed, latency_ms: _evalWhisperMs });

                // Reset partial fallback timer — confirmed text arrived (11.03.2026)
                if (config.partialFallback.enabled && state.fallbackState.has(churchId)) {
                    const fb = state.fallbackState.get(churchId);
                    fb.lastConfirmedAt = Date.now();
                    fb.lastFallbackText = '';
                    fb.repairShadowCycles = 0;
                    fb.lastRepairPartial = '';
                    // OPT1a (22.06, r3): new confirmed text => the previously held open tail is stale.
                    // Drop the tracked tail and release the hard-cap clock so it cannot anchor a hold
                    // that no longer corresponds to the current confirmed prefix.
                    clearHeldTail(fb);
                }

                // Notify broadcaster of confirmed transcription (always, regardless of mode)
                ws.send(JSON.stringify({
                    type: 'transcription',
                    text: result.confirmed,
                    language: 'de',
                    isConfirmed: true
                }));

                // ========== SMOOTH MODE vs LEGACY MODE ==========
                if (config.smoothMode.enabled) {
                    const phaseState = state.smoothPhases.get(churchId);
                    const accumulator = state.smoothAccumulators.get(churchId);

                    // In initial_buffer phase: accumulate, try warmup release if thresholds met
                    if (phaseState.phase === 'initial_buffer') {
                        const normalRelease = accumulator.add(result.confirmed, false, confirmedSourceLineage);

                        if (normalRelease) {
                            // Normal thresholds met during initial_buffer — process it
                            if (!phaseState.warmupDone) phaseState.warmupDone = true;
                            console.log(`[WARMUP] ${churchId}: Release during initial_buffer (normal thresholds): ${normalRelease.sentenceCount} sent, ${normalRelease.charCount} chars`);
                            await processCompleteSentence(churchId, normalRelease.text, latencyTxId, { origin: 'smooth_release', releaseReason: 'initial_buffer_normal', sourceLineage: normalRelease.sourceLineage });
                        } else if (!phaseState.warmupDone) {
                            // Normal thresholds not met — try warmup thresholds (1 sentence, 30 chars)
                            const warmupRelease = accumulator._checkRelease(false, {
                                minSentences: config.smoothMode.warmupMinSentences,
                                minChars: config.smoothMode.warmupMinChars
                            });
                            if (warmupRelease) {
                                phaseState.warmupDone = true;
                                console.log(`[WARMUP] ${churchId}: First emission — ${warmupRelease.sentenceCount} sent, ${warmupRelease.charCount} chars, reason: ${warmupRelease.reason}`);
                                await processCompleteSentence(churchId, warmupRelease.text, latencyTxId, { origin: 'warmup_release', releaseReason: 'warmup_first', sourceLineage: warmupRelease.sourceLineage });
                            }
                        }

                        const pending = accumulator.peek();
                        if (pending) {
                            console.log(`[SmoothMode] ${churchId}: Buffering (initial phase): "${pending.substring(0, 50)}..."`);
                        }
                    }
                    // In streaming phase: accumulate and release when threshold met
                    else {
                        const release = accumulator.add(result.confirmed, isFinal, confirmedSourceLineage);

                        if (release) {
                            console.log(`[SmoothMode] ${churchId}: Releasing batch: ${release.sentenceCount} sentences, ${release.charCount} chars`);
                            await processCompleteSentence(churchId, release.text, latencyTxId, { origin: 'smooth_release', releaseReason: 'streaming_batch', sourceLineage: release.sourceLineage });
                        } else {
                            // Show pending text as preview
                            const pending = accumulator.peek();
                            if (pending) {
                                broadcastToChurch(churchId, {
                                    type: 'smooth_pending',
                                    text: pending,
                                    sentenceCount: accumulator.sentences?.length || 0
                                });
                            }
                        }
                    }
                } else {
                    // ========== LEGACY MODE (Smooth Mode disabled) ==========
                    if (!state.sentenceBuffers.has(churchId)) {
                        state.sentenceBuffers.set(churchId, new SentenceBuffer());
                    }
                    const sentenceBuffer = state.sentenceBuffers.get(churchId);

                    const completeSentences = sentenceBuffer.add(result.confirmed, isFinal);
                    console.log(`[DEBUG] 📝 SentenceBuffer returned ${completeSentences.length} complete sentences, isFinal=${isFinal}`);

                    for (const sentence of completeSentences) {
                        console.log(`[DEBUG] Processing sentence (${sentence.text.length} characters)`);
                        await processCompleteSentence(churchId, sentence.text, latencyTxId);
                    }
                }
            }

            // ============================================================
            // PARTIAL FALLBACK (11.03.2026)
            // When LocalAgreement stalls (hasNew=false for too long),
            // emit the latest partial text as "best effort" translation input.
            // Addresses 42% gap problem with Swiss German causing LA instability.
            // ============================================================
            if (config.partialFallback.enabled && !result.hasNew && result.partial) {
                const fb = ensureFallbackState(churchId);
                if (fb) {
                    fb.latestPartial = result.partial || fb.latestPartial || '';
                    fb.latestPartialAt = Date.now();
                    fb.latestStable = result.stable || '';
                    fb.latestLatencyTxId = latencyTxId || fb.latestLatencyTxId || null;
                    fb.latestPartialProvenance = result.partialProvenance || null;
                    fb.latestStableProvenance = result.stableProvenance || null;
                    const phaseState = state.smoothPhases.get(churchId);
                    const nowMs = Date.now();
                    const timeSinceConfirmed = nowMs - fb.lastConfirmedAt;
                    const routeAges = activeListenerRoutes(churchId).map(route => routeDeadlineAgeMs(fb, route.routeKey, nowMs));
                    const timeSinceListenerBound = routeAges.length > 0 ? Math.max(...routeAges) : timeSinceConfirmed;
                    const fallbackAgeMs = config.partialFallback.listenerClockEnabled ? timeSinceListenerBound : timeSinceConfirmed;
                    const flowDecision = logFlowGovernorShadow(churchId, {
                        text: result.partial,
                        stablePrefix: result.confirmed || '',
                        ageMs: fallbackAgeMs,
                        // completenessScore intentionally omitted (18.06, iter 1 cleanup): let
                        // flowGovernor's estimateCompletenessScore run instead of a hardcoded 0.6.
                    }, { source: 'partial_preview' });
                    // Phase 2 part 1 instrumentation (28.06.2026): on this stall path the gateway passes
                    // result.confirmed (the empty delta) as stablePrefix -> flowGovernor sees spw=0 and
                    // force-falls-back. Measure whether the cumulative LA stable prefix EXISTS but is
                    // unexported (-> part 1 apply will fix) vs is truly empty (-> part 2 warm-start).
                    // LOG ONLY — no behavior change yet (stablePrefix above still uses result.confirmed).
                    // Shadow: what flowGovernor WOULD decide if stablePrefix used result.stable — i.e.
                    // would Part 1 apply have fired would_soft_commit_prefix? Pure call (decideFlowGovernor),
                    // NOT logged as a flow_governor_shadow event (avoids polluting that stage's counts).
                    const shadowWithStable = (config.flowGovernor.enabled && result.stable)
                        ? decideFlowGovernor(
                            { text: result.partial, stablePrefix: result.stable, ageMs: timeSinceConfirmed, profile: getFlowGovernorProfile(churchId) },
                            { ...config.flowGovernor, enabled: true })
                        : null;
                    evalLog({
                        stage: 'stable_prefix_probe', churchId,
                        confirmed_delta_len: (result.confirmed || '').length,
                        stable_len: (result.stable || '').length,
                        la_confirmed_word_count: result.laConfirmedWordCount || 0,
                        stable_source: result.stable ? 'whisper_stable' : (result.confirmed ? 'confirmed_delta' : 'empty'),
                        flow_decision: flowDecision?.decision || null,           // current (stablePrefix=confirmed delta)
                        shadow_decision_with_stable: shadowWithStable?.decision || null,  // Part 1 apply preview
                        shadow_reason_with_stable: shadowWithStable?.reason || null,
                        age_ms: timeSinceConfirmed,
                    });
                    const flowGovernorWantsFallback = config.flowGovernor.applyEnabled
                        && (flowDecision?.decision === 'would_force_fallback' || flowDecision?.decision === 'would_micro_emit');

                    // Only fire in streaming phase, after timeout, with enough text
                    if (config.partialFallback.repairShadowEnabled && result.partial && result.partial !== fb.lastRepairPartial) {
                        fb.lastRepairPartial = result.partial;
                        fb.repairShadowCycles = (fb.repairShadowCycles || 0) + 1;
                        const bufferSec = Math.max(0, (result.bufferDurationMs || result.buffer_ms || 0) / 1000);
                        if (fb.repairShadowCycles >= config.partialFallback.repairShadowCycles
                            && fallbackAgeMs >= config.partialFallback.repairShadowBufferSec * 1000
                            && nowMs >= (fb.repairShadowCooldownUntil || 0)) {
                            fb.repairShadowCooldownUntil = nowMs + config.partialFallback.repairShadowCooldownMs;
                            evalLog({ stage: 'a5_3_repair_shadow', churchId, action: 'trigger', n_cycles: fb.repairShadowCycles, buffer_sec: bufferSec || null, x_sec: config.partialFallback.repairShadowBufferSec, cooldown_ms: config.partialFallback.repairShadowCooldownMs, stall_ms: fallbackAgeMs, stall_since_confirm_ms: timeSinceConfirmed, stall_since_listener_bound_ms: timeSinceListenerBound, partial_len: result.partial.length, short_form_only: true, window_cap_sec: 15, fallback_recent: Boolean(fb.lastFallbackAt && nowMs - fb.lastFallbackAt < config.partialFallback.repairShadowCooldownMs) });
                            fb.repairShadowCycles = 0;
                        }
                    }

                    if (phaseState?.phase === 'streaming' &&
                        (fallbackAgeMs > config.partialFallback.timeoutMs || flowGovernorWantsFallback) &&
                        result.partial.length >= config.partialFallback.minPartialLength) {

                        // Jaccard guard: don't re-emit substantially same text
                        const similarity = jaccardSimilarity(result.partial, fb.lastFallbackText);

                        if (similarity < config.partialFallback.similarityThreshold) {
                            qualityTracker.trackFallback(churchId, 'fired', similarity);
                            console.log(`[FALLBACK] ${churchId}: No confirmed text for ${(timeSinceConfirmed / 1000).toFixed(1)}s. ` +
                                `Emitting partial as best-effort (${result.partial.length} chars, sim=${similarity.toFixed(2)})`);
                            recordLiveQualityMetric(churchId, {
                                stage: 'fallback',
                                stall_ms: fallbackAgeMs,
                                pause_ms: fallbackAgeMs,
                                fallback_stall_ms: fallbackAgeMs,
                                stall_since_confirm_ms: timeSinceConfirmed,
                                stall_since_listener_bound_ms: timeSinceListenerBound,
                                listener_clock_enabled: config.partialFallback.listenerClockEnabled,
                            });
                            logAutopilotShadow(churchId, { source: 'partial_fallback' });

                            // Iteration 2 (18.06.2026) - boundary-aware fallback emission, gated by
                            // BOUNDARY_CONFIRMATION_APPLY (default OFF). Trim to the last safe boundary
                            // so we never emit a fragment ending on an open function word; hold the
                            // unsafe tail for a later cycle. Emergency-emit raw past 2x timeout so we
                            // NEVER lose content (addresses the "it skips text" complaint).
                            let fallbackText = result.partial;
                            let bcHold = false;
                            let emissionCompleteness = null;  // Q1b: logging-only tag for E1 metric

                            if (config.noOpenCut.enabled) {
                                // ===== Q1b NO-OPEN-CUT (WIRING) =====
                                // Map the EXISTING governor decision (flowDecision) onto the emission.
                                // The bug was that this path used to flush raw regardless of decision;
                                // here the governor decision actually steers what we emit/hold.
                                const noc = decideNoOpenCutAction({
                                    text: result.partial,
                                    decision: flowDecision,
                                    nowMs: Date.now(),
                                    firstHeldAt: fb.firstHeldAt,
                                    maxHoldMs: config.noOpenCut.maxHoldMs,
                                });
                                emissionCompleteness = noc.emission_completeness;

                                // BUG2 (22.06, r3) - corrected model. The held tail is NOT re-emitted from
                                // here: the ASR growing buffer (whisper_service.py) keeps the un-confirmed
                                // audio and re-transcribes it, so result.partial RE-SURFACES the tail on the
                                // next cycle on its own (an earlier finding). Merging fb.trackedTail back would
                                // DOUBLE-count it (duplicate "X." + "X. and we"). So trackedTail is TRACKED
                                // ONLY (diagnostics/metric); the ASR partial carries the tail. firstHeldAt
                                // still anchors the hard cap for as long as a tail is held.
                                const trackedTail = String(noc.holdText || '').trim();

                                if (noc.action === 'hold') {
                                    bcHold = true;
                                    // Hard cap base: stamp firstHeldAt on the FIRST held tail; never reset per update.
                                    if (fb.firstHeldAt == null) fb.firstHeldAt = Date.now();
                                    // Track (do NOT merge) the open tail. For 'merged'/'merge_to_next'
                                    // noc.holdText carries the tail; for plain 'held' it is '' (the ASR
                                    // partial buffer still holds it and will re-surface it next cycle).
                                    fb.trackedTail = trackedTail || fb.trackedTail || '';
                                    evalLog({ stage: 'fallback_release_policy', churchId, decision: 'hold',
                                        reason: noc.reason, text: result.partial,
                                        tracked_tail: fb.trackedTail,
                                        emission_completeness: noc.emission_completeness,
                                        ...whisperRequestEvidence(churchId) });
                                    console.log(`[NO_OPEN_CUT] ${churchId}: HOLD (${noc.reason}, ${(timeSinceConfirmed / 1000).toFixed(1)}s)`);
                                } else {
                                    fallbackText = noc.emitText;
                                    if (trackedTail) {
                                        // An open tail remains after this emission. The ASR partial will
                                        // re-surface it next cycle; we only TRACK it here. Keep firstHeldAt
                                        // anchored (stamp now if this is the first held tail) so the hard cap
                                        // is measured from the FIRST hold, not reset on a prefix release.
                                        fb.trackedTail = trackedTail;
                                        if (fb.firstHeldAt == null) fb.firstHeldAt = Date.now();
                                    } else {
                                        // OPT1b (22.06, r3): closed/forced_open WITHOUT a remaining tail ->
                                        // the thought is closed. Clear the tracked tail + hard-cap clock so
                                        // they do not hang after the thought ends.
                                        clearHeldTail(fb);
                                    }
                                    if (noc.action === 'emit_prefix_hold' && noc.emitText !== result.partial) {
                                        evalLog({ stage: 'fallback_release_policy', churchId, decision: 'boundary_trim',
                                            emitted: noc.emitText, original: result.partial, tracked_tail: trackedTail,
                                            emission_completeness: noc.emission_completeness });
                                    } else if (noc.action === 'emergency_trim') {
                                        evalLog({ stage: 'fallback_release_policy', churchId, decision: 'boundary_trim',
                                            emitted: noc.emitText, original: result.partial, tracked_tail: trackedTail,
                                            emission_completeness: noc.emission_completeness, hard_cap: true });
                                    } else if (noc.action === 'forced_open') {
                                        evalLog({ stage: 'fallback_release_policy', churchId, decision: 'emergency_flush',
                                            stall_ms: timeSinceConfirmed, text: result.partial,
                                            emission_completeness: noc.emission_completeness, hard_cap: true });
                                        console.log(`[NO_OPEN_CUT] ${churchId}: FORCED_OPEN (hard cap, no safe boundary)`);
                                    }
                                }
                            } else if (config.boundaryConfirmation.applyEnabled) {
                                // ===== LEGACY (OFF): boundary confirmation iteration 2 — UNCHANGED =====
                                const { head } = splitAtSafeBoundary(result.partial);
                                // Fix 18.06: cap extra hold at ~2s (was 2x timeout = up to 10s of hold,
                                // which caused a 20.5s mega-pause). Emit raw quickly when no safe boundary.
                                const emergency = timeSinceConfirmed >= config.partialFallback.timeoutMs + 2000;
                                if (head) {
                                    fallbackText = head;
                                    if (head !== result.partial) {
                                        evalLog({ stage: 'fallback_release_policy', churchId, decision: 'boundary_trim', emitted: head, original: result.partial });
                                    }
                                } else if (emergency) {
                                    evalLog({ stage: 'fallback_release_policy', churchId, decision: 'emergency_flush', stall_ms: timeSinceConfirmed, text: result.partial });
                                } else {
                                    bcHold = true;
                                    evalLog({ stage: 'fallback_release_policy', churchId, decision: 'hold', reason: 'no_safe_boundary', text: result.partial,
                                        ...whisperRequestEvidence(churchId) });
                                    console.log(`[FALLBACK] ${churchId}: APPLY hold - no safe boundary (${(timeSinceConfirmed / 1000).toFixed(1)}s)`);
                                }
                            }

                            if (!bcHold && config.deadlineFallback.provisionalEnabled && config.deadlineFallback.suppressAgeBudget) {
                                // Finding #5 — OPT-IN only (default OFF after the 11.07 cap regression).
                                // When explicitly enabled, the deadline watchdog is the SOLE provisional
                                // emitter: skip the old raw/safe-ish age_budget emission (residual dup
                                // source rel_seq 105) AND do not reset the stall timer / poison B4 history.
                                // WARNING: only safe once the deadline ladder has a bounded emergency rung
                                // (rung 3.5, deadline_emergency_prefix) — otherwise rung-3 skips leave gaps
                                // unfilled and the cap breaks (11.07: 41 skips, 26s pauses).
                                evalLog({ stage: 'fallback_release_policy', churchId, decision: 'suppressed_provisional', text: fallbackText });
                            } else if (!bcHold) {
                                const accumulator = state.smoothAccumulators.get(churchId);
                                if (accumulator) {
                                    // Add (trimmed) fallback text to accumulator, then force flush if no natural release
                                    let release = accumulator.add(fallbackText, false,
                                        buildProjectedSourceLineage(
                                            fb.latestPartial,
                                            fallbackText,
                                            fb.latestPartialProvenance,
                                        ));
                                    if (!release) {
                                        release = accumulator.flush();
                                    }
                                    if (release) {
                                        console.log(`[FALLBACK] ${churchId}: Released ${release.sentenceCount} sent, ${release.charCount} chars`);
                                        // An age-budget publication has no decision record of its
                                        // own (`fallback_release_policy` describes only part of
                                        // the branches), so the evidence goes as a separate event -
                                        // at THE SAME moment, before emission.
                                        evalLog({ stage: 'whisper_request_evidence', churchId,
                                            decision: 'age_budget_fallback',
                                            ...whisperRequestEvidence(churchId, { publication: true }) });
                                        // BUG1 fix (22.06): carry emission_completeness through the emission chain
                                        // (processCompleteSentence -> queue -> translateAndBroadcast ->
                                        //  dispatchIndependent -> translation/broadcast eval records) so D1
                                        //  measures the REAL per-language open-cut exposure (was missing -> the
                                        //  tag never reached translation, partial_emission_rate_pl read ~0).
                                        await fb.repE3Guard.trackPartial({
                                            text: release.text, provenance: fb.latestPartialProvenance,
                                        }, () => processCompleteSentence(churchId, release.text, latencyTxId,
                                            { emissionCompleteness, origin: 'partial_fallback', releaseReason: 'age_budget_fallback', sourceLineage: release.sourceLineage }));
                                    }
                                }

                                fb.lastFallbackText = fallbackText;
                                fb.lastFallbackAt = Date.now();
                                fb.lastConfirmedAt = fb.lastFallbackAt;  // Reset timer — wait another cycle
                                fb.repairShadowCycles = 0;
                                fb.lastRepairPartial = '';

                                // PF->B4 fix (13.04.2026): Add fallback text to B4 history
                                // so next confirmed emission covering same content gets caught by Jaccard
                                const fbWords = fallbackText.toLowerCase()
                                    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
                                    .split(' ').filter(w => w.length >= 2);
                                const fbStems = [...new Set(
                                    fbWords.filter(w => !DE_STOPWORDS.has(stemWord(w)))
                                        .map(w => stemWord(w)).filter(s => s.length > 1)
                                )];
                                // FQF-1 ON: the common processCompleteSentence accepted-enqueue
                                // boundary owns B4 commits. Keep this compatibility write only for
                                // the legacy arm, otherwise a dropped fallback would still poison B4.
                                if (!FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED && fbStems.length >= 3) {
                                    let fbHistory = state.emissionFullHistory.get(churchId);
                                    if (!fbHistory) {
                                        fbHistory = [];
                                        state.emissionFullHistory.set(churchId, fbHistory);
                                    }
                                    // Don't duplicate if same stem-set already in history
                                    const fbSet = new Set(fbStems);
                                    const isDup = fbHistory.some(h => {
                                        if (h.stems.size !== fbSet.size) return false;
                                        for (const s of fbSet) { if (!h.stems.has(s)) return false; }
                                        return true;
                                    });
                                    if (!isDup) {
                                        fbHistory.push({ stems: fbSet, words: fbWords });
                                        if (fbHistory.length > 3) fbHistory.shift();
                                        console.log(`[PF_B4_FIX] ${churchId}: Added fallback to B4 history (${fbStems.length} stems)`);
                                    }
                                }
                            }

                            evalLog({ stage: 'fallback', churchId, text: result.partial,
                                stall_ms: fallbackAgeMs,
                                stall_since_confirm_ms: timeSinceConfirmed,
                                stall_since_listener_bound_ms: timeSinceListenerBound,
                                listener_clock_enabled: config.partialFallback.listenerClockEnabled,
                                similarity,
                                is_speech: result.isSpeech !== false,
                                boundary_quality: (endsWithTerminal(result.partial) && !endsOnOpenWord(result.partial)) ? 'closed' : 'open',
                                flow_governor_decision: flowDecision?.decision || null,
                                flow_governor_reason: flowDecision?.reason || null,
                                flow_governor_apply: config.flowGovernor.applyEnabled,
                                // Q1b no-open-cut: logging-only emission_completeness tag (feeds E1 metric).
                                no_open_cut_enabled: config.noOpenCut.enabled,
                                emission_completeness: emissionCompleteness });
                        } else {
                            qualityTracker.trackFallback(churchId, 'blocked', similarity);
                            evalLog({
                                stage: 'fallback_blocked',
                                churchId,
                                text: result.partial,
                                stall_ms: fallbackAgeMs,
                                stall_since_confirm_ms: timeSinceConfirmed,
                                stall_since_listener_bound_ms: timeSinceListenerBound,
                                similarity,
                                threshold: config.partialFallback.similarityThreshold,
                                partial_len: result.partial.length,
                                last_fallback_len: fb.lastFallbackText.length,
                                flow_governor_decision: flowDecision?.decision || null,
                                flow_governor_reason: flowDecision?.reason || null,
                            });
                        }
                    }
                }
            }

            // ============================================================
            // T6 (30.03.2026): Pause-triggered flush
            // When speaker pauses (VAD isSpeech=false for ~6s = 3 chunks),
            // flush accumulated text immediately — lets translation catch up
            // to the speaker's timing during natural breaks.
            // ============================================================
            if (config.smoothMode.enabled) {
                const phaseState = state.smoothPhases.get(churchId);
                if (phaseState?.phase === 'streaming') {
                    const prevSilence = state.silenceChunks.get(churchId) || 0;

                    if (result.isSpeech === false) {
                        const silenceCount = prevSilence + 1;
                        state.silenceChunks.set(churchId, silenceCount);

                        // 2 consecutive non-speech chunks ≈ 4s pause (tuned 31.03: 3→2 for faster catch-up)
                        if (silenceCount === 2) {
                            const accumulator = state.smoothAccumulators.get(churchId);
                            if (accumulator) {
                                const pauseFlush = accumulator.flush();
                                if (pauseFlush) {
                                    console.log(`[T6_PAUSE] ${churchId}: Speaker pause detected (~${silenceCount * 2}s). Flushing ${pauseFlush.sentenceCount} sentences, ${pauseFlush.charCount} chars`);
                                    await processCompleteSentence(churchId, pauseFlush.text, latencyTxId, { origin: 'pause_flush', releaseReason: 'speaker_pause', sourceLineage: pauseFlush.sourceLineage });
                                }
                            }
                        }
                    } else {
                        if (prevSilence > 0) state.silenceChunks.set(churchId, 0);
                    }
                }
            }

            // Boundary confirmation SHADOW (iteration 1, 18.06.2026): on REAL consecutive
            // partials, check whether the PREVIOUS terminal boundary survived this update.
            // Logged only, no behavior change. Gated by BOUNDARY_CONFIRMATION_SHADOW.
            if (config.boundaryConfirmation.shadowEnabled && result.partial) {
                const fbBc = state.fallbackState.get(churchId);
                const prevPartial = fbBc?.lastPartial || '';
                if (prevPartial && endsWithTerminal(prevPartial)) {
                    const conf = confirmTerminalBoundary({
                        candidate: prevPartial,
                        nextText: result.partial,
                        vadPause: result.isSpeech === false,
                    });
                    evalLog({
                        stage: 'boundary_confirmation_shadow',
                        churchId,
                        candidate: prevPartial,
                        next_text: result.partial,
                        is_speech: result.isSpeech !== false,
                        confirmed: conf.confirmed,
                        reason: conf.reason,
                        candidate_boundary_quality: endsOnOpenWord(prevPartial) ? 'open' : 'closed',
                    });
                }
                if (fbBc) fbBc.lastPartial = result.partial;
            }

            // Send PARTIAL text as preview (may still change)
            if (result.partial) {
                console.log(`[DEBUG] Partial preview available (${result.partial.length} characters)`);
                broadcastToChurch(churchId, { type: 'partial', text: result.partial, language: 'de' });
            }

            if (isFinal && config.holdN.enabled) {
                const heldText = state.holdNEmitters.get(churchId)?.flush();
                if (heldText) {
                    console.log(`[HOLD_N] ${churchId}: final flush ${heldText.length} chars`);
                    await processCompleteSentence(churchId, heldText, latencyTxId, { forceHoldN: true, origin: 'holdn_final_flush', releaseReason: 'final_flush' });
                }
            }
        } else {
            // Fallback to simple transcription (local mode without LocalAgreement)
            const readyBuffer = accumulateAudioPCM(churchId, samples, isFinal);

            if (readyBuffer) {
                console.log(`[Whisper] Transcribing ${readyBuffer.length} PCM samples @ ${sampleRate}Hz for ${churchId}`);
                const result = await transcribeSwissGerman(readyBuffer, { sample_rate: sampleRate });

                if (!isCurrentBroadcasterAudio(ws, clientState, churchId, audioGeneration)) {
                    console.log(`[PCM] ${churchId}: Dropping stale Whisper result for audio generation ${audioGeneration}`);
                    return;
                }

                console.log(`[DEBUG] 🎤 Whisper result for ${churchId}: ${result.text ? `${result.text.length} characters` : 'empty'}`);

                if (result.text) {
                    state.stats.whisperTranscriptions++;
                updateWhisperActivity(); // Auto-shutdown tracking
                    console.log(`[Whisper] ${churchId}: transcription completed (${result.text.length} characters)`);

                    if (!state.sentenceBuffers.has(churchId)) {
                        state.sentenceBuffers.set(churchId, new SentenceBuffer());
                    }
                    const sentenceBuffer = state.sentenceBuffers.get(churchId);
                    const completeSentences = sentenceBuffer.add(result.text, isFinal);

                    for (const sentence of completeSentences) {
                        await processCompleteSentence(churchId, sentence.text);
                    }

                    const pending = sentenceBuffer.peek();
                    if (pending) {
                        broadcastToChurch(churchId, { type: 'partial', text: pending, language: 'de' });
                    }

                    ws.send(JSON.stringify({
                        type: 'transcription',
                        text: result.text,
                        language: 'de'
                    }));
                }
            }
        }
    } catch (error) {
        console.error(`[PCM] Error processing audio for ${churchId}:`, error.message);
        ws.send(JSON.stringify({
            type: 'transcription_error',
            error: 'Audio transcription failed'
        }));
    }
}

// PCM audio accumulation buffer (Phase B)
const pcmAudioBuffers = new Map();  // churchId -> { samples: Float32Array[], totalSamples: number }
const PCM_MIN_SAMPLES = 16000 * 3;  // Minimum 3 seconds of audio at 16kHz

/**
 * Accumulate PCM Float32 samples for a church
 * @param {string} churchId - Church identifier
 * @param {Float32Array} samples - Audio samples
 * @param {boolean} isFinal - Whether this is the final chunk
 * @returns {Float32Array|null} - Combined samples if ready, null if still accumulating
 */
function accumulateAudioPCM(churchId, samples, isFinal) {
    if (!pcmAudioBuffers.has(churchId)) {
        pcmAudioBuffers.set(churchId, { samples: [], totalSamples: 0 });
    }

    const buffer = pcmAudioBuffers.get(churchId);

    // Add samples to buffer
    if (samples.length > 0) {
        buffer.samples.push(samples);
        buffer.totalSamples += samples.length;
    }

    // Check if we have enough audio OR this is the final chunk
    if (buffer.totalSamples >= PCM_MIN_SAMPLES || (isFinal && buffer.totalSamples > 0)) {
        // Combine all samples
        const combined = new Float32Array(buffer.totalSamples);
        let offset = 0;
        for (const chunk of buffer.samples) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        // Clear buffer
        buffer.samples = [];
        buffer.totalSamples = 0;

        if (isFinal) {
            pcmAudioBuffers.delete(churchId);
        }

        console.log(`[PCM] Accumulated ${combined.length} samples for ${churchId}`);
        return combined;
    }

    return null;
}

// B4 (18.02.2026): German stopwords — high frequency, zero semantic value for dedup.
// PRE-STEMMED (4-char truncate) to match stemWord() output.
// "über" removed: too productive a prefix (Überleben, Überzeugung → "über" = false filter).
const DE_STOPWORDS = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des',
    'ein', 'eine', 'eine', 'eine', 'eine',       // einem/einen/einer all stem to "eine"
    'und', 'oder', 'aber', 'auch', 'noch', 'dann',
    'ist', 'war', 'hat', 'sind', 'wird', 'kann',
    'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
    'nich', 'sich', 'mit', 'von', 'auf', 'aus',   // nicht → nich
    'für', 'als', 'dass', 'wie', 'man', 'hier',
    'in', 'an', 'zu', 'so', 'da', 'nun', 'wo',
    'vor', 'nach', 'bei', 'bis', 'nur',           // über removed
    'sehr', 'scho', 'wenn', 'was', 'zum', 'zur',  // schon → scho
    'denn', 'doch', 'mal', 'eben', 'dort', 'imme'  // immer → imme
]);

/**
 * B2 (17.02.2026): Poor man's stemming - truncate words >4 chars to first 4.
 * Handles Whisper variants like "Felsen"/"Felser", "Kirche"/"Kirchen".
 * @param {string} word - Input word
 * @returns {string} Stemmed word (lowercase, 4 chars max)
 */
function stemWord(word) {
    const clean = word.toLowerCase().replace(/[^a-zäöüß]/g, '');
    return clean.length > 4 ? clean.substring(0, 4) : clean;
}

/**
 * B2 (17.02.2026): Remove inter-segment overlap using N-gram stem matching.
 * After buffer trim, Whisper may re-transcribe already-sent content.
 * Compares stemmed words of new text against last sent text.
 * If 4+ consecutive stems match, trims the overlapping prefix.
 *
 * @param {string} newText - New text about to be sent
 * @param {string} lastText - Last 20 words previously sent
 * @returns {string} Text with overlap removed (or original if no overlap)
 */
function removeInterSegmentOverlap(newText, lastText) {
    if (!lastText || !newText) return newText;

    const newWords = newText.split(/\s+/);
    const lastWords = lastText.split(/\s+/);

    if (newWords.length < 4 || lastWords.length < 4) return newText;

    const newStems = newWords.map(stemWord);
    const lastStems = lastWords.map(stemWord);

    // Sliding window: find longest prefix of newStems that matches a suffix of lastStems
    let bestOverlap = 0;

    for (let startInLast = 0; startInLast < lastStems.length; startInLast++) {
        let matchLen = 0;
        for (let j = 0; j < newStems.length && (startInLast + j) < lastStems.length; j++) {
            if (newStems[j] === lastStems[startInLast + j] && newStems[j].length > 0) {
                matchLen++;
            } else {
                break;
            }
        }
        if (matchLen >= 4 && matchLen > bestOverlap) {
            bestOverlap = matchLen;
        }
    }

    if (bestOverlap > 0) {
        const trimmed = newWords.slice(bestOverlap).join(' ');
        console.log(
            `[B2_DEDUP] Trimmed ${bestOverlap} overlapping words from: ` +
            `"${newText.substring(0, 60)}..." → "${trimmed.substring(0, 60)}..."`
        );
        return trimmed;
    }

    return newText;
}

/**
 * P2 (17.02.2026, rewrite: prefix-trim): Cross-emission PREFIX-TRIM dedup.
 *
 * Catch-up pattern: Whisper re-transcribes growing buffer, producing emissions
 * that start with OLD content (already sent) followed by NEW continuation.
 * Instead of skip/emit on whole text, finds the boundary and trims the old prefix.
 *
 * Algorithm:
 *   1. Check each 6-gram against per-church emission history
 *   2. Walk from start — find first run of 4+ consecutive NEW N-grams (= transition)
 *   3. Snap trim point to nearest sentence boundary (.!?) within 5 words
 *   4. Trim old prefix, emit only new suffix
 *
 * @param {string} text - New text about to be sent
 * @param {string} churchId - Church identifier for per-session state
 * @returns {{text: string, action: 'emit'|'warn'|'skip'|'trim'}}
 */
const P2_NGRAM_SIZE = 6;
const P2_HISTORY_CAP = 500;
const splitDedupWords = (text) => String(text || '').split(/\s+/);

function crossEmissionDedup(text, churchId, { deferCommit = false, silent = false } = {}) {
    if (!text) return { text, action: 'emit' };

    const N = P2_NGRAM_SIZE;          // N-gram size (~one German clause)
    const GAP_TOLERANCE = 4;          // consecutive new N-grams = transition to new content
    const MIN_PREFIX_WORDS = 10;      // don't trim tiny overlaps (preserves rhetorical repetition)
    const SENTENCE_SNAP_RANGE = 5;    // look ±5 words for .!? to snap trim point
    const LOW_REPEAT = 0.2;           // below: emit as-is
    const HIGH_REPEAT = 0.7;          // above + no transition: skip (pure dup)

    const words = splitDedupWords(text);
    if (words.length < N) return { text, action: 'emit' };

    const stems = words.map(w => stemWord(w));

    const history = state.emissionNgramHistory.get(churchId) || new Set();
    const finalize = (result) => {
        if (!deferCommit) commitP2History(text, churchId);
        return result;
    };

    // Check each N-gram position against history
    const ngramCount = stems.length - N + 1;
    const matched = new Array(ngramCount);
    let totalMatched = 0;

    for (let i = 0; i < ngramCount; i++) {
        const ngram = stems.slice(i, i + N).join('|');
        matched[i] = history.has(ngram);
        if (matched[i]) totalMatched++;
    }

    if (ngramCount === 0 || totalMatched === 0) {
        return finalize({ text, action: 'emit' });
    }

    const repeatRatio = totalMatched / ngramCount;

    // Low repeat — no catch-up pattern
    if (repeatRatio <= LOW_REPEAT) {
        return finalize({ text, action: 'emit' });
    }

    // --- PREFIX-TRIM: find where old content ends, new begins ---
    let trimWordIdx = -1;
    let consecutiveMisses = 0;

    for (let i = 0; i < ngramCount; i++) {
        if (!matched[i]) {
            consecutiveMisses++;
            if (consecutiveMisses >= GAP_TOLERANCE) {
                trimWordIdx = i - GAP_TOLERANCE + 1;
                break;
            }
        } else {
            consecutiveMisses = 0;
        }
    }

    // Case 1: Transition found — trim prefix if substantial
    if (trimWordIdx >= MIN_PREFIX_WORDS) {
        // Snap to nearest sentence boundary (.!?) to avoid mid-sentence cuts
        let snapIdx = trimWordIdx;
        for (let offset = 0; offset <= SENTENCE_SNAP_RANGE; offset++) {
            const backIdx = trimWordIdx - offset - 1;
            if (backIdx >= 0 && /[.!?]$/.test(words[backIdx])) {
                snapIdx = backIdx + 1;
                break;
            }
            const fwdIdx = trimWordIdx + offset;
            if (fwdIdx > 0 && fwdIdx < words.length && /[.!?]$/.test(words[fwdIdx - 1])) {
                snapIdx = fwdIdx;
                break;
            }
        }
        if (snapIdx >= MIN_PREFIX_WORDS) {
            trimWordIdx = snapIdx;
        }

        const trimmed = words.slice(trimWordIdx).join(' ').trim();
        if (!silent) console.log(
            `[P2_PREFIX_TRIM] ${churchId}: Removed ${trimWordIdx} old words ` +
            `(${(repeatRatio * 100).toFixed(0)}% overall), ` +
            `keeping ${words.length - trimWordIdx}: "${trimmed.substring(0, 80)}..."`
        );
        if (!trimmed || trimmed.length < 3) {
            return finalize({ text: '', action: 'skip' });
        }
        return finalize({ text: trimmed, action: 'trim' });
    }

    // Case 2: No transition (all matched) — pure repeat, skip
    if (trimWordIdx < 0 && repeatRatio > HIGH_REPEAT) {
        if (!silent) console.log(
            `[P2_CROSS_DEDUP] ${churchId}: SKIP (${(repeatRatio * 100).toFixed(0)}% repeat, ` +
            `no new content): "${text.substring(0, 80)}..."`
        );
        return finalize({ text: '', action: 'skip' });
    }

    // Case 3: Small prefix (<10 words) or scattered matches — pass through with warning.
    // Returns 'warn' (not 'emit') so qualityTracker can count how many segments
    // passed "on the edge" (30-70% overlap). The text IS emitted — 'warn' is a
    // diagnostic signal, not a filter action that blocks output.
    if (repeatRatio > 0.3) {
        if (!silent) console.log(
            `[P2_CROSS_DEDUP] ${churchId}: WARN (${(repeatRatio * 100).toFixed(0)}% repeat, ` +
            `passing through): "${text.substring(0, 80)}..."`
        );
        return finalize({ text, action: 'warn' });
    }

    return finalize({ text, action: 'emit' });
}

function commitP2History(text, churchId) {
    const N = P2_NGRAM_SIZE;
    const words = splitDedupWords(text);
    if (words.length < N) return false;

    let history = state.emissionNgramHistory.get(churchId);
    if (!history) {
        history = new Set();
        state.emissionNgramHistory.set(churchId, history);
    }
    _addNgramsToHistory(words.map(w => stemWord(w)), N, history);
    if (history.size > P2_HISTORY_CAP) {
        const entries = [...history];
        state.emissionNgramHistory.set(churchId, new Set(entries.slice(-P2_HISTORY_CAP)));
    }
    return true;
}

/**
 * Helper: add stemmed N-grams from a word list to a Set
 */
function _addNgramsToHistory(stems, n, historySet) {
    for (let i = 0; i <= stems.length - n; i++) {
        historySet.add(stems.slice(i, i + n).join('|'));
    }
}

/**
 * B4 (18.02.2026): Jaccard Overlap Guard — bag-of-words dedup.
 * Pair-coding: Claude Opus (Lead) + Gemini 2.5 Pro (Reviewer), APPROVE.
 *
 * Catches repetitions that sequential N-gram (P2/B2) misses:
 *   A. Number paraphrasing ("400" vs "Vierhundert")
 *   B. Near-exact with punctuation differences
 *   C. Catch-up with word insertion/deletion
 *   D. Fragments followed by full reconstruction
 *   E. Word reordering
 *
 * Uses stemmed content words (stopwords filtered) for Jaccard similarity.
 * Compares each new emission against last 3 stored emissions.
 *
 * @param {string} text - New emission text (post-P2)
 * @param {string} churchId - Church identifier
 * @returns {{text: string, action: 'emit'|'trim'|'skip'}}
 */

/**
 * Jaccard similarity for partial fallback duplicate guard (11.03.2026).
 * Bag-of-words comparison — returns 0..1 (1 = identical word sets).
 */
function jaccardSimilarity(a, b) {
    if (!a || !b) return 0;
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

const B4_HISTORY_SIZE = 3;
const B4_MIN_EMISSION_WORDS = 6;
const B4_MIN_CONTENT_STEMS = 3;
const b4CadencePolicies = new Map();

function getB4CadencePolicy(churchId) {
    let policy = b4CadencePolicies.get(churchId);
    if (!policy) {
        policy = createB4CadencePolicy();
        b4CadencePolicies.set(churchId, policy);
    }
    return policy;
}

function decideB4Cadence(text, churchId, atMs) {
    return getB4CadencePolicy(churchId).decide(text, atMs);
}

function commitB4CadenceHistory(text, churchId, atMs) {
    return getB4CadencePolicy(churchId).commit(text, atMs);
}

function clearB4CadenceHistory(churchId) {
    return b4CadencePolicies.delete(churchId);
}

function jaccardOverlapGuard(text, churchId, { deferCommit = false, silent = false } = {}) {
    if (!text) return { text, action: 'emit' };

    const JACCARD_THRESHOLD = 0.5;
    const MIN_NEW_WORDS = 5;

    const words = splitDedupWords(text);
    if (words.length < B4_MIN_EMISSION_WORDS) return { text, action: 'emit' };

    // Filter stopwords from stem bag — critical for German (stopwords = ~30% of text)
    const stems = words
        .map(w => stemWord(w))
        .filter(s => s.length > 1 && !DE_STOPWORDS.has(s));

    if (stems.length < B4_MIN_CONTENT_STEMS) return { text, action: 'emit' };

    const history = state.emissionFullHistory.get(churchId) || [];
    const finalize = (result) => {
        if (!deferCommit) commitB4History(text, churchId);
        return result;
    };

    if (history.length === 0) {
        return finalize({ text, action: 'emit' });
    }

    const currentBag = new Set(stems);
    let bestJaccard = 0;

    for (let i = 0; i < history.length; i++) {
        const histBag = history[i].stems;
        let intersectionSize = 0;
        for (const s of currentBag) {
            if (histBag.has(s)) intersectionSize++;
        }
        const unionSize = currentBag.size + histBag.size - intersectionSize;
        const jaccard = unionSize > 0 ? intersectionSize / unionSize : 0;

        if (jaccard > bestJaccard) {
            bestJaccard = jaccard;
        }
    }

    if (bestJaccard <= JACCARD_THRESHOLD) {
        return finalize({ text, action: 'emit' });
    }

    // --- OVERLAP DETECTED: find new content ---
    const allHistoryStems = new Set();
    // Legacy parity: before FQF-1 the current candidate was appended, the history
    // capped to 3, then excluded. With a full history that meant the two newest
    // prior emissions, while bestJaccard above still compared all three.
    for (const entry of history.slice(-(B4_HISTORY_SIZE - 1))) {
        for (const s of entry.stems) allHistoryStems.add(s);
    }

    const newRegion = _findNewContentRegion(words, allHistoryStems);

    if (newRegion.newWordCount < MIN_NEW_WORDS) {
        const rhetoricalDecision = protectRhetoricalRepeat({
            text,
            previousText: history[history.length - 1]?.words?.join(' ') || '',
            proposedAction: 'skip',
        });
        if (rhetoricalDecision.rhetoricalRepeat && !silent) {
            evalLog({
                stage: 'b4_rhetorical_repeat_shadow',
                churchId,
                jaccard: bestJaccard,
                new_word_count: newRegion.newWordCount,
                would_preserve: true,
                applied: B4_RHETORICAL_REPEAT_APPLY_ENABLED,
            });
        }
        if (rhetoricalDecision.rhetoricalRepeat && B4_RHETORICAL_REPEAT_APPLY_ENABLED) {
            if (!silent) console.log(
                `[B4_JACCARD] ${churchId}: PRESERVE rhetorical repeat ` +
                `(J=${(bestJaccard * 100).toFixed(0)}%): "${text.substring(0, 80)}..."`
            );
            return finalize(rhetoricalDecision);
        }
        if (rhetoricalDecision.rhetoricalRepeat) {
            if (!silent) console.log(
                `[B4_JACCARD] ${churchId}: SHADOW would preserve rhetorical repeat ` +
                `(J=${(bestJaccard * 100).toFixed(0)}%)`
            );
        }
        if (!silent) console.log(
            `[B4_JACCARD] ${churchId}: SKIP (J=${(bestJaccard * 100).toFixed(0)}%, ` +
            `${newRegion.newWordCount} new words): "${text.substring(0, 80)}..."`
        );
        return finalize({ text: '', action: 'skip', rhetoricalRepeat: rhetoricalDecision.rhetoricalRepeat });
    }

    // Snap to sentence boundary
    let snapIdx = newRegion.start;
    for (let offset = 0; offset <= 3; offset++) {
        const backIdx = newRegion.start - offset - 1;
        if (backIdx >= 0 && /[.!?]$/.test(words[backIdx])) {
            snapIdx = backIdx + 1;
            break;
        }
    }

    const trimmed = words.slice(snapIdx).join(' ').trim();
    if (!silent) console.log(
        `[B4_JACCARD] ${churchId}: TRIM (J=${(bestJaccard * 100).toFixed(0)}%, ` +
        `removed ${snapIdx}/${words.length} words): "${trimmed.substring(0, 80)}..."`
    );

    if (!trimmed || trimmed.length < 3) return finalize({ text: '', action: 'skip' });
    return finalize({ text: trimmed, action: 'trim' });
}

function commitB4History(text, churchId) {
    const words = splitDedupWords(text);
    if (words.length < B4_MIN_EMISSION_WORDS) return false;
    const stems = words
        .map(w => stemWord(w))
        .filter(s => s.length > 1 && !DE_STOPWORDS.has(s));
    if (stems.length < B4_MIN_CONTENT_STEMS) return false;

    let history = state.emissionFullHistory.get(churchId);
    if (!history) {
        history = [];
        state.emissionFullHistory.set(churchId, history);
    }
    history.push({ stems: new Set(stems), words });
    _capEmissionHistory(history, B4_HISTORY_SIZE);
    return true;
}

/**
 * B4 helper: Bidirectional new-content search.
 * Primary: backward from end (catch-up = new content at end).
 * Fallback: forward from start (rare: new prefix + old suffix).
 */
function _findNewContentRegion(words, historyStems) {
    // Backward: find where new content starts (from the end)
    let suffixStart = words.length;
    for (let i = words.length - 1; i >= 0; i--) {
        const stem = stemWord(words[i]);
        if (stem.length <= 1 || DE_STOPWORDS.has(stem)) { suffixStart = i; continue; }
        if (!historyStems.has(stem)) {
            suffixStart = i;
        } else {
            break;
        }
    }
    return { start: suffixStart, newWordCount: words.length - suffixStart };
}

/**
 * B4 helper: Cap emission history array (FIFO).
 */
function _capEmissionHistory(history, maxSize) {
    while (history.length > maxSize) history.shift();
}

/**
 * P3 (17.02.2026): Detect and remove duplicate content within a single text block.
 * Uses sliding window N-gram matching instead of sentence-split approach (replaces R4).
 *
 * Algorithm: Find repeated 6-gram sequences within the same emission.
 * If a 6-gram appears twice (with min distance 12 words apart), remove second occurrence.
 * Stem-based matching (stem4) tolerates Whisper word variants.
 *
 * Improvement over R4: doesn't depend on sentence boundaries (.!?),
 * catches mid-sentence duplicates like "beraubte sich selbst und wurde einem Sklaven gleich"
 * appearing twice within one long emission.
 *
 * @param {string} text - Text that may contain intra-line duplicates
 * @returns {string} Text with duplicate content removed
 */
function deduplicateSentences(text) {
    if (!text) return text;

    const words = text.split(/\s+/);
    const N = 6;
    const MIN_DISTANCE = N * 2; // 12 words between duplicates (avoid removing rhetorical adjacency)

    if (words.length < N * 2) return text; // Too short for meaningful intra-line dups

    const stems = words.map(w => stemWord(w));
    const keep = new Array(words.length).fill(true);

    // Find first occurrence of each N-gram
    const firstOccurrence = new Map(); // ngram → start index

    for (let i = 0; i <= stems.length - N; i++) {
        const ngram = stems.slice(i, i + N).join('|');

        if (firstOccurrence.has(ngram)) {
            const firstIdx = firstOccurrence.get(ngram);

            // Min distance check: don't remove if too close (may be rhetorical repetition)
            if (i >= firstIdx + MIN_DISTANCE) {
                // Expand the duplicate region forward: how many more consecutive words match?
                let dupEnd = i + N;
                while (dupEnd < stems.length &&
                       (firstIdx + (dupEnd - i)) < stems.length &&
                       stems[dupEnd] === stems[firstIdx + (dupEnd - i)]) {
                    dupEnd++;
                }

                // Mark second occurrence as duplicate
                for (let j = i; j < dupEnd; j++) {
                    keep[j] = false;
                }

                const removedFragment = words.slice(i, Math.min(i + 10, dupEnd)).join(' ');
                console.log(
                    `[P3_DEDUP] Intra-line duplicate at word ${i} (first at ${firstIdx}, ` +
                    `${dupEnd - i} words): "${removedFragment}..."`
                );

                // Skip ahead past the duplicate region
                i = dupEnd - 1;
            }
        } else {
            firstOccurrence.set(ngram, i);
        }
    }

    const result = words.filter((_, i) => keep[i]).join(' ').trim();

    // Safety: if too much was removed, keep original
    if (result.length < text.length * 0.3) {
        console.log(`[P3_DEDUP] Safety: removed >70% of text — keeping original`);
        return text;
    }

    return result || text;
}

/**
 * Process a complete sentence through the translation pipeline (Phase 6)
 * @param {string} churchId - Church identifier
 * @param {string} text - Complete sentence text
 * @param {string} latencyTxId - Latency tracking transaction ID (optional)
 */
async function processCompleteSentence(churchId, text, latencyTxId = null, options = {}) {
    console.log(`[STT] ${churchId}: processing ${text.length} characters`);
    const sourceReleaseText = text;
    const sourceReleaseLineage = FQF_SOURCE_LINEAGE_ENABLED
        || (typeof REP_SHADOW_ENABLED !== 'undefined' && REP_SHADOW_ENABLED)
        ? (options.sourceLineage || missingSourceLineage('process_entry_unscoped'))
        : null;
    // Audit the source release BEFORE any filter mutates it (shadow).
    let releaseMeta = logSourceReleaseAudit(churchId, text, options.origin, options.releaseReason, options);
    if (typeof repObserver !== 'undefined') repObserver.observe({
        stage: 'asr_smooth_release',
        churchId,
        text,
        lineage: sourceReleaseLineage,
        releaseMeta,
    });
    const releaseOriginalWordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    const trimEvents = [];
    const logSourceReleaseOutcome = (outcome, blockStage = null, extra = {}) => {
        const projectedLineage = sourceReleaseLineage
            ? projectSourceLineage(sourceReleaseText, text, sourceReleaseLineage)
            : null;
        if (typeof repObserver !== 'undefined') repObserver.observe({
            stage: 'source_release_outcome',
            churchId,
            text,
            lineage: projectedLineage,
            releaseMeta,
            outcome,
            blockStage,
            filterDecisions: trimEvents.map((event) => event.stage),
        });
        evalLog({ stage: 'source_release_outcome', churchId, ...releaseIdentityFields(releaseMeta), outcome, block_stage: blockStage, origin: releaseMeta?.origin ?? options.origin ?? null, release_reason: releaseMeta?.releaseReason ?? options.releaseReason ?? null, source_len: releaseMeta?.sourceLen ?? String(text || '').length, ...extra });
    };

    // ---- Refined A2.7 (10.07.2026): server-side supersede of finals vs CUMULATIVE emitted span ----
    // A non-deadline release ("final") that only repeats content already emitted provisionally
    // by the deadline watchdog is the partial+final duplication T5/B4 miss (overlap < 0.85).
    // Match by SOURCE SPAN (normalized-word prefix) against the CUMULATIVE span emitted this
    // starvation run (finding #2 fix — per-payload ledger let a later provisional replay), not
    // release_seq: suppress a pure repeat, emit only the new tail, pass real corrections.
    if (config.deadlineFallback.provisionalEnabled && options.origin !== 'deadline_fallback') {
        const fbSup = state.fallbackState.get(churchId);
        if (fbSup) {
            const reviewFixes = config.deadlineFallback.reviewFixesEnabled;
            const nowSup = Date.now();
            if (reviewFixes) {
                // Staleness: a span that never closed with a real emission must not supersede a much
                // later unrelated final. Drop the baseline if the last provisional is older than TTL.
                // reviewFixes-only: 4.52 has no whole-span stale-clear (it expires per ledger entry
                // inside supersedeDecisionBaseline, and lastDeadlineEmitAt does not exist there).
                if (fbSup.lastDeadlineEmitAt && (nowSup - fbSup.lastDeadlineEmitAt) > config.deadlineFallback.supersedeTtlMs) {
                    fbSup.emittedSourceNorm = [];
                    fbSup.deadlineLedger = [];
                }
            }
            // Which state gates the attempt differs per arm: reviewFixes matches the cumulative
            // span, baseline matches per-entry ledger records.
            const hasBaselineToMatch = reviewFixes
                ? (Array.isArray(fbSup.emittedSourceNorm) && fbSup.emittedSourceNorm.length > 0)
                : (Array.isArray(fbSup.deadlineLedger) && fbSup.deadlineLedger.length > 0);
            if (hasBaselineToMatch) {
                const decision = supersedeDecisionFor({
                    reviewFixes,
                    finalText: text,
                    // reviewFixes arm reads these:
                    emittedNorm: fbSup.emittedSourceNorm,
                    minEmitTailWords: config.deadlineFallback.minEmitTailWords,
                    // baseline arm reads these:
                    ledger: fbSup.deadlineLedger,
                    now: nowSup,
                    ttlMs: config.deadlineFallback.supersedeTtlMs,
                    // both:
                    minWords: config.deadlineFallback.minDeltaWords,
                });
                if (decision.action === 'suppress') {
                    // Baseline marks the winning entry; the cumulative arm has no per-entry state.
                    if (decision.entry) decision.entry.superseded = true;
                    evalLog({ stage: 'deadline_supersede', churchId, action: 'suppress', provisional_final_replay: 1, covered_words: decision.coveredWords ?? null, tail_words: decision.tailWords ?? null, source_hash: releaseMeta?.sourceHash ?? null });
                    logSourceReleaseOutcome('blocked_pre_queue', 'deadline_supersede', { reason: 'provisional_final_replay' });
                    if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
                    // Baseline consumed by the provisional; the real final closed the span.
                    fbSup.emittedSourceNorm = [];
                    if (reviewFixes) fbSup.deadlineLedger = [];
                    return;
                }
                if (decision.action === 'emit_tail' && decision.text) {
                    if (decision.entry) decision.entry.superseded = true;
                    evalLog({ stage: 'deadline_supersede', churchId, action: 'emit_tail', provisional_final_replay: 0, covered_words: decision.coveredWords ?? null, tail_words: decision.tailWords ?? null });
                    text = decision.text;
                }
            }
            // New real source release ends the current starvation span -> reset the delta baseline
            // so the next deadline computes its stable-delta from scratch (never re-emits old head).
            // 4.52 resets ONLY emittedSourceNorm here and lets deadlineLedger age out by TTL
            // (per-entry) - wiping the ledger is a reviewFixes behavior.
            fbSup.emittedSourceNorm = [];
            if (reviewFixes) fbSup.deadlineLedger = [];
        }
    }

    qualityTracker.resetPendingFilters(churchId);
    qualityTracker.trackDEInput(churchId);

    // B1 (17.02.2026): Sanity gate - reject text with low alphabetic ratio
    // Catches guillemet/number hallucinations that slip through Python filters
    const alphaChars = (text.match(/[a-zA-ZäöüÄÖÜß]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    const alphaRatio = totalChars > 0 ? alphaChars / totalChars : 0;
    if (alphaRatio < 0.4 && totalChars > 10) {
        console.log(`[B1_SANITY] ${churchId}: REJECTED low alpha ratio ${alphaRatio.toFixed(2)} (${text.length} characters)`);
        qualityTracker.trackFilterAction(churchId, 'B1', 'reject');
        qualityTracker.trackPipelineBlock(churchId, 'B1', `alpha=${alphaRatio.toFixed(2)}`);
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }
    qualityTracker.trackFilterAction(churchId, 'B1', 'pass');

    // FIX (22.01.2026): Skip fragments that don't end with punctuation
    // This prevents unnatural TTS output ending with "i", "lub", etc.
    // Exception: Very long fragments (>100 chars) are processed anyway to avoid infinite buffering
    const endsWithPunctuation = /[.!?]$/.test(text.trim());
    if (!endsWithPunctuation && text.trim().length < 50) {
        console.log(`[STT] ${churchId}: SKIPPING ${text.length}-character fragment without punctuation`);
        qualityTracker.trackFilterAction(churchId, 'punctGate', 'hold');
        qualityTracker.trackPipelineBlock(churchId, 'punctGate', `len=${text.trim().length}`);
        logSourceReleaseOutcome('blocked_pre_queue', 'punctGate', { reason: `len=${text.trim().length}` });
        if (latencyTxId) {
            completeWhisperOnlyTracking(latencyTxId);
        }
        return;
    }
    qualityTracker.trackFilterAction(churchId, 'punctGate', 'pass');

    // P2 (17.02.2026): Cross-emission semantic dedup — check against recent emission history
    // Must run BEFORE B2 (which only checks last 20 words)
    const deferDedupHistoryCommit = FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED;
    const p2HistoryCandidate = text;
    const crossResult = crossEmissionDedup(text, churchId, { deferCommit: deferDedupHistoryCommit });
    qualityTracker.trackFilterAction(churchId, 'P2', crossResult.action);
    if (crossResult.action === 'skip') {
        console.log(`[P2_CROSS_DEDUP] ${churchId}: Entire text was cross-emission repeat — skipping`);
        qualityTracker.trackPipelineBlock(churchId, 'P2', 'cross-emission repeat');
        logSourceReleaseOutcome('blocked_pre_queue', 'P2', { reason: 'cross-emission repeat' });
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }
    text = crossResult.text;
    if (!text || text.trim().length < 3) {
        logSourceReleaseOutcome('blocked_pre_queue', 'empty_or_too_short');
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }

    // Project B (B3.2): Path C semantic dedup — drop current if P1 correction
    // Placement: after P2 (N-gram), before JOG (bag-of-words). Mutually exclusive Jaccard ranges.
    if (config.holdN.enabled) {
        let emitter = state.holdNEmitters.get(churchId);
        if (!emitter) {
            emitter = createHoldNEmitter(config.holdN);
            state.holdNEmitters.set(churchId, emitter);
        }

        const holdResult = emitter.apply(text, { force: options.forceHoldN === true });
        evalLog({
            stage: 'hold_n',
            churchId,
            enabled: true,
            hold_words: config.holdN.words,
            emitted_chars: holdResult.emitText.length,
            held_words: holdResult.heldWords,
            held_chars: holdResult.heldText.length,
        });

        if (!holdResult.emitText) {
            console.log(`[HOLD_N] ${churchId}: holding ${holdResult.heldWords} words, no emission yet`);
            qualityTracker.trackFilterAction(churchId, 'HOLD_N', 'hold');
            if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
            return;
        }

        text = holdResult.emitText;
        qualityTracker.trackFilterAction(churchId, 'HOLD_N', 'emit');
        console.log(`[HOLD_N] ${churchId}: emitting ${text.length} chars, holding ${holdResult.heldWords} words`);
    }

    if (HG_DEDUP_ENABLED && hgDedupService) {
        try {
            const dedupDecision = await hgDedupService.process(churchId, {
                id: state.stats.whisperTranscriptions,
                text,
                timestamp: Date.now(),
            });
            if (dedupDecision.action === 'drop') {
                console.log(`[HG_DEDUP] ${churchId}: DROP (P1 correction, sim=${dedupDecision.similarity?.toFixed(2)})`);
                qualityTracker.trackPipelineBlock(churchId, 'HG_DEDUP', 'P1 correction');
                if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
                return;
            }
        } catch (err) {
            console.warn(`[HG_DEDUP] ${churchId}: Embedding failed, fallback translate: ${err.message}`);
            evalLog({ stage: 'hg_dedup', churchId, action: 'fallback_translate', reason: 'embedding_error', error: err.message });
        }
    }

    // JOG (18.02.2026): Jaccard overlap guard — bag-of-words dedup for paraphrased repetitions
    // B4-CTX (02.03.2026): Preserve trimmed prefix as source context for translation
    const preB4Text = text;
    const b4HistoryCandidate = text;
    const legacyB4Result = jaccardOverlapGuard(text, churchId, { deferCommit: deferDedupHistoryCommit });
    const b4CadenceAtMs = Date.now();
    const b4CadenceActive = B4_CADENCE_V2_SHADOW_ENABLED || B4_CADENCE_V2_APPLY_ENABLED;
    const b4CadenceResult = b4CadenceActive
        ? decideB4Cadence(text, churchId, b4CadenceAtMs)
        : null;
    if (b4CadenceResult && !deferDedupHistoryCommit && b4CadenceResult.action !== 'skip') {
        commitB4CadenceHistory(b4CadenceResult.text, churchId, b4CadenceAtMs);
    }
    const jaccardResult = B4_CADENCE_V2_APPLY_ENABLED ? b4CadenceResult : legacyB4Result;
    if (b4CadenceActive) {
        evalLog({
            stage: 'b4_cadence_v2_shadow',
            churchId,
            ...releaseIdentityFields(releaseMeta),
            legacy_action: legacyB4Result.action,
            candidate_action: b4CadenceResult.action,
            candidate_reason: b4CadenceResult.reason,
            candidate_removed_words: b4CadenceResult.removedWords ?? 0,
            candidate_best_prefix_words: b4CadenceResult.bestPrefix ?? 0,
            candidate_non_prefix_safe: b4CadenceResult.nonPrefixSafe === true,
            policy_applied: B4_CADENCE_V2_APPLY_ENABLED,
            history_max_age_ms: getB4CadencePolicy(churchId).config.maxAgeMs,
            history_size: getB4CadencePolicy(churchId).config.historySize,
        });
    }
    if (typeof B4_REPLAY_CAPTURE_ENABLED !== 'undefined' && B4_REPLAY_CAPTURE_ENABLED) {
        const projectedB4Lineage = sourceReleaseLineage
            ? projectSourceLineage(sourceReleaseText, preB4Text, sourceReleaseLineage)
            : null;
        evalLog({
            stage: 'b4_replay_capture',
            churchId,
            ...releaseIdentityFields(releaseMeta),
            origin: releaseMeta?.origin ?? options.origin ?? null,
            release_reason: releaseMeta?.releaseReason ?? options.releaseReason ?? null,
            source_text: sourceReleaseText,
            p2_input_text: p2HistoryCandidate,
            p2_action: crossResult.action,
            b4_input_text: preB4Text,
            b4_action: jaccardResult.action,
            b4_output_text: jaccardResult.text,
            b4_legacy_action: legacyB4Result.action,
            b4_cadence_v2_action: b4CadenceResult?.action ?? null,
            b4_cadence_v2_reason: b4CadenceResult?.reason ?? null,
            b4_cadence_v2_applied: B4_CADENCE_V2_APPLY_ENABLED,
            source_lineage: projectedB4Lineage ? {
                status: projectedB4Lineage.status ?? null,
                reason: projectedB4Lineage.reason ?? null,
                logicalChunkIds: Array.isArray(projectedB4Lineage.logicalChunkIds)
                    ? [...projectedB4Lineage.logicalChunkIds]
                    : [],
                wordCount: projectedB4Lineage.wordCount ?? null,
                wordSpans: Array.isArray(projectedB4Lineage.wordSpans)
                    ? projectedB4Lineage.wordSpans.map((span) => ({ ...span }))
                    : [],
            } : null,
        });
    }
    qualityTracker.trackFilterAction(churchId, 'B4', jaccardResult.action);
    if (jaccardResult.action === 'trim') {
        trimEvents.push({
            stage: 'B4',
            before_words: preB4Text.split(/\s+/).filter(Boolean).length,
            after_words: String(jaccardResult.text || '').split(/\s+/).filter(Boolean).length,
        });
    }
    if (jaccardResult.action === 'skip') {
        const reason = B4_CADENCE_V2_APPLY_ENABLED
            ? `cadence_v2:${jaccardResult.reason}`
            : 'jaccard overlap';
        qualityTracker.trackPipelineBlock(churchId, 'B4', reason);
        logSourceReleaseOutcome('blocked_pre_queue', 'B4', { reason });
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }
    text = jaccardResult.text;
    if (!text || text.trim().length < 3) {
        logSourceReleaseOutcome('blocked_pre_queue', 'B4', { reason: 'empty after trim' });
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }

    // B4-CTX: Extract trimmed prefix as DE source context for translation
    // B4 correctly removes duplicate prefix from DE output, but GPT-4.1-mini needs
    // that context for accurate theological translation (e.g., Philipper 2,6-7 → kenosis)
    let b4SourceContext = null;
    if (jaccardResult.action === 'trim' && preB4Text !== text) {
        let prefix = jaccardResult.contextText
            || (jaccardResult.nonPrefixSafe
                ? ''
                : preB4Text.slice(0, preB4Text.length - text.length).trim());
        // Limit to 200 words (closest to suffix = most relevant context)
        const prefixWords = prefix.split(/\s+/);
        if (prefixWords.length > 200) {
            prefix = prefixWords.slice(-200).join(' ');
        }
        b4SourceContext = prefix || null;
        if (b4SourceContext) {
            console.log(`[B4_CTX] ${churchId}: Preserved ${prefixWords.length} words trimmed prefix as translation context`);
        }
    }

    // B2 (17.02.2026): Inter-segment dedup - remove overlapping prefix
    const lastSent = state.lastSentTexts.get(churchId) || '';
    if (lastSent) {
        const preB2 = text;
        text = removeInterSegmentOverlap(text, lastSent);
        qualityTracker.trackFilterAction(churchId, 'B2', text !== preB2 ? 'trim' : 'emit');
        if (!text || text.trim().length < 3) {
            console.log(`[B2_DEDUP] ${churchId}: Entire text was overlap — skipping`);
            qualityTracker.trackPipelineBlock(churchId, 'B2', 'entire overlap');
            logSourceReleaseOutcome('blocked_pre_queue', 'B2', { reason: 'entire overlap' });
            if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
            return;
        }
    } else {
        qualityTracker.trackFilterAction(churchId, 'B2', 'emit');
    }

    // P3 (17.02.2026): Intra-line N-gram dedup — remove duplicate content within text
    const preP3 = text;
    text = deduplicateSentences(text);
    if (text !== preP3) {
        trimEvents.push({
            stage: 'P3',
            before_words: preP3.split(/\s+/).filter(Boolean).length,
            after_words: String(text || '').split(/\s+/).filter(Boolean).length,
        });
    }
    qualityTracker.trackFilterAction(churchId, 'P3', text !== preP3 ? 'trim' : 'emit');
    if (!text || text.trim().length < 3) {
        console.log(`[P3_DEDUP] ${churchId}: Text empty after intra-line dedup — skipping`);
        qualityTracker.trackPipelineBlock(churchId, 'P3', 'empty after dedup');
        logSourceReleaseOutcome('blocked_pre_queue', 'P3', { reason: 'empty after dedup' });
        if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
        return;
    }

    // INTRA (28.05.2026): SmoothMode can batch P1 corrections inside one emission.
    // This pass trims only conservative local correction patterns before GPT/TTS.
    const preIntra = text;
    const intraResult = await cleanupIntraEmissionAsync(text, INTRA_EMISSION_DEDUP_CONFIG, {
        embedFn: embedTextForDedup,
    });
    if (intraResult.blocked) {
        qualityTracker.trackFilterAction(churchId, 'INTRA', 'blocked');
    } else {
        qualityTracker.trackFilterAction(churchId, 'INTRA', intraResult.action === 'trim' ? 'trim' : 'emit');
    }
    if (INTRA_EMISSION_DEDUP_CONFIG.semanticEnabled) {
        const sem = intraResult.semanticSummary || { trimCandidates: 0, blocked: 0, dryRun: INTRA_EMISSION_DEDUP_CONFIG.semanticDryRun };
        if (sem.dryRun && sem.trimCandidates > 0) {
            qualityTracker.trackFilterAction(churchId, 'INTRA_SEM', 'dry_run');
        } else if (intraResult.action === 'trim' && intraResult.decisions.some(d => d.reason === 'semantic_correction')) {
            qualityTracker.trackFilterAction(churchId, 'INTRA_SEM', 'trim');
        } else if (sem.blocked > 0) {
            qualityTracker.trackFilterAction(churchId, 'INTRA_SEM', 'blocked');
        } else {
            qualityTracker.trackFilterAction(churchId, 'INTRA_SEM', 'emit');
        }
    }
    if (intraResult.action === 'trim') {
        trimEvents.push({ stage: 'INTRA', before_words: preIntra.split(/\s+/).filter(Boolean).length, after_words: String(intraResult.text || '').split(/\s+/).filter(Boolean).length });
        const collapsedUnits = intraResult.collapsedUnits || 0;
        console.log(`[INTRA_DEDUP] ${churchId}: removed ${intraResult.removedUnits.length} unit(s) + ${collapsedUnits} internal-repeat collapse(s), removal_ratio=${intraResult.removalRatio.toFixed(3)}`);
        evalLog({
            stage: 'intra_emission_dedup',
            churchId,
            action: 'trim',
            removed_units: intraResult.removedUnits.length,
            // Collapse-only trims (id 42/80) drop no whole unit, so surface the
            // internal-repeat removals explicitly or the scorecard sees an empty diff.
            collapsed_internal: Boolean(intraResult.collapsedInternal),
            collapsed_units: collapsedUnits,
            removed_fragments: (intraResult.removedFragments || []).map(f => String(f).slice(0, 160)).slice(0, 5),
            removal_ratio: Number(intraResult.removalRatio.toFixed(4)),
            decisions: intraResult.decisions.filter(d => d.action !== 'keep').slice(0, 5),
        });
        text = intraResult.text;
    } else if (INTRA_EMISSION_DEDUP_CONFIG.semanticEnabled && intraResult.semanticSummary?.trimCandidates > 0) {
        evalLog({
            stage: 'intra_emission_dedup',
            churchId,
            action: 'semantic_dry_run',
            trim_candidates: intraResult.semanticSummary.trimCandidates,
            blocked: intraResult.semanticSummary.blocked,
            decisions: intraResult.decisions.filter(d => d.reason === 'semantic_correction' || d.action === 'blocked').slice(0, 5),
        });
    } else if (intraResult.blocked) {
        evalLog({
            stage: 'intra_emission_dedup',
            churchId,
            action: 'blocked',
            reason: intraResult.reason,
            removed_units: intraResult.removedUnits.length,
            removal_ratio: Number((intraResult.removalRatio || 0).toFixed(4)),
        });
    }

    if (typeof repObserver !== 'undefined') repObserver.observe({
        stage: 'asr_source_filter_output',
        churchId,
        text,
        lineage: sourceReleaseLineage
            ? projectSourceLineage(sourceReleaseText, text, sourceReleaseLineage)
            : null,
        releaseMeta,
        filterDecisions: trimEvents.map((event) => event.stage),
    });

    // P2.7 (05.08.2026): pre-policy reference for the R denominator.
    // Emitted for EVERY post-filter release — regardless of shadow/apply decisions, active
    // languages, or downstream blocks. `translation.src` cannot serve as R: it is logged
    // AFTER T5 (translationDispatch.js:112) and after age/controller drops, so anything they
    // block silently vanishes from the denominator. A denominator that shrinks together with
    // the policy is exactly the self-improving-metric trap EC-4 exposed.
    const activeLanguages = getActiveLanguages(churchId);
    // Use the shadow's NORMALIZED config, never the raw env map: the env map carries only
    // the tunables that have env vars, so `minUnitWords`/`minUnitContentTokens` would be
    // undefined, every `words >= undefined` comparison would be false, and EVERY unit would
    // come out `scorable: false` — a shadow that silently measures nothing.
    const sourceUnits = buildSourceUnits({
        sessionEpoch: releaseMeta?.sessionEpoch ?? null,
        releaseSeq: releaseMeta?.releaseSeq ?? null,
        text,
    }, sourceSemanticRepeatShadow.config);
    evalLog({
        stage: 'source_semantic_reference',
        churchId,
        session_epoch: releaseMeta?.sessionEpoch ?? null,
        release_seq: releaseMeta?.releaseSeq ?? null,
        source_hash: releaseMeta?.sourceHash ?? null,
        origin: releaseMeta?.origin ?? options.origin ?? null,
        release_reason: releaseMeta?.releaseReason ?? options.releaseReason ?? null,
        policy_stage: 'post_source_filters_pre_p27_pre_t5_pre_fanout',
        policy_applied: false,
        active_languages: activeLanguages.length,
        unit_count: sourceUnits.length,
        scorable_unit_count: sourceUnits.filter((unit) => unit.scorable).length,
        units: sourceUnits.map((unit) => ({
            source_unit_id: unit.source_unit_id,
            unit_index: unit.unit_index,
            text: unit.text,
            words: unit.words,
            content_tokens: unit.content_tokens,
            closed: unit.closed,
            full_unit: unit.full_unit,
            scorable: unit.scorable,
        })),
    });

    // APPLY must not let a loser that never reaches the translation queue poison
    // B2's immediate history. OFF preserves the original synchronous update.
    const commitLastSentText = () => {
        const allWords = text.split(/\s+/);
        state.lastSentTexts.set(churchId, allWords.slice(-20).join(' '));
    };
    if (!FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) commitLastSentText();

    // DEBUG: Log subscription state
    const subs = state.subscriptions.get(churchId);
    if (!subs) {
        console.log(`[DEBUG] ⚠️ No subscriptions Map for churchId: ${churchId}`);
        console.log(`[DEBUG] Available churchIds in subscriptions:`, [...state.subscriptions.keys()]);
    } else {
        console.log(`[DEBUG] Subscriptions for ${churchId}:`, [...subs.entries()].map(([lang, clients]) => `${lang}:${clients.size}`).join(', ') || 'EMPTY');
    }

    broadcastToChurch(churchId, { type: 'recognized', text, language: 'de' });
    state.stats.sentencesProcessed++;

    // Active languages resolved above (needed by the P2.7 reference record).
    console.log(`[DEBUG] Active languages for ${churchId}: [${activeLanguages.join(', ')}] (count: ${activeLanguages.length})`);

    if (activeLanguages.length > 0) {
        // Sermon Preparation Context (02.03.2026): proactive topic priming
        const sermonCtx = state.sermonContext.get(churchId)?.text || null;

        // R1.4: Enqueue for background GPT worker instead of blocking Whisper
        const queue = getOrCreateTranslationQueue(churchId);
        const coordinatorReadyAtMs = Date.now();
        const enqueueAfterCoordinator = (coordinatorDecision) => {
            if (coordinatorDecision.action === 'drop') {
                qualityTracker.trackFilterAction(churchId, 'FQF2', 'skip');
                qualityTracker.trackPipelineBlock(churchId, 'FQF2', coordinatorDecision.reason);
                logSourceReleaseOutcome('blocked_pre_queue', 'fallback_coordinator', {
                    reason: coordinatorDecision.reason,
                });
                if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
                return { acceptedForTranslation: false, coordinatorDecision };
            }
            if (latencyTxId) {
                recordLatencyStage(latencyTxId, 'queue_entered', { queue_depth: queue.depth });
            }
            logEmissionDecision(evalLog, {
                churchId,
                decision: 'hold',
                reason: 'queued_for_translation',
                ageMs: 0,
                queueDepth: queue.depth,
                source: 'translation_queue',
                latencyTxId,
            });
            logEmissionControllerShadow({
                churchId,
                source: 'translation_queue',
                runtimeDecision: 'hold',
                sessionEpoch: releaseMeta?.sessionEpoch,
                releaseSeq: releaseMeta?.releaseSeq,
                origin: releaseMeta?.origin ?? options.origin ?? null,
                signals: {
                    ageMs: 0,
                    queueDepth: queue.depth,
                    asrStable: true,
                    semanticComplete: true,
                    providerHealthy: areProvidersHealthyForEmission(isTtsEnabled()),
                    ttsEnabled: isTtsEnabled(),
                    activeLanguages: activeLanguages.length,
                    activeGenders: 0,
                },
            });
            // Stamp only the post-filter text that truly reaches the translation queue.
            // The original source_hash remains the pre-filter audit identity.
            releaseMeta = stampEmittedSourceIdentity(releaseMeta, text);
            releaseMeta = {
                ...releaseMeta,
                sourceLineageEnabled: FQF_SOURCE_LINEAGE_ENABLED,
                sourceLineage: FQF_SOURCE_LINEAGE_ENABLED
                    ? projectSourceLineage(sourceReleaseText, text, sourceReleaseLineage)
                    : null,
                safeSourceBoundaryWordIndexes: safeSourceBoundaryWordIndexes(
                    sourceUnits,
                    sourceWordCount(text),
                ),
            };
            if (FQF_SOURCE_LINEAGE_ENABLED) {
                evalLog({
                    stage: 'source_lineage_transport',
                    phase: 'accepted_enqueue',
                    churchId,
                    ...releaseIdentityFields(releaseMeta),
                    ...sourceLineageFields(releaseMeta),
                });
            }
            const finalWordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length;
            const logAcceptedSourceOutcome = () => {
                if (trimEvents.length > 0) {
                    logSourceReleaseOutcome('trimmed_emitted', null, {
                        languages: activeLanguages,
                        trim_ratio: releaseOriginalWordCount > 0 ? Number(((releaseOriginalWordCount - finalWordCount) / releaseOriginalWordCount).toFixed(4)) : 0,
                        trim_events: trimEvents,
                        final_words: finalWordCount,
                    });
                } else {
                    logSourceReleaseOutcome('queued', null, {
                        languages: activeLanguages,
                        final_words: finalWordCount,
                    });
                }
            };
            if (!FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) logAcceptedSourceOutcome();
            const queueItem = {
                churchId,
                text,
                languages: activeLanguages,
                latencyTxId,
                sourceContext: b4SourceContext,
                sermonContext: sermonCtx,
                createdAt: FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED
                    ? coordinatorReadyAtMs
                    : Date.now(),
            // P-B: carry drain identity so translation/broadcast eval records are tagged.
                drainMeta: (options && options.source === 'disconnect_drain')
                    ? { drainId: options.drainId, tailItemId: options.tailItemId } : null,
            // Q1b BUG1: carry no-open-cut completeness tag so translation/broadcast eval
            // records carry emission_completeness -> feeds target_partial_exposure_rate[lang].
                emissionCompleteness: (options && options.emissionCompleteness) || null,
                releaseMeta,
                sourceLineage: releaseMeta.sourceLineage,
                dedupHistoryCandidates: deferDedupHistoryCommit ? [{
                    p2Text: p2HistoryCandidate,
                    b4Text: b4HistoryCandidate,
                    b4CadenceText: b4CadenceResult && b4CadenceResult.action !== 'skip'
                        ? b4CadenceResult.text
                        : null,
                    b4CadenceAtMs,
                    emittedSourceText: text,
                    releaseMeta,
                }] : null,
            };
            const revisionPreflight = revisionAdmissionShadow.preflightAccepted({
                churchId,
                text,
                releaseMeta,
            });
            const releaseEpochIsCurrent = releaseMeta?.sessionEpoch === _sessionEpoch;
            const releaseGuardReason = releaseEpochIsCurrent
                ? revisionPreflight.reason
                : 'stale_session_epoch';
            const releaseGuardWouldReject = !releaseEpochIsCurrent || revisionPreflight.accept === false;
            const releaseGuardApplied = FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED
                && releaseGuardWouldReject;
            if (releaseGuardWouldReject) {
                evalLog({
                    stage: 'fqf_release_identity_guard',
                    churchId,
                    session_epoch: releaseMeta?.sessionEpoch ?? null,
                    release_seq: releaseMeta?.releaseSeq ?? null,
                    policy_applied: releaseGuardApplied,
                    decision: releaseGuardApplied ? 'rejected' : 'would_reject',
                    reason: releaseGuardReason,
                });
            }
            const acceptedForTranslation = !releaseGuardApplied && queue.enqueue(queueItem);
            if (acceptedForTranslation) {
                const revisionTicket = revisionAdmissionShadow.registerAccepted({
                    churchId,
                    text,
                    releaseMeta,
                });
                if (revisionTicket) {
                    releaseMeta = { ...releaseMeta, revisionTicket };
                    queueItem.releaseMeta = releaseMeta;
                    queueItem.revisionTicket = revisionTicket;
                }
            }
            if (!acceptedForTranslation && FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) {
                cancelFallbackCoordinatorObservation(churchId, releaseMeta);
                logSourceReleaseOutcome('blocked_pre_queue', 'translation_queue', {
                    reason: releaseGuardApplied ? releaseGuardReason : 'queue_rejected',
                });
                if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
            }
            if (!acceptedForTranslation && releaseGuardApplied && !FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) {
                if (latencyTxId) completeWhisperOnlyTracking(latencyTxId);
            }
            if (acceptedForTranslation && FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) {
                commitLastSentText();
                logAcceptedSourceOutcome();
            }
            if (acceptedForTranslation && !coordinatorDecision.observedBeforeEnqueue) {
                observeFallbackCoordinatorShadowAtAcceptedEnqueue({
                    churchId,
                    origin: options.origin,
                    text,
                    releaseMeta,
                });
            }
            if (acceptedForTranslation) {
                sourceTextLedgerShadow.observe({
                    churchId,
                    origin: releaseMeta?.origin ?? options.origin ?? 'legacy',
                    text,
                    releaseMeta,
                });
                sourceSemanticRepeatShadow.observe({
                    churchId,
                    sessionEpoch: releaseMeta?.sessionEpoch ?? null,
                    releaseSeq: releaseMeta?.releaseSeq ?? null,
                    units: sourceUnits,
                    activeLanguages: activeLanguages.length,
                });
                if (config.deadlineFallback.provisionalEnabled && config.deadlineFallback.reviewFixesEnabled
                    && options.origin === 'deadline_fallback') {
                    const fbLedger = state.fallbackState.get(churchId);
                    if (fbLedger) {
                        const nowLedger = Date.now();
                        if (fbLedger.lastDeadlineEmitAt && (nowLedger - fbLedger.lastDeadlineEmitAt) > config.deadlineFallback.supersedeTtlMs) {
                            fbLedger.emittedSourceNorm = [];
                            fbLedger.deadlineLedger = [];
                        }
                        const emittedNorm = dpNormWords(text);
                        fbLedger.emittedSourceNorm = [...(fbLedger.emittedSourceNorm || []), ...emittedNorm];
                        fbLedger.deadlineLedger = [...(fbLedger.deadlineLedger || []), { norm: emittedNorm, text, at: nowLedger }];
                        fbLedger.lastDeadlineEmitAt = nowLedger;
                    }
                }
            }
            return { acceptedForTranslation, coordinatorDecision };
        };

        let enqueueResult;
        if (FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED) {
            enqueueResult = await fallbackCoordinatorApplyEnqueueSequencer.run(churchId, async () => {
                releaseMeta = stampEmittedSourceIdentity(releaseMeta, text);
                const coordinatorDecision = await coordinateFallbackCoordinatorApplyBeforeEnqueue({
                    churchId,
                    origin: options.origin,
                    text,
                    releaseMeta,
                });
                return enqueueAfterCoordinator(coordinatorDecision);
            });
        } else {
            enqueueResult = enqueueAfterCoordinator({
                action: 'enqueue_full',
                reason: 'apply_disabled',
                observedBeforeEnqueue: false,
            });
        }
        return enqueueResult;
    } else {
        console.log(`[DEBUG] ⚠️ SKIPPING TRANSLATION - no active languages for ${churchId}`);
        logSourceReleaseOutcome('blocked_pre_queue', 'no_active_languages', { reason: 'no active listener languages' });
        // Complete latency tracking without translation
        if (latencyTxId) {
            completeWhisperOnlyTracking(latencyTxId);
        }
    }
}

// ------------------------------------------------------------
// Client (listener) handlers
// ------------------------------------------------------------
function removeClientFromChurchSubscriptions(ws, churchId) {
    const subs = state.subscriptions.get(churchId);
    if (!subs) return;

    for (const [lang, clients] of subs.entries()) {
        if (clients.delete(ws)) {
            console.log(`[DEBUG] Removed listener socket from stale subscription: ${churchId}/${lang}`);
        }
    }
}

function handleSubscribe(ws, message, clientState) {
    const { churchId, language, voiceGender } = message;
    const listenerSessionId = listenerSessionIdFrom(message.listenerSessionId);

    console.log(`[DEBUG] 📥 handleSubscribe called: churchId="${churchId}", language="${language}", voiceGender="${voiceGender || 'default'}"`);
    console.log(`[DEBUG] Current churches registered:`, [...state.churches.keys()]);

    if (!churchId || !language || !config.targetLanguages.includes(language)
        || (message.listenerSessionId != null && !listenerSessionId)) {
        console.log(`[DEBUG] ⚠️ Invalid subscription: churchId=${churchId}, language=${language}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid subscription' }));
        return;
    }

    if (!requireListenerClient(ws, clientState, churchId)) return;

    // A phone can have exactly one live listener language at a time. Remove this
    // socket from all stale language sets before adding the new subscription so
    // queued emissions route to the newly selected language immediately.
    if (clientState.churchId) removeClientFromChurchSubscriptions(ws, clientState.churchId);
    if (clientState.churchId !== churchId) removeClientFromChurchSubscriptions(ws, churchId);

    // Add to new subscription
    if (!state.subscriptions.has(churchId)) {
        console.log(`[DEBUG] Creating new subscriptions Map for churchId: ${churchId}`);
        state.subscriptions.set(churchId, new Map());
    }
    const churchSubs = state.subscriptions.get(churchId);
    if (!churchSubs.has(language)) {
        churchSubs.set(language, new Set());
    }
    churchSubs.get(language).add(ws);

    clientState.type = 'client';
    clientState.churchId = churchId;
    clientState.language = language;
    clientState.listenerSessionId = listenerSessionId;
    if (listenerSessionId) state.clientListenerSessionIds.set(ws, listenerSessionId);
    else state.clientListenerSessionIds.delete(ws);

    // Store voice gender preference for server-side TTS
    if (voiceGender === 'male' || voiceGender === 'female') {
        state.clientVoiceGenders.set(ws, voiceGender);
    }

    const count = churchSubs.get(language).size;
    evalLog({
        stage: 'listener_session_bound',
        churchId,
        lang: language,
        listener_session_id: listenerSessionId,
        authenticated: true,
        tracked: listenerSessionId !== null,
    });
    console.log(`[CLIENT] ✅ Subscribed: ${churchId}/${language} (${count} listeners)`);

    // DEBUG: Show all subscriptions state
    console.log(`[DEBUG] All subscriptions after subscribe:`, [...state.subscriptions.entries()].map(([cId, langMap]) =>
        `${cId}: {${[...langMap.entries()].map(([l, clients]) => `${l}:${clients.size}`).join(', ')}}`
    ).join(' | '));

    ws.send(JSON.stringify({
        type: 'subscribed',
        churchId,
        language,
        listenerSessionId,
        playoutTracking: listenerSessionId !== null,
        languageName: config.languageNames[language]
    }));

    // Send current Smooth Mode state to newly subscribed listener (26.01.2026)
    if (config.smoothMode.enabled && state.smoothPhases.has(churchId)) {
        const phaseState = state.smoothPhases.get(churchId);
        ws.send(JSON.stringify({
            type: 'smooth_phase_change',
            phase: phaseState.phase
        }));
        // If in initial_buffer, also send current progress
        if (phaseState.phase === 'initial_buffer') {
            const elapsedSec = (Date.now() - phaseState.startTime) / 1000;
            const progress = Math.min(elapsedSec / config.smoothMode.initialBufferSec, 1.0);
            ws.send(JSON.stringify({
                type: 'smooth_buffer_progress',
                progress: progress,
                phase: 'initial_buffer',
                remainingSec: Math.max(0, config.smoothMode.initialBufferSec - elapsedSec)
            }));
        }
    }
}

function handleUnsubscribe(ws, clientState) {
    if (clientState.churchId && clientState.language) {
        removeClientFromChurchSubscriptions(ws, clientState.churchId);
    }
    state.clientVoiceGenders.delete(ws);
    state.clientListenerSessionIds.delete(ws);
    clientState.churchId = null;
    clientState.language = null;
    clientState.listenerSessionId = null;
    ws.send(JSON.stringify({ type: 'unsubscribed' }));
}

// ------------------------------------------------------------
// Recording handlers (multi-language subscription)
// ------------------------------------------------------------

function handleSubscribeRecording(ws, message, clientState) {
    const { churchId, languages, voiceGender, sessionToken } = message;

    if (!churchId || !Array.isArray(languages) || languages.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid recording subscription' }));
        return;
    }

    const sessionResult = validateRoleSession(sessionToken || clientState.sessionToken, 'broadcaster', churchId);
    if (!sessionResult.valid) {
        sendAuthError(ws, sessionResult.error || 'Broadcaster authentication required');
        return;
    }

    const validLangs = languages.filter(lang => config.targetLanguages.includes(lang));
    if (validLangs.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'No valid languages' }));
        return;
    }

    // Set client state
    clientState.authenticated = true;
    clientState.type = 'recorder';
    clientState.churchId = churchId;
    clientState.recordingLanguages = validLangs;

    // Set voice gender for TTS generation
    state.clientVoiceGenders.set(ws, voiceGender || 'male');

    // Subscribe to ALL requested languages
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
    }
    const churchSubs = state.subscriptions.get(churchId);
    for (const lang of validLangs) {
        if (!churchSubs.has(lang)) {
            churchSubs.set(lang, new Set());
        }
        churchSubs.get(lang).add(ws);
    }

    console.log(`[RECORDER] ✅ Subscribed: ${churchId} → [${validLangs.join(', ')}] (${voiceGender || 'male'})`);

    ws.send(JSON.stringify({
        type: 'recording_subscribed',
        churchId,
        languages: validLangs,
        voiceGender: voiceGender || 'male'
    }));
}

function handleUnsubscribeRecording(ws, clientState) {
    const langs = clientState.recordingLanguages || [];
    const churchId = clientState.churchId;

    if (churchId && langs.length > 0) {
        const subs = state.subscriptions.get(churchId);
        if (subs) {
            for (const lang of langs) {
                subs.get(lang)?.delete(ws);
            }
        }
    }

    state.clientVoiceGenders.delete(ws);
    clientState.type = null;
    clientState.churchId = null;
    clientState.recordingLanguages = null;

    console.log(`[RECORDER] ❌ Unsubscribed: ${churchId}`);

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'recording_unsubscribed' }));
    }
}

function handleDisconnect(ws, clientState) {
    if (clientState.type === 'node' && clientState.churchId) {
        const churchId = clientState.churchId;
        const audioGeneration = clientState.audioGeneration || 0;
        resetBroadcasterAudioGeneration(clientState, 'broadcaster disconnected');

        // P-B: always log the pending tail at teardown so the OFF baseline is measurable
        // (confirmed_tail > 0 + no drain events => TAIL LOST). Refinement #6.
        try {
            const _acc = state.smoothAccumulators.get(churchId);
            const _accStats = (_acc && _acc.getStats) ? _acc.getStats() : {};
            const _em = state.holdNEmitters.get(churchId);
            const _q = translationQueues.get(churchId);
            evalLog({
                stage: 'disconnect_legacy_cleanup', churchId,
                smooth_pending_sentences: _accStats.currentSentences || 0,
                smooth_pending_chars: _accStats.currentChars || 0,
                holdn_pending_chars: (_em && _em.peek ? _em.peek() : '').length,
                queue_depth: _q ? _q.depth : 0,
                flush_enabled: config.disconnectDrain.enabled,
            });
        } catch { /* never block teardown */ }

        // P-B: drain-before-cleanup (behind DISCONNECT_FLUSH_ENABLED). Async; it performs
        // flushSessionSummary + state cleanup + church_offline at the END, so we return here and
        // skip the legacy synchronous teardown below.
        if (config.disconnectDrain.enabled) {
            const drainId = `${churchId}:${audioGeneration}:${Date.now()}`;
            let _tailSeq = 0;
            runDisconnectDrain(
                {
                    churchId, drainId,
                    timeouts: {
                        finalTranscribeMs: config.disconnectDrain.finalTranscribeTimeoutMs,
                        queueDrainMs: config.disconnectDrain.queueDrainTimeoutMs,
                    },
                },
                {
                    now: Date.now,
                    evalLog,
                    newTailItemId: () => `${drainId}#${++_tailSeq}`,
                    snapshot: () => {
                        const acc = state.smoothAccumulators.get(churchId);
                        const st = (acc && acc.getStats) ? acc.getStats() : {};
                        const em = state.holdNEmitters.get(churchId);
                        const q = translationQueues.get(churchId);
                        return {
                            smoothSentences: st.currentSentences || 0,
                            smoothChars: st.currentChars || 0,
                            holdnChars: (em && em.peek ? em.peek() : '').length,
                            queueDepth: q ? q.depth : 0,
                            inFlight: q ? q.inFlight : 0,
                        };
                    },
                    // 4th gap: NO staleness guard — drain is the deliberate end-of-session, so
                    // accept the final transcription regardless of audioGeneration/readyState/churches.
                    finalTranscribe: async () => {
                        if (!whisperEnabled) return null;
                        const audio = flushAudioBuffer(churchId);
                        clearAudioBuffer(churchId);
                        if (!audio) return null;
                        const result = await transcribeStream(audio);
                        return (result && result.text) ? result.text : null;
                    },
                    flushSmooth: () => {
                        const acc = state.smoothAccumulators.get(churchId);
                        return (acc && acc.flush) ? acc.flush() : null;
                    },
                    flushHoldN: () => {
                        const em = state.holdNEmitters.get(churchId);
                        return (em && em.flush) ? em.flush() : '';
                    },
                    emit: (text, meta) => processCompleteSentence(churchId, text, null, {
                        source: 'disconnect_drain', origin: 'disconnect_drain', releaseReason: 'disconnect_drain',
                        drainId: meta.drainId, tailItemId: meta.tailItemId, forceHoldN: true,
                        sourceLineage: meta.sourceLineage || null,
                    }),
                    drainQueue: async () => {
                        const q = translationQueues.get(churchId);
                        if (q) await q.drain();
                    },
                    flushSummary: () => qualityTracker.flushSessionSummary(churchId, 'disconnect_drain'),
                    cleanup: () => {
                        if (typeof repObserver !== 'undefined') repObserver.closeChurch(churchId);
                        clearB4CadenceHistory(churchId);
                        fallbackCoordinatorApplyWaiters.failOpenChurch(churchId);
                        state.churches.delete(churchId);
                        state.emissionNgramHistory.delete(churchId);
                        state.lastSentTexts.delete(churchId);
                        state.emissionFullHistory.delete(churchId);
                        state.translationEmissionHistory.delete(churchId);
                        state.silenceChunks.delete(churchId);
                        state.fallbackState.delete(churchId);
                        sourceTextLedgerShadow.clear(churchId);
                        revisionAdmissionShadow.clear(churchId);
                        state.liveQualityStates.delete(churchId);
                        state.holdNEmitters.delete(churchId);
                        state.smoothAccumulators.delete(churchId);
                        state.smoothPhases.delete(churchId);
                        clearContextBuffer(churchId);
                        clearCommittedTranslations(churchId);
                        clearBoundaryLedger(churchId);
                        stopTranslationQueue(churchId);
                        broadcastToAll({ type: 'church_offline', churchId });
                        console.log(`[NODE] Disconnected (drained): ${churchId}`);
                    },
                }
            ).catch((err) => console.error(`[DRAIN] ${churchId}: ${err && err.message}`));
            return;
        }

        // Phase 1: Flush remaining audio and transcribe before disconnect
        if (whisperEnabled) {
            const remainingAudio = flushAudioBuffer(churchId);
            if (remainingAudio) {
                transcribeStream(remainingAudio).then(result => {
                    if (!isCurrentBroadcasterAudio(ws, clientState, churchId, audioGeneration)) {
                        console.log(`[PCM] ${churchId}: Dropping stale Whisper result for audio generation ${audioGeneration}`);
                        return;
                    }
                    if (result.text) {
                        console.log(`[Whisper] Final transcription for ${churchId}: ${result.text.length} characters`);
                        state.stats.whisperTranscriptions++;
                updateWhisperActivity(); // Auto-shutdown tracking
                        // Process through sentence pipeline
                        const sentenceBuffer = state.sentenceBuffers.get(churchId);
                        if (sentenceBuffer) {
                            const sentences = sentenceBuffer.add(result.text, true);
                            for (const sentence of sentences) {
                                processCompleteSentence(churchId, sentence.text);
                            }
                        }
                    }
                }).catch(err => {
                    console.error(`[Whisper] Final transcription failed for ${churchId}:`, err.message);
                });
            }
            clearAudioBuffer(churchId);
        }

        // Flush any remaining sentences in buffer before disconnect (Phase 6)
        const sentenceBuffer = state.sentenceBuffers.get(churchId);
        if (sentenceBuffer) {
            const remaining = sentenceBuffer.flush();
            // Process remaining sentences asynchronously
            (async () => {
                for (const sentence of remaining) {
                    await processCompleteSentence(churchId, sentence.text);
                }
            })();
            state.sentenceBuffers.delete(churchId);
        }

        // Quality tracking: flush session summary + MD report BEFORE state cleanup
        qualityTracker.flushSessionSummary(churchId, 'disconnect');
        if (typeof repObserver !== 'undefined') repObserver.closeChurch(churchId);
        clearB4CadenceHistory(churchId);

        state.churches.delete(churchId);
        // HOTFIX 7.1: Do NOT delete subscriptions map on broadcaster disconnect.
        // Listeners remain connected when broadcaster drops; their subscriptions
        // must be preserved for when broadcaster reconnects. Stale entries are
        // cleaned up by individual listener WS close handlers (handleUnsubscribe).
        // P2/B3/B4/T5/T6: Clean up dedup + pause state for this church
        state.emissionNgramHistory.delete(churchId);
        state.lastSentTexts.delete(churchId);
        state.emissionFullHistory.delete(churchId);
        state.translationEmissionHistory.delete(churchId);
        state.silenceChunks.delete(churchId);
        // Partial Fallback + Smooth Mode cleanup (11.03.2026)
        fallbackCoordinatorApplyWaiters.failOpenChurch(churchId);
        state.fallbackState.delete(churchId);
        sourceTextLedgerShadow.clear(churchId);
        revisionAdmissionShadow.clear(churchId);
        state.liveQualityStates.delete(churchId);
        state.holdNEmitters.delete(churchId);
        state.smoothAccumulators.delete(churchId);
        state.smoothPhases.delete(churchId);
        // Clear translation context buffer for this church
        clearContextBuffer(churchId);
        // QW-7: Clear committed translations for this church
        clearCommittedTranslations(churchId);
        clearBoundaryLedger(churchId);
        // R1.4: Stop translation queue worker for this church
        stopTranslationQueue(churchId);
        broadcastToAll({ type: 'church_offline', churchId });
        console.log(`[NODE] Disconnected: ${churchId}`);
    } else if (clientState.type === 'recorder') {
        handleUnsubscribeRecording(ws, clientState);
    } else if (clientState.type === 'client') {
        state.clientVoiceGenders.delete(ws);
        handleUnsubscribe(ws, clientState);
    }
}

// ============================================================
// Translation (GPT-4.1-mini via Azure OpenAI)
// ============================================================

// ============================================================
// T5 (30.03.2026): Post-translation dedup — catches paraphrased repeats
// that slip through DE-level dedup (P2/B2/B4).
// Pair-coding session: Claude Opus (Lead) + GPT-4o (Reviewer).
// ============================================================

const T5_DEDUP_WINDOW = DEFAULT_T5_DEDUP_WINDOW;
const T5_DEDUP_THRESHOLD = DEFAULT_T5_DEDUP_THRESHOLD; // Tuned 13.04: 0.30->0.45 (0.30 blocked emissions with 70% new content, causing pauses)
const T5_V2_OVERLAP_THRESHOLD = parseFloat(process.env.T5_V2_OVERLAP_THRESHOLD || String(DEFAULT_T5_V2_OVERLAP_THRESHOLD));
const T5_SHORT_TEXT_CHARS = DEFAULT_T5_SHORT_TEXT_CHARS;
function isT5V2Enabled() { return process.env.T5_V2_ENABLED === 'true'; }

function postTranslationDedup(text, language, churchId, ctx = {}) {
    if (!text || text.length < 10) return { action: 'emit' };

    const historyMap = state.translationEmissionHistory;
    const historyLanguage = ctx.deliveryScope
        ? `${language}#${ctx.deliveryScope}`
        : language;
    if (!ctx.deferCommit && !historyMap.has(churchId)) historyMap.set(churchId, new Map());
    const churchHistory = historyMap.get(churchId);
    if (!ctx.deferCommit && !churchHistory.has(historyLanguage)) churchHistory.set(historyLanguage, []);
    const history = churchHistory?.get(historyLanguage) || [];

    const evaluation = evaluatePostTranslationDedup(text, language, history, {
        legacyThreshold: T5_DEDUP_THRESHOLD,
        v2OverlapThreshold: T5_V2_OVERLAP_THRESHOLD,
        shortTextChars: T5_SHORT_TEXT_CHARS,
        stopwords: DEFAULT_TRANSLATION_STOPWORDS,
    });
    const applied = isT5V2Enabled() ? evaluation.v2 : evaluation.legacy;

    evalLog({
        stage: 'post_translation_dedup',
        churchId,
        emissionId: ctx.emissionId ?? null,
        release_seq: ctx.releaseSeq ?? null,
        source_hash: ctx.sourceHash ?? null,
        lang: language,
        action: applied.action,
        reason: applied.reason || null,
        legacy_action: evaluation.legacy.action,
        legacy_reason: evaluation.legacy.reason || null,
        v2_action: evaluation.v2.action,
        v2_reason: evaluation.v2.reason || null,
        t5_v2_enabled: isT5V2Enabled(),
        jaccard: evaluation.metrics.jaccard ?? null,
        overlap_ratio: evaluation.metrics.overlap_ratio ?? null,
        new_content_ratio: evaluation.metrics.new_content_ratio ?? null,
        history_index: evaluation.metrics.history_index ?? null,
        text_len: evaluation.metrics.text_len ?? text.length,
        content_word_count: evaluation.metrics.content_word_count ?? null,
    });

    if (applied.action === 'skip') return applied;

    if (!ctx.deferCommit) commitT5History(text, language, churchId, ctx.deliveryScope);

    return { action: 'emit' };
}

function commitT5History(text, language, churchId, deliveryScope = null) {
    if (!text || text.length < 10) return false;
    const historyMap = state.translationEmissionHistory;
    if (!historyMap.has(churchId)) historyMap.set(churchId, new Map());
    const churchHistory = historyMap.get(churchId);
    const historyLanguage = deliveryScope ? `${language}#${deliveryScope}` : language;
    if (!churchHistory.has(historyLanguage)) churchHistory.set(historyLanguage, []);
    const history = churchHistory.get(historyLanguage);
    history.push(historyEntryFor(text, DEFAULT_TRANSLATION_STOPWORDS));
    if (history.length > T5_DEDUP_WINDOW) history.shift();
    return true;
}

/**
 * Translate text to all active languages and broadcast results
 *
 * Uses the translationService which:
 * 1. Normalizes Swiss German → Hochdeutsch
 * 2. Checks liturgical phrase cache
 * 3. Extracts dynamic glossary terms
 * 4. Translates with GPT-4.1-mini
 *
 * @param {string} churchId - Church identifier
 * @param {string} text - German source text
 * @param {string[]} languages - Target language codes
 * @param {string} latencyTxId - Latency tracking transaction ID (optional)
 * @param {string|null} sermonContext - Sermon preparation context for theological accuracy (02.03.2026)
 */
/**
 * N3: per-language independent dispatch path (feature flag TRANSLATION_DISPATCH_INDEPENDENT).
 * Each language runs translate → pipeline → TTS/broadcast on its OWN promise via
 * dispatchPerLanguage (translationDispatch.js), so fast languages emit without waiting
 * for the slowest. Mirrors the legacy BROADCAST_PARALLEL synth/broadcast behaviour
 * per (lang,gender). The legacy barrier path in translateAndBroadcast is unchanged.
 */
async function dispatchIndependent(churchId, text, languages, latencyTxId, sourceContext, sermonContext, queuedAt, queueDepthAtDequeue, drainMeta = null, emissionCompleteness = null, releaseMeta = null, dedupHistoryCandidates = [], deliveryOptions = {}) {
    const _emissionId = nextEmissionId();
    const _evalTransStart = Date.now();
    const ttsEnabled = isTtsEnabled();
    const commitDedupHistories = createDedupHistoryCommitter({
        churchId,
        sourceCandidates: dedupHistoryCandidates,
        releaseMeta,
        deliveryScope: deliveryOptions.deliveryScope || null,
    });

    // Per-(lang,gender) TTS synth + immediate broadcast (mirrors legacy ttsJobs.map callback).
    async function synthAndBroadcastGender(result, gender) {
        try {
            const _evalTtsStart = Date.now();

            if (TTS_PROGRESSIVE_ENABLED) {
                const textMsg = {
                    type: 'translation',
                    emissionId: _emissionId,
                    release_seq: releaseMeta?.releaseSeq ?? null,
                    source_hash: releaseMeta?.sourceHash ?? null,
                    originalText: text,
                    translatedText: result.text,
                    language: result.language,
                    languageName: config.languageNames[result.language],
                    progressive: true,
                    emissionMode: result.emissionMode || null,
                    emissionReason: result.emissionReason || null
                };
                if (latencyTxId) textMsg.txId = latencyTxId;
                const _textSentCount = broadcastToLanguageGender(
                    churchId, result.language, gender, textMsg,
                    {
                        targetListenerSessionIds: deliveryOptions.targetListenerSessionIds || null,
                        excludeListenerSessionIds: deliveryOptions.excludeListenerSessionIds || null,
                    },
                );

                let firstChunkMs = null;
                let chunkCount = 0;
                let nullCount = 0;
                let totalSentencesSeen = 0;

                const onChunk = (audioBase64, sentenceIdx, totalSentences, isLast, sentenceText) => {
                    totalSentencesSeen = totalSentences;
                    if (audioBase64 === null || audioBase64 === undefined) {
                        nullCount++;
                    }
                    if (firstChunkMs === null) {
                        firstChunkMs = Date.now() - _evalTtsStart;
                    }
                    broadcastProgressiveTtsChunk({
                        churchId,
                        emissionId: _emissionId,
                        releaseMeta,
                        language: result.language,
                        gender,
                        sentenceIndex: sentenceIdx,
                        totalSentences,
                        sentenceText,
                        audioBase64,
                        isLast,
                        latencyTxId,
                        emissionMode: result.emissionMode || null,
                        emissionReason: result.emissionReason || null,
                        targetListenerSessionIds: deliveryOptions.targetListenerSessionIds || null,
                        excludeListenerSessionIds: deliveryOptions.excludeListenerSessionIds || null,
                    });
                    chunkCount++;
                };

                await synthesizeSpeechProgressive(
                    result.text,
                    result.language,
                    gender,
                    onChunk,
                    ttsRequestTelemetry({ churchId, emissionId: _emissionId, releaseMeta }),
                );

                const _evalTtsMs = Date.now() - _evalTtsStart;
                const ttsMetric = {
                    stage: 'tts',
                    churchId,
                    emissionId: _emissionId,
                    lang: result.language,
                    gender,
                    latency_ms: _evalTtsMs,
                    mode: 'progressive',
                    emission_mode: result.emissionMode || null,
                    emission_reason: result.emissionReason || null,
                    chunks: chunkCount,
                    null_chunks: nullCount,
                    total_sentences: totalSentencesSeen,
                    first_chunk_ms: firstChunkMs,
                    ...sourceLineageFields(releaseMeta),
                };
                recordLiveQualityFromEvalEntry({
                    ...ttsMetric,
                    first_audio_ms: firstChunkMs,
                    tts_ms: _evalTtsMs,
                });
                logAutopilotShadow(churchId, { source: 'dispatch_independent_tts' });
                evalLog(ttsMetric);
                logEmissionDecision(evalLog, {
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    gender,
                    decision: 'emit',
                    reason: 'progressive_tts',
                    ageMs: queuedAt ? Date.now() - queuedAt : 0,
                    queueDepth: queueDepthAtDequeue,
                    source: 'dispatch_independent_tts',
                    latencyTxId,
                    firstAudioMs: firstChunkMs,
                    listenersServed: _textSentCount,
                    progressive: true,
                });
                logEmissionControllerShadow({
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    gender,
                    source: 'dispatch_independent_tts',
                    runtimeDecision: 'emit',
                    signals: {
                        ageMs: queuedAt ? Date.now() - queuedAt : 0,
                        queueDepth: queueDepthAtDequeue,
                        providerHealthy: nullCount === 0,
                        ttsEnabled: true,
                        activeLanguages: languages.length,
                        activeGenders: 1,
                    },
                });

                if (nullCount > 0) {
                    logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: `null_chunks_${nullCount}_of_${totalSentencesSeen}` });
                }

                logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, listenersServed: _textSentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });
                console.log(`  [${result.language.toUpperCase()}/${gender}] 🔄 progressive: ${chunkCount}/${totalSentencesSeen} chunks, first@${firstChunkMs}ms, total ${_evalTtsMs}ms → ${_textSentCount} listeners`);
                return;
            }

            // Legacy non-progressive path
            const audioBase64 = await synthesizeSpeech(
                result.text,
                result.language,
                gender,
                ttsRequestTelemetry({ churchId, emissionId: _emissionId, releaseMeta }),
            );
            const _evalTtsMs = Date.now() - _evalTtsStart;
            const ttsMetric = {
                stage: 'tts',
                churchId,
                emissionId: _emissionId,
                lang: result.language,
                gender,
                latency_ms: _evalTtsMs,
                emission_mode: result.emissionMode || null,
                emission_reason: result.emissionReason || null,
                ...sourceLineageFields(releaseMeta),
            };
            recordLiveQualityFromEvalEntry({
                ...ttsMetric,
                first_audio_ms: _evalTtsMs,
                tts_ms: _evalTtsMs,
            });
            logAutopilotShadow(churchId, { source: 'dispatch_independent_tts' });
            evalLog(ttsMetric);

            if (audioBase64 === null) {
                logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: 'null_audio' });
            }

            const msg = {
                type: 'translation',
                emissionId: _emissionId,
                release_seq: releaseMeta?.releaseSeq ?? null,
                source_hash: releaseMeta?.sourceHash ?? null,
                source_lineage_status: releaseMeta?.sourceLineage?.status || 'missing',
                originalText: text,
                translatedText: result.text,
                language: result.language,
                languageName: config.languageNames[result.language],
                emissionMode: result.emissionMode || null,
                emissionReason: result.emissionReason || null,
                ...revisionAdmissionTelemetry(releaseMeta),
            };
            if (latencyTxId) {
                msg.txId = latencyTxId;
                const audioCapturedAtSrv = getAudioCapturedAt(latencyTxId);
                if (audioCapturedAtSrv) msg.audioCapturedAt = audioCapturedAtSrv;
            }
            if (audioBase64) {
                msg.audioBase64 = audioBase64;
                msg.audioFormat = 'mp3';
            }
            const _sentCount = broadcastToLanguageGender(
                churchId, result.language, gender, msg,
                {
                    targetListenerSessionIds: deliveryOptions.targetListenerSessionIds || null,
                    excludeListenerSessionIds: deliveryOptions.excludeListenerSessionIds || null,
                },
            );
            logEmissionDecision(evalLog, {
                churchId,
                emissionId: _emissionId,
                language: result.language,
                gender,
                decision: 'emit',
                reason: audioBase64 ? 'tts_audio' : 'tts_null_audio',
                ageMs: queuedAt ? Date.now() - queuedAt : 0,
                queueDepth: queueDepthAtDequeue,
                source: 'dispatch_independent_tts',
                latencyTxId,
                firstAudioMs: _evalTtsMs,
                listenersServed: _sentCount,
                progressive: false,
            });
            logEmissionControllerShadow({
                churchId,
                emissionId: _emissionId,
                language: result.language,
                gender,
                source: 'dispatch_independent_tts',
                runtimeDecision: 'emit',
                signals: {
                    ageMs: queuedAt ? Date.now() - queuedAt : 0,
                    queueDepth: queueDepthAtDequeue,
                    providerHealthy: audioBase64 !== null,
                    ttsEnabled: true,
                    activeLanguages: languages.length,
                    activeGenders: 1,
                },
            });
            logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, listenersServed: _sentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });
            console.log(`  [${result.language.toUpperCase()}/${gender}] ✅ TTS ${_evalTtsMs}ms → ${_sentCount} listeners`);
        } catch (err) {
            logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: 'exception', error: err.message });
        }
    }

    function broadcastTextOnly(result, textOnly) {
        const msg = {
            type: 'translation',
            originalText: text,
            translatedText: result.text,
            language: result.language,
            languageName: config.languageNames[result.language],
            textOnly: textOnly === true,
            emissionMode: result.emissionMode || null,
            emissionReason: result.emissionReason || null
        };
        if (latencyTxId) msg.txId = latencyTxId;
        const _sentCount = broadcastToLanguage(
            churchId, result.language, msg,
            {
                targetListenerSessionIds: deliveryOptions.targetListenerSessionIds || null,
                excludeListenerSessionIds: deliveryOptions.excludeListenerSessionIds || null,
            },
        );
        logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender: null, listenersServed: _sentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });
        console.log(`  [${result.language.toUpperCase()}] ✅ translation completed (${result.text.length} characters)`);
    }

    const outcomes = await dispatchPerLanguage({
        text,
        languages,
        churchId,
        emissionId: _emissionId,
        queuedAt,
        queueDepth: queueDepthAtDequeue,
        ttsEnabled,
        translate: async (lang) => {
            const r = await translateText(
                text,
                lang,
                churchId,
                sourceContext,
                sermonContext,
                translationRequestTelemetry({
                    churchId,
                    emissionId: _emissionId,
                    releaseMeta,
                    queuedAt,
                }),
            );
            return {
                language: lang,
                languageName: LANGUAGE_NAMES[lang],
                text: r.text,
                dupCounts: r.dupCounts || null,
                promptTokens: r.promptTokens || 0,
                cachedTokens: r.cachedTokens || 0,
                attempts: r.providerMeta?.attempts || 0,
                contextMode: r.providerMeta?.contextMode || null,
                recoveredFromContentFilter: r.providerMeta?.recoveredFromContentFilter === true,
                filterSource: r.providerMeta?.filterSource || null,
                success: true,
            };
        },
        emit: async ({ result, decision, textOnly, emissionMode, emissionReason, ttsTargets = null }) => {
            const resultWithMode = { ...result, emissionMode, emissionReason };
            if (decision === 'text_only') {
                broadcastTextOnly(resultWithMode, textOnly);
            } else {
                const genders = ttsTargets || getActiveGendersForLanguage(
                    churchId,
                    result.language,
                    deliveryOptions.targetListenerSessionIds || null,
                    deliveryOptions.excludeListenerSessionIds || null,
                );
                await Promise.allSettled(genders.map((g) => synthAndBroadcastGender(resultWithMode, g)));
            }
        },
        // Stamp emission-level 'translation_done' as each lang's translation completes
        // (last/slowest wins) so completeLatencyTracking computes translation_processing /
        // translation_to_broadcast instead of null (parity with the legacy barrier path).
        onTranslated: () => {
            if (latencyTxId) recordLatencyStage(latencyTxId, 'translation_done');
        },
        releaseMeta,
        origin: fallbackEmissionOriginForTelemetry(releaseMeta, dedupHistoryCandidates),
        sessionEpoch: fallbackEmissionSessionEpochForTelemetry(releaseMeta, dedupHistoryCandidates),
        deps: {
            postTranslationDedup: (candidate, lang, candidateChurchId, ctx) => postTranslationDedup(
                candidate,
                lang,
                candidateChurchId,
                { ...ctx, deliveryScope: deliveryOptions.deliveryScope || null },
            ),
            decideAgeBudget,
            ageBudgetConfig: config.ageBudget,
            commitTranslation,
            trackEmission: (cid, l, m) => qualityTracker.trackEmission(cid, l, m),
            trackFilterAction: (cid, f, a) => qualityTracker.trackFilterAction(cid, f, a),
            evalLog: (entry) => {
                // P-B: tag drain emissions so the analyzer can verify per-unit tail coverage.
                let e = drainMeta ? { ...entry, source: 'disconnect_drain', drainId: drainMeta.drainId, tailItemId: drainMeta.tailItemId } : entry;
                // Q1b BUG1: tag translation eval records with emission_completeness so
                // target_partial_exposure_rate[lang] is computed from the REAL tag (was missing).
                if (emissionCompleteness && e?.stage === 'translation') {
                    e = { ...e, emission_completeness: emissionCompleteness };
                }
                recordLiveQualityFromEvalEntry(e);
                if (e?.stage === 'translation') {
                    logAutopilotShadow(e.churchId, { source: 'dispatch_per_language_translation' });
                }
                return evalLog(e);
            },
            logEmissionDecision: (payload) => logEmissionDecision(evalLog, payload),
            logEmissionControllerDecision: (payload) => logEmissionControllerShadow(payload),
            decideRuntimeEmission: (payload) => decideEmissionControllerRuntime(payload),
            processBoundaryCommit: (payload) => applyBoundaryCommitLedger({
                ...payload,
                deliveryScope: deliveryOptions.deliveryScope || null,
            }),
            observeRevisionAdmission: (payload) => revisionAdmissionShadow.observeCheckpoint(payload),
            deferDedupHistoryCommit: FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED,
            commitDedupHistories,
            resolveTtsTargets: (lang) => getActiveGendersForLanguage(
                churchId,
                lang,
                deliveryOptions.targetListenerSessionIds || null,
                deliveryOptions.excludeListenerSessionIds || null,
            ),
            now: Date.now,
            log: (m) => console.log(m),
        },
    });

    state.stats.translations += outcomes.filter((o) => o.emitted).length;

    if (latencyTxId) {
        const latencyResult = completeLatencyTracking(latencyTxId);
        if (latencyResult) {
            const upload = latencyResult.capture_to_gateway !== null ? ` | Upload: ${latencyResult.capture_to_gateway}ms` : '';
            console.log(`[LATENCY] Server E2E: ${latencyResult.end_to_end}ms | Whisper: ${latencyResult.whisper_processing}ms | Translation: ${latencyResult.translation_processing}ms${upload}`);
        }
    }
}

async function translateAndBroadcast(churchId, text, languages, latencyTxId = null, sourceContext = null, sermonContext = null, queuedAt = null, queueDepthAtDequeue = 0, drainMeta = null, emissionCompleteness = null, releaseMeta = null, dedupHistoryCandidates = [], deliveryOptions = {}) {
    const emissionOrigin = fallbackEmissionOriginForTelemetry(releaseMeta, dedupHistoryCandidates);
    const emissionSessionEpoch = fallbackEmissionSessionEpochForTelemetry(releaseMeta, dedupHistoryCandidates);
    console.log(`[TRANSLATE] 🌍 Starting translation for churchId="${churchId}"`);
    console.log(`[TRANSLATE] Source length: ${text.length} characters -> [${languages.join(', ')}]`);

    try {
        // T1 (17.02.2026): German bypass REMOVED — all languages go through GPT-4.1-mini
        // German now gets ASR cleanup (STEP 0 in prompt) instead of raw Whisper output
        const languagesToTranslate = languages;

        // Record translation start
        if (latencyTxId) {
            recordLatencyStage(latencyTxId, 'translation_sent');
        }

        // N3: per-language independent dispatch (feature-flagged). Removes the
        // translateToAllLanguages Promise.all barrier so fast langs emit without waiting
        // for the slowest. OFF (default) → legacy barrier path below stays UNCHANGED.
        if (TRANSLATION_DISPATCH_INDEPENDENT && BROADCAST_PARALLEL) {
            await dispatchIndependent(
                churchId,
                text,
                languagesToTranslate,
                latencyTxId,
                sourceContext,
                sermonContext,
                queuedAt,
                queueDepthAtDequeue,
                drainMeta,
                emissionCompleteness,
                releaseMeta,
                dedupHistoryCandidates,
                deliveryOptions,
            );
            return;
        }

        // Use translation service (GPT-4.1-mini with glossary)
        const _evalTransStart = Date.now();
        const _emissionId = nextEmissionId();
        const results = await translateToAllLanguages(
            text,
            languagesToTranslate,
            churchId,
            sourceContext,
            sermonContext,
            translationRequestTelemetry({
                churchId,
                emissionId: _emissionId,
                releaseMeta,
                queuedAt,
            }),
        );
        const _evalTransMs = Date.now() - _evalTransStart;

        // Record translation complete
        if (latencyTxId) {
            recordLatencyStage(latencyTxId, 'translation_done');
        }

        console.log(`[DEBUG] Translation results received: ${results.length} languages`);

        const ttsEnabled = isTtsEnabled();

        // Build list of all TTS jobs (language x gender) for parallel synthesis
        const ttsJobs = [];
        const noTtsResults = [];
        const commitDedupHistories = createDedupHistoryCommitter({
            churchId,
            sourceCandidates: dedupHistoryCandidates,
            releaseMeta,
        });

        for (const result of results) {
            if (!result.success || !result.text || result.text.trim().length === 0) {
                if (!result.success) {
                    console.error(`  [${result.language.toUpperCase()}] ❌ FAILED: ${result.error}`);
                    evalLog({
                        stage: 'source_release_outcome',
                        churchId,
                        release_seq: releaseMeta?.releaseSeq ?? null,
                        source_hash: releaseMeta?.sourceHash ?? null,
                        outcome: 'translated_blocked',
                        block_stage: result.failureKind === 'content_filter' ? 'CONTENT_FILTER' : 'PROVIDER',
                        failure_kind: result.failureKind || 'unknown',
                        attempts: result.attempts || 0,
                        context_mode: result.contextMode || 'full',
                        recovered_from_content_filter: result.recoveredFromContentFilter === true,
                        filter_source: result.filterSource || null,
                        lang: result.language,
                        emissionId: _emissionId,
                    });
                } else if (!result.text || result.text.trim().length === 0) {
                    console.log(`  [${result.language.toUpperCase()}] ⚠️ Empty result (ASR cleanup returned nothing) — skipping`);
                }
                continue;
            }

            // T5 (30.03.2026): Post-translation dedup — skip paraphrased repeats
            const t5HistoryCandidate = result.text;
            const t5Result = postTranslationDedup(t5HistoryCandidate, result.language, churchId, {
                emissionId: _emissionId,
                releaseSeq: releaseMeta?.releaseSeq,
                sourceHash: releaseMeta?.sourceHash,
                deferCommit: FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED,
            });
            if (t5Result.action === 'skip') {
                console.log(`  [${result.language.toUpperCase()}] 🔇 ${t5Result.reason} (${result.text.length} characters)`);
                qualityTracker.trackFilterAction(churchId, 'T5', 'skip');
                evalLog({ stage: 'source_release_outcome', churchId, release_seq: releaseMeta?.releaseSeq ?? null, source_hash: releaseMeta?.sourceHash ?? null, outcome: 'translated_blocked', block_stage: 'T5', lang: result.language, emissionId: _emissionId, reason: t5Result.reason || null });
                continue;
            }
            qualityTracker.trackFilterAction(churchId, 'T5', 'emit');

            const boundaryResult = applyBoundaryCommitLedger({
                churchId,
                lang: result.language,
                text: result.text,
                sourceText: text,
                emissionId: _emissionId,
            });
            if (boundaryResult.changed) {
                result.text = boundaryResult.text;
                qualityTracker.trackFilterAction(churchId, 'BCL', 'trim');
            } else {
                qualityTracker.trackFilterAction(churchId, 'BCL', 'emit');
            }

            const ageDecision = decideAgeBudget({
                ageMs: queuedAt ? Date.now() - queuedAt : 0,
                queueDepth: queueDepthAtDequeue,
                config: config.ageBudget,
            });
            const logFallbackAgeDecision = [
                'partial_fallback',
                'deadline_fallback',
                'mixed',
            ].includes(emissionOrigin);
            if (ageDecision.action !== 'normal_tts' || logFallbackAgeDecision) {
                evalLog({
                    stage: 'age_budget',
                    churchId,
                    emissionId: _emissionId,
                    lang: result.language,
                    action: ageDecision.action,
                    reason: ageDecision.reason,
                    origin: emissionOrigin,
                    session_epoch: emissionSessionEpoch,
                    release_seq: releaseMeta?.releaseSeq ?? null,
                    age_ms: ageDecision.ageMs,
                    queue_depth: ageDecision.queueDepth,
                });
            }
            const runtimeEmissionDecision = decideEmissionControllerRuntime({
                churchId,
                emissionId: _emissionId,
                language: result.language,
                source: 'legacy_translation_path',
                origin: emissionOrigin,
                sessionEpoch: emissionSessionEpoch,
                releaseSeq: releaseMeta?.releaseSeq,
                signals: {
                    ageMs: ageDecision.ageMs,
                    queueDepth: ageDecision.queueDepth,
                    providerHealthy: areProvidersHealthyForEmission(ttsEnabled),
                    ttsEnabled,
                    activeLanguages: languagesToTranslate.length,
                    activeGenders: 0,
                },
            });
            if (runtimeEmissionDecision?.action === 'drop') {
                console.warn(`  [${result.language.toUpperCase()}] EmissionController drop (${runtimeEmissionDecision.reason})`);
                qualityTracker.trackFilterAction(churchId, 'EMISSION_CONTROLLER', 'drop');
                logEmissionDecision(evalLog, {
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    decision: 'drop',
                    reason: runtimeEmissionDecision.reason,
                    ageMs: runtimeEmissionDecision.ageMs,
                    queueDepth: runtimeEmissionDecision.queueDepth,
                    source: 'legacy_emission_controller',
                    latencyTxId,
                });
                continue;
            }
            if (ageDecision.action === 'drop_stale') {
                console.warn(`  [${result.language.toUpperCase()}] ⏭️ Age budget drop (${ageDecision.ageMs}ms, q=${ageDecision.queueDepth})`);
                qualityTracker.trackFilterAction(churchId, 'AGE', 'drop_stale');
                logEmissionDecision(evalLog, {
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    decision: 'drop',
                    reason: ageDecision.reason,
                    ageDecision,
                    source: 'legacy_age_budget',
                    latencyTxId,
                });
                logEmissionControllerShadow({
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    source: 'legacy_age_budget',
                    runtimeDecision: 'drop',
                    signals: {
                        ageMs: ageDecision.ageMs,
                        queueDepth: ageDecision.queueDepth,
                        providerHealthy: areProvidersHealthyForEmission(ttsEnabled),
                        ttsEnabled,
                        activeLanguages: languagesToTranslate.length,
                        activeGenders: 0,
                    },
                });
                continue;
            }
            const controllerAudioSkip = runtimeEmissionDecision?.action === 'audio_skip';
            const legacyTextOnly = ageDecision.action === 'text_only_stale' || controllerAudioSkip || !ttsEnabled;
            const emissionMetadata = deriveRuntimeEmissionMetadata({
                decision: legacyTextOnly ? 'audio_skip' : 'tts',
                ageDecision,
                runtimeDecision: runtimeEmissionDecision,
            });

            // QW-7: Track emitted translation in committed prefix
            commitTranslation(
                churchId,
                result.language,
                result.text,
                { contextMode: result.contextMode },
            );

            const dupCounts = result.dupCounts || { adjacentWordDups: 0, bigramDups: 0, trigramDups: 0, totalWordDups: 0 };
            qualityTracker.trackEmission(churchId, result.language, {
                repetitions: dupCounts,
                sourceText: text,
                latency: { translationMs: _evalTransMs },
            });

            console.log(`[DEBUG] 📤 Broadcasting translation to ${churchId}/${result.language}`);
            evalLog({ stage: 'translation', churchId, emissionId: _emissionId, session_epoch: releaseMeta?.sessionEpoch ?? null, release_seq: releaseMeta?.releaseSeq ?? null, source_hash: releaseMeta?.sourceHash ?? null, src: text, lang: result.language, translation: result.text, latency_ms: _evalTransMs, prompt_tokens: result.promptTokens || 0, cached_tokens: result.cachedTokens || 0, ...sourceLineageFields(releaseMeta), ...(drainMeta ? { source: 'disconnect_drain', drainId: drainMeta.drainId, tailItemId: drainMeta.tailItemId } : {}), ...(emissionCompleteness ? { emission_completeness: emissionCompleteness } : {}) });

            let acceptedForEmission = false;
            if (ageDecision.action === 'text_only_stale' || controllerAudioSkip) {
                if (ageDecision.action === 'text_only_stale') {
                    qualityTracker.trackFilterAction(churchId, 'AGE', 'text_only_stale');
                }
                if (controllerAudioSkip) {
                    qualityTracker.trackFilterAction(churchId, 'EMISSION_CONTROLLER', 'audio_skip');
                }
                logEmissionDecision(evalLog, {
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    decision: 'audio_skip',
                    reason: emissionMetadata.emissionReason,
                    ageDecision,
                    ageMs: runtimeEmissionDecision?.ageMs,
                    queueDepth: runtimeEmissionDecision?.queueDepth,
                    source: controllerAudioSkip ? 'legacy_emission_controller' : 'legacy_age_budget',
                    latencyTxId,
                });
                logEmissionControllerShadow({
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    source: 'legacy_age_budget',
                    runtimeDecision: 'audio_skip',
                    signals: {
                        ageMs: ageDecision.ageMs,
                        queueDepth: ageDecision.queueDepth,
                        providerHealthy: areProvidersHealthyForEmission(ttsEnabled),
                        ttsEnabled,
                        activeLanguages: languagesToTranslate.length,
                        activeGenders: 0,
                    },
                });
                noTtsResults.push({ ...result, textOnly: true, ageBudget: ageDecision, ...emissionMetadata });
                acceptedForEmission = true;
            } else if (ttsEnabled) {
                qualityTracker.trackFilterAction(churchId, 'AGE', 'normal_tts');
                const genders = getActiveGendersForLanguage(churchId, result.language);
                if (genders.length > 0) {
                    revisionAdmissionShadow.observeCheckpoint({
                        churchId,
                        ticket: releaseMeta?.revisionTicket || null,
                        language: result.language,
                        emissionId: _emissionId,
                        checkpoint: 'accepted_output_pre_tts',
                    });
                }
                for (const gender of genders) {
                    ttsJobs.push({ result: { ...result, ...emissionMetadata }, gender });
                }
                acceptedForEmission = genders.length > 0;
            } else {
                logEmissionDecision(evalLog, {
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    decision: 'audio_skip',
                    reason: 'tts_disabled',
                    ageDecision,
                    source: 'legacy_tts_disabled',
                    latencyTxId,
                });
                logEmissionControllerShadow({
                    churchId,
                    emissionId: _emissionId,
                    language: result.language,
                    source: 'legacy_tts_disabled',
                    runtimeDecision: 'audio_skip',
                    signals: {
                        ageMs: ageDecision.ageMs,
                        queueDepth: ageDecision.queueDepth,
                        providerHealthy: areProvidersHealthyForEmission(false),
                        ttsEnabled: false,
                        activeLanguages: languagesToTranslate.length,
                        activeGenders: 0,
                    },
                });
                noTtsResults.push({ ...result, ...emissionMetadata });
                acceptedForEmission = true;
            }
            if (acceptedForEmission) {
                commitDedupHistories({
                    lang: result.language,
                    t5Text: t5HistoryCandidate,
                    bclText: result.text,
                    emissionId: _emissionId,
                });
            }
        }

        // Broadcast non-TTS translations immediately
        for (const result of noTtsResults) {
            const msg = {
                type: 'translation',
                originalText: text,
                translatedText: result.text,
                language: result.language,
                languageName: config.languageNames[result.language],
                textOnly: result.textOnly === true,
                emissionMode: result.emissionMode || null,
                emissionReason: result.emissionReason || null
            };
            if (latencyTxId) msg.txId = latencyTxId;
            const _sentCount = broadcastToLanguage(churchId, result.language, msg);
            logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender: null, listenersServed: _sentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });
            state.stats.translations++;
            console.log(`  [${result.language.toUpperCase()}] ✅ translation completed (${result.text.length} characters)`);
        }

        // TTS dispatch (Project A A3.3: feature-flagged parallel vs legacy)
        if (ttsJobs.length > 0) {
            if (BROADCAST_PARALLEL) {
                // Scenario A: per-(lang,gender) immediate broadcast after TTS
                const _ttsAllStart = Date.now();
                const ttsPromises = ttsJobs.map(async ({ result, gender }) => {
                    try {
                        const _evalTtsStart = Date.now();

                        if (TTS_PROGRESSIVE_ENABLED) {
                            // projectTTS 3a.2: progressive mode — text first, then per-sentence chunks
                            const textMsg = {
                                type: 'translation',
                                originalText: text,
                                translatedText: result.text,
                                language: result.language,
                                languageName: config.languageNames[result.language],
                                progressive: true,
                                emissionMode: result.emissionMode || null,
                                emissionReason: result.emissionReason || null
                            };
                            if (latencyTxId) textMsg.txId = latencyTxId;
                            const _textSentCount = broadcastToLanguageGender(churchId, result.language, gender, textMsg);

                            let firstChunkMs = null;
                            let chunkCount = 0;
                            let nullCount = 0;
                            let totalSentencesSeen = 0;

                            const onChunk = (audioBase64, sentenceIdx, totalSentences, isLast, sentenceText) => {
                                totalSentencesSeen = totalSentences;
                                if (audioBase64 === null || audioBase64 === undefined) {
                                    nullCount++;
                                }
                                if (firstChunkMs === null) {
                                    firstChunkMs = Date.now() - _evalTtsStart;
                                }
                                broadcastProgressiveTtsChunk({
                                    churchId,
                                    emissionId: _emissionId,
                                    releaseMeta,
                                    language: result.language,
                                    gender,
                                    sentenceIndex: sentenceIdx,
                                    totalSentences,
                                    sentenceText,
                                    audioBase64,
                                    isLast,
                                    latencyTxId,
                                    emissionMode: result.emissionMode || null,
                                    emissionReason: result.emissionReason || null,
                                });
                                chunkCount++;
                            };

                            await synthesizeSpeechProgressive(
                                result.text,
                                result.language,
                                gender,
                                onChunk,
                                ttsRequestTelemetry({ churchId, emissionId: _emissionId, releaseMeta }),
                            );

                            const _evalTtsMs = Date.now() - _evalTtsStart;
                            evalLog({
                                stage: 'tts',
                                churchId,
                                emissionId: _emissionId,
                                lang: result.language,
                                gender,
                                latency_ms: _evalTtsMs,
                                mode: 'progressive',
                                emission_mode: result.emissionMode || null,
                                emission_reason: result.emissionReason || null,
                                chunks: chunkCount,
                                null_chunks: nullCount,
                                total_sentences: totalSentencesSeen,
                                first_chunk_ms: firstChunkMs,
                                ...sourceLineageFields(releaseMeta),
                            });
                            logEmissionDecision(evalLog, {
                                churchId,
                                emissionId: _emissionId,
                                language: result.language,
                                gender,
                                decision: 'emit',
                                reason: 'progressive_tts',
                                ageMs: queuedAt ? Date.now() - queuedAt : 0,
                                queueDepth: queueDepthAtDequeue,
                                source: 'legacy_parallel_tts',
                                latencyTxId,
                                firstAudioMs: firstChunkMs,
                                listenersServed: _textSentCount,
                                progressive: true,
                            });
                            logEmissionControllerShadow({
                                churchId,
                                emissionId: _emissionId,
                                language: result.language,
                                gender,
                                source: 'legacy_parallel_tts',
                                runtimeDecision: 'emit',
                                signals: {
                                    ageMs: queuedAt ? Date.now() - queuedAt : 0,
                                    queueDepth: queueDepthAtDequeue,
                                    providerHealthy: nullCount === 0,
                                    ttsEnabled: true,
                                    activeLanguages: languagesToTranslate.length,
                                    activeGenders: 1,
                                },
                            });

                            if (nullCount > 0) {
                                logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: `null_chunks_${nullCount}_of_${totalSentencesSeen}` });
                            }

                            logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, listenersServed: _textSentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });

                            console.log(`  [${result.language.toUpperCase()}/${gender}] 🔄 progressive: ${chunkCount}/${totalSentencesSeen} chunks, first@${firstChunkMs}ms, total ${_evalTtsMs}ms → ${_textSentCount} listeners`);
                            return { lang: result.language, gender, ttsMs: _evalTtsMs, sentCount: _textSentCount, progressive: true, chunks: chunkCount };
                        }

                        // Legacy non-progressive path (UNCHANGED)
                        const audioBase64 = await synthesizeSpeech(
                            result.text,
                            result.language,
                            gender,
                            ttsRequestTelemetry({ churchId, emissionId: _emissionId, releaseMeta }),
                        );
                        const _evalTtsMs = Date.now() - _evalTtsStart;
                        evalLog({
                            stage: 'tts',
                            churchId,
                            emissionId: _emissionId,
                            lang: result.language,
                            gender,
                            latency_ms: _evalTtsMs,
                            emission_mode: result.emissionMode || null,
                            emission_reason: result.emissionReason || null,
                            ...sourceLineageFields(releaseMeta),
                        });

                        // OQ3: synthesizeSpeech catches internally, returns null on error
                        if (audioBase64 === null) {
                            logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: 'null_audio' });
                        }

                        // IMMEDIATE broadcast for this (lang, gender) — core Scenario A change
                        const msg = {
                            type: 'translation',
                            emissionId: _emissionId,
                            release_seq: releaseMeta?.releaseSeq ?? null,
                            source_hash: releaseMeta?.sourceHash ?? null,
                            originalText: text,
                            translatedText: result.text,
                            language: result.language,
                            languageName: config.languageNames[result.language],
                            emissionMode: result.emissionMode || null,
                            emissionReason: result.emissionReason || null,
                            ...revisionAdmissionTelemetry(releaseMeta),
                        };
                        if (latencyTxId) {
                            msg.txId = latencyTxId;
                            const audioCapturedAtSrv = getAudioCapturedAt(latencyTxId);
                            if (audioCapturedAtSrv) msg.audioCapturedAt = audioCapturedAtSrv;
                        }
                        if (audioBase64) {
                            msg.audioBase64 = audioBase64;
                            msg.audioFormat = 'mp3';
                        }
                        const _sentCount = broadcastToLanguageGender(churchId, result.language, gender, msg);
                        logEmissionDecision(evalLog, {
                            churchId,
                            emissionId: _emissionId,
                            language: result.language,
                            gender,
                            decision: 'emit',
                            reason: audioBase64 ? 'tts_audio' : 'tts_null_audio',
                            ageMs: queuedAt ? Date.now() - queuedAt : 0,
                            queueDepth: queueDepthAtDequeue,
                            source: 'legacy_parallel_tts',
                            latencyTxId,
                            firstAudioMs: _evalTtsMs,
                            listenersServed: _sentCount,
                            progressive: false,
                        });
                        logEmissionControllerShadow({
                            churchId,
                            emissionId: _emissionId,
                            language: result.language,
                            gender,
                            source: 'legacy_parallel_tts',
                            runtimeDecision: 'emit',
                            signals: {
                                ageMs: queuedAt ? Date.now() - queuedAt : 0,
                                queueDepth: queueDepthAtDequeue,
                                providerHealthy: audioBase64 !== null,
                                ttsEnabled: true,
                                activeLanguages: languagesToTranslate.length,
                                activeGenders: 1,
                            },
                        });
                        logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, listenersServed: _sentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });

                        console.log(`  [${result.language.toUpperCase()}/${gender}] ✅ TTS ${_evalTtsMs}ms → ${_sentCount} listeners`);
                        return { lang: result.language, gender, ttsMs: _evalTtsMs, sentCount: _sentCount };
                    } catch (err) {
                        logTTSError({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, reason: 'exception', error: err.message });
                        return { lang: result.language, gender, ttsMs: 0, sentCount: 0, error: err.message };
                    }
                });

                await Promise.allSettled(ttsPromises);
                console.log(`[TTS] Parallel dispatch: ${ttsJobs.length} jobs in ${Date.now() - _ttsAllStart}ms`);

                // Stats
                const uniqueLangs = new Set(ttsJobs.map(j => j.result.language));
                state.stats.translations += uniqueLangs.size;

            } else {
                // Legacy: Promise.all → broadcast all after completion (pre-Scenario A behaviour)
                const _ttsAllStart = Date.now();
                const ttsResults = await Promise.all(
                    ttsJobs.map(async ({ result, gender }) => {
                        const _evalTtsStart = Date.now();
                        const audioBase64 = await synthesizeSpeech(
                            result.text,
                            result.language,
                            gender,
                            ttsRequestTelemetry({ churchId, emissionId: _emissionId, releaseMeta }),
                        );
                        const _evalTtsMs = Date.now() - _evalTtsStart;
                        evalLog({
                            stage: 'tts',
                            churchId,
                            emissionId: _emissionId,
                            lang: result.language,
                            gender,
                            latency_ms: _evalTtsMs,
                            emission_mode: result.emissionMode || null,
                            emission_reason: result.emissionReason || null,
                            ...sourceLineageFields(releaseMeta),
                        });
                        return { result, gender, audioBase64, ttsMs: _evalTtsMs };
                    })
                );
                console.log(`[TTS] ⚡ ${ttsJobs.length} jobs completed in parallel: ${Date.now() - _ttsAllStart}ms`);

                for (const { result, gender, audioBase64, ttsMs } of ttsResults) {
                    const msg = {
                        type: 'translation',
                        emissionId: _emissionId,
                        release_seq: releaseMeta?.releaseSeq ?? null,
                        source_hash: releaseMeta?.sourceHash ?? null,
                        originalText: text,
                        translatedText: result.text,
                        language: result.language,
                        languageName: config.languageNames[result.language],
                        emissionMode: result.emissionMode || null,
                        emissionReason: result.emissionReason || null,
                        ...revisionAdmissionTelemetry(releaseMeta),
                    };
                    if (latencyTxId) {
                        msg.txId = latencyTxId;
                        const audioCapturedAtSrv = getAudioCapturedAt(latencyTxId);
                        if (audioCapturedAtSrv) msg.audioCapturedAt = audioCapturedAtSrv;
                    }
                    if (audioBase64) {
                        msg.audioBase64 = audioBase64;
                        msg.audioFormat = 'mp3';
                    }
                    const _sentCount = broadcastToLanguageGender(churchId, result.language, gender, msg);
                    logEmissionDecision(evalLog, {
                        churchId,
                        emissionId: _emissionId,
                        language: result.language,
                        gender,
                        decision: 'emit',
                        reason: audioBase64 ? 'tts_audio' : 'tts_null_audio',
                        ageMs: queuedAt ? Date.now() - queuedAt : 0,
                        queueDepth: queueDepthAtDequeue,
                        source: 'legacy_barrier_tts',
                        latencyTxId,
                        firstAudioMs: ttsMs,
                        listenersServed: _sentCount,
                        progressive: false,
                    });
                    logEmissionControllerShadow({
                        churchId,
                        emissionId: _emissionId,
                        language: result.language,
                        gender,
                        source: 'legacy_barrier_tts',
                        runtimeDecision: 'emit',
                        signals: {
                            ageMs: queuedAt ? Date.now() - queuedAt : 0,
                            queueDepth: queueDepthAtDequeue,
                            providerHealthy: audioBase64 !== null,
                            ttsEnabled: true,
                            activeLanguages: languagesToTranslate.length,
                            activeGenders: 1,
                        },
                    });
                    logBroadcastStage({ emissionId: _emissionId, releaseMeta, churchId, lang: result.language, gender, listenersServed: _sentCount, sourceEmitMs: _evalTransStart, drainMeta, emissionCompleteness });
                }

                const uniqueLangs = new Set(ttsJobs.map(j => j.result.language));
                state.stats.translations += uniqueLangs.size;
                for (const lang of uniqueLangs) {
                    const r = ttsJobs.find(j => j.result.language === lang).result;
                    console.log(`  [${lang.toUpperCase()}] ✅ translation completed (${r.text.length} characters)`);
                }
            }
        }

        // Complete latency tracking (broadcast done)
        if (latencyTxId) {
            const latencyResult = completeLatencyTracking(latencyTxId);
            if (latencyResult) {
                const upload = latencyResult.capture_to_gateway !== null ? ` | Upload: ${latencyResult.capture_to_gateway}ms` : '';
                console.log(`[LATENCY] Server E2E: ${latencyResult.end_to_end}ms | Whisper: ${latencyResult.whisper_processing}ms | Translation: ${latencyResult.translation_processing}ms${upload}`);
            }
        }
    } catch (error) {
        console.error('[TRANSLATE] ❌ Pipeline error:', error.message);
        // Complete tracking even on error
        if (latencyTxId) {
            completeLatencyTracking(latencyTxId);
        }
    }
}

// ============================================================
// Broadcast Helpers
// ============================================================
function broadcastToChurch(churchId, message) {
    const subs = state.subscriptions.get(churchId);
    if (!subs) return;

    const data = JSON.stringify(message);
    for (const clients of subs.values()) {
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
    }
}

function broadcastToLanguage(churchId, language, message, options = {}) {
    const subs = state.subscriptions.get(churchId);
    const clients = subs?.get(language);

    if (!clients || clients.size === 0) {
        console.log(`[DEBUG] ⚠️ broadcastToLanguage: No clients for ${churchId}/${language}`);
        return 0;
    }

    const data = JSON.stringify(message);
    let sentCount = 0;
    for (const client of clients) {
        const listenerSessionId = state.clientListenerSessionIds.get(client);
        const isTarget = !options.targetListenerSessionIds
            || options.targetListenerSessionIds.has(listenerSessionId);
        const isExcluded = options.excludeListenerSessionIds?.has(listenerSessionId) === true;
        if (isTarget && !isExcluded && client.readyState === WebSocket.OPEN) {
            client.send(data);
            sentCount++;
        }
    }
    console.log(`[DEBUG] ✅ broadcastToLanguage: Sent to ${sentCount}/${clients.size} clients for ${churchId}/${language}`);
    return sentCount;
}

/**
 * Get unique voice genders subscribed for a given church + language
 * @param {string} churchId
 * @param {string} language
 * @returns {string[]} Array of unique genders ('male', 'female')
 */
function hasDeliveryRecipients(
    churchId,
    language,
    targetListenerSessionIds = null,
    excludeListenerSessionIds = null,
) {
    const subs = state.subscriptions.get(churchId);
    const clients = subs?.get(language);
    if (!clients || clients.size === 0) return false;

    return [...clients].some((client) => {
        if (client.readyState !== WebSocket.OPEN) return false;
        const listenerSessionId = state.clientListenerSessionIds.get(client);
        return (!targetListenerSessionIds || targetListenerSessionIds.has(listenerSessionId))
            && excludeListenerSessionIds?.has(listenerSessionId) !== true;
    });
}

function getActiveGendersForLanguage(
    churchId,
    language,
    targetListenerSessionIds = null,
    excludeListenerSessionIds = null,
) {
    const subs = state.subscriptions.get(churchId);
    const clients = subs?.get(language);
    if (!clients || clients.size === 0) return [];

    const genders = new Set();
    for (const client of clients) {
        const listenerSessionId = state.clientListenerSessionIds.get(client);
        if (targetListenerSessionIds && !targetListenerSessionIds.has(listenerSessionId)) continue;
        if (excludeListenerSessionIds?.has(listenerSessionId) === true) continue;
        if (client.readyState !== WebSocket.OPEN) continue;
        const gender = state.clientVoiceGenders.get(client) || 'male';
        genders.add(gender);
    }
    return [...genders];
}

/**
 * Broadcast message to clients of a specific church/language/gender
 * Clients without a stored gender preference default to 'male'
 */
function broadcastToLanguageGender(churchId, language, gender, message, options = {}) {
    const subs = state.subscriptions.get(churchId);
    const clients = subs?.get(language);
    if (!clients || clients.size === 0) return 0;

    const data = JSON.stringify(message);
    let sentCount = 0;
    for (const client of clients) {
        const clientGender = state.clientVoiceGenders.get(client) || 'male';
        const listenerSessionId = state.clientListenerSessionIds.get(client);
        const isTarget = !options.targetListenerSessionIds
            || options.targetListenerSessionIds.has(listenerSessionId);
        const isExcluded = options.excludeListenerSessionIds?.has(listenerSessionId) === true;
        if (isTarget && !isExcluded && clientGender === gender && client.readyState === WebSocket.OPEN) {
            client.send(data);
            sentCount++;
            if (listenerSessionId && message.type === 'tts_chunk') {
                const sourceSpans = options.releaseMeta?.sourceLineageEnabled
                    ? sourceLineageTelemetry(options.releaseMeta.sourceLineage).source_spans
                    : [];
                const ledgerResult = listenerPlayoutLedger.recordBroadcast({
                    churchId,
                    listenerSessionId,
                    chunk: { ...message, synthesized: options.synthesized === true },
                    sourceSpans,
                });
                evalLog({
                    stage: 'listener_playout_ledger',
                    churchId,
                    lang: language,
                    listener_session_id: listenerSessionId,
                    chunk_key: `${message.session_epoch}:${message.release_seq}:${message.language}`
                        + `${message.delivery_unit_id ? `:${message.delivery_unit_id}` : ''}`
                        + `:${message.sentence_index}`,
                    session_epoch: message.session_epoch,
                    outcome: 'broadcast',
                    accepted: ledgerResult.accepted === true,
                    duplicate: ledgerResult.duplicate === true,
                    reason: ledgerResult.reason || null,
                    synthesized: options.synthesized === true,
                });
            }
        }
    }
    if (sentCount > 0) {
        console.log(`[DEBUG] ✅ broadcastToLanguageGender: Sent to ${sentCount} clients for ${churchId}/${language}/${gender}`);
    }
    return sentCount;
}

function broadcastToAll(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    }
}

function getActiveLanguages(churchId) {
    const subs = state.subscriptions.get(churchId);
    if (!subs) return [];
    return [...subs.entries()].filter(([_, clients]) => clients.size > 0).map(([lang]) => lang);
}

function getListenerCount(churchId) {
    const subs = state.subscriptions.get(churchId);
    if (!subs) return 0;
    return [...subs.values()].reduce((sum, clients) => sum + clients.size, 0);
}

// ============================================================
// Start Server
// ============================================================
server.listen(config.port, () => {
    const status = getServiceStatus();
    const cacheStats = getCacheStats();
    const sentenceStats = getSentenceServiceStats();
    const audioStats = getAudioServiceStats();

    const whisperStat = getWhisperStats();

    console.log('');
    console.log('============================================================');
    console.log('  BARNABAS Translation Server (Phase 1 + 6)');
    console.log('============================================================');
    console.log(`  HTTP:      http://localhost:${config.port}`);
    console.log(`  WebSocket: ws://localhost:${config.port}/ws`);
    console.log(`  Health:    http://localhost:${config.port}/health`);
    console.log('------------------------------------------------------------');
    console.log('  Translation Backend:');
    if (status.available) {
        console.log(`    ✓ GPT-4.1-mini (Azure OpenAI)`);
        console.log(`    ✓ Endpoint: ${status.endpoint || 'configured'}`);
    } else {
        console.log('    ✗ GPT-4.1-mini (not configured)');
    }
    console.log('------------------------------------------------------------');
    console.log('  Features:');
    console.log('    - Glossary: 252 theological terms (5 languages)');
    console.log('    - Swiss German normalization (85 mappings)');
    console.log(`    - Liturgical cache: ${cacheStats.totalPhrases} phrases (${cacheStats.mode} mode)`);
    console.log('    - User authentication: PIN + QR codes');
    console.log('    - Broadcaster protection: Master password');
    console.log('------------------------------------------------------------');
    console.log('  Phase 1 + C - Whisper ASR (Swiss German):');
    if (whisperEnabled) {
        console.log(`    ✓ Whisper ASR enabled`);
        console.log(`    ✓ Mode: REMOTE (Python faster-whisper)`);
        console.log(`    ✓ Service URL: ${process.env.WHISPER_SERVICE_URL}`);
        console.log(`    ✓ Model: ${whisperStat.model || 'loading...'}`);
        console.log(`    ✓ Device: ${whisperStat.device}`);
        console.log(`    ✓ Status: ${whisperStat.isReady ? 'Ready' : 'Initializing...'}`);
    } else {
        console.log('    ✗ Whisper ASR disabled (WHISPER_ENABLED=false)');
    }
    console.log('------------------------------------------------------------');
    console.log('  Phase 6 - Audio & Sentence Processing:');
    console.log(`    ✓ Sentence boundary detection (max ${sentenceStats.config.maxChunkLength} chars)`);
    console.log(`    ✓ ${sentenceStats.thoughtStarters} German thought-starter patterns`);
    console.log(`    ✓ Audio quality monitoring (VAD threshold: ${audioStats.config.vadThreshold})`);
    console.log(`    ✓ Voice Activity Detection (${audioStats.config.vadFrameSize} sample frames)`);
    console.log('============================================================');
    console.log('');

    // Server-side TTS info
    console.log('  Server-side TTS:');
    if (isTtsEnabled()) {
        console.log(`    ✓ Azure Speech TTS: ENABLED`);
        console.log(`    ✓ Region: ${process.env.AZURE_SPEECH_REGION}`);
    } else {
        console.log(`    ✗ Disabled (USE_SERVER_TTS=${process.env.USE_SERVER_TTS || 'not set'})`);
    }
    console.log('============================================================');
    console.log('');

    // Smooth Mode info
    if (config.smoothMode.enabled) {
        console.log('  Smooth Mode (26.01.2026):');
        console.log(`    ✓ Initial buffer: ${config.smoothMode.initialBufferSec}s`);
        console.log(`    ✓ Min sentences: ${config.smoothMode.minSentences}`);
        console.log(`    ✓ Early release: ${config.smoothMode.earlyReleaseMs}ms`);
        console.log(`    ✓ Max hold time: ${config.smoothMode.maxHoldMs}ms`);
        console.log('============================================================');
        console.log('');
    }
});

// Graceful shutdown: flush quality tracking data before exit
async function gracefulShutdown(signal) {
    console.log(`[SERVER] ${signal} received — flushing quality tracking...`);
    for (const churchId of state.churches.keys()) {
        qualityTracker.flushSessionSummary(churchId, signal);
    }
    qualityTracker.flushSync();
    const evalStats = await flushEvalLog();
    console.log(`[SERVER] Quality tracking and eval logs flushed (eval_written=${evalStats.written}, eval_dropped=${evalStats.dropped}). Exiting.`);
    process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

// ============================================================
// Smooth Mode Safety Interval (26.01.2026)
// Checks accumulators for timeout every 2 seconds
// ============================================================
if (config.deadlineFallback.enabled) {
    const deadlineFallbackTimer = setInterval(() => {
        checkDeadlineFallbacks().catch(err => console.error('[DEADLINE_FALLBACK]', err && err.message));
    }, config.deadlineFallback.checkIntervalMs);
    if (deadlineFallbackTimer.unref) deadlineFallbackTimer.unref();
    console.log(`[Config] Deadline Fallback: ENABLED (timeout=${config.deadlineFallback.timeoutMs}ms, check=${config.deadlineFallback.checkIntervalMs}ms)`);
    // Print the three flags that decide WHICH deadline semantics run, so a deploy can be
    // confirmed from the log alone instead of by reading env and inferring. The validated 4.52 config
    // is exactly: provisional=true, reviewFixes=false, suppressAgeBudget=false.
    // Any other combination is NOT the validated state.
    const dfFlags = `provisional=${config.deadlineFallback.provisionalEnabled}, reviewFixes=${config.deadlineFallback.reviewFixesEnabled}, suppressAgeBudget=${config.deadlineFallback.suppressAgeBudget}`;
    const is452 = config.deadlineFallback.provisionalEnabled
        && !config.deadlineFallback.reviewFixesEnabled
        && !config.deadlineFallback.suppressAgeBudget;
    console.log(`[Config] Deadline semantics: ${dfFlags} -> ${is452 ? 'VALIDATED 4.52 (pinned baseline)' : 'NOT the validated 4.52 combination'}`);
}

if (config.smoothMode.enabled) {
    setInterval(async () => {
        for (const [churchId, accumulator] of state.smoothAccumulators.entries()) {
            const phaseState = state.smoothPhases.get(churchId);
            if (!phaseState || phaseState.phase !== 'streaming') {
                continue; // Only check during streaming phase
            }

            const release = accumulator.checkTimeout();
            if (release) {
                console.log(`[SmoothMode] ${churchId}: Safety timeout release: ${release.sentenceCount} sentences`);
                await processCompleteSentence(churchId, release.text, null, { origin: 'smooth_timeout', releaseReason: 'safety_timeout', sourceLineage: release.sourceLineage });
            }
        }
    }, 2000); // Check every 2 seconds
}

// ============================================================
// Whisper Auto-Shutdown Interval (05.02.2026)
// Checks for inactivity every minute and stops container if idle
// Security: Uses execFile (not exec), 30s timeout, state machine
// ============================================================
if (config.whisperAutoShutdown.enabled) {
    startWhisperInactivityMonitoring();
} else {
    console.log('[WhisperAutoShutdown] Disabled via WHISPER_AUTO_SHUTDOWN=false');
}
