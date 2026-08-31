import { describe, expect, it } from 'vitest';
import { buildSsml, normalizeNumeralsForSpeech } from '../ttsService.js';

/**
 * Thousands separator in speech.
 *
 * SYMPTOM: "3.000 Rindern" read aloud as "three - zero zero zero".
 * CAUSE: `buildSsml` replaces EVERY dot with `<break time="300ms"/>`, so the number falls apart
 * before it is even sent to Azure. The fix must therefore run BEFORE punctuation substitution -
 * these tests guard both.
 */

describe('normalizeNumeralsForSpeech - thousands separator', () => {
    it('reassembles a number carrying a separator', () => {
        expect(normalizeNumeralsForSpeech('7.000 Schafen', 'de')).toBe('7000 Schafen');
        expect(normalizeNumeralsForSpeech('1.234.567 Menschen', 'de')).toBe('1234567 Menschen');
        expect(normalizeNumeralsForSpeech('mit 7.000 Schafen, 3.000 Rindern', 'de'))
            .toBe('mit 7000 Schafen, 3000 Rindern');
    });

    it('does NOT touch fractions, versions or verse numbers', () => {
        for (const text of ['3.14', '4.52', 'Hiob 3. Vers 14', 'Kapitel 38.', 'rev 0000209']) {
            expect(normalizeNumeralsForSpeech(text, 'de')).toBe(text);
        }
    });

    it('does NOT touch a decimal part after the separator', () => {
        // `3.000,50` - the dot is adjacent to a decimal part, so the whole value is left alone
        expect(normalizeNumeralsForSpeech('3.000,50 Franken', 'de')).toBe('3.000,50 Franken');
    });

    it('applies ONLY to languages that use the dot as a thousands separator', () => {
        // In English the dot is the DECIMAL separator: `3.141` is not `3141`.
        expect(normalizeNumeralsForSpeech('3.141 sheep', 'en')).toBe('3.141 sheep');
        expect(normalizeNumeralsForSpeech('7.000 owiec', 'pl')).toBe('7.000 owiec');
    });

    it('passes through empty and non-text input', () => {
        expect(normalizeNumeralsForSpeech('', 'de')).toBe('');
        expect(normalizeNumeralsForSpeech(null, 'de')).toBeNull();
    });
});

describe('buildSsml - a number does not fall apart into a break', () => {
    it('REGRESSION: `3.000` does not become `3 <break/> 000`', () => {
        const ssml = buildSsml('mit 3.000 Rindern', 'de', 'male');
        expect(ssml).toContain('3000');
        expect(ssml).not.toMatch(/3\s*<break[^>]*\/>\s*000/);
    });

    it('a sentence-ending dot STILL produces a break', () => {
        const ssml = buildSsml('Gott ist die Antwort. Amen', 'de', 'male');
        expect(ssml).toContain('<break time="300ms"/>');
    });

    it('English is left untouched', () => {
        const ssml = buildSsml('about 3.141 sheep', 'en', 'male');
        // a decimal number still splits on a break - behaviour from before the change,
        // deliberately NOT touched, because removing the dot would change the value
        expect(ssml).not.toContain('3141');
    });
});
