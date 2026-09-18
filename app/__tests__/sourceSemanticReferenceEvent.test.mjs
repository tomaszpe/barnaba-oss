/**
 * P2.7 pre-policy denominator (05.08.2026) — `source_semantic_reference`.
 *
 * Review blocker: R was being read from `translation.src`, which server.js logs AFTER
 * T5 (`translationDispatch.js:112`) and after age/controller drops. Anything those
 * block silently disappears from the denominator, so a future suppress could shrink
 * the very set it is measured against — the EC-4 self-improving-metric trap.
 *
 * The reference record therefore has to be emitted by the emission path itself,
 * BEFORE fan-out and independently of every downstream decision. This test runs the
 * REAL processCompleteSentence slice in a vm sandbox (same technique as
 * intraTrimTelemetry.test.mjs) and asserts exactly that, plus the second half of the
 * contract: shadow history advances ONLY for content that reached `queued`.
 */

import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, cleanupIntraEmissionAsync } from '../intraEmissionDedupService.js';
import { stampEmittedSourceIdentity } from '../emittedSourceIdentity.js';
import {
    missingSourceLineage,
    projectSourceLineage,
    sourceLineageFromWhisper,
    sourceLineageTelemetry,
    sourceWordCount,
} from '../sourceLineage.js';
import { safeSourceBoundaryWordIndexes } from '../sourceBoundaryMap.js';
import { buildSourceUnits, createSourceSemanticRepeatShadow } from '../sourceSemanticRepeatShadow.js';
import { PerChurchEnqueueSequencer } from '../fallbackCoordinatorApply.js';
import { assertContextProvides, buildPipelineSlice } from './helpers/serverPipelineSlice.mjs';

// EXACTLY the shape server.js assembles from the environment: only the tunables that have
// env vars. It has no `minUnitWords`/`minUnitContentTokens` — feeding it straight into
// `buildSourceUnits` makes every `words >= undefined` false, so every unit comes out
// `scorable: false` and the shadow measures nothing. The harness must therefore mirror the
// server's wiring, not hand the pipeline a richer config than production has.
const ENV_SHAPED_CONFIG = {
    enabled: true,
    windowSec: 150,
    maxHistoryUnits: 32,
    tauHighPrecision: 0.75,
    tauExploratory: 0.70,
    maxNewLexicalTokens: 2,
    maxQueueDepth: 32,
};

const pipelineSource = buildPipelineSlice(import.meta.url);

const noop = () => {};

const TEXT = 'Seneca hat schon ein Buch geschrieben. Das ist die zweite Perspektive.';

