const DEFAULT_T5_DEDUP_WINDOW = 5;
const DEFAULT_T5_DEDUP_THRESHOLD = 0.45;
const DEFAULT_T5_V2_OVERLAP_THRESHOLD = 0.85;
const DEFAULT_T5_SHORT_TEXT_CHARS = 40;
// Languages written without spaces between words: word-overlap checks do not apply.
const T5_EXACT_ONLY_LANGUAGES = new Set(['zh']);

const DEFAULT_TRANSLATION_STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'and', 'or', 'but', 'in',
    'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'not', 'no',
    'this', 'that', 'it', 'he', 'she', 'we', 'they', 'you', 'i', 'me',
    'my', 'his', 'her', 'our', 'your', 'its', 'so', 'if', 'as', 'very',
    'w', 'na', 'z', 'do', 'to', 'że', 'się', 'jest', 'nie', 'o', 'jak',
    'ale', 'tak', 'co', 'ten', 'za', 'od', 'po', 'już', 'ty', 'ja', 'on',
    'my', 'ich', 'tego', 'tym', 'te', 'ta',
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'est',
    'en', 'que', 'qui', 'ne', 'pas', 'ce', 'il', 'se', 'nous', 'vous',
    'el', 'los', 'las', 'es', 'por', 'con', 'si', 'lo', 'gli', 'di',
    'che', 'non', 'um', 'uma', 'os', 'der', 'die', 'das', 'und', 'ist',
    'ein', 'eine', 'nicht', 'mit',
]);

function tokenizeContentWords(text, stopwords = DEFAULT_TRANSLATION_STOPWORDS) {
    const words = String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1);
    return words.filter(w => !stopwords.has(w));
}

function compareToHistory(currentSet, prevWords) {
    let intersection = 0;
    for (const w of currentSet) {
        if (prevWords.has(w)) intersection++;
    }
    const unionSize = currentSet.size + prevWords.size - intersection;
    const jaccard = unionSize > 0 ? intersection / unionSize : 0;
    const overlapRatio = currentSet.size > 0 ? intersection / currentSet.size : 0;
    const newContentRatio = 1 - overlapRatio;
    return { intersection, unionSize, jaccard, overlapRatio, newContentRatio };
}

function emitDecision(reason = null) {
    return { action: 'emit', reason };
}

function skipDecision(reason, metrics = {}) {
    return { action: 'skip', reason, ...metrics };
}

function evaluatePostTranslationDedup(text, language, history, options = {}) {
    const {
        legacyThreshold = DEFAULT_T5_DEDUP_THRESHOLD,
        v2OverlapThreshold = DEFAULT_T5_V2_OVERLAP_THRESHOLD,
        shortTextChars = DEFAULT_T5_SHORT_TEXT_CHARS,
        stopwords = DEFAULT_TRANSLATION_STOPWORDS,
    } = options;

    if (!text || text.length < 10) {
        return {
            legacy: emitDecision('too_short_for_t5'),
            v2: emitDecision('too_short_for_t5'),
            metrics: { text_len: String(text || '').length, content_word_count: 0 },
        };
    }

    const textNorm = text.trim().toLowerCase();
    for (let i = 0; i < history.length; i++) {
        if (history[i].exact === textNorm) {
            const reason = `T5: exact duplicate (${language})`;
            return {
                legacy: skipDecision(reason, { history_index: i }),
                v2: skipDecision(reason, { history_index: i }),
                metrics: { text_len: text.length, history_index: i, jaccard: 1, overlap_ratio: 1, new_content_ratio: 0 },
            };
        }
    }

    if (T5_EXACT_ONLY_LANGUAGES.has(language)) {
        return {
            legacy: emitDecision('exact_only_language'),
            v2: emitDecision('exact_only_language'),
            metrics: { text_len: text.length, history_index: null, content_word_count: null },
        };
    }

    const contentWords = tokenizeContentWords(text, stopwords);
    if (text.length < shortTextChars) {
        const normalized = contentWords.join(' ');
        for (let i = 0; i < history.length; i++) {
            if (history[i].normalized === normalized) {
                const reason = `T5: exact short repeat (${language})`;
                return {
                    legacy: skipDecision(reason, { history_index: i }),
                    v2: skipDecision(reason, { history_index: i }),
                    metrics: { text_len: text.length, history_index: i, content_word_count: contentWords.length },
                };
            }
        }
        return {
            legacy: emitDecision('short_not_exact_repeat'),
            v2: emitDecision('short_not_exact_repeat'),
            metrics: { text_len: text.length, history_index: null, content_word_count: contentWords.length },
        };
    }

    const currentSet = new Set(contentWords);
    if (currentSet.size < 3) {
        return {
            legacy: emitDecision('too_few_content_words'),
            v2: emitDecision('too_few_content_words'),
            metrics: { text_len: text.length, history_index: null, content_word_count: currentSet.size },
        };
    }

    let best = {
        history_index: null,
        jaccard: 0,
        overlap_ratio: 0,
        new_content_ratio: 1,
    };
    for (let i = 0; i < history.length; i++) {
        const cmp = compareToHistory(currentSet, history[i].words);
        if (cmp.jaccard > best.jaccard) {
            best = {
                history_index: i,
                jaccard: cmp.jaccard,
                overlap_ratio: cmp.overlapRatio,
                new_content_ratio: cmp.newContentRatio,
            };
        }
    }

    const legacy = best.jaccard > legacyThreshold
        ? skipDecision(`T5: paraphrase repeat (${language}, J=${(best.jaccard * 100).toFixed(0)}%)`, { history_index: best.history_index })
        : emitDecision('legacy_no_repeat');
    const v2 = best.overlap_ratio >= v2OverlapThreshold
        ? skipDecision(`T5v2: near-duplicate (${language}, overlap=${(best.overlap_ratio * 100).toFixed(0)}%)`, { history_index: best.history_index })
        : emitDecision('v2_new_content_present');

    return {
        legacy,
        v2,
        metrics: {
            text_len: text.length,
            history_index: best.history_index,
            content_word_count: currentSet.size,
            jaccard: Number(best.jaccard.toFixed(4)),
            overlap_ratio: Number(best.overlap_ratio.toFixed(4)),
            new_content_ratio: Number(best.new_content_ratio.toFixed(4)),
        },
    };
}

function historyEntryFor(text, stopwords = DEFAULT_TRANSLATION_STOPWORDS) {
    const contentWords = tokenizeContentWords(text, stopwords);
    return {
        exact: String(text || '').trim().toLowerCase(),
        normalized: contentWords.join(' '),
        words: new Set(contentWords),
    };
}

export {
    DEFAULT_T5_DEDUP_WINDOW,
    DEFAULT_T5_DEDUP_THRESHOLD,
    DEFAULT_T5_V2_OVERLAP_THRESHOLD,
    DEFAULT_T5_SHORT_TEXT_CHARS,
    DEFAULT_TRANSLATION_STOPWORDS,
    tokenizeContentWords,
    evaluatePostTranslationDedup,
    historyEntryFor,
};