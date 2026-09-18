/**
 * INTRA trim telemetry (31.07.2026) — regression guard for `trim_events[stage=INTRA]`.
 *
 * BUG: server.js read `intraResult.original` for `before_words`, but
 * cleanupIntraEmissionAsync never returns an `original` field (it returns
 * text/decisions/removedUnits/...). `String(undefined || '')` -> `before_words: 0`
 * for every emission actually trimmed by INTRA. The aggregate `trim_ratio` in
 * `source_release_outcome` was NOT affected (it is computed independently from
 * releaseOriginalWordCount/finalWordCount), but the per-stage detail was — so the
 * telemetry could not answer "which filter cut how much", and INTRA looked like a
 * stage that trims text out of nothing.
 *
 * This test runs the REAL emission path: the server.js source slice covering
 * B2/P2/B4/P3/INTRA + processCompleteSentence is executed in a vm sandbox
 * (same technique as b4RhetoricalRepeatPolicy.test.mjs) against the REAL
 * intraEmissionDedupService. Filters are not reimplemented here, so a mutation
 * back to `intraResult.original` turns the first assertion red.
 */

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, cleanupIntraEmissionAsync } from '../intraEmissionDedupService.js';
import { stampEmittedSourceIdentity } from '../emittedSourceIdentity.js';
import {
    missingSourceLineage,
    projectSourceLineage,
    sourceLineageTelemetry,
    sourceWordCount,
} from '../sourceLineage.js';
import { safeSourceBoundaryWordIndexes } from '../sourceBoundaryMap.js';
import { buildSourceUnits, createSourceSemanticRepeatShadow } from '../sourceSemanticRepeatShadow.js';
import { assertContextProvides, buildPipelineSlice } from './helpers/serverPipelineSlice.mjs';

const pipelineSource = buildPipelineSlice(import.meta.url);

// A SmoothMode batch carrying a P1 self-correction: unit 2 supersedes unit 1.
// The shared prefix is deliberately 9 words: P3 (6-gram, MIN_DISTANCE 12) does NOT
// fire on it, so INTRA is the only stage that trims this release and `trim_events`
// carries exactly one entry. Verified below by asserting the event count.
const CORRECTION_BATCH = [
    'Und Hiob spricht über die Ruhe in der Prüfung.',
    'Und Hiob spricht über die Ruhe in der Prüfung Gottes, die er behalten will.',
    'Das ist die zweite Perspektive.',
].join(' ');

const noop = () => {};

/** Runs the real processCompleteSentence and returns every evalLog record it emitted. */
async function runEmissionPath(text) {
    const evalRecords = [];
    const enqueued = [];

    const context = {
        console: { log: noop, warn: noop, error: noop },
        Date,
        Math,
        JSON,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Map,
        Set,
        parseInt,
        parseFloat,

        // --- observability under test ---
        evalLog: record => evalRecords.push(record),
        // Flags declared ABOVE the slice in server.js, so the sandbox must supply
        // them. assertContextProvides() below fails loudly when a new one appears.
        B4_RHETORICAL_REPEAT_APPLY_ENABLED: false,
        FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED: false,
        FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED: false,
        FQF_SOURCE_LINEAGE_ENABLED: false,
        FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED: false,
        _sessionEpoch: 'epoch-test',

        // --- INTRA: the real service, DEV production config (flag ON, semantic OFF) ---
        cleanupIntraEmissionAsync,
        INTRA_EMISSION_DEDUP_CONFIG: {
            ...DEFAULT_CONFIG,
            enabled: true,
            semanticEnabled: false,
            semanticDryRun: true,
        },
        embedTextForDedup: null,

        // --- source-release audit identity (shape only; not under test) ---
        logSourceReleaseAudit: (churchId, srcText, origin, releaseReason) => ({
            sessionEpoch: 'epoch-test',
            releaseSeq: 1,
            sourceHash: 'pre-filter-hash',
            sourceLen: String(srcText || '').length,
            origin: origin ?? null,
            releaseReason: releaseReason ?? null,
        }),
        releaseIdentityFields: meta => ({
            session_epoch: meta?.sessionEpoch ?? null,
            release_seq: meta?.releaseSeq ?? null,
            source_hash: meta?.sourceHash ?? null,
        }),
        stampEmittedSourceIdentity,
        missingSourceLineage,
        projectSourceLineage,
        sourceLineageTelemetry,
        sourceWordCount,
        safeSourceBoundaryWordIndexes,
        sourceLineageFields: () => ({}),

        // --- P2.7 (05.08): pre-policy reference record + shadow, both inert here.
        // The reference event is emitted unconditionally by the emission path, so the
        // sandbox must provide its builder; the shadow itself stays off (flag default).
        buildSourceUnits,
        // Server-shaped wiring: raw env map + a real instance exposing the normalized config.
        SOURCE_SEMANTIC_REPEAT_SHADOW_CONFIG: { enabled: false },
        sourceSemanticRepeatShadow: {
            config: createSourceSemanticRepeatShadow({ embedFn: async () => [1, 0, 0], config: { enabled: false } }).config,
            observe: () => 0,
        },
        observeFallbackCoordinatorShadowAtAcceptedEnqueue: noop,
        coordinateFallbackCoordinatorApplyBeforeEnqueue: async () => ({
            action: 'enqueue_full',
            reason: 'apply_disabled',
            observedBeforeEnqueue: false,
        }),
        cancelFallbackCoordinatorObservation: noop,
        sourceTextLedgerShadow: { observe: () => null },
        revisionAdmissionShadow: {
            preflightAccepted: () => ({ decision: 'accept', accept: true, reason: 'test' }),
            registerAccepted: () => null,
        },

        // --- upstream stages disabled so the only trim in this run is INTRA ---
        config: {
            deadlineFallback: { provisionalEnabled: false, reviewFixesEnabled: false },
            holdN: { enabled: false, words: 5 },
            targetLanguages: ['pl'],
        },
        state: {
            fallbackState: new Map(),
            holdNEmitters: new Map(),
            lastSentTexts: new Map(),
            emissionNgramHistory: new Map(),
            emissionFullHistory: new Map(),
            subscriptions: new Map(),
            sermonContext: new Map(),
            stats: { sentencesProcessed: 0, whisperTranscriptions: 0 },
        },
        HG_DEDUP_ENABLED: false,
        hgDedupService: null,
        supersedeDecisionFor: () => ({ action: 'emit' }),
        createHoldNEmitter: () => ({ apply: t => ({ emitText: t, heldWords: 0, heldText: '' }) }),

        // --- downstream: capture, do not translate ---
        qualityTracker: {
            resetPendingFilters: noop,
            trackDEInput: noop,
            trackFilterAction: noop,
            trackPipelineBlock: noop,
        },
        broadcastToChurch: noop,
        getActiveLanguages: () => ['pl'],
        getOrCreateTranslationQueue: () => ({
            depth: 0,
            enqueue: (item) => { enqueued.push(item); return true; },
        }),
        recordLatencyStage: noop,
        logEmissionDecision: noop,
        logEmissionControllerShadow: noop,
        areProvidersHealthyForEmission: () => true,
        isTtsEnabled: () => false,
        completeWhisperOnlyTracking: noop,
        dpNormWords: t => String(t || '').toLowerCase().split(/\s+/).filter(Boolean),
    };

    assertContextProvides(pipelineSource, context);
    vm.runInNewContext(pipelineSource, context);
    await context.processCompleteSentence('church-test', text, null, { origin: 'smooth_release' });

    return { evalRecords, enqueued };
}

