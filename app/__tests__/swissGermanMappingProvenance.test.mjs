import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeSwissGerman } from '../glossary/glossaryService.js';

const data = JSON.parse(readFileSync(
    new URL('../glossary/swissGermanMapping.json', import.meta.url),
    'utf8',
));

const mappingEntries = Object.values(data.mappings).flatMap((category) => Object.entries(category));
const phraseEntries = Object.entries(data.phrases);

describe('clean-room Swiss German mapping', () => {
    it('keeps declared counts and entries internally consistent', () => {
        expect(data.version).toBe('2.0.0');
        expect(mappingEntries).toHaveLength(190);
        expect(phraseEntries).toHaveLength(79);
        expect(data.mappingCount).toBe(mappingEntries.length + phraseEntries.length);

        for (const [source, target] of [...mappingEntries, ...phraseEntries]) {
            expect(source.trim()).not.toBe('');
            expect(target.trim()).not.toBe('');
        }
    });

    it('carries explicit clean-room provenance without claiming native-speaker approval', () => {
        expect(data.provenance.method).toMatch(/clean-room authoring/i);
        expect(data.provenance.method).toMatch(/no legacy mapping list|no .* copied/i);
        expect(data.provenance.referenceUse).toMatch(/not used as entry sources/i);
        expect(data.provenance.reviewStatus).toMatch(/native-speaker sermon review required/i);
        expect(data.provenance.references.length).toBeGreaterThan(0);
        expect(data.provenance.references.every((url) => url.startsWith('https://'))).toBe(true);
    });

    it('preserves the phrase-first then word-level runtime contract', () => {
        expect(normalizeSwissGerman('de Heilig Geischt isch bi üs'))
            .toBe('der Heilige Geist ist bei uns');
    });

    it('normalizes short phrases when they are complete tokens', () => {
        expect(normalizeSwissGerman('I bi da, i de Chile.'))
            .toBe('ich bin da, in der Kirche.');
    });

    it('does not replace short phrases across Standard German word boundaries', () => {
        expect(normalizeSwissGerman('Dabei bist du bei dem Haus.'))
            .toBe('Dabei bist du bei dem Haus.');
    });

    it('treats combining marks as token characters in decomposed Unicode', () => {
        const nfc = 'Chräi bi dir';
        const nfd = nfc.normalize('NFD');

        expect(normalizeSwissGerman(nfc)).toBe(nfc);
        expect(normalizeSwissGerman(nfd)).toBe(nfd);
    });
});
