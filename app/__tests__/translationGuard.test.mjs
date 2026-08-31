/**
 * Unit tests for the MEANING GUARD.
 *
 * UT-G1..UT-G4: verify TRANSLATION_GUARD_ENABLED flag controls the guard section.
 * Containment for garble(ASR)→GPT meaning-flips: speaker/referent (S), negation (N),
 * verse numbers/references (R), orphan-fragment completion (F).
 * Uses buildSystemPrompt directly (exported for testability, same pattern as pathD.test.mjs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildSystemPrompt, LANGUAGE_NAMES } from '../translationService.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ALL_LANGS = Object.keys(LANGUAGE_NAMES);  // 12 langs including 'de'
const NON_DE_LANGS = ALL_LANGS.filter(l => l !== 'de');

function getPrompt(lang) {
    return buildSystemPrompt(lang);
}

afterEach(() => {
    delete process.env.TRANSLATION_GUARD_ENABLED;
});

// ── UT-G1: Flag=true → guard present in all langs ───────────────────────────

describe('UT-G1: TRANSLATION_GUARD_ENABLED=true — guard in all langs', () => {
    it('non-DE langs contain translation guard rules (S/N/R/F)', () => {
        process.env.TRANSLATION_GUARD_ENABLED = 'true';

        for (const lang of NON_DE_LANGS) {
            const prompt = getPrompt(lang);
            expect(prompt, `${lang} should contain guard heading`).toContain(
                '### MEANING GUARD (garbled ASR input):'
            );
            // S: speaker/referent
            expect(prompt, `${lang} S-rule`).toContain('never reassign who speaks or acts');
            expect(prompt, `${lang} S-rule name substitution`).toContain('do NOT substitute a name');
            // N: negation
            expect(prompt, `${lang} N-rule`).toContain('never add or remove a negation');
            // R: numbers/references/counted entities (QTY_ENTITY).
            // Long literal phrases act as a lock on the agreed wording; rewording MUST break this
            // test and force a deliberate update.
            expect(prompt, `${lang} R-rule entity`).toContain('numeric value, Bible reference, and counted noun/entity');
            expect(prompt, `${lang} R-rule verbs`).toContain('Do not infer, correct, renumber, expand, complete, or replace');
            expect(prompt, `${lang} R-rule no-Bible-prior`).toContain('replace them from Bible knowledge');
            // F: fragments
            expect(prompt, `${lang} F-rule`).toContain('do not complete it into a confident sentence');
        }
    });

    it('DE lang contains cleanup-variant guard (no translation wording)', () => {
        process.env.TRANSLATION_GUARD_ENABLED = 'true';

        const prompt = getPrompt('de');
        expect(prompt).toContain('### MEANING GUARD (garbled ASR input):');
        expect(prompt).toContain('Cleanup fixes FORM only');
        expect(prompt).toContain('Never add or remove a negation');
        expect(prompt).toContain('numeric value, Bible reference, and counted noun/entity');
        // the DE variant has "- do not infer..." (lower case) - assert without the first letter
        expect(prompt).toContain('o not infer, correct, renumber, expand, complete, or replace');
        expect(prompt).toContain('do not complete them into confident sentences');
    });
});

// ── UT-G2: Flag=false/unset → guard NOT present ─────────────────────────────

describe('UT-G2: TRANSLATION_GUARD_ENABLED off — no guard (baseline prompt)', () => {
    it('flag=false — non-DE and DE prompts contain no guard', () => {
        process.env.TRANSLATION_GUARD_ENABLED = 'false';

        for (const lang of ['pl', 'en', 'de']) {
            const prompt = getPrompt(lang);
            expect(prompt, `${lang} no guard heading`).not.toContain('MEANING GUARD');
            expect(prompt, `${lang} no guard rule`).not.toContain('never add or remove a negation');
        }
    });

    it('unset env var (default) — no guard', () => {
        delete process.env.TRANSLATION_GUARD_ENABLED;

        const prompt = getPrompt('en');
        expect(prompt).not.toContain('MEANING GUARD');
    });
});

// ── UT-G3: Prompt structure integrity ───────────────────────────────────────

describe('UT-G3: guard placement and formatting', () => {
    it('guard appears AFTER ASR CLEANUP and BEFORE GUIDELINES', () => {
        process.env.TRANSLATION_GUARD_ENABLED = 'true';

        for (const lang of ['en', 'pl', 'de', 'it']) {
            const prompt = getPrompt(lang);
            const cleanupIdx = prompt.indexOf('### ASR CLEANUP');
            const guardIdx = prompt.indexOf('### MEANING GUARD');
            const guidelinesIdx = lang === 'de'
                ? prompt.indexOf('### CLEANUP GUIDELINES:')
                : prompt.indexOf('### TRANSLATION GUIDELINES:');

            expect(cleanupIdx, `${lang} ASR CLEANUP exists`).toBeGreaterThan(-1);
            expect(guardIdx, `${lang} guard exists`).toBeGreaterThan(-1);
            expect(guidelinesIdx, `${lang} guidelines exist`).toBeGreaterThan(-1);
            expect(guardIdx, `${lang} guard after cleanup`).toBeGreaterThan(cleanupIdx);
            expect(guardIdx, `${lang} guard before guidelines`).toBeLessThan(guidelinesIdx);
        }
    });

    it('guard section is well-formed (no triple newlines internally)', () => {
        process.env.TRANSLATION_GUARD_ENABLED = 'true';

        for (const lang of ['en', 'pl', 'de']) {
            const prompt = getPrompt(lang);
            const guardIdx = prompt.indexOf('### MEANING GUARD');
            const endIdx = lang === 'de'
                ? prompt.indexOf('### CLEANUP GUIDELINES:', guardIdx)
                : prompt.indexOf('### TRANSLATION GUIDELINES:', guardIdx);
            const section = prompt.substring(guardIdx, endIdx);
            expect(section, `${lang} guard section clean`).not.toMatch(/\n\n\n/);
        }
    });
});

// ── UT-G4: cache isolation (flag flip must not serve stale prompt) ──────────

describe('UT-G4: systemPromptCache keyed by guard flag', () => {
    it('OFF → ON → OFF returns baseline prompt again (no stale cache)', () => {
        delete process.env.TRANSLATION_GUARD_ENABLED;
        const promptOff1 = getPrompt('pl');

        process.env.TRANSLATION_GUARD_ENABLED = 'true';
        const promptOn = getPrompt('pl');

        delete process.env.TRANSLATION_GUARD_ENABLED;
        const promptOff2 = getPrompt('pl');

        expect(promptOn).toContain('MEANING GUARD');
        expect(promptOff1).not.toContain('MEANING GUARD');
        expect(promptOff2).toBe(promptOff1);  // byte-identical baseline (Azure cache safe)
        expect(promptOn).not.toBe(promptOff1);
    });
});
