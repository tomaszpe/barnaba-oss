/**
 * Look-ahead terminal boundary confirmation for streaming ASR partials.
 *
 * Problem (measured on the reference deployment, 06.2026): Whisper ends ~98% of partials
 * with terminal punctuation, so `/[.!?]$/` is a near-constant `true` signal that cannot
 * discriminate a real sentence end from a spurious mid-utterance period. complete_micro_phrase
 * fired on truncated fragments; 55-61% were continued by the next ASR update.
 *
 * Discriminator (validated offline): a terminal boundary is trustworthy only if
 *   (a) a VAD pause corroborates it (fast-path, no wait), OR
 *   (b) the candidate text survives as a PREFIX of the next ASR update.
 * Prefix (not substring) catches BOTH failure modes at once:
 *   - continuation: "...triggert." -> "...triggert, und..."  (period replaced, prefix breaks)
 *   - head revision: "Irgendeine..." -> "Nicht irgendeine..." (head changed, prefix breaks)
 * A cheap function-word guard rejects boundaries ending on an open conjunction/preposition/
 * article even when punctuation is present (catches ~11%; look-ahead catches the rest).
 *
 * Pure module: no I/O, no clock, no mutable state. Caller holds the pending partial.
 */

// Terminal punctuation, tolerating trailing quotes/brackets and ellipsis (".", "...", "?»").
const TERMINAL = /[.!?]+["'»”’)\]]*$/;

// Ending on one of these is not a real boundary even with a period (open construction).
const OPEN_ENDING_WORDS = new Set([
    // conjunctions / subordinators
    'und', 'oder', 'aber', 'denn', 'weil', 'dass', 'als', 'wenn', 'sondern', 'doch',
    'sowie', 'obwohl', 'damit', 'falls', 'bevor', 'nachdem', 'waehrend', 'während', 'sobald', 'wie',
    // prepositions
    'in', 'an', 'auf', 'fuer', 'für', 'mit', 'von', 'zu', 'bei', 'nach', 'ueber', 'über',
    'unter', 'vor', 'durch', 'um', 'aus', 'gegen', 'ohne', 'seit', 'trotz', 'zwischen',
    // articles / determiners
    'der', 'die', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    'dem', 'den', 'des', 'dieser', 'diese', 'dieses',
    // relative / interrogative pronouns (co=was, etc.) - virtually never end a declarative sentence.
    // NOTE: reflexive/object/subject pronouns (sich/uns/er...) are NOT added: they DO end valid
    // sentences ("er freut sich."), so they need the look-ahead gate, not a word list.
    'was', 'welche', 'welcher', 'welches', 'welchem', 'welchen', 'deren', 'dessen', 'denen',
]);

function normalize(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function endsWithTerminal(text) {
    return TERMINAL.test(String(text || '').trim());
}

function lastWord(text) {
    const words = normalize(text)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
    return words.length ? words[words.length - 1] : '';
}

function endsOnOpenWord(text, openWords = OPEN_ENDING_WORDS) {
    return openWords.has(lastWord(text));
}

/**
 * Did the candidate survive verbatim as a PREFIX of the next ASR update?
 * True => the period stayed and nothing before it changed => real boundary.
 */
function survivesNextUpdate(candidate, nextText) {
    const c = normalize(candidate);
    const n = normalize(nextText);
    if (!c || !n) return false;
    return n.startsWith(c);
}

/**
 * Confirm whether a terminal boundary in `candidate` should be trusted.
 * @param {object} args
 * @param {string} args.candidate  partial that ended in terminal punctuation (the pending boundary)
 * @param {string|null} args.nextText  the subsequent ASR partial/confirmed (null = not seen yet)
 * @param {boolean} args.vadPause  true if VAD reports a speech pause at/after the boundary
 * @param {Set<string>} [args.openWords]
 * @returns {{confirmed: boolean, reason: string}}
 */
function confirmTerminalBoundary({ candidate, nextText = null, vadPause = false, openWords } = {}) {
    if (!endsWithTerminal(candidate)) {
        return { confirmed: false, reason: 'no_terminal' };
    }
    if (endsOnOpenWord(candidate, openWords)) {
        return { confirmed: false, reason: 'open_function_word' };
    }
    if (vadPause === true) {
        return { confirmed: true, reason: 'vad_pause' };
    }
    if (nextText == null) {
        return { confirmed: false, reason: 'pending_first_seen' };
    }
    if (survivesNextUpdate(candidate, nextText)) {
        return { confirmed: true, reason: 'survived_next_update' };
    }
    return { confirmed: false, reason: 'continued_or_revised' };
}

/**
 * Split text at the last SAFE boundary so we never emit a fragment ending on an open
 * function word (the "it cuts after a conjunction" complaint). Iteration 2.
 *   head = longest prefix ending at terminal/clause punctuation whose last word is content;
 *   tail = remainder to keep for the next emission (continuity: next starts where we cut).
 * If there is no safe boundary, head = '' and the caller should HOLD (emit nothing yet).
 */
function splitAtSafeBoundary(text, openWords = OPEN_ENDING_WORDS) {
    const t = String(text || '').trim();
    if (!t) return { head: '', tail: '' };
    const tokens = t.split(/\s+/);
    const bare = (tok) => tok.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const endsClausePunct = (tok) => /[.!?,;:]["'»”’)\]]*$/.test(tok);
    let lastSafe = -1;
    for (let i = 0; i < tokens.length; i++) {
        const b = bare(tokens[i]);
        if (endsClausePunct(tokens[i]) && b && !openWords.has(b)) lastSafe = i;
    }
    if (lastSafe < 0) return { head: '', tail: t };
    return {
        head: tokens.slice(0, lastSafe + 1).join(' '),
        tail: tokens.slice(lastSafe + 1).join(' '),
    };
}

export {
    TERMINAL,
    OPEN_ENDING_WORDS,
    normalize,
    endsWithTerminal,
    lastWord,
    endsOnOpenWord,
    survivesNextUpdate,
    confirmTerminalBoundary,
    splitAtSafeBoundary,
};
