/**
 * Q1b no-open-cut WIRING (22.06.2026)
 *
 * Maps an EXISTING flowGovernor decision (see flowGovernor.js: decideFlowGovernor)
 * onto a concrete partial-fallback emission action, so that open or truncated partials
 * ("...wchodzimy w nasze") are never flushed raw. This is NOT a second governor and
 * NOT a new boundary heuristic: the boundary definition is reused from
 * boundaryConfirmation.js (splitAtSafeBoundary / endsWithTerminal / endsOnOpenWord).
 *
 * The historical bug was in the WIRING - the fallback path did a
 * blind `accumulator.flush()` regardless of what the governor decided. This module
 * is the missing translation layer: governor decision -> emission action.
 *
 * Pure module: no I/O, no clock, no mutable state. Caller supplies `nowMs` and
 * `firstHeldAt` (timestamp of the FIRST held tail, NOT reset per partial update),
 * so the hard cap is honoured and unit-testable.
 *
 * Tail model (22.06 r3): `holdText` is the open tail this decision declined to emit. The
 * caller does NOT merge it back into the next input: the ASR growing buffer re-transcribes
 * the un-confirmed audio, so the tail RE-SURFACES in the next result.partial on its own.
 * holdText is therefore TRACKED ONLY (diagnostics + hard-cap anchoring), never re-emitted
 * by the wiring — merging it would duplicate the re-surfaced tail. (ASR partial carries the
 * tail; heldTail = tracked only.)
 *
 * Actions returned:
 *   emit_full          -> emit whole text as-is (closed thought, ON==OFF parity)
 *   emit_prefix_hold   -> emit only the safe prefix, hold the (open) tail
 *   hold               -> emit nothing this cycle, keep the tail
 *   emergency_trim     -> hard cap hit: emit up to the last safe boundary
 *   forced_open        -> hard cap hit AND no safe boundary anywhere: emit whole (degraded, logged)
 *
 * emission_completeness tags (logging-only, feed E1 metric_partial_emissions):
 *   closed | closed_prefix_held_tail | merged | emergency_trim | forced_open
 */

import { endsWithTerminal, endsOnOpenWord, splitAtSafeBoundary } from './boundaryConfirmation.js';

const DEFAULT_MAX_HOLD_MS = 8000;

/**
 * Is the text a closed thought we can emit verbatim (ON == OFF parity)?
 * Closed = ends on terminal punctuation AND not on an open function word.
 * Reuses the same definition as the rest of the pipeline (no new heuristic).
 */
function isClosedThought(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return endsWithTerminal(t) && !endsOnOpenWord(t);
}

/**
 * Decide the emission action for a partial under no-open-cut, given the governor decision.
 *
 * @param {object} args
 * @param {string} args.text              the partial text under consideration
 * @param {object|null} args.decision     flowGovernor decision object ({decision, reason, ...})
 * @param {number} args.nowMs             current timestamp (ms)
 * @param {number|null} args.firstHeldAt  timestamp of the FIRST held tail (ms); null if not holding yet
 * @param {number} [args.maxHoldMs]       hard cap from firstHeldAt (default 8000)
 * @returns {{action:string, emitText:string, holdText:string, emission_completeness:string, reason:string, hardCapHit:boolean}}
 */
