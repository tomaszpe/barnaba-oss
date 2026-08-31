import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    clearContextBuffer,
    updateContextBuffer,
    formatSourceTargetContext,
} from '../translationService.js';

const CHURCH = 'sourceTargetChurch';

describe('source/target context pairs', () => {
    beforeEach(() => {
        clearContextBuffer(CHURCH);
    });

    afterEach(() => {
        clearContextBuffer(CHURCH);
    });

    it('formats the latest source and translated pairs for one target language', () => {
        updateContextBuffer(CHURCH, 'pl', 'Quelle eins.', 'Zrodlo pierwsze.');
        updateContextBuffer(CHURCH, 'pl', 'Quelle zwei.', 'Zrodlo drugie.');
        updateContextBuffer(CHURCH, 'en', 'Quelle en.', 'English only.');

        const context = formatSourceTargetContext(CHURCH, 'pl', 2);

        expect(context).toContain('DE: Quelle eins.');
        expect(context).toContain('Polish: Zrodlo pierwsze.');
        expect(context).toContain('DE: Quelle zwei.');
        expect(context).not.toContain('English only.');
    });

    it('returns null when disabled', () => {
        updateContextBuffer(CHURCH, 'pl', 'Quelle.', 'Zrodlo.');
        expect(formatSourceTargetContext(CHURCH, 'pl', 0)).toBeNull();
    });
});
