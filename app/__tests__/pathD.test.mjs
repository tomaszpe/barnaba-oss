/**
 * Unit tests for Path D — translation prompt consolidation (Project B, B3.3).
 *
 * UT-D1..UT-D3: verify TRANSLATION_CONSOLIDATION flag controls prompt instruction.
 * Uses buildSystemPrompt directly (exported for testability).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildSystemPrompt, LANGUAGE_NAMES } from '../translationService.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ALL_LANGS = Object.keys(LANGUAGE_NAMES);  // 12 langs including 'de'
const NON_DE_LANGS = ALL_LANGS.filter(l => l !== 'de');

// buildSystemPrompt(targetLang, glossaryTerms, previousContext, sermonContext)
function getPrompt(lang) {
    return buildSystemPrompt(lang, [], '', null);
}

// ── UT-D1: Flag=true → instruction present in all langs ─────────────────────

describe('UT-D1: TRANSLATION_CONSOLIDATION=true — instruction in all langs', () => {
    afterEach(() => {
        delete process.env.TRANSLATION_CONSOLIDATION;
    });

    it('non-DE langs contain exact B1.8 Variant C text', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'true';

        for (const lang of NON_DE_LANGS) {
            const prompt = getPrompt(lang);
            expect(prompt, `${lang} should contain Variant C instruction`).toContain(
                'Treat input as streaming transcript'
            );
            expect(prompt, `${lang} should contain non-redundant`).toContain(
                'non-redundant output'
            );
        }
    });

    it('DE lang contains same Variant C consolidation text', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'true';

        const prompt = getPrompt('de');
        expect(prompt).toContain('Treat input as streaming transcript');
        expect(prompt).toContain('non-redundant output');
    });
});

// ── UT-D2: Flag=false → instruction NOT present ─────────────────────────────

describe('UT-D2: TRANSLATION_CONSOLIDATION=false — no instruction', () => {
    afterEach(() => {
        delete process.env.TRANSLATION_CONSOLIDATION;
    });

    it('non-DE prompt does NOT contain consolidation instruction', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'false';

        const prompt = getPrompt('pl');
        expect(prompt).not.toContain('streaming transcript');
        expect(prompt).not.toContain('STREAMING DEDUP');
    });

    it('DE prompt does NOT contain consolidation instruction', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'false';

        const prompt = getPrompt('de');
        expect(prompt).not.toContain('streaming transcript');
        expect(prompt).not.toContain('STREAMING DEDUP');
    });

    it('unset env var (default) — no instruction', () => {
        delete process.env.TRANSLATION_CONSOLIDATION;

        const prompt = getPrompt('en');
        expect(prompt).not.toContain('streaming transcript');
        expect(prompt).not.toContain('STREAMING DEDUP');
    });
});

// ── UT-D3: Prompt structure integrity ───────────────────────────────────────

describe('UT-D3: Prompt structure integrity with consolidation', () => {
    afterEach(() => {
        delete process.env.TRANSLATION_CONSOLIDATION;
    });

    it('instruction appears BEFORE SECURITY section in non-DE', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'true';

        const prompt = getPrompt('en');
        const dedupIdx = prompt.indexOf('STREAMING DEDUP');
        const securityIdx = prompt.indexOf('### SECURITY:');

        expect(dedupIdx, 'STREAMING DEDUP must exist').toBeGreaterThan(-1);
        expect(securityIdx, 'SECURITY must exist').toBeGreaterThan(-1);
        expect(dedupIdx, 'STREAMING DEDUP before SECURITY').toBeLessThan(securityIdx);
    });

    it('instruction appears BEFORE SECURITY section in DE', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'true';

        const prompt = getPrompt('de');
        const dedupIdx = prompt.indexOf('STREAMING DEDUP');
        const securityIdx = prompt.indexOf('### SECURITY:');

        expect(dedupIdx).toBeGreaterThan(-1);
        expect(securityIdx).toBeGreaterThan(-1);
        expect(dedupIdx).toBeLessThan(securityIdx);
    });

    it('STREAMING DEDUP section is well-formed (no malformed breaks)', () => {
        process.env.TRANSLATION_CONSOLIDATION = 'true';

        for (const lang of ['en', 'pl', 'de', 'it']) {
            const prompt = getPrompt(lang);
            // Extract the STREAMING DEDUP section and its immediate context
            const dedupIdx = prompt.indexOf('### STREAMING DEDUP:');
            const securityIdx = prompt.indexOf('### SECURITY:', dedupIdx);
            const section = prompt.substring(dedupIdx, securityIdx);
            // Section should not have triple newlines internally
            expect(section, `${lang} STREAMING DEDUP section clean`).not.toMatch(/\n\n\n/);
        }
    });
});
