import { describe, it, expect } from 'vitest';
import {
    normWords,
    computeSourceDelta,
    buildDeadlinePayload,
    tailIsSignificant,
    supersedeDecisionBaseline,
    supersedeDecisionReviewFixes,
    supersedeDecisionFor,
} from '../deadlineProvisional.js';

describe('normWords', () => {
    it('lowercases, strips punctuation, collapses whitespace', () => {
        expect(normWords('Der  Herr, spricht!')).toEqual(['der', 'herr', 'spricht']);
    });
    it('handles empty / null', () => {
        expect(normWords('')).toEqual([]);
        expect(normWords(null)).toEqual([]);
    });
});

describe('computeSourceDelta', () => {
    it('returns the appended tail when latest extends emitted (clean prefix)', () => {
        const emitted = normWords('Der Herr ist mein Hirte');
        const r = computeSourceDelta(emitted, 'Der Herr ist mein Hirte, mir wird nichts mangeln.');
        expect(r.diverged).toBe(false);
        expect(r.delta).toBe('mir wird nichts mangeln.');
        expect(r.deltaWords).toBe(4);
    });

    it('preserves original casing/punctuation of the delta (not normalized)', () => {
        const emitted = normWords('Gott ist');
        const r = computeSourceDelta(emitted, 'Gott ist Liebe, spricht Johannes.');
        expect(r.delta).toBe('Liebe, spricht Johannes.');
    });

    it('flags divergence when emitted head was corrected (head revision)', () => {
        const emitted = normWords('Irgendeine Sache');
        const r = computeSourceDelta(emitted, 'Nicht irgendeine Sache, sondern diese.');
        expect(r.diverged).toBe(true);
        expect(r.delta).toBe('');
    });

    it('empty emitted -> whole latest is the delta', () => {
        const r = computeSourceDelta([], 'Ein neuer Satz.');
        expect(r.diverged).toBe(false);
        expect(r.delta).toBe('Ein neuer Satz.');
        expect(r.deltaWords).toBe(3);
    });

    it('no new content when latest equals emitted', () => {
        const emitted = normWords('Alles gleich.');
        const r = computeSourceDelta(emitted, 'Alles gleich.');
        expect(r.diverged).toBe(false);
        expect(r.deltaWords).toBe(0);
        expect(r.delta).toBe('');
    });

    it('tolerates punctuation-only tokens in the latest string', () => {
        const emitted = normWords('Er sagte');
        const r = computeSourceDelta(emitted, 'Er sagte -- und ging.');
        expect(r.diverged).toBe(false);
        // "--" is dropped as a pure-punctuation token; delta starts at "und"
        expect(normWords(r.delta)).toEqual(['und', 'ging']);
    });
});

describe('buildDeadlinePayload — fallback ladder', () => {
    it('rung 1: emits new stable delta when stable advanced enough', () => {
        const r = buildDeadlinePayload({
            latestStable: 'Der Herr ist gut, seine Gnade waehret ewig.',
            latestPartial: 'Der Herr ist gut, seine Gnade waehret ewig und',
            emittedNorm: normWords('Der Herr ist gut,'),
            minWords: 3,
        });
        expect(r.mode).toBe('deadline_stable');
        expect(r.text).toBe('seine Gnade waehret ewig.');
    });

    it('rung 2: falls back to safe closed prefix of partial when stable static', () => {
        const r = buildDeadlinePayload({
            latestStable: 'Der Herr ist gut,',                       // no new stable
            latestPartial: 'Der Herr ist gut, seine Gnade bleibt, aber wir', // safe prefix ends at "bleibt,"
            emittedNorm: normWords('Der Herr ist gut,'),
            minWords: 3,
        });
        expect(r.mode).toBe('deadline_safe_prefix');
        // "aber wir" is an open tail -> dropped; safe prefix delta = "seine Gnade bleibt,"
        expect(r.text).toBe('seine Gnade bleibt,');
    });

    it('rung 3: no safe payload when only raw mid-clause and no safe boundary', () => {
        const r = buildDeadlinePayload({
            latestStable: 'Der Herr ist gut',
            latestPartial: 'Der Herr ist gut seine Gnade und die',  // no clause punctuation -> no safe prefix
            emittedNorm: normWords('Der Herr ist gut'),
            minWords: 3,
        });
        expect(r.mode).toBe('deadline_no_safe_payload');
        expect(r.text).toBe('');
    });

    it('rung 3: stable delta below minWords and no safe prefix delta -> skip', () => {
        const r = buildDeadlinePayload({
            latestStable: 'Der Herr ist gut, ja',   // only "ja" is new (1 word < 3)
            latestPartial: 'Der Herr ist gut, ja',
            emittedNorm: normWords('Der Herr ist gut,'),
            minWords: 3,
        });
        expect(r.mode).toBe('deadline_no_safe_payload');
    });

    it('never emits a corrected head as a stable delta (divergence -> ladder continues)', () => {
        const r = buildDeadlinePayload({
            latestStable: 'Nicht irgendeine Sache, sondern diese Wahrheit.',
            latestPartial: 'Nicht irgendeine Sache, sondern diese Wahrheit.',
            emittedNorm: normWords('Irgendeine Sache'),  // head was revised
            minWords: 3,
        });
        // stable diverged; safe-prefix path also computes delta vs the (diverged) emitted head.
        // Since emitted "irgendeine sache" is not a prefix of the corrected head, safe path also
        // diverges -> no_safe_payload (conservative: short silence over replaying corrected head).
        expect(r.mode).toBe('deadline_no_safe_payload');
    });
});

