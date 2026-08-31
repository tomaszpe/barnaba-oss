const WORD_RE = /\S+/g;

function splitWordsWithOffsets(text) {
    if (typeof text !== 'string') return [];
    return [...text.matchAll(WORD_RE)].map(match => ({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
    }));
}

function createHoldNEmitter({ enabled = false, words = 0 } = {}) {
    const holdWords = Math.max(0, Number.parseInt(words, 10) || 0);
    let pending = '';

    function apply(text, { force = false } = {}) {
        const incoming = [pending, text].filter(Boolean).join(pending && text ? ' ' : '').trim();
        pending = '';

        if (!enabled || holdWords <= 0) {
            return { emitText: incoming, heldText: '', heldWords: 0, applied: false };
        }

        if (!incoming) {
            return { emitText: '', heldText: '', heldWords: 0, applied: true };
        }

        if (force) {
            return { emitText: incoming, heldText: '', heldWords: 0, applied: true };
        }

        const wordsWithOffsets = splitWordsWithOffsets(incoming);
        if (wordsWithOffsets.length <= holdWords) {
            pending = incoming;
            return { emitText: '', heldText: pending, heldWords: wordsWithOffsets.length, applied: true };
        }

        const firstHeld = wordsWithOffsets[wordsWithOffsets.length - holdWords];
        const emitText = incoming.slice(0, firstHeld.start).trim();
        pending = incoming.slice(firstHeld.start).trim();

        return {
            emitText,
            heldText: pending,
            heldWords: holdWords,
            applied: true,
        };
    }

    function flush() {
        const emitText = pending.trim();
        pending = '';
        return emitText;
    }

    function peek() {
        return pending;
    }

    return { apply, flush, peek };
}

export { createHoldNEmitter, splitWordsWithOffsets };
