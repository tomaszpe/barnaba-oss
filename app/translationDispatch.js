/**
 * N3 — Per-language independent translation dispatch.
 *
 * Runs each target language's full post-translation pipeline (T5 dedup, age budget,
 * committed-prefix tracking, quality tracking, eval logging) and emits it as soon as
 * THAT language's GPT call resolves — instead of awaiting Promise.all over all languages
 * (the MAX(de,en,pl) barrier in translateAndBroadcast). Fast languages no longer wait
 * for the slowest one.
 *
 * Extracted as an injectable unit because server.js has import-time side effects
 * (untestable inline) — same rationale as translationQueue.js (fix #3, 29.05).
 *
 * The heavy I/O (WebSocket broadcast, TTS synthesis) stays in server.js via the
 * `emit` callback; this module owns the control flow + filter pipeline that N3 changes.
 */

import { sourceLineageTelemetry } from './sourceLineage.js';
import { revisionAdmissionTelemetry } from './revisionAdmissionShadow.js';
import { translationFailureFields } from './translationProviderError.js';

const EMPTY_DUP_COUNTS = { adjacentWordDups: 0, bigramDups: 0, trigramDups: 0, totalWordDups: 0 };

const sourceLineageFields = (releaseMeta) => (
  {
    ...(releaseMeta?.sourceLineageEnabled
      ? sourceLineageTelemetry(releaseMeta.sourceLineage)
      : {}),
    ...revisionAdmissionTelemetry(releaseMeta),
  }
);

function deriveEmissionMode({ decision, ageDecision, runtimeDecision }) {
  if (runtimeDecision?.mode) return runtimeDecision.mode;
  if (decision === 'text_only' || ageDecision?.action === 'text_only_stale') return 'audio_skip';
  if (ageDecision?.action === 'drop_stale') return 'drop';
  const ageMs = Math.max(0, Number(ageDecision?.ageMs) || 0);
  if (ageMs <= 3000) return 'quality';
  if (ageMs <= 7000) return 'fast';
  if (ageMs <= 12000) return 'catchup';
  return 'audio_skip';
}

/**
 * @param {object} a
 * @param {string} a.text - German source text (shared by all languages of this emission)
 * @param {string[]} a.languages - target language codes
 * @param {string} a.churchId
 * @param {number} a.emissionId - shared per-emission id
 * @param {number|null} [a.queuedAt] - ms timestamp when source was queued (age budget)
 * @param {number} [a.queueDepth] - queue depth at dequeue (age budget)
 * @param {boolean} a.ttsEnabled
 * @param {(lang: string) => Promise<object>} a.translate - per-lang translate (e.g. translateText bound)
 * @param {(payload: object) => Promise<void>} a.emit - does broadcast/TTS for one language
 * @param {object} a.deps - injected dependencies (see below)
 * @returns {Promise<Array<{lang: string, emitted: boolean, decision?: string, latencyMs: number, skipReason?: string}>>}
 */
