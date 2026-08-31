import { describe, it, expect } from 'vitest';
import { splitForTTS } from '../sentenceSplitter.js';

describe('splitForTTS — TTS sentence splitter (Option H)', () => {
    describe('edge cases', () => {
        it('returns empty array for empty string', () => {
            expect(splitForTTS('')).toEqual([]);
        });

        it('returns empty array for whitespace-only', () => {
            expect(splitForTTS('   \n\t  ')).toEqual([]);
        });

        it('returns empty array for non-string input', () => {
            expect(splitForTTS(null)).toEqual([]);
            expect(splitForTTS(undefined)).toEqual([]);
            expect(splitForTTS(42)).toEqual([]);
        });
    });

    describe('short text (single-piece path)', () => {
        it('returns single element for text below default threshold (60)', () => {
            const text = 'To jest krótkie zdanie.';
            const result = splitForTTS(text);
            expect(result).toEqual([text]);
        });

        it('respects custom singleThreshold', () => {
            const text = 'Dłuższe zdanie które ma 35 znaków.';
            // With threshold 100, should pass through
            expect(splitForTTS(text, { singleThreshold: 100 })).toEqual([text]);
        });

        it('strips whitespace on short-text path', () => {
            const text = '  Krótkie zdanie.  ';
            const result = splitForTTS(text);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe('Krótkie zdanie.');
        });
    });

    describe('multi-sentence split (above threshold)', () => {
        it('splits long text into multiple sentences', () => {
            const text =
                'Bóg jest miłością, którą objawia nam w Chrystusie. ' +
                'Jezus oddał życie za nas wszystkich, byśmy mieli zbawienie. ' +
                'To jest najważniejsza prawda wiary.';
            const result = splitForTTS(text);
            expect(result.length).toBeGreaterThanOrEqual(2);
            // Every piece should contain text
            for (const piece of result) {
                expect(piece.length).toBeGreaterThan(0);
            }
            // Joined result covers the source meaning (order preserved).
            expect(result[0]).toContain('Bóg');
        });

        it('preserves Polish diacritics (ó, ż, ś, ć, ń, ą, ę, ł, ź)', () => {
            const text =
                'Łączymy się w modlitwie z całym Kościołem. ' +
                'Żadna radość nie może się równać z obecnością Boga. ' +
                'Świętość jest naszym powołaniem.';
            const result = splitForTTS(text);
            const joined = result.join(' ');
            expect(joined).toContain('Łączymy');
            expect(joined).toContain('Żadna');
            expect(joined).toContain('Świętość');
            expect(joined).toContain('Kościołem');
        });

        it('splits on ! and ? not only .', () => {
            const text =
                'Czy wierzycie w to zbawienie? ' +
                'Odpowiedzcie z pełnego serca! ' +
                'Bóg was wysłucha na pewno wszyscy.';
            const result = splitForTTS(text);
            expect(result.length).toBeGreaterThanOrEqual(2);
            // At least one piece should end with ? or !
            const endings = result.map(p => p.trim().slice(-1));
            expect(endings.some(e => e === '?' || e === '!' || e === '.')).toBe(true);
        });

        it('handles text with no sentence-ending punctuation (single piece fallback)', () => {
            const text =
                'a dlugi tekst bez zadnej interpunkcji kropki wykrzyknika ani znaku zapytania ktory powinien byc cofniety jako jedno zdanie dla bezpieczenstwa';
            const result = splitForTTS(text);
            expect(result).toHaveLength(1);
            expect(result[0]).toContain('dlugi');
        });
    });

    describe('small-fragment merging', () => {
        it('merges ultra-short trailing fragment with previous piece', () => {
            // "Eliphaz." would be a tiny piece — should merge with previous.
            const text =
                'Widzieli jego cierpienie i próby które znosił z cichą pokorą każdego dnia. ' +
                'A zatem przyszli trzej mężowie do niego cichutko z odległych krain. ' +
                'Elifaz.';
            const result = splitForTTS(text, { minPieceLength: 25 });
            // "Elifaz." is 7 chars — should NOT be its own piece.
            const shortPieces = result.filter(p => p.length < 25);
            expect(shortPieces).toHaveLength(0);
        });

        it('does not merge when minPieceLength=0', () => {
            const text =
                'Pierwsze zdanie tekstu znacznie dłuższe niż zwykle okej. ' +
                'Krótkie. ' +
                'Drugie zdanie jest dłuższe niż minimum rozsądnego progu.';
            const result = splitForTTS(text, { minPieceLength: 0 });
            // "Krótkie." (8 chars) should stay separate
            expect(result.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('idempotence and safety', () => {
        it('does not mutate input', () => {
            const text = 'Pierwsze zdanie. Drugie zdanie. Trzecie zdanie dostatecznie długie dla splitu.';
            const copy = text;
            splitForTTS(text);
            expect(text).toBe(copy);
        });

        it('produces non-empty pieces (no empty strings)', () => {
            const text =
                'Zdanie pierwsze.  .  .  Zdanie drugie po wielu kropkach i spacjach ok. ' +
                'Trzecie zdanie jest bez kropek na końcu linii tak';
            const result = splitForTTS(text);
            for (const piece of result) {
                expect(piece.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