describe('INTRA trim telemetry through the real emission path', () => {
    it('reports a real before_words for an emission trimmed by INTRA', async () => {
        const { evalRecords, enqueued } = await runEmissionPath(CORRECTION_BATCH);

        // The emission must actually reach the translation queue (full path, not a block).
        expect(enqueued).toHaveLength(1);

        // INTRA must have actually trimmed — otherwise this test proves nothing.
        const intraLog = evalRecords.find(r => r.stage === 'intra_emission_dedup');
        expect(intraLog?.action).toBe('trim');

        const outcome = evalRecords.find(r => r.stage === 'source_release_outcome');
        expect(outcome?.outcome).toBe('trimmed_emitted');

        // INTRA is the only trimming stage for this fixture — if an upstream filter
        // starts trimming it too, the isolation this test relies on is gone.
        expect(outcome.trim_events).toHaveLength(1);
        const intraEvent = outcome.trim_events.find(e => e.stage === 'INTRA');
        expect(intraEvent, 'source_release_outcome must carry an INTRA trim event').toBeDefined();

        // The regression guard. Pre-fix (`intraResult.original`) this was 0.
        expect(intraEvent.before_words).toBeGreaterThan(0);
        expect(intraEvent.after_words).toBeLessThan(intraEvent.before_words);
        expect(intraEvent.stage).toBe('INTRA');
    });

    it('counts before_words from the text INTRA actually received', async () => {
        const { evalRecords } = await runEmissionPath(CORRECTION_BATCH);

        const outcome = evalRecords.find(r => r.stage === 'source_release_outcome');
        const intraEvent = outcome.trim_events.find(e => e.stage === 'INTRA');

        // No upstream stage trims in this run, so INTRA's input is the raw release.
        const releaseWords = CORRECTION_BATCH.split(/\s+/).filter(Boolean).length;
        expect(intraEvent.before_words).toBe(releaseWords);
        expect(intraEvent.after_words).toBe(outcome.final_words);
    });

    it('keeps the aggregate trim_ratio independent of the per-stage detail', async () => {
        const { evalRecords } = await runEmissionPath(CORRECTION_BATCH);

        const outcome = evalRecords.find(r => r.stage === 'source_release_outcome');
        const releaseWords = CORRECTION_BATCH.split(/\s+/).filter(Boolean).length;

        // trim_ratio is computed from releaseOriginalWordCount/finalWordCount, NOT from
        // trim_events — it was correct even while before_words was broken. Pinned so a
        // future refactor cannot quietly rewire it onto the per-stage numbers.
        expect(outcome.trim_ratio).toBeCloseTo((releaseWords - outcome.final_words) / releaseWords, 4);
        expect(outcome.trim_ratio).toBeGreaterThan(0);
    });
});

describe('intraEmissionDedupService contract', () => {
    it('does not expose an `original` field (the shape server.js used to read)', async () => {
        const result = await cleanupIntraEmissionAsync(CORRECTION_BATCH, {
            ...DEFAULT_CONFIG,
            enabled: true,
        }, { embedFn: null });

        expect(result.action).toBe('trim');
        expect(result).not.toHaveProperty('original');
    });
});