export async function dispatchPerLanguage({
  text,
  languages,
  churchId,
  emissionId,
  queuedAt = null,
  queueDepth = 0,
  ttsEnabled,
  translate,
  emit,
  onTranslated = () => {},
  releaseMeta = null,
  origin = null,
  sessionEpoch = null,
  deps,
}) {
  const {
    postTranslationDedup,
    decideAgeBudget,
    ageBudgetConfig,
    commitTranslation,
    trackEmission,
    trackFilterAction,
    evalLog,
    logEmissionDecision = () => {},
    logEmissionControllerDecision = () => {},
    decideRuntimeEmission = () => null,
    commitDedupHistories = () => {},
    deferDedupHistoryCommit = false,
    resolveTtsTargets = () => [],
    observeRevisionAdmission = () => null,
    processBoundaryCommit = null,
    now = () => Date.now(),
    log = () => {},
  } = deps;

  const settled = await Promise.allSettled(
    languages.map((lang) => processOneLanguage(lang)),
  );

  // Promise.allSettled never rejects; unwrap to outcomes (defensive — pipeline catches its own).
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { lang: languages[i], emitted: false, latencyMs: 0, skipReason: 'unexpected_error' },
  );

  async function processOneLanguage(lang) {
    const t0 = now();
    let result;
    try {
      result = await translate(lang);
    } catch (err) {
      result = { language: lang, text: null, success: false, ...translationFailureFields(err) };
    }
    const latencyMs = now() - t0;

    // Signal this language's translation completed (before TTS/broadcast). Used by the
    // caller to stamp the emission-level 'translation_done' latency stage — last call
    // (slowest lang) wins, matching the legacy barrier's translation_done timing.
    onTranslated(lang, latencyMs);

    // 1. Skip failed / empty (mirrors server.js loop head).
    if (!result.success || !result.text || result.text.trim().length === 0) {
      if (!result.success) {
        log(`  [${lang.toUpperCase()}] FAILED: ${result.error}`);
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
          lang,
          emissionId,
        });
      } else {
        log(`  [${lang.toUpperCase()}] Empty result — skipping`);
      }
      return { lang, emitted: false, latencyMs, skipReason: result.success ? 'empty' : 'failed' };
    }

    // 2. T5 post-translation dedup.
    const t5HistoryCandidate = result.text;
    const t5 = postTranslationDedup(t5HistoryCandidate, lang, churchId, {
      emissionId,
      releaseSeq: releaseMeta?.releaseSeq,
      sourceHash: releaseMeta?.sourceHash,
      deferCommit: deferDedupHistoryCommit,
    });
    if (t5.action === 'skip') {
      log(`  [${lang.toUpperCase()}] T5 ${t5.reason}`);
      trackFilterAction(churchId, 'T5', 'skip');
      evalLog({ stage: 'source_release_outcome', churchId, release_seq: releaseMeta?.releaseSeq ?? null, source_hash: releaseMeta?.sourceHash ?? null, outcome: 'translated_blocked', block_stage: 'T5', lang, emissionId, reason: t5.reason || null });
      return { lang, emitted: false, latencyMs, skipReason: 'T5' };
    }
    trackFilterAction(churchId, 'T5', 'emit');

    let emittedText = result.text;
    if (processBoundaryCommit) {
      const boundary = processBoundaryCommit({
        churchId,
        lang,
        text: emittedText,
        sourceText: text,
        emissionId,
        now,
      });
      if (boundary?.metrics?.length) {
        for (const metric of boundary.metrics) evalLog(metric);
      }
      if (boundary?.changed) {
        emittedText = boundary.text;
        result = { ...result, text: emittedText };
        trackFilterAction(churchId, 'BCL', 'trim');
      } else {
        trackFilterAction(churchId, 'BCL', 'emit');
      }
    }

    // 3. Age budget.
    const ageDecision = decideAgeBudget({
      ageMs: queuedAt ? now() - queuedAt : 0,
      queueDepth,
      config: ageBudgetConfig,
    });
    const logFallbackAgeDecision = [
      'partial_fallback',
      'deadline_fallback',
      'mixed',
    ].includes(origin);
    if (ageDecision.action !== 'normal_tts' || logFallbackAgeDecision) {
      evalLog({
        stage: 'age_budget',
        churchId,
        emissionId,
        lang,
        action: ageDecision.action,
        reason: ageDecision.reason,
        origin,
        session_epoch: sessionEpoch,
        release_seq: releaseMeta?.releaseSeq ?? null,
        age_ms: ageDecision.ageMs,
        queue_depth: ageDecision.queueDepth,
      });
    }
    if (ageDecision.action === 'drop_stale') {
      if (logFallbackAgeDecision) {
        evalLog({
          stage: 'emission_controller_runtime',
          churchId,
          emissionId,
          lang,
          source: 'dispatch_per_language',
          origin,
          session_epoch: sessionEpoch,
          release_seq: releaseMeta?.releaseSeq ?? null,
          runtime_action: 'not_run',
          runtime_mode: null,
          runtime_reason: 'age_budget_drop_stale',
          runtime_evaluated: false,
          terminal_disposition: 'drop',
          age_ms: ageDecision.ageMs,
          queue_depth: ageDecision.queueDepth,
        });
      }
      log(`  [${lang.toUpperCase()}] Age budget drop (${ageDecision.ageMs}ms, q=${ageDecision.queueDepth})`);
      trackFilterAction(churchId, 'AGE', 'drop_stale');
      logEmissionDecision({
        churchId,
        emissionId,
        language: lang,
        decision: 'drop',
        reason: ageDecision.reason,
        ageDecision,
        source: 'dispatch_per_language',
      });
      logEmissionControllerDecision({
        churchId,
        emissionId,
        language: lang,
        source: 'dispatch_per_language',
        runtimeDecision: 'drop',
        origin,
        sessionEpoch,
        releaseSeq: releaseMeta?.releaseSeq,
        signals: {
          ageMs: ageDecision.ageMs,
          queueDepth: ageDecision.queueDepth,
          providerHealthy: true,
          ttsEnabled,
          activeLanguages: languages.length,
          activeGenders: 0,
        },
      });
      return { lang, emitted: false, latencyMs, skipReason: 'drop_stale', emissionMode: 'drop' };
    }

    const runtimeDecision = decideRuntimeEmission({
      churchId,
      emissionId,
      language: lang,
      source: 'dispatch_per_language',
      origin,
      sessionEpoch,
      releaseSeq: releaseMeta?.releaseSeq,
      signals: {
        ageMs: ageDecision.ageMs,
        queueDepth: ageDecision.queueDepth,
        providerHealthy: true,
        ttsEnabled,
        activeLanguages: languages.length,
        activeGenders: 0,
      },
    });

    if (runtimeDecision?.action === 'drop') {
      log(`  [${lang.toUpperCase()}] EmissionController drop (${runtimeDecision.reason})`);
      trackFilterAction(churchId, 'EMISSION_CONTROLLER', 'drop');
      logEmissionDecision({
        churchId,
        emissionId,
        language: lang,
        decision: 'drop',
        reason: runtimeDecision.reason,
        ageMs: runtimeDecision.ageMs,
        queueDepth: runtimeDecision.queueDepth,
        source: 'dispatch_per_language_runtime',
      });
      return { lang, emitted: false, latencyMs, skipReason: 'emission_controller_drop', emissionMode: 'drop' };
    }

    // 4. Committed prefix (no-op when CP disabled) + quality tracking.
    if (result.contextMode) {
      commitTranslation(churchId, lang, emittedText, { contextMode: result.contextMode });
    } else {
      commitTranslation(churchId, lang, emittedText);
    }
    const dupCounts = result.dupCounts || EMPTY_DUP_COUNTS;
    trackEmission(churchId, lang, {
      repetitions: dupCounts,
      sourceText: text,
      latency: { translationMs: latencyMs }, // N3: REAL per-lang latency (was shared MAX)
    });

    // 5. Eval log — per-lang latency_ms (fixes D1 MAX-only measurement gap).
    evalLog({
      stage: 'translation',
      churchId,
      session_epoch: releaseMeta?.sessionEpoch ?? null,
      release_seq: releaseMeta?.releaseSeq ?? null,
      source_hash: releaseMeta?.sourceHash ?? null,
      emissionId,
      src: text,
      lang,
      translation: emittedText,
      latency_ms: latencyMs,
      prompt_tokens: result.promptTokens || 0,
      cached_tokens: result.cachedTokens || 0,
      ...sourceLineageFields(releaseMeta),
    });
    if (releaseMeta?.sourceLineageEnabled) {
      evalLog({
        stage: 'source_lineage_transport',
        phase: 'translation',
        churchId,
        session_epoch: releaseMeta?.sessionEpoch ?? null,
        release_seq: releaseMeta?.releaseSeq ?? null,
        source_hash: releaseMeta?.sourceHash ?? null,
        emissionId,
        lang,
        ...sourceLineageFields(releaseMeta),
      });
    }

    // 6. Decide emit mode (mirrors server.js text_only / tts / TTS-disabled branches).
    let decision;
    let textOnly = false;
    if (ageDecision.action === 'text_only_stale') {
      trackFilterAction(churchId, 'AGE', 'text_only_stale');
      decision = 'text_only';
      textOnly = true;
    } else if (runtimeDecision?.action === 'audio_skip') {
      trackFilterAction(churchId, 'EMISSION_CONTROLLER', 'audio_skip');
      decision = 'text_only';
      textOnly = true;
    } else if (ttsEnabled) {
      trackFilterAction(churchId, 'AGE', 'normal_tts');
      decision = 'tts';
    } else {
      decision = 'text_only';
    }
    const decisionReason = decision === 'text_only' && !textOnly
      ? 'tts_disabled'
      : runtimeDecision?.action === 'audio_skip'
        ? runtimeDecision.reason
        : ageDecision.reason || 'normal_tts';
    const emissionMode = deriveEmissionMode({ decision, ageDecision, runtimeDecision });

    logEmissionDecision({
      churchId,
      emissionId,
      language: lang,
      decision,
      reason: decisionReason,
      ageDecision,
      source: 'dispatch_per_language',
    });
    logEmissionControllerDecision({
      churchId,
      emissionId,
      language: lang,
      source: 'dispatch_per_language',
      runtimeDecision: decision,
      origin,
      sessionEpoch,
      releaseSeq: releaseMeta?.releaseSeq,
      signals: {
        ageMs: ageDecision.ageMs,
        queueDepth: ageDecision.queueDepth,
        providerHealthy: true,
        ttsEnabled,
        activeLanguages: languages.length,
        activeGenders: 0,
      },
    });

    const ttsTargets = decision === 'tts'
      ? resolveTtsTargets(lang)
      : null;
    if (deferDedupHistoryCommit && decision === 'tts' && ttsTargets.length === 0) {
      return { lang, emitted: false, latencyMs, skipReason: 'no_tts_targets', emissionMode };
    }

    // FQF T1 shadow: the ticket was assigned only after accepted enqueue. This
    // checkpoint reads ledger state after all output gates and never changes emit.
    if (decision === 'tts' && ttsTargets.length > 0) {
      observeRevisionAdmission({
        churchId,
        ticket: releaseMeta?.revisionTicket || null,
        language: lang,
        emissionId,
        checkpoint: 'accepted_output_pre_tts',
      });
    }

    // FQF-1: target resolution is complete, so this is the accepted-output boundary.
    // Commit before heavy TTS/broadcast work; completion/playback is not required.
    if (deferDedupHistoryCommit) {
      commitDedupHistories({ lang, t5Text: t5HistoryCandidate, bclText: emittedText, emissionId });
    }
    await emit({
      result,
      lang,
      latencyMs,
      decision,
      textOnly,
      ageDecision,
      emissionMode,
      emissionReason: decisionReason,
      ...(ttsTargets ? { ttsTargets } : {}),
    });
    return { lang, emitted: true, decision, latencyMs, emissionMode };
  }
}
