/**
 * Q1b no-open-cut tests (E4, TDD).
 *
 * Validates the WIRING layer (app/noOpenCut.js): an existing flowGovernor decision is
 * mapped onto a concrete emission action so open or truncated partials are never flushed raw.
 * The boundary definition is reused from boundaryConfirmation.js (no new heuristic).
 *
 * Covers (per plan E4):
 *  1. OFF preserves legacy (ON==OFF parity for closed text – both emit verbatim).
 *  2. ON does NOT emit an open fragment ("wchodzimy in nasse") -> hold/merge.
 *  3. ON for "closed. open tail" -> emits only the closed prefix, holds the tail.
 *  4. ON does not change behaviour for closed (terminal) text -> 'closed' (ON==OFF).
 *  5. hard cap does NOT reset per partial update (counted from firstHeldAt).
 *  6. integration: governor decision steers emission (not a blind flush).
 */

import { describe, it, expect } from 'vitest';
import { decideNoOpenCutAction, isClosedThought, clearHeldTail } from '../noOpenCut.js';
import { decideFlowGovernor } from '../flowGovernor.js';

const T0 = 1_000_000;

describe('no-open-cut: closed thoughts (ON==OFF parity)', () => {
    it('emits a closed terminal thought verbatim', () => {
        const r = decideNoOpenCutAction({
            text: 'Gott ist treu und seine Gnade bleibt.',
            decision: { decision: 'would_micro_emit', reason: 'complete_micro_phrase' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('emit_full');
        expect(r.emitText).toBe('Gott ist treu und seine Gnade bleibt.');
        expect(r.emission_completeness).toBe('closed');
    });

    it('isClosedThought rejects open-word terminal endings', () => {
        // ends on a period but on an open function word -> NOT a closed thought.
        expect(isClosedThought('und wir gehen weiter und.')).toBe(false);
        expect(isClosedThought('Das ist gut.')).toBe(true);
        expect(isClosedThought('wir wchodzimy in')).toBe(false);
    });

    it('closed text yields identical emitText regardless of governor decision (parity)', () => {
        const text = 'Das ist ein vollstaendiger Satz.';
        const a = decideNoOpenCutAction({ text, decision: { decision: 'would_hold' }, nowMs: T0, firstHeldAt: T0 - 50000 });
        const b = decideNoOpenCutAction({ text, decision: { decision: 'would_force_fallback' }, nowMs: T0, firstHeldAt: null });
        expect(a.emitText).toBe(text);
        expect(b.emitText).toBe(text);
        expect(a.emission_completeness).toBe('closed');
        expect(b.emission_completeness).toBe('closed');
    });
});

describe('no-open-cut: open fragments are held, not emitted raw', () => {
    it('ON does not emit an open fragment with no safe boundary -> hold', () => {
        // "Und wir wchodzimy in" – open thought, no terminal, no safe clause boundary.
        const r = decideNoOpenCutAction({
            text: 'Und wir gehen jetzt hinein in',
            decision: { decision: 'would_force_fallback', reason: 'age_budget_forces_partial_fallback' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('hold');
        expect(r.emitText).toBe('');
        expect(r.emission_completeness).toBe('held');
    });

    it('would_hold governor decision -> hold (no emission)', () => {
        const r = decideNoOpenCutAction({
            text: 'Das ist ein Anfang ohne genug',
            decision: { decision: 'would_hold', reason: 'waiting_for_stability' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('hold');
        expect(r.emitText).toBe('');
    });

    it('would_merge_to_next -> hold and tag merged', () => {
        const r = decideNoOpenCutAction({
            text: 'und dann',
            decision: { decision: 'would_merge_to_next', reason: 'max_hold_without_safe_release' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('hold');
        expect(r.emission_completeness).toBe('merged');
        expect(r.holdText).toBe('und dann');
    });
});

describe('no-open-cut: emit safe prefix, hold the open tail', () => {
    it('"Das ist ein vollstaendiger Satz. Und wir gehen in" -> emit only the first sentence', () => {
        const text = 'Das ist ein vollstaendiger Satz. Und wir gehen in';
        const r = decideNoOpenCutAction({
            text,
            decision: { decision: 'would_soft_commit_prefix', reason: 'stable_prefix_age_budget' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('emit_prefix_hold');
        expect(r.emitText).toBe('Das ist ein vollstaendiger Satz.');
        expect(r.holdText).toBe('Und wir gehen in');
        expect(r.emission_completeness).toBe('closed_prefix_held_tail');
    });

    it('would_force_fallback with a safe prefix emits the prefix, not the open tail', () => {
        const text = 'Wir schauen heute auf Hiob, und dann fragen wir uns, weshalb das';
        const r = decideNoOpenCutAction({
            text,
            decision: { decision: 'would_force_fallback', reason: 'age_budget_forces_partial_fallback' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('emit_prefix_hold');
        // emits up to the last safe clause boundary; never ends on the open "das".
        expect(r.emitText.endsWith('das')).toBe(false);
        expect(r.emitText.length).toBeGreaterThan(0);
        expect(r.emitText.length).toBeLessThan(text.length);
    });
});

describe('no-open-cut: hard cap from firstHeldAt (not reset per update)', () => {
    const openText = 'und wir gehen jetzt hinein in';  // no safe boundary
    const cap = 8000;

    it('within the cap -> still holds', () => {
        const r = decideNoOpenCutAction({
            text: openText,
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: T0 + 5000,           // 5s after first held
            firstHeldAt: T0,
            maxHoldMs: cap,
        });
        expect(r.action).toBe('hold');
        expect(r.hardCapHit).toBe(false);
    });

    it('past the cap measured from firstHeldAt -> forced_open (no safe boundary)', () => {
        const r = decideNoOpenCutAction({
            text: openText,
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: T0 + 9000,           // 9s after first held -> cap exceeded
            firstHeldAt: T0,
            maxHoldMs: cap,
        });
        expect(r.hardCapHit).toBe(true);
        expect(r.action).toBe('forced_open');
        expect(r.emission_completeness).toBe('forced_open');
        expect(r.emitText).toBe(openText);
    });

    it('past the cap WITH a safe boundary -> emergency_trim to last safe boundary', () => {
        const text = 'Das ist sicher, und wir gehen jetzt hinein in';
        const r = decideNoOpenCutAction({
            text,
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: T0 + 9000,
            firstHeldAt: T0,
            maxHoldMs: cap,
        });
        expect(r.hardCapHit).toBe(true);
        expect(r.action).toBe('emergency_trim');
        expect(r.emitText).toBe('Das ist sicher,');
        expect(r.emission_completeness).toBe('emergency_trim');
    });

    it('cap is NOT reset by a later partial update: firstHeldAt anchors the clock', () => {
        // Simulate two partial updates: the second update arrives at +9s but firstHeldAt
        // is still T0. A naive (reset-per-update) impl would compute age from the latest
        // update and keep holding; here the cap correctly fires.
        const update1 = decideNoOpenCutAction({
            text: 'und wir',
            decision: { decision: 'would_hold' },
            nowMs: T0 + 2000,
            firstHeldAt: T0,
            maxHoldMs: cap,
        });
        expect(update1.hardCapHit).toBe(false);

        const update2 = decideNoOpenCutAction({
            text: 'und wir gehen jetzt hinein in',
            decision: { decision: 'would_hold' },
            nowMs: T0 + 9000,           // 9s from firstHeldAt (NOT from update1)
            firstHeldAt: T0,            // unchanged across updates
            maxHoldMs: cap,
        });
        expect(update2.hardCapHit).toBe(true);
    });
});

describe('no-open-cut: BUG2 – open tail is preserved, never dropped', () => {
    // The historical regression: the server integration took only noc.emitText (the safe
    // prefix) and discarded noc.holdText (the open tail), AND cleared firstHeldAt even
    // though the tail was still held -> tail lost + hard cap broken. The pure module is the
    // contract the integration relies on: emit_prefix_hold MUST surface the tail in holdText
    // so the caller can put it back into pending.

    it('emit_prefix_hold returns the open tail in holdText (so it can be re-held, not dropped)', () => {
        const text = 'Das ist ein vollstaendiger Satz. Und wir gehen jetzt hinein in';
        const r = decideNoOpenCutAction({
            text,
            decision: { decision: 'would_soft_commit_prefix', reason: 'stable_prefix_age_budget' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('emit_prefix_hold');
        expect(r.emitText).toBe('Das ist ein vollstaendiger Satz.');
        // The tail must be carried out so the integration can preserve it for the next cycle.
        expect(r.holdText).toBe('Und wir gehen jetzt hinein in');
        expect(r.holdText.length).toBeGreaterThan(0);
        // emitText + holdText must together still cover the open tail's content (no silent loss).
        expect(text.includes(r.holdText)).toBe(true);
    });

    it('prefix + tail reconstruct the original (no content silently dropped)', () => {
        const text = 'Wir beten heute fuer Frieden, und dann sprechen wir noch ueber';
        const r = decideNoOpenCutAction({
            text,
            decision: { decision: 'would_force_fallback', reason: 'age_budget_forces_partial_fallback' },
            nowMs: T0,
            firstHeldAt: null,
        });
        expect(r.action).toBe('emit_prefix_hold');
        // Normalised concatenation of emitted prefix + held tail == original (up to whitespace).
        const recombined = `${r.emitText} ${r.holdText}`.replace(/\s+/g, ' ').trim();
        const original = text.replace(/\s+/g, ' ').trim();
        expect(recombined).toBe(original);
    });

    it('held tail survives across cycles: firstHeldAt anchors the cap while the tail is still held', () => {
        // Cycle 1: open tail, governor holds -> tail is held, clock starts at firstHeldAt.
        const openTail = 'und wir gehen jetzt hinein in';
        const c1 = decideNoOpenCutAction({
            text: openTail,
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: T0 + 1000,
            firstHeldAt: T0,           // tail held since T0
            maxHoldMs: 8000,
        });
        expect(c1.action).toBe('hold');
        expect(c1.hardCapHit).toBe(false);
        // Cycle 2: SAME firstHeldAt (NOT reset). Within the cap the tail is still held (alive).
        const c2 = decideNoOpenCutAction({
            text: openTail,
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: T0 + 4000,
            firstHeldAt: T0,           // unchanged -> tail did NOT get dropped, clock not reset
            maxHoldMs: 8000,
        });
        expect(c2.action).toBe('hold');
        expect(c2.hardCapHit).toBe(false);
    });
});

describe('no-open-cut: clearHeldTail hygiene (OPT1)', () => {
    it('resets trackedTail and firstHeldAt on a held fallbackState entry', () => {
        const fb = { trackedTail: 'und wir gehen in', firstHeldAt: T0, lastConfirmedAt: T0, lastFallbackText: 'x' };
        const did = clearHeldTail(fb);
        expect(did).toBe(true);
        expect(fb.trackedTail).toBe('');
        expect(fb.firstHeldAt).toBe(null);
        // Unrelated fields are left untouched (hygiene is scoped to the held-tail diagnostics).
        expect(fb.lastConfirmedAt).toBe(T0);
        expect(fb.lastFallbackText).toBe('x');
    });

    it('is idempotent: a second call on an already-clear entry keeps it clear', () => {
        const fb = { trackedTail: '', firstHeldAt: null };
        expect(clearHeldTail(fb)).toBe(true);
        expect(fb.trackedTail).toBe('');
        expect(fb.firstHeldAt).toBe(null);
    });

    it('is null-safe: returns false and does not throw when fb is absent', () => {
        expect(clearHeldTail(null)).toBe(false);
        expect(clearHeldTail(undefined)).toBe(false);
    });

    it('after clear, a fresh hold re-stamps firstHeldAt from the NEW first hold (clock not stuck)', () => {
        // Simulates: thought closed -> clearHeldTail -> a new open tail starts holding later.
        const fb = { trackedTail: 'old tail', firstHeldAt: T0 };
        clearHeldTail(fb);
        // Caller stamps firstHeldAt only when it is null (the wiring contract).
        const stampAt = T0 + 30000;
        if (fb.firstHeldAt == null) fb.firstHeldAt = stampAt;
        expect(fb.firstHeldAt).toBe(stampAt);  // new clock, not the stale T0
        // And the hard cap is measured from the NEW stamp, so a tail held briefly after a close
        // is not instantly force-opened by a stale clock.
        const r = decideNoOpenCutAction({
            text: 'und wir gehen jetzt hinein in',  // no safe boundary
            decision: { decision: 'would_hold', reason: 'waiting_for_safe_boundary' },
            nowMs: stampAt + 1000,
            firstHeldAt: fb.firstHeldAt,
            maxHoldMs: 8000,
        });
        expect(r.action).toBe('hold');
        expect(r.hardCapHit).toBe(false);
    });
});

describe('no-open-cut: integration – real governor decision steers emission', () => {
    it('governor force_fallback on an open partial -> wiring holds, not blind flush', () => {
        // Produce a REAL decision from flowGovernor (not a hand-mocked one).
        const decision = decideFlowGovernor({
            text: 'Wir schauen heute auf Hiob und auf die Frage des Leidens',
            ageMs: 7200,
            profile: 'fast',
            completenessScore: 0.6,
        });
        expect(decision.decision).toBe('would_force_fallback');

        const r = decideNoOpenCutAction({ text: decision.text, decision, nowMs: T0, firstHeldAt: null });
        // The text ends on "Leidens" (content word, no terminal, no clause punct) -> no safe
        // boundary -> the wiring HOLDS instead of emitting the open fragment.
        expect(r.action).toBe('hold');
        expect(r.emitText).toBe('');
    });

    it('governor would_hold on a stable-but-unbounded prefix -> wiring holds', () => {
        const decision = decideFlowGovernor({
            text: 'Das ist ein stabiler Anfang und dann kommt noch mehr',
            stablePrefix: 'Das ist ein stabiler Anfang',
            ageMs: 6000,
            profile: 'normal',
            completenessScore: 0.7,
        });
        expect(decision.decision).toBe('would_hold');

        const r = decideNoOpenCutAction({ text: decision.text, decision, nowMs: T0, firstHeldAt: null });
        expect(r.action).toBe('hold');
    });

    it('governor micro_emit on a closed phrase -> wiring emits verbatim (parity)', () => {
        const decision = decideFlowGovernor({
            text: 'Gott ist treu und seine Gnade bleibt.',
            ageMs: 1200,
            profile: 'normal',
        });
        expect(decision.decision).toBe('would_micro_emit');

        const r = decideNoOpenCutAction({ text: decision.text, decision, nowMs: T0, firstHeldAt: null });
        expect(r.action).toBe('emit_full');
        expect(r.emitText).toBe('Gott ist treu und seine Gnade bleibt.');
        expect(r.emission_completeness).toBe('closed');
    });
});
