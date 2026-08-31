import { describe, it, expect } from 'vitest';
import { createHoldNEmitter } from '../holdNPolicy.js';

describe('createHoldNEmitter', () => {
    it('holds the last N words and emits them with the next segment', () => {
        const emitter = createHoldNEmitter({ enabled: true, words: 3 });

        const first = emitter.apply('Das ist ein langer erster Satz mit Kontext.');
        expect(first.emitText).toBe('Das ist ein langer erster');
        expect(first.heldText).toBe('Satz mit Kontext.');

        const second = emitter.apply('Und jetzt geht es weiter.');
        expect(second.emitText).toBe('Satz mit Kontext. Und jetzt');
        expect(second.heldText).toBe('geht es weiter.');
    });

    it('holds everything until enough words are available', () => {
        const emitter = createHoldNEmitter({ enabled: true, words: 5 });

        const first = emitter.apply('Zu kurz.');
        expect(first.emitText).toBe('');
        expect(first.heldText).toBe('Zu kurz.');

        const second = emitter.apply('Jetzt reicht der Kontext.');
        expect(second.emitText).toBe('Zu');
        expect(second.heldWords).toBe(5);
    });

    it('is transparent when disabled', () => {
        const emitter = createHoldNEmitter({ enabled: false, words: 5 });
        expect(emitter.apply('Alles direkt.')).toMatchObject({
            emitText: 'Alles direkt.',
            heldText: '',
            applied: false,
        });
    });
});
