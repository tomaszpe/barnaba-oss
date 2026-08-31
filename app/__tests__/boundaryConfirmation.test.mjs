import { describe, expect, it } from 'vitest';
import {
    confirmTerminalBoundary,
    endsOnOpenWord,
    endsWithTerminal,
    splitAtSafeBoundary,
    survivesNextUpdate,
} from '../boundaryConfirmation.js';

describe('boundaryConfirmation - primitives', () => {
    it('detects terminal punctuation incl. ellipsis and trailing quotes', () => {
        expect(endsWithTerminal('Gott ist treu.')).toBe(true);
        expect(endsWithTerminal('Wirklich?')).toBe(true);
        expect(endsWithTerminal('und auf...')).toBe(true);
        expect(endsWithTerminal('er sagte: «Amen.»')).toBe(true);
        expect(endsWithTerminal('wir gehen weiter und')).toBe(false);
    });

    it('flags open-ending function words (conjunction/preposition/article)', () => {
        expect(endsOnOpenWord('und das ist weil.')).toBe(true);     // conjunction
        expect(endsOnOpenWord('wir warten auf...')).toBe(true);      // preposition
        expect(endsOnOpenWord('das war der.')).toBe(true);           // article
        expect(endsOnOpenWord('der Knopf wird gedrückt.')).toBe(false); // content word
    });

    it('survives only as a verbatim prefix of the next update', () => {
        expect(survivesNextUpdate('Gott ist treu.', 'Gott ist treu. Und dann ging er.')).toBe(true);
        expect(survivesNextUpdate('uns triggert.', 'uns triggert, und es kann sein.')).toBe(false);
    });
});

describe('boundaryConfirmation - real false-positives (Prove-It, 17.06.2026)', () => {
    // Content-word continuation: period after "triggert" became a comma in the next update.
    it('rejects continuation where the period turns into a comma', () => {
        const candidate = 'Die Situation ist nicht im Verhältnis zu irgendetwas, das uns triggert.';
        const nextText = 'Die Situation ist nicht im Verhältnis zu irgendetwas, das uns triggert, und es kann nur etwas Kleines sein.';
        expect(confirmTerminalBoundary({ candidate, nextText })).toEqual({
            confirmed: false,
            reason: 'continued_or_revised',
        });
    });

    // Head revision: "Irgendeine" -> "Nicht irgendeine" (opposite meaning). Prefix breaks.
    it('rejects head-revised emission even if the tail still matches', () => {
        const candidate = 'Irgendeine kleine Situation und wir explodieren, der rote Knopf wird gedrückt.';
        const nextText = 'Nicht irgendeine kleine Situation und wir explodieren, der rote Knopf wird gedrückt. Und meine Frage ist die.';
        expect(confirmTerminalBoundary({ candidate, nextText })).toEqual({
            confirmed: false,
            reason: 'continued_or_revised',
        });
    });

    // Preposition ellipsis: "...wieder auf..." caught cheaply by the open-word guard.
    it('rejects boundary ending on a preposition via the open-word guard', () => {
        const candidate = 'Die Bibel ist ein Buch, das dies auf verschiedene Wörter wieder auf...';
        const nextText = 'Die Bibel ist ein Buch, das das auf verschiedene Wörter wieder auf eingeht.';
        expect(confirmTerminalBoundary({ candidate, nextText })).toEqual({
            confirmed: false,
            reason: 'open_function_word',
        });
    });
});

describe('boundaryConfirmation - true boundaries and fast-path', () => {
    it('confirms a real boundary that survives into the next update', () => {
        const candidate = 'Gott ist treu und seine Gnade bleibt.';
        const nextText = 'Gott ist treu und seine Gnade bleibt. Und dann ging er weiter.';
        expect(confirmTerminalBoundary({ candidate, nextText })).toEqual({
            confirmed: true,
            reason: 'survived_next_update',
        });
    });

    it('confirms immediately on a VAD pause without waiting for the next update', () => {
        expect(confirmTerminalBoundary({ candidate: 'Wir beten gemeinsam.', vadPause: true })).toEqual({
            confirmed: true,
            reason: 'vad_pause',
        });
    });

    it('holds on first sight when there is no next update and no pause', () => {
        expect(confirmTerminalBoundary({ candidate: 'Wir beten gemeinsam.', nextText: null })).toEqual({
            confirmed: false,
            reason: 'pending_first_seen',
        });
    });

    it('does not treat a non-terminal partial as a boundary', () => {
        expect(confirmTerminalBoundary({ candidate: 'wir gehen weiter und', nextText: 'wir gehen weiter und beten' })).toEqual({
            confirmed: false,
            reason: 'no_terminal',
        });
    });

    it('open-word guard wins even with a VAD pause (never emit on open construction)', () => {
        expect(confirmTerminalBoundary({ candidate: 'das ist weil.', vadPause: true })).toEqual({
            confirmed: false,
            reason: 'open_function_word',
        });
    });
});

describe('splitAtSafeBoundary - iteration 2 boundary-aware trim', () => {
    it('keeps a complete sentence whole (content word + period)', () => {
        expect(splitAtSafeBoundary('Der rote Knopf wird gedrückt.')).toEqual({
            head: 'Der rote Knopf wird gedrückt.', tail: '',
        });
    });
    it('cuts at the clause comma and keeps the open continuation as tail', () => {
        expect(splitAtSafeBoundary('das uns triggert, und es kann sein')).toEqual({
            head: 'das uns triggert,', tail: 'und es kann sein',
        });
    });
    it('emits the complete sentence and holds the incomplete tail', () => {
        expect(splitAtSafeBoundary('Gott ist treu. Wir gehen weiter und')).toEqual({
            head: 'Gott ist treu.', tail: 'Wir gehen weiter und',
        });
    });
    it('holds (head empty) when the only boundary ends on an open function word', () => {
        expect(splitAtSafeBoundary('und das ist weil.')).toEqual({ head: '', tail: 'und das ist weil.' });
    });
    it('holds when there is no boundary punctuation at all', () => {
        expect(splitAtSafeBoundary('wir gehen weiter und beten')).toEqual({ head: '', tail: 'wir gehen weiter und beten' });
    });
    it('trims a trailing relative pronoun (co=was) to the clause boundary', () => {
        expect(splitAtSafeBoundary('Das ist das Buch, was')).toEqual({ head: 'Das ist das Buch,', tail: 'was' });
    });
    it('flags a fragment ending on the relative pronoun "was"', () => {
        expect(endsOnOpenWord('und das ist was.')).toBe(true);
    });
});
