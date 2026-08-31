import {
    hasRhetoricalRepeatIntent,
    protectRhetoricalRepeat,
} from './b4RhetoricalRepeatPolicy.js';

export const B4_CADENCE_DEFAULTS = Object.freeze({
    historySize: 7,
    maxAgeMs: 16_000,
    minPrefixWords: 6,
    minNewWords: 5,
    sentenceSnapWords: 4,
});

const rawWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);
const normalize = (word) => String(word || '').toLocaleLowerCase('de-DE')
    .replace(/[^\p{L}\p{N}]/gu, '');
const normalizedWords = (text) => rawWords(text).map(normalize).filter(Boolean);

const containsSequence = (container, candidate) => {
    if (!candidate.length || candidate.length > container.length) return false;
    for (let start = 0; start + candidate.length <= container.length; start++) {
        if (candidate.every((word, index) => word === container[start + index])) return true;
    }
    return false;
};

export const dedupAdjacentSentenceRevisions = (text) => {
    const words = rawWords(text);
    if (words.length < 10 || hasRhetoricalRepeatIntent(text)) {
        return { text, changed: false, removedWords: 0, contextText: null };
    }
    const sentences = [];
    let current = [];
    for (const word of words) {
        current.push(word);
        if (/[.!?]["'»”)]*$/.test(word)) {
            sentences.push(current);
            current = [];
        }
    }
    if (current.length) sentences.push(current);
    const kept = [];
    const removed = [];
    for (const sentence of sentences) {
        const previous = kept.at(-1);
        const currentNorm = sentence.map(normalize).filter(Boolean);
        const previousNorm = previous?.map(normalize).filter(Boolean) ?? [];
        if (previousNorm.length >= 5 && currentNorm.length >= 5
            && containsSequence(currentNorm, previousNorm)) {
            removed.push(previous.join(' '));
            kept[kept.length - 1] = sentence;
        } else if (previousNorm.length >= 5 && currentNorm.length >= 5
            && containsSequence(previousNorm, currentNorm)) {
            removed.push(sentence.join(' '));
        } else {
            kept.push(sentence);
        }
    }
    const removedWords = removed.reduce((sum, sentence) => sum + rawWords(sentence).length, 0);
    if (!removedWords) return { text, changed: false, removedWords: 0, contextText: null };
    return {
        text: kept.flat().join(' '),
        changed: true,
        removedWords,
        contextText: removed.join(' '),
    };
};

const longestPrefixInStream = (candidate, stream) => {
    let best = 0;
    for (let start = 0; start < stream.length; start++) {
        let length = 0;
        while (length < candidate.length && start + length < stream.length
            && candidate[length] === stream[start + length]) length++;
        if (length > best) best = length;
    }
    return best;
};

const safeBoundary = (words, coveredPrefix, snapWords) => {
    for (let index = coveredPrefix - 1;
        index >= Math.max(0, coveredPrefix - snapWords);
        index--) {
        if (/[.!?]["'»”)]*$/.test(words[index])) return index + 1;
    }
    return -1;
};

export const createB4CadencePolicy = (options = {}) => {
    const config = { ...B4_CADENCE_DEFAULTS, ...options };
    const history = [];
    const active = (atMs) => history.filter((entry) => (
        !Number.isFinite(atMs) || !Number.isFinite(entry.atMs)
            || atMs - entry.atMs <= config.maxAgeMs
    ));

    return {
        config,
        decide(text, atMs = null) {
            const internal = dedupAdjacentSentenceRevisions(text);
            const candidateText = internal.text;
            const words = rawWords(candidateText);
            const normalized = normalizedWords(candidateText);
            const finalizeEmit = (reason, bestPrefix = 0) => internal.changed
                ? {
                    text: candidateText,
                    action: 'trim',
                    reason: 'adjacent_sentence_revision',
                    bestPrefix,
                    removedWords: internal.removedWords,
                    nonPrefixSafe: true,
                    contextText: internal.contextText,
                }
                : { text, action: 'emit', reason, bestPrefix };
            if (normalized.length < config.minPrefixWords) return finalizeEmit('short');
            const recent = active(atMs);
            const stream = recent.flatMap((entry) => entry.normalized);
            if (!stream.length) return finalizeEmit('empty_history');
            const bestPrefix = longestPrefixInStream(normalized, stream);
            if (bestPrefix === normalized.length) {
                const rhetorical = protectRhetoricalRepeat({
                    text: candidateText,
                    previousText: recent.at(-1)?.text ?? '',
                    proposedAction: 'skip',
                });
                if (rhetorical.rhetoricalRepeat) {
                    return { ...rhetorical, reason: 'explicit_rhetorical_repeat', bestPrefix };
                }
                return { text: '', action: 'skip', reason: 'exact_recent_sequence', bestPrefix };
            }
            if (bestPrefix < config.minPrefixWords) {
                return finalizeEmit('no_ordered_prefix', bestPrefix);
            }
            const boundary = safeBoundary(words, bestPrefix, config.sentenceSnapWords);
            const suffix = boundary >= 0 ? words.slice(boundary) : [];
            if (boundary < config.minPrefixWords || suffix.length < config.minNewWords) {
                return finalizeEmit('no_safe_boundary', bestPrefix);
            }
            return {
                text: suffix.join(' '),
                action: 'trim',
                reason: 'exact_recent_prefix_at_boundary',
                bestPrefix,
                removedWords: boundary,
                contextText: words.slice(0, boundary).join(' '),
            };
        },
        commit(emittedText, atMs = null) {
            const normalized = normalizedWords(emittedText);
            if (!normalized.length) return false;
            history.push({ text: emittedText, normalized, atMs });
            while (history.length > config.historySize) history.shift();
            return true;
        },
        snapshot() {
            return history.map((entry) => ({ ...entry, normalized: [...entry.normalized] }));
        },
    };
};
