import { describe, it, expect } from 'vitest';
import { resolveQueuedEmissionLanguages } from '../languageRouting.js';

describe('queued emission language routing', () => {
    it('uses live listener subscriptions instead of the enqueue-time language snapshot', () => {
        const queuedLanguages = ['pl'];
        const liveLanguagesAfterPhoneSwitch = ['en'];

        expect(resolveQueuedEmissionLanguages(liveLanguagesAfterPhoneSwitch, queuedLanguages)).toEqual(['en']);
    });

    it('returns no languages when all listeners leave before dequeue', () => {
        expect(resolveQueuedEmissionLanguages([])).toEqual([]);
    });

    it('deduplicates active languages while preserving order', () => {
        expect(resolveQueuedEmissionLanguages(['pl', 'en', 'pl', 'it'])).toEqual(['pl', 'en', 'it']);
    });
});
