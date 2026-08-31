/**
 * Unit tests for fix #1 — per-language context buffer isolation.
 *
 * Bug ("TRANSLATION CONTEXT BUGS", issue #1):
 * contextBuffer keyed by churchId only (no targetLang). translateToAllLanguages
 * runs Promise.all across languages → each language reads/writes the same buffer
 * → a given language receives another language's translated text as
 * "previous context". Non-deterministic terminology drift between emissions.
 *
 * Fix: contextBuffer becomes Map<churchId, Map<lang, {sentences}>>; updateContextBuffer
 * and getPreviousContext take targetLang. Pre-warm seed stays a shared per-church
 * fallback shown to every language until that language has its own content.
 *
 * Mirrors committedPrefix.test.mjs state-lifecycle pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    updateContextBuffer,
    getPreviousContext,
    clearContextBuffer,
    preWarmContextBuffer,
} from '../translationService.js';

const CHURCH = 'ctxChurch001';
const CHURCH2 = 'ctxChurch002';

beforeEach(() => {
    clearContextBuffer(CHURCH);
    clearContextBuffer(CHURCH2);
});
afterEach(() => {
    clearContextBuffer(CHURCH);
    clearContextBuffer(CHURCH2);
});

describe('Context buffer — per-language isolation (fix #1)', () => {
    it('returns null when empty', () => {
        expect(getPreviousContext(CHURCH, 'pl')).toBeNull();
    });

    it('pl update does not leak into en (the bug)', () => {
        updateContextBuffer(CHURCH, 'pl', 'Hiob spricht.', 'Hiob mowi.');
        expect(getPreviousContext(CHURCH, 'pl')).toBe('Hiob mowi.');
        // Before fix: en reads the shared buffer and gets the Polish text.
        expect(getPreviousContext(CHURCH, 'en')).toBeNull();
    });

    it('each language accumulates independently', () => {
        updateContextBuffer(CHURCH, 'pl', 'A.', 'A-pl.');
        updateContextBuffer(CHURCH, 'en', 'A.', 'A-en.');
        updateContextBuffer(CHURCH, 'pl', 'B.', 'B-pl.');
        expect(getPreviousContext(CHURCH, 'pl')).toBe('A-pl. B-pl.');
        expect(getPreviousContext(CHURCH, 'en')).toBe('A-en.');
    });

    it('keeps only last 2 sentences per language', () => {
        updateContextBuffer(CHURCH, 'pl', 's1', 't1');
        updateContextBuffer(CHURCH, 'pl', 's2', 't2');
        updateContextBuffer(CHURCH, 'pl', 's3', 't3');
        expect(getPreviousContext(CHURCH, 'pl')).toBe('t2 t3');
    });

    it('isolates per church', () => {
        updateContextBuffer(CHURCH, 'pl', 's', 'church1-pl');
        expect(getPreviousContext(CHURCH2, 'pl')).toBeNull();
    });

    it('clearContextBuffer wipes all languages for a church', () => {
        updateContextBuffer(CHURCH, 'pl', 's', 'tpl');
        updateContextBuffer(CHURCH, 'en', 's', 'ten');
        clearContextBuffer(CHURCH);
        expect(getPreviousContext(CHURCH, 'pl')).toBeNull();
        expect(getPreviousContext(CHURCH, 'en')).toBeNull();
    });
});

describe('Pre-warm seed — shared per-church fallback', () => {
    it('pre-warm shows for every language until that language has own content', () => {
        preWarmContextBuffer(CHURCH, 'Hiob leidet und vertraut Gott in der Pruefung.');
        const pl = getPreviousContext(CHURCH, 'pl');
        expect(pl).toContain('Sermon preparation');
        expect(pl).toContain('Hiob leidet');
        // same seed visible to another language
        expect(getPreviousContext(CHURCH, 'en')).toContain('Sermon preparation');
    });

    it('real translation coexists with seed for one round, then slides it out', () => {
        preWarmContextBuffer(CHURCH, 'seed text here');
        updateContextBuffer(CHURCH, 'pl', 's1', 't1');
        const after1 = getPreviousContext(CHURCH, 'pl');
        expect(after1).toContain('seed text here');
        expect(after1).toContain('t1');
        updateContextBuffer(CHURCH, 'pl', 's2', 't2');
        expect(getPreviousContext(CHURCH, 'pl')).toBe('t1 t2');
    });

    it('seed does not bleed across languages once one language advances', () => {
        preWarmContextBuffer(CHURCH, 'seed');
        updateContextBuffer(CHURCH, 'pl', 's1', 't1');
        updateContextBuffer(CHURCH, 'pl', 's2', 't2'); // pl slid past seed
        expect(getPreviousContext(CHURCH, 'pl')).toBe('t1 t2');
        // en still on the seed (hasn't translated yet)
        expect(getPreviousContext(CHURCH, 'en')).toContain('seed');
    });
});
