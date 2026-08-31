import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    checkLiturgicalCache,
    clearCache,
    getCacheStats,
    initLiturgicalCache,
} from '../cacheService.js';

const data = JSON.parse(readFileSync(
    new URL('../cache/liturgicalPhrases.json', import.meta.url),
    'utf8',
));

beforeEach(() => {
    clearCache();
});

describe('public-domain liturgical phrase corpus', () => {
    it('declares a complete, internally consistent provenance contract', () => {
        expect(data.publicDomainOnly).toBe(true);
        expect(data.phraseCount).toBe(data.phrases.length);
        expect(new Set(data.phrases.map(({ id }) => id)).size).toBe(data.phrases.length);
        expect(Object.keys(data.sources).sort()).toEqual([...data.languages].sort());

        for (const language of data.languages) {
            expect(data.sources[language]).toMatchObject({ status: 'Public Domain' });
            expect(data.sources[language].edition.trim()).not.toBe('');
            expect(data.sources[language].url).toMatch(/^https:\/\//);
        }
        for (const phrase of data.phrases) {
            expect(phrase.id.trim()).not.toBe('');
            expect(phrase.category.trim()).not.toBe('');
            expect(phrase.sourceReference.trim()).not.toBe('');
            expect(phrase.de.trim()).not.toBe('');
            expect(Object.hasOwn(phrase, 'tr')).toBe(false);
        }
    });

    it('keeps every verified language complete except the documented Swahili gaps', () => {
        const expectedSwahiliGaps = new Set([
            'aaronic_blessing_1',
            'aaronic_blessing_2',
            'aaronic_blessing_3',
            'lord_have_mercy_matt_17_15',
        ]);

        for (const language of data.languages.filter((language) => language !== 'sw')) {
            expect(data.phrases.filter((phrase) => !phrase[language])).toEqual([]);
        }
        expect(new Set(
            data.phrases.filter((phrase) => !phrase.sw).map(({ id }) => id),
        )).toEqual(expectedSwahiliGaps);
    });

    it('falls through for Turkish and for Swahili phrases outside the New Testament', async () => {
        await initLiturgicalCache();
        const aaronic = data.phrases.find(({ id }) => id === 'aaronic_blessing_1');

        expect(checkLiturgicalCache('Amen', 'en')).toMatchObject({ text: 'Amen' });
        expect(checkLiturgicalCache('Amen', 'tr')).toBeNull();
        expect(checkLiturgicalCache(aaronic.de, 'sw')).toBeNull();
        expect(getCacheStats().totalPhrases).toBe(18);
    });
});