async function runEmissionPath(text, {
    activeLanguages = ['pl'],
    shadow = null,
    releaseSeq = 42,
    fqfEnabled = false,
    holdNApply = null,
    origin = 'smooth_release',
    queueAccepts = true,
    applyEnabled = false,
    coordinatorDecision = { action: 'enqueue_full', reason: 'not_a_collision', observedBeforeEnqueue: true },
    lineageEnabled = false,
} = {}) {
    const evalRecords = [];
    const enqueued = [];
    const observed = [];
    const fqf2Observed = [];
    const ledgerObserved = [];
    const revisionObserved = [];
    const revisionTicket = Object.freeze({
        version: 1, kind: 'single', ticketId: 'ticket-42', familyId: 'family-1', generation: 1,
    });

    const context = {
        console: { log: noop, warn: noop, error: noop },
        Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, parseInt, parseFloat,

        evalLog: (record) => evalRecords.push(record),
        // Flags declared ABOVE the slice in server.js, so the sandbox must supply
        // them. assertContextProvides() below fails loudly when a new one appears.
        B4_RHETORICAL_REPEAT_APPLY_ENABLED: false,
        FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED: fqfEnabled,
        FQF_FALLBACK_COORDINATOR_APPLY_RUNTIME_ENABLED: applyEnabled,
        FQF_SOURCE_LINEAGE_ENABLED: lineageEnabled,
        FQF_T4_SOURCE_RESEGMENTATION_V2_RUNTIME_ENABLED: false,
        _sessionEpoch: 'epoch-test',

        cleanupIntraEmissionAsync,
        INTRA_EMISSION_DEDUP_CONFIG: { ...DEFAULT_CONFIG, enabled: true, semanticEnabled: false, semanticDryRun: true },
        embedTextForDedup: null,

        logSourceReleaseAudit: (churchId, srcText, origin, releaseReason) => ({
            sessionEpoch: 'epoch-test',
            releaseSeq,
            sourceHash: 'pre-filter-hash',
            sourceLen: String(srcText || '').length,
            origin: origin ?? null,
            releaseReason: releaseReason ?? null,
        }),
        releaseIdentityFields: (meta) => ({
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
        sourceLineageFields: (meta) => meta?.sourceLineageEnabled
            ? sourceLineageTelemetry(meta.sourceLineage)
            : {},

        buildSourceUnits,
        // Same two objects the server has: the raw env map, and a real shadow instance whose
        // `config` getter exposes the NORMALIZED config. Swapping the emission path back to
        // the raw map turns `scorable_unit_count` to 0 and reddens this suite.
        SOURCE_SEMANTIC_REPEAT_SHADOW_CONFIG: ENV_SHAPED_CONFIG,
        sourceSemanticRepeatShadow: shadow || {
            config: createSourceSemanticRepeatShadow({ embedFn: async () => [1, 0, 0], config: ENV_SHAPED_CONFIG }).config,
            observe: (payload) => { observed.push(payload); return 1; },
        },
        observeFallbackCoordinatorShadowAtAcceptedEnqueue: (payload) => fqf2Observed.push(payload),
        coordinateFallbackCoordinatorApplyBeforeEnqueue: vi.fn(async () => coordinatorDecision),
        fallbackCoordinatorApplyEnqueueSequencer: new PerChurchEnqueueSequencer(),
        cancelFallbackCoordinatorObservation: noop,
        sourceTextLedgerShadow: {
            observe: (payload) => { ledgerObserved.push(payload); return {}; },
        },
        revisionAdmissionShadow: {
            preflightAccepted: () => ({ decision: 'accept', accept: true, reason: 'test' }),
            registerAccepted: (payload) => { revisionObserved.push(payload); return revisionTicket; },
        },

        config: {
            deadlineFallback: { provisionalEnabled: false, reviewFixesEnabled: false },
            holdN: { enabled: Boolean(holdNApply), words: 5 },
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
        createHoldNEmitter: () => ({
            apply: holdNApply || ((t) => ({ emitText: t, heldWords: 0, heldText: '' })),
        }),

        qualityTracker: {
            resetPendingFilters: noop,
            trackDEInput: noop,
            trackFilterAction: noop,
            trackPipelineBlock: noop,
        },
        broadcastToChurch: noop,
        getActiveLanguages: () => activeLanguages,
        getOrCreateTranslationQueue: () => ({
            depth: 0,
            enqueue: (item) => {
                if (!queueAccepts) return false;
                enqueued.push(item);
                return true;
            },
        }),
        recordLatencyStage: noop,
        logEmissionDecision: noop,
        logEmissionControllerShadow: noop,
        areProvidersHealthyForEmission: () => true,
        isTtsEnabled: () => false,
        completeWhisperOnlyTracking: noop,
        dpNormWords: (t) => String(t || '').toLowerCase().split(/\s+/).filter(Boolean),
    };

    assertContextProvides(pipelineSource, context);
    vm.runInNewContext(pipelineSource, context);
    const sourceLineage = lineageEnabled ? sourceLineageFromWhisper(text, {
        whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9',
        decodeId: 'decode-1',
        inputPcmSha256: 'c'.repeat(64),
        inputStartSample: 0,
        inputEndSample: 100000,
        provenanceStatus: 'complete',
        alignmentStatus: 'exact',
        confirmedWordSpans: text.match(/[\p{L}\p{N}]+/gu).map((word, index) => ({
            text: word,
            start_sample: index * 100,
            end_sample: index * 100 + 50,
        })),
    }) : null;
    await context.processCompleteSentence('church-test', text, null, {
        origin,
        releaseReason: 'streaming_batch',
        sourceLineage,
    });

    return { evalRecords, enqueued, observed, fqf2Observed, ledgerObserved, revisionObserved, revisionTicket, state: context.state };
}

const referenceOf = (records) => records.find((r) => r.stage === 'source_semantic_reference');

describe('source_semantic_reference — the pre-policy R record', () => {
    it('is emitted for a normal release, before fan-out, marked as pre-policy', async () => {
        const { evalRecords } = await runEmissionPath(TEXT);
        const reference = referenceOf(evalRecords);

        expect(reference).toBeDefined();
        expect(reference.policy_applied).toBe(false);
        expect(reference.policy_stage).toBe('post_source_filters_pre_p27_pre_t5_pre_fanout');
        expect(reference.release_seq).toBe(42);
        expect(reference.session_epoch).toBe('epoch-test');
        expect(reference.unit_count).toBe(2);
        expect(reference.units.map((u) => u.text)).toEqual([
            'Seneca hat schon ein Buch geschrieben.',
            'Das ist die zweite Perspektive.',
        ]);
        expect(reference.units.map((u) => u.source_unit_id)).toEqual(['epoch-test:42:0', 'epoch-test:42:1']);
    });

    it('precedes the queue record, so R is written before anything can act on it', async () => {
        const { evalRecords } = await runEmissionPath(TEXT);
        const referenceIndex = evalRecords.findIndex((r) => r.stage === 'source_semantic_reference');
        const outcomeIndex = evalRecords.findIndex((r) => r.stage === 'source_release_outcome' && r.outcome === 'queued');

        expect(referenceIndex).toBeGreaterThanOrEqual(0);
        expect(outcomeIndex).toBeGreaterThan(referenceIndex);
    });

    it('is emitted even when no language is active — R does not depend on listeners', async () => {
        const { evalRecords, enqueued } = await runEmissionPath(TEXT, { activeLanguages: [] });
        const reference = referenceOf(evalRecords);

        expect(reference).toBeDefined();
        expect(reference.active_languages).toBe(0);
        expect(enqueued).toHaveLength(0);
    });

    it('marks a plain sentence as SCORABLE — the shadow must have something to score', async () => {
        // Regression guard: passing the raw env map (no minUnitWords / minUnitContentTokens)
        // to buildSourceUnits produced closed=true, full_unit=false, scorable=false for every
        // unit, i.e. zero embeddings and zero candidates, with no error anywhere.
        const { evalRecords } = await runEmissionPath('Seneca hat schon ein Buch geschrieben.');
        const reference = referenceOf(evalRecords);

        expect(reference.scorable_unit_count).toBeGreaterThan(0);
        expect(reference.units[0]).toMatchObject({ closed: true, full_unit: true, scorable: true });
    });

    it('pins the exact defect: the raw env map yields zero scorable units', () => {
        const withEnvMap = buildSourceUnits({ sessionEpoch: 'e', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' }, ENV_SHAPED_CONFIG);
        const withNormalized = buildSourceUnits(
            { sessionEpoch: 'e', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' },
            createSourceSemanticRepeatShadow({ embedFn: async () => [1, 0, 0], config: ENV_SHAPED_CONFIG }).config,
        );
        expect(withEnvMap.filter((unit) => unit.scorable)).toHaveLength(0);
        expect(withNormalized.filter((unit) => unit.scorable)).toHaveLength(1);
    });

    it('marks a punctuation shard as present but not scorable', async () => {
        const { evalRecords } = await runEmissionPath('Seneca hat schon ein Buch geschrieben. » . Der rote Knopf wird gedrueckt heute.');
        const reference = referenceOf(evalRecords);

        expect(reference.unit_count).toBeGreaterThan(reference.scorable_unit_count);
        expect(reference.units.some((u) => u.scorable === false)).toBe(true);
    });
});

describe('shadow observation point', () => {
    it('FQF-4B attaches exact text-free lineage only at accepted enqueue', async () => {
        const result = await runEmissionPath(TEXT, { lineageEnabled: true });
        const event = result.evalRecords.find((record) => (
            record.stage === 'source_lineage_transport' && record.phase === 'accepted_enqueue'
        ));

        expect(result.enqueued[0].sourceLineage.status).toBe('complete');
        expect(event).toMatchObject({
            source_lineage_status: 'complete',
            source_span_word_count: 11,
        });
        expect(JSON.stringify(event)).not.toContain('Seneca');
    });

    it('hands FQF-2, FQF-3A and T1 the post-filter payload only after a real queue acceptance', async () => {
        const queued = await runEmissionPath(TEXT, { origin: 'partial_fallback' });
        expect(queued.enqueued).toHaveLength(1);
        expect(queued.fqf2Observed).toEqual([expect.objectContaining({
            churchId: 'church-test',
            origin: 'partial_fallback',
            text: queued.enqueued[0].text,
            releaseMeta: expect.objectContaining({ releaseSeq: 42 }),
        })]);
        expect(queued.ledgerObserved).toEqual([expect.objectContaining({
            churchId: 'church-test',
            origin: 'partial_fallback',
            text: queued.enqueued[0].text,
            releaseMeta: expect.objectContaining({ releaseSeq: 42 }),
        })]);
        expect(queued.revisionObserved).toEqual([expect.objectContaining({
            churchId: 'church-test',
            text: queued.enqueued[0].text,
            releaseMeta: expect.objectContaining({ releaseSeq: 42 }),
        })]);
        expect(queued.enqueued[0].revisionTicket).toBe(queued.revisionTicket);
        expect(queued.enqueued[0].releaseMeta.revisionTicket).toBe(queued.revisionTicket);

        const blocked = await runEmissionPath(TEXT, {
            origin: 'deadline_fallback',
            activeLanguages: [],
        });
        expect(blocked.enqueued).toHaveLength(0);
        expect(blocked.fqf2Observed).toHaveLength(0);
        expect(blocked.revisionObserved).toHaveLength(0);

        const stoppedQueue = await runEmissionPath(TEXT, {
            origin: 'partial_fallback',
            queueAccepts: false,
        });
        expect(stoppedQueue.enqueued).toHaveLength(0);
        expect(stoppedQueue.fqf2Observed).toHaveLength(0);
        expect(stoppedQueue.revisionObserved).toHaveLength(0);
        expect(stoppedQueue.ledgerObserved).toHaveLength(0);
        expect(blocked.ledgerObserved).toHaveLength(0);
    });

    it('queues the exact P2 and B4 inputs as separate deferred history candidates', async () => {
        const original = 'Pierwszy długi tekst wejściowy zawiera wiele słów i kończy się poprawnie.';
        const afterHold = 'Skrócony tekst po buforze nadal zawiera wystarczająco wiele słów.';
        const { enqueued } = await runEmissionPath(original, {
            fqfEnabled: true,
            holdNApply: () => ({ emitText: afterHold, heldWords: 2, heldText: 'ogon' }),
        });

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].dedupHistoryCandidates).toEqual([{
            p2Text: original,
            b4Text: afterHold,
            emittedSourceText: afterHold,
            releaseMeta: expect.objectContaining({ sessionEpoch: 'epoch-test', releaseSeq: 42 }),
        }]);
    });

    it('a conservative APPLY drop occurs before queue acceptance and poisons no source history', async () => {
        const dropped = await runEmissionPath(TEXT, {
            fqfEnabled: true,
            applyEnabled: true,
            origin: 'deadline_fallback',
            coordinatorDecision: {
                action: 'drop',
                reason: 'drop_history_repeat',
                observedBeforeEnqueue: true,
            },
        });

        expect(dropped.enqueued).toHaveLength(0);
        expect(dropped.observed).toHaveLength(0);
        expect(dropped.state.emissionNgramHistory.has('church-test')).toBe(false);
        expect(dropped.state.emissionFullHistory.has('church-test')).toBe(false);
        expect(dropped.state.lastSentTexts.has('church-test')).toBe(false);
        expect(dropped.evalRecords).toContainEqual(expect.objectContaining({
            stage: 'source_release_outcome',
            outcome: 'blocked_pre_queue',
            block_stage: 'fallback_coordinator',
            reason: 'drop_history_repeat',
        }));
    });

    it('advances history only for content that actually reached `queued`', async () => {
        const queuedRun = await runEmissionPath(TEXT);
        expect(queuedRun.enqueued).toHaveLength(1);
        expect(queuedRun.observed).toHaveLength(1);
        expect(queuedRun.observed[0].releaseSeq).toBe(42);
        expect(queuedRun.observed[0].units.map((u) => u.source_unit_id))
            .toEqual(referenceOf(queuedRun.evalRecords).units.map((u) => u.source_unit_id));
        // The shadow scores only `scorable` units, so handing it a set with none is the same
        // as not calling it at all.
        expect(queuedRun.observed[0].units.some((u) => u.scorable)).toBe(true);

        const notQueuedRun = await runEmissionPath(TEXT, { activeLanguages: [] });
        expect(notQueuedRun.enqueued).toHaveLength(0);
        expect(notQueuedRun.observed).toHaveLength(0);
    });

    it('end-to-end with the REAL shadow: a repeated sentence becomes a candidate', async () => {
        // The strongest form of the regression: wire the actual shadow (server-shaped env
        // config, fake embeddings) into the real emission path and require a verdict on the
        // far side. With the raw env map this run produced zero embeddings and zero records.
        const logs = [];
        const embedded = [];
        const shadow = createSourceSemanticRepeatShadow({
            embedFn: async (text) => { embedded.push(text); return text.includes('Seneca') ? [1, 0, 0] : [0, 1, 0]; },
            logFn: (entry) => logs.push(entry),
            config: ENV_SHAPED_CONFIG,
        });

        await runEmissionPath('Seneca hat schon ein Buch geschrieben.', { shadow, releaseSeq: 1 });
        await runEmissionPath('Seneca hat schon ein Buch geschrieben.', { shadow, releaseSeq: 2 });
        await shadow.idle();

        expect(embedded.length).toBeGreaterThan(0);
        expect(shadow.stats().scored).toBe(2);
        const verdicts = logs.map((entry) => entry.verdict);
        expect(verdicts).toEqual(['keep', 'candidate_high_precision']);
        expect(logs[1].best_eligible_release_seq).toBe(1);
        expect(logs[1].estimated_redundant_audio_sec).toBeGreaterThan(0);
    });

    it('hands the shadow the same units the reference record published', async () => {
        const { evalRecords, observed } = await runEmissionPath(TEXT);
        expect(observed[0].units).toEqual(referenceOf(evalRecords).units.map((u) => expect.objectContaining({
            source_unit_id: u.source_unit_id,
            text: u.text,
        })));
    });
});