describe('supersedeDecisionReviewFixes — final vs cumulative emitted span (arm NOT validated, flag OFF)', () => {
    it('suppresses a final that exactly repeats the emitted span', () => {
        const r = supersedeDecisionReviewFixes({ finalText: 'Der Herr ist gut.', emittedNorm: normWords('Der Herr ist gut.') });
        expect(r.action).toBe('suppress');
        expect(r.tailWords).toBe(0);
    });

    it('emits only the new tail when the final extends the emitted span', () => {
        const r = supersedeDecisionReviewFixes({
            finalText: 'Der Herr ist gut, und seine Gnade bleibt ewig.',
            emittedNorm: normWords('Der Herr ist gut,'), minWords: 3,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('und seine Gnade bleibt ewig.');
        expect(r.coveredWords).toBe(4);
    });

    it('finding #2: does NOT replay B when cumulative span already covers A+B', () => {
        // provisionals A ("Der Herr ist gut,") then B ("und bleibt treu") -> cumulative = A+B.
        // final = A + B + C. Must emit ONLY C, never re-emit B.
        const emittedNorm = normWords('Der Herr ist gut, und bleibt treu');
        const r = supersedeDecisionReviewFixes({
            finalText: 'Der Herr ist gut, und bleibt treu, spricht der Herr.',
            emittedNorm, minWords: 2,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('spricht der Herr.');
        expect(r.coveredWords).toBe(7);
    });

    it('suppresses when the final is fully inside the emitted span (over-emitted prefix)', () => {
        const r = supersedeDecisionReviewFixes({
            finalText: 'Der Herr ist gut',
            emittedNorm: normWords('Der Herr ist gut, seine Gnade bleibt.'),
        });
        expect(r.action).toBe('suppress');
    });

    it('finding #5: suppresses a negligible non-significant tail below minEmitTailWords', () => {
        const r = supersedeDecisionReviewFixes({
            finalText: 'Der Herr ist gut, ja.',
            emittedNorm: normWords('Der Herr ist gut'), minWords: 3, minEmitTailWords: 3,
        });
        expect(r.action).toBe('suppress');
        expect(r.tailWords).toBe(1);
    });

    it('finding #5: RESCUES a short tail carrying a number (Hiob 42)', () => {
        const r = supersedeDecisionReviewFixes({
            finalText: 'lest das Buch Hiob 42',
            emittedNorm: normWords('lest das Buch Hiob'), minEmitTailWords: 3,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('42');
    });

    it('finding #5: RESCUES a short tail carrying a negation', () => {
        const r = supersedeDecisionReviewFixes({
            finalText: 'Gott vergisst dich nicht',
            emittedNorm: normWords('Gott vergisst dich'), minEmitTailWords: 3,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('nicht');
    });

    it('passes a final that diverges from the emitted span (real new semantics)', () => {
        const r = supersedeDecisionReviewFixes({ finalText: 'Ganz etwas anderes jetzt.', emittedNorm: normWords('Der Herr ist gut') });
        expect(r.action).toBe('pass');
    });

    it('passes when nothing was emitted (empty span)', () => {
        const r = supersedeDecisionReviewFixes({ finalText: 'Der Herr ist gut.', emittedNorm: [] });
        expect(r.action).toBe('pass');
    });
});

describe('tailIsSignificant', () => {
    it('true for digits and negations, false for a bare noun tail', () => {
        expect(tailIsSignificant('42')).toBe(true);
        expect(tailIsSignificant('Hiob 42')).toBe(true);
        expect(tailIsSignificant('nicht')).toBe(true);
        expect(tailIsSignificant('kein Wunder')).toBe(true);
        expect(tailIsSignificant('Hiob')).toBe(false);
        expect(tailIsSignificant('der Herr')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Baseline arm = the pinned baseline image = listening review 4.52.
// Vectors copied from the baseline image's own test file, INCLUDING the per-entry ledger
// semantics that have no equivalent in the cumulative arm (entry.superseded,
// largest-coverage pick, per-entry TTL, old minWords rule). These are the gate:
// the pre-P0.1 suite locked the NO-GO arm only, so a green suite proved nothing
// about 4.52.
// ---------------------------------------------------------------------------
describe('supersedeDecisionBaseline — final vs per-entry ledger (arm VALIDATED = 4.52)', () => {
    const at = 1_000_000;

    it('suppresses a final that exactly repeats a provisional', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Der Herr ist gut.',
            ledger: [{ norm: normWords('Der Herr ist gut.'), at, superseded: false }],
            now: at + 1000,
        });
        expect(r.action).toBe('suppress');
        expect(r.tailWords).toBe(0);
    });

    it('emits only the new tail when the final extends a provisional', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Der Herr ist gut, und seine Gnade bleibt ewig.',
            ledger: [{ norm: normWords('Der Herr ist gut,'), at, superseded: false }],
            now: at + 1000, minWords: 3,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('und seine Gnade bleibt ewig.');
        expect(r.coveredWords).toBe(4);
    });

    it('suppresses when the extending tail is below minWords (OLD rule: no significance rescue)', () => {
        // Divergence from the reviewFixes arm: baseline has NO tailIsSignificant escape hatch,
        // so even a digit-carrying short tail is suppressed. Locking this on purpose - it is
        // 4.52 behavior; "improving" it here would silently re-introduce finding #5.
        const r = supersedeDecisionBaseline({
            finalText: 'Wir lesen Hiob 42.',
            ledger: [{ norm: normWords('Wir lesen'), at, superseded: false }],
            now: at + 1000, minWords: 3,
        });
        expect(r.action).toBe('suppress');
        expect(r.tailWords).toBe(2);
    });

    it('passes a final that diverges from every provisional (real new semantics)', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Ganz andere Worte hier.',
            ledger: [{ norm: normWords('Der Herr ist gut'), at, superseded: false }],
            now: at + 1000,
        });
        expect(r.action).toBe('pass');
    });

    it('ignores ledger entries older than the TTL (per-entry expiry)', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Der Herr ist gut.',
            ledger: [{ norm: normWords('Der Herr ist gut.'), at, superseded: false }],
            now: at + 26_000, ttlMs: 25_000,
        });
        expect(r.action).toBe('pass');
    });

    it('ignores already-superseded entries', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Der Herr ist gut.',
            ledger: [{ norm: normWords('Der Herr ist gut.'), at, superseded: true }],
            now: at + 1000,
        });
        expect(r.action).toBe('pass');
    });

    it('picks the provisional with the largest coverage when several match', () => {
        const r = supersedeDecisionBaseline({
            finalText: 'Der Herr ist gut, und bleibt treu, spricht der Herr.',
            ledger: [
                { norm: normWords('Der Herr'), at, superseded: false },
                { norm: normWords('Der Herr ist gut, und bleibt treu'), at, superseded: false },
                { norm: normWords('Der Herr ist'), at, superseded: false },
            ],
            now: at + 1000, minWords: 2,
        });
        expect(r.action).toBe('emit_tail');
        expect(r.text).toBe('spricht der Herr.');
        expect(r.coveredWords).toBe(7);
        // The caller marks this entry superseded — the cumulative arm cannot.
        expect(r.entry.norm).toEqual(normWords('Der Herr ist gut, und bleibt treu'));
    });
});

