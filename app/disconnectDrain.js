// ============================================================
// P-B: Disconnect drain orchestrator (drain-before-cleanup)
// Pure orchestration with INJECTED deps so it is unit-testable without server state.
// Order (refinements 21.06): final transcribe (guard-bypassed) -> smooth flush ->
// holdN flush -> queue drain (in-flight aware) -> flushSessionSummary -> cleanup.
// Emits the per-unit tail events; each emitted tail carries drainId + tailItemId so the
// analyzer can verify coverage through translation/broadcast (not char arithmetic).
// ============================================================
import { createHash } from 'node:crypto';

const TIMEOUT = Symbol('drain.timeout');
const defaultHash = (t) => createHash('sha1').update(String(t || '')).digest('hex').slice(0, 12);

// Race a promise against a timeout. Returns { timedOut, value }.
export async function withTimeout(promiseLike, ms) {
    const p = Promise.resolve().then(() => promiseLike);
    if (!ms || ms <= 0) return { timedOut: false, value: await p };
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), ms); });
    try {
        const value = await Promise.race([p, timeout]);
        return value === TIMEOUT ? { timedOut: true, value: null } : { timedOut: false, value };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {object} ctx { churchId, drainId, timeouts: { finalTranscribeMs, queueDrainMs } }
 * @param {object} deps {
 *   now(), hash(text), newTailItemId(), evalLog(entry),
 *   snapshot() -> { smoothSentences, smoothChars, holdnChars, queueDepth, inFlight },
 *   finalTranscribe() -> Promise<string|null>   (MUST bypass the staleness guard),
 *   flushSmooth() -> { text, sentenceCount, charCount } | null,
 *   flushHoldN() -> string,
 *   emit(text, { drainId, tailItemId }) -> Promise   (== processCompleteSentence, Smooth path, forceHoldN),
 *   drainQueue() -> Promise                          (resolves when queue depth + in-flight == 0),
 *   flushSummary(), cleanup()
 * }
 * @returns {Promise<{tailItems, emitted, stageCut, durationMs}>}
 */
export async function runDisconnectDrain(ctx, deps) {
    const hash = deps.hash || defaultHash;
    const now = deps.now || (() => 0);
    const { churchId, drainId } = ctx;
    const timeouts = ctx.timeouts || {};
    const t0 = now();

    let tailItems = 0;
    let submitted = 0;   // deps.emit returned without throwing (== submitted to pipeline, NOT proven broadcast)
    let emitErrors = 0;
    let stageCut = null;

    const log = (entry) => { try { deps.evalLog(entry); } catch { /* logging must never break drain */ } };

    const emitTail = async (text, stage, extra = {}, emitExtra = {}) => {
        if (!text || !String(text).trim()) return;
        const tailItemId = deps.newTailItemId();
        tailItems++;
        log({ stage, churchId, drainId, tailItemId, source_text_hash: hash(text), text: String(text).slice(0, 120), ...extra });
        try {
            await deps.emit(text, { drainId, tailItemId, ...emitExtra });
            submitted++;
        } catch (e) {
            emitErrors++;
            log({ stage: 'disconnect_emit_error', churchId, drainId, tailItemId, error: String((e && e.message) || e) });
        }
    };

    const s0 = deps.snapshot();
    log({
        stage: 'disconnect_drain_start', churchId, drainId,
        smooth_pending_sentences: s0.smoothSentences, smooth_pending_chars: s0.smoothChars,
        holdn_pending_chars: s0.holdnChars, queue_depth_start: s0.queueDepth, inflight_start: s0.inFlight,
    });

    // 1. Final transcription of the last audio buffer — bypassing the staleness guard.
    let finalText = null;
    try {
        const ft = await withTimeout(deps.finalTranscribe(), timeouts.finalTranscribeMs);
        if (ft.timedOut) stageCut = stageCut || 'final_transcribe';
        finalText = ft.value || null;
    } catch (e) {
        log({ stage: 'disconnect_final_transcribe_result', churchId, drainId, accepted: false, error: String((e && e.message) || e) });
    }
    if (finalText && String(finalText).trim()) {
        const tailItemId = deps.newTailItemId();
        tailItems++;
        log({
            stage: 'disconnect_final_transcribe_result', churchId, drainId, tailItemId,
            text_len: String(finalText).length, source_text_hash: hash(finalText), accepted: true,
            timed_out: stageCut === 'final_transcribe', final_transcribe_timeout_ms: timeouts.finalTranscribeMs || 0,
        });
        try { await deps.emit(finalText, { drainId, tailItemId }); submitted++; }
        catch (e) { emitErrors++; log({ stage: 'disconnect_emit_error', churchId, drainId, tailItemId, error: String((e && e.message) || e) }); }
    } else {
        log({
            stage: 'disconnect_final_transcribe_result', churchId, drainId, accepted: false,
            timed_out: stageCut === 'final_transcribe', final_transcribe_timeout_ms: timeouts.finalTranscribeMs || 0,
        });
    }

    // 2. Smooth accumulator flush (sub-threshold pending sentences — the prime tail-loss).
    const sm = deps.flushSmooth();
    if (sm && sm.text) {
        await emitTail(
            sm.text,
            'disconnect_smooth_flush',
            { released_sentences: sm.sentenceCount, released_chars: sm.charCount },
            { sourceLineage: sm.sourceLineage || null },
        );
    }

    // 3. HOLD_N flush (held tail words).
    const held = deps.flushHoldN();
    if (held && held.trim()) {
        await emitTail(held, 'disconnect_holdn_flush', { released_chars: held.length });
    }

    // 4. Drain the translation queue — waits for queued items AND the in-flight worker item.
    const beforeDepth = deps.snapshot().queueDepth;
    const dq = await withTimeout(deps.drainQueue(), timeouts.queueDrainMs);
    if (dq.timedOut) stageCut = stageCut || 'queue_drain';
    const sEnd = deps.snapshot();
    log({
        stage: 'disconnect_queue_drain', churchId, drainId,
        depth_start: beforeDepth, depth_end: sEnd.queueDepth, inflight_end: sEnd.inFlight,
        duration_ms: now() - t0, queue_drain_timeout_ms: timeouts.queueDrainMs || 0, timed_out: dq.timedOut,
    });

    // 5. Timeout marker (explicit, never silent) before the done event.
    if (stageCut) {
        log({
            stage: 'disconnect_drain_timeout', churchId, drainId, stage_cut: stageCut,
            residual_tail_items: Math.max(0, tailItems - submitted),
            residual_queue_depth: sEnd.queueDepth, residual_inflight: sEnd.inFlight,
        });
    }
    // NOTE: tail_items_submitted = handed to processCompleteSentence without throwing. It is NOT
    // proof of broadcast (punctGate/dedup can still drop it). The analyzer computes the real
    // tail_items_broadcasted from broadcast records carrying this drainId/tailItemId.
    log({
        stage: 'disconnect_drain_done', churchId, drainId,
        tail_items_total: tailItems, tail_items_submitted: submitted, tail_items_emit_errors: emitErrors,
        stage_cut: stageCut, duration_ms: now() - t0,
    });

    // 6. Session summary AFTER the drain (so metrics don't say "end" before the tail is out).
    try { deps.flushSummary(); } catch (e) { log({ stage: 'disconnect_summary_error', churchId, drainId, error: String((e && e.message) || e) }); }

    // 7. Cleanup LAST (deletes accumulators, stops the worker, announces church_offline).
    try { deps.cleanup(); } catch (e) { log({ stage: 'disconnect_cleanup_error', churchId, drainId, error: String((e && e.message) || e) }); }

    return { tailItems, submitted, emitErrors, stageCut, durationMs: now() - t0 };
}

export default { runDisconnectDrain, withTimeout };
