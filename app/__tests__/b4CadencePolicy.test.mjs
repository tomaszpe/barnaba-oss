import { describe, expect, it } from 'vitest';

import {
    B4_CADENCE_DEFAULTS,
    createB4CadencePolicy,
    dedupAdjacentSentenceRevisions,
} from '../b4CadencePolicy.js';

describe('B4 cadence v2 policy', () => {
    it('uses the selected 16-second, seven-emission window', () => {
        expect(B4_CADENCE_DEFAULTS).toMatchObject({ historySize: 7, maxAgeMs: 16_000 });
    });

    it('finds a duplicate spanning adjacent accepted emissions', () => {
        const policy = createB4CadencePolicy();
        policy.commit('Das Buch Hiob zeigt uns einen Menschen,', 1_000);
        policy.commit('der gelernt hat, mit offenen Fragen zu leben.', 2_000);
        expect(policy.decide(
            'Das Buch Hiob zeigt uns einen Menschen, der gelernt hat, mit offenen Fragen zu leben.',
            3_000,
        )).toMatchObject({ action: 'skip', reason: 'exact_recent_sequence' });
    });

    it('trims only at a proven sentence boundary and commits only emitted text', () => {
        const policy = createB4CadencePolicy();
        const previous = 'Wir sprechen heute über Hiob und seine offenen Fragen.';
        policy.commit(previous, 1_000);
        const decision = policy.decide(
            `${previous} Danach beginnt ein neuer Gedanke über Hoffnung und Vertrauen.`,
            2_000,
        );
        expect(decision).toMatchObject({
            action: 'trim',
            text: 'Danach beginnt ein neuer Gedanke über Hoffnung und Vertrauen.',
        });
        policy.commit(decision.text, 2_000);
        expect(policy.snapshot().at(-1).text).toBe(decision.text);
    });

    it.each([
        ['Wie können wir mehr Geld in unserem Leben haben?', 'Wie können wir mehr Gelassenheit in unserem Leben haben?'],
        ['Wir sollen diesen Weg jetzt gehen und vertrauen.', 'Wir sollen diesen Weg jetzt nicht gehen und vertrauen.'],
        ['Hiob wartete vier Tage auf eine Antwort.', 'Hiob wartete vierzig Tage auf eine Antwort.'],
    ])('preserves a meaning-changing correction: %s', (previous, correction) => {
        const policy = createB4CadencePolicy({ minPrefixWords: 5 });
        policy.commit(previous, 1_000);
        expect(policy.decide(correction, 2_000)).toMatchObject({ action: 'emit' });
    });

    it('preserves an explicitly announced rhetorical repeat', () => {
        const policy = createB4CadencePolicy();
        const repeat = 'Ich sage es nochmals, das Buch Hiob zeigt uns einen Menschen, der mit offenen Fragen lebt.';
        policy.commit('Ich sage es nochmals, das Buch Hiob zeigt uns einen Menschen,', 1_000);
        policy.commit('der mit offenen Fragen lebt.', 1_500);
        expect(policy.decide(repeat, 2_000)).toMatchObject({
            action: 'emit',
            reason: 'explicit_rhetorical_repeat',
        });
    });

    it('collapses only an adjacent contained sentence revision', () => {
        const input = 'Absolut vollkommener gerechter reicher Mann. Er ist ein absolut vollkommener gerechter reicher Mann. Danach beginnt ein neuer Gedanke.';
        expect(dedupAdjacentSentenceRevisions(input)).toMatchObject({
            changed: true,
            text: 'Er ist ein absolut vollkommener gerechter reicher Mann. Danach beginnt ein neuer Gedanke.',
        });
    });
});