// ---------------------------------------------------------------------------
// P0.1 (5a): routing. Two correct algorithms prove nothing if the 4.52 config
// calls the wrong one. supersedeDecisionFor is the ONLY place the flag decides.
// ---------------------------------------------------------------------------
describe('supersedeDecisionFor — flag routing', () => {
    const at = 1_000_000;
    // One input where the arms MUST disagree, so the assertion cannot pass by accident:
    // a short digit tail. Baseline suppresses (old minWords rule); reviewFixes rescues it
    // via tailIsSignificant (finding #5).
    const divergent = {
        finalText: 'Wir lesen Hiob 42.',
        ledger: [{ norm: normWords('Wir lesen'), at, superseded: false }],
        now: at + 1000,
        emittedNorm: normWords('Wir lesen'),
        minWords: 3,
        minEmitTailWords: 3,
    };

    it('reviewFixes=false -> baseline semantics (4.52 config)', () => {
        expect(supersedeDecisionFor({ reviewFixes: false, ...divergent }))
            .toEqual(supersedeDecisionBaseline(divergent));
        expect(supersedeDecisionFor({ reviewFixes: false, ...divergent }).action).toBe('suppress');
    });

    it('reviewFixes=true -> review-fixes semantics', () => {
        expect(supersedeDecisionFor({ reviewFixes: true, ...divergent }))
            .toEqual(supersedeDecisionReviewFixes(divergent));
        expect(supersedeDecisionFor({ reviewFixes: true, ...divergent }).action).toBe('emit_tail');
    });

    it('defaults to baseline when the flag is absent (fail safe = 4.52)', () => {
        expect(supersedeDecisionFor(divergent).action).toBe('suppress');
    });
});
