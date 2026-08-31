/**
 * Unit tests for QW-7 — Committed Prefix for GPT translation.
 *
 * Phase 9B.5.5a: Updated for per-lang whitelist + window 800.
 * Tests state management lifecycle: commit, accumulate, truncate, clear, isolate, per-lang.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    commitTranslation,
    getCommittedText,
    clearCommittedTranslations,
    buildSystemPrompt,
} from '../translationService.js';

// ---- helpers ----
const CHURCH = 'testChurch001';
const CHURCH2 = 'testChurch002';

// Save and restore env var
let origFlag;
beforeEach(() => {
    origFlag = process.env.COMMITTED_PREFIX_ENABLED_LANGS;
    process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'pl,it,en';
    clearCommittedTranslations(CHURCH);
    clearCommittedTranslations(CHURCH2);
});
afterEach(() => {
    if (origFlag === undefined) {
        delete process.env.COMMITTED_PREFIX_ENABLED_LANGS;
    } else {
        process.env.COMMITTED_PREFIX_ENABLED_LANGS = origFlag;
    }
    clearCommittedTranslations(CHURCH);
    clearCommittedTranslations(CHURCH2);
});

// ---- tests ----

describe('QW-7 Committed Prefix', () => {

    describe('commitTranslation', () => {
        it('accumulates correctly across multiple commits', () => {
            commitTranslation(CHURCH, 'pl', 'Hiob odpowiada.');
            expect(getCommittedText(CHURCH, 'pl')).toBe('Hiob odpowiada.');

            commitTranslation(CHURCH, 'pl', 'Przyjaciele mowia.');
            expect(getCommittedText(CHURCH, 'pl')).toBe(
                'Hiob odpowiada. Przyjaciele mowia.'
            );
        });

        it('truncates to 800 chars with sliding window', () => {
            const word = 'abcdefghij '; // 11 chars including space
            const repeats = Math.ceil(1000 / word.length);
            const longText = word.repeat(repeats).trim();

            commitTranslation(CHURCH, 'pl', longText);
            const result = getCommittedText(CHURCH, 'pl');

            expect(result.length).toBeLessThanOrEqual(800);
            expect(longText.endsWith(result.slice(-50))).toBe(true);
        });

        it('avoids mid-word truncation', () => {
            const sentence = 'hello world ';
            const repeats = Math.ceil(790 / sentence.length);
            const filler = sentence.repeat(repeats).trim();
            commitTranslation(CHURCH, 'en', filler);

            commitTranslation(CHURCH, 'en', 'final sentence here and more words');
            const result = getCommittedText(CHURCH, 'en');

            expect(result.length).toBeLessThanOrEqual(800);
            const firstWord = result.split(' ')[0];
            expect(['hello', 'world', 'final', 'sentence', 'here', 'and', 'more', 'words']).toContain(firstWord);
        });

        it('skips empty or whitespace-only input', () => {
            commitTranslation(CHURCH, 'pl', 'First.');
            commitTranslation(CHURCH, 'pl', '');
            commitTranslation(CHURCH, 'pl', '   ');
            expect(getCommittedText(CHURCH, 'pl')).toBe('First.');
        });
    });

    describe('getCommittedText', () => {
        it('returns null when state is missing', () => {
            expect(getCommittedText('nonexistent', 'pl')).toBeNull();
        });

        it('returns null for existing church but missing lang', () => {
            commitTranslation(CHURCH, 'pl', 'Tekst.');
            expect(getCommittedText(CHURCH, 'fr')).toBeNull();
        });
    });

    describe('clearCommittedTranslations', () => {
        it('resets all langs for given church', () => {
            commitTranslation(CHURCH, 'pl', 'Polski.');
            commitTranslation(CHURCH, 'en', 'English.');
            commitTranslation(CHURCH, 'it', 'Italiano.');

            clearCommittedTranslations(CHURCH);

            expect(getCommittedText(CHURCH, 'pl')).toBeNull();
            expect(getCommittedText(CHURCH, 'en')).toBeNull();
            expect(getCommittedText(CHURCH, 'it')).toBeNull();
        });

        it('does not affect other churches', () => {
            commitTranslation(CHURCH, 'pl', 'Church1.');
            commitTranslation(CHURCH2, 'pl', 'Church2.');

            clearCommittedTranslations(CHURCH);

            expect(getCommittedText(CHURCH, 'pl')).toBeNull();
            expect(getCommittedText(CHURCH2, 'pl')).toBe('Church2.');
        });
    });

    describe('per-(churchId, lang) isolation', () => {
        it('keeps state independent across churches and langs', () => {
            commitTranslation(CHURCH, 'pl', 'PL1');
            commitTranslation(CHURCH, 'en', 'EN1');
            commitTranslation(CHURCH2, 'pl', 'PL2');

            expect(getCommittedText(CHURCH, 'pl')).toBe('PL1');
            expect(getCommittedText(CHURCH, 'en')).toBe('EN1');
            expect(getCommittedText(CHURCH2, 'pl')).toBe('PL2');
            expect(getCommittedText(CHURCH2, 'en')).toBeNull();
        });
    });

    describe('per-lang feature flag (whitelist)', () => {
        it('enables only whitelisted languages', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'pl,it,en';

            commitTranslation(CHURCH, 'pl', 'Test PL');
            expect(getCommittedText(CHURCH, 'pl')).toBe('Test PL');

            // DE is NOT whitelisted (architecturally broken)
            commitTranslation(CHURCH, 'de', 'Test DE');
            expect(getCommittedText(CHURCH, 'de')).toBeNull();

            // ES is NOT whitelisted
            commitTranslation(CHURCH, 'es', 'Test ES');
            expect(getCommittedText(CHURCH, 'es')).toBeNull();
        });

        it('handles empty whitelist (all disabled)', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = '';
            commitTranslation(CHURCH, 'pl', 'Test');
            expect(getCommittedText(CHURCH, 'pl')).toBeNull();
        });

        it('handles unset whitelist (all disabled)', () => {
            delete process.env.COMMITTED_PREFIX_ENABLED_LANGS;
            commitTranslation(CHURCH, 'pl', 'Test');
            expect(getCommittedText(CHURCH, 'pl')).toBeNull();
        });

        it('case-insensitive lang matching', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'PL,IT,EN';
            commitTranslation(CHURCH, 'pl', 'Test');
            expect(getCommittedText(CHURCH, 'pl')).toBe('Test');
        });

        it('trims whitespace in whitelist', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = ' pl , it , en ';
            commitTranslation(CHURCH, 'pl', 'Test');
            expect(getCommittedText(CHURCH, 'pl')).toBe('Test');
        });
    });

    describe('softer prompt content', () => {
        it('non-DE prompt includes softer CP instruction when enabled', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'pl';
            const prompt = buildSystemPrompt('pl');
            expect(prompt).toContain('translate the full sermon text');
            expect(prompt).toContain('do NOT skip translating new content');
        });

        it('non-DE prompt has no CP instruction when lang not in whitelist', () => {
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'it,en';
            const prompt = buildSystemPrompt('pl');
            expect(prompt).not.toContain('already_translated');
        });

        it('DE prompt has no CP instruction regardless of whitelist', () => {
            // ASSERTED, not merely named. Until 29.08 this test set the env var,
            // built the prompt and stopped: no expect() at all, so the claim in
            // its own name could not fail. Vitest's --expect.requireAssertions
            // found it, and it was the only one of 1117.
            //
            // The claim turns out to be true and is now measured: DE is the
            // source language, so even with 'de' wrongly present in the
            // whitelist none of the committed-prefix wording reaches the prompt.
            process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'de,pl,it,en';
            const prompt = buildSystemPrompt('de');
            expect(prompt).not.toContain('already_translated');
            expect(prompt).not.toContain('translate the full sermon text');
            expect(prompt).not.toContain('do NOT skip translating new content');

            // Same whitelist, a target language: the instruction IS there. This
            // half stops the assertions above from passing for the trivial reason
            // that the wording had simply been renamed.
            expect(buildSystemPrompt('pl')).toContain('already_translated');
        });
    });
});