function decideNoOpenCutAction({ text, decision = null, nowMs = Date.now(), firstHeldAt = null, maxHoldMs = DEFAULT_MAX_HOLD_MS } = {}) {
    const t = String(text || '').trim();
    const govDecision = decision?.decision || null;

    // 0. Closed thought -> emit as-is. This is the ON==OFF parity path; it short-circuits
    //    before any hold logic so terminal-punctuated text behaves exactly like legacy.
    if (isClosedThought(t)) {
        return {
            action: 'emit_full',
            emitText: t,
            holdText: '',
            emission_completeness: 'closed',
            reason: 'closed_terminal_thought',
            hardCapHit: false,
        };
    }

    // 1. Hard cap: counted from firstHeldAt (first held tail), NOT reset per update.
    const heldForMs = firstHeldAt != null ? Math.max(0, nowMs - firstHeldAt) : 0;
    const hardCapHit = firstHeldAt != null && heldForMs >= maxHoldMs;

    if (hardCapHit) {
        const { head } = splitAtSafeBoundary(t);
        if (head) {
            return {
                action: 'emergency_trim',
                emitText: head,
                holdText: head === t ? '' : t.slice(head.length).trim(),
                emission_completeness: 'emergency_trim',
                reason: 'max_hold_without_safe_release',
                hardCapHit: true,
            };
        }
        // No safe boundary anywhere after hard cap -> degrade: emit whole (logged, rare).
        return {
            action: 'forced_open',
            emitText: t,
            holdText: '',
            emission_completeness: 'forced_open',
            reason: 'hard_cap_no_safe_boundary',
            hardCapHit: true,
        };
    }

    // 2. Map governor decision -> action (within hard cap budget).
    switch (govDecision) {
        case 'would_micro_emit': {
            // Governor is confident this is emittable. Honour parity: if it is actually a
            // closed thought we already returned above; otherwise emit only the safe prefix.
            const { head } = splitAtSafeBoundary(t);
            if (head) {
                return {
                    action: 'emit_prefix_hold',
                    emitText: head,
                    holdText: head === t ? '' : t.slice(head.length).trim(),
                    emission_completeness: head === t ? 'closed' : 'closed_prefix_held_tail',
                    reason: 'micro_emit_safe_prefix',
                    hardCapHit: false,
                };
            }
            // micro_emit but no safe boundary -> hold rather than open-cut.
            return holdResult('micro_emit_no_safe_boundary');
        }

        case 'would_soft_commit_prefix': {
            const { head } = splitAtSafeBoundary(t);
            if (head) {
                return {
                    action: 'emit_prefix_hold',
                    emitText: head,
                    holdText: head === t ? '' : t.slice(head.length).trim(),
                    emission_completeness: head === t ? 'closed' : 'closed_prefix_held_tail',
                    reason: 'soft_commit_safe_prefix',
                    hardCapHit: false,
                };
            }
            return holdResult('soft_commit_no_safe_boundary');
        }

        case 'would_force_fallback': {
            // Age budget forced a fallback. Under no-open-cut we still refuse to emit an open
            // tail: emit the safe prefix if there is one, otherwise hold for the next cycle.
            const { head } = splitAtSafeBoundary(t);
            if (head) {
                return {
                    action: 'emit_prefix_hold',
                    emitText: head,
                    holdText: head === t ? '' : t.slice(head.length).trim(),
                    emission_completeness: head === t ? 'closed' : 'closed_prefix_held_tail',
                    reason: 'force_fallback_safe_prefix',
                    hardCapHit: false,
                };
            }
            return holdResult('force_fallback_no_safe_boundary');
        }

        case 'would_merge_to_next':
            return {
                action: 'hold',
                emitText: '',
                holdText: t,
                emission_completeness: 'merged',
                reason: 'merge_to_next',
                hardCapHit: false,
            };

        case 'would_hold':
        default:
            return holdResult(decision?.reason || 'waiting_for_safe_boundary');
    }
}

/**
 * OPT1 (22.06 r3): hygiene reset of the held-tail diagnostics on a fallbackState entry.
 *
 * Clears the tracked open tail and the hard-cap clock (firstHeldAt) so neither lingers after
 * a thought is closed. Pure mutation of the passed object; no clock, no I/O. Idempotent and
 * null-safe. trackedTail is diagnostics-only (the ASR growing buffer re-surfaces the real tail
 * on the next partial), so clearing it never loses content.
 *
 * Called by the wiring on: (a) every CONFIRMED result (old open tail is stale), and (b) any
 * emission that closes/opens WITHOUT a remaining held tail (closed / forced_open).
 *
 * @param {{trackedTail?: string, firstHeldAt?: number|null}|null|undefined} fb
 * @returns {boolean} true if an fb object was reset, false if fb was null/undefined
 */
function clearHeldTail(fb) {
    if (!fb) return false;
    fb.trackedTail = '';
    fb.firstHeldAt = null;
    return true;
}

function holdResult(reason) {
    return {
        action: 'hold',
        emitText: '',
        holdText: '',  // caller keeps its own pending tail; '' means "no change emitted"
        emission_completeness: 'held',
        reason,
        hardCapHit: false,
    };
}

export {
    DEFAULT_MAX_HOLD_MS,
    isClosedThought,
    decideNoOpenCutAction,
    clearHeldTail,
};
