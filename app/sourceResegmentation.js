import { sliceSourceLineage, sourceWords } from './sourceLineage.js';

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/**
 * Build a new source unit from an audio-proven word boundary.
 * The translated output is never trimmed: callers translate `text` from scratch.
 */
export function resegmentSourceAtWord(text, sourceLineage, committedPrefixWords) {
    const source = String(text || '');
    const prefix = Number(committedPrefixWords);
    const matches = [...source.matchAll(WORD_RE)];
    if (!Number.isSafeInteger(prefix) || prefix < 0) {
        return { action: 'unchanged', reason: 'invalid_prefix', text: source, sourceLineage };
    }
    if (sourceLineage?.status !== 'complete'
        || sourceLineage.wordSpans?.length !== sourceLineage.wordCount
        || sourceLineage.wordCount !== sourceWords(source).length
        || matches.length !== sourceLineage.wordCount) {
        return { action: 'unchanged', reason: 'lineage_not_complete', text: source, sourceLineage };
    }
    if (prefix === 0) {
        return { action: 'unchanged', reason: 'no_committed_prefix', text: source, sourceLineage };
    }
    if (prefix >= matches.length) {
        return {
            action: 'suppress',
            reason: 'source_fully_committed',
            text: '',
            sourceLineage: null,
            startWord: matches.length,
            remainingWords: 0,
        };
    }

    const startOffset = matches[prefix].index;
    const residual = source.slice(startOffset).trim();
    const residualLineage = sliceSourceLineage(
        sourceLineage,
        prefix,
        matches.length - prefix,
    );
    if (!residual || residualLineage.status !== 'complete') {
        return { action: 'unchanged', reason: 'residual_not_provable', text: source, sourceLineage };
    }
    return {
        action: 'resegment',
        reason: 'committed_audio_prefix',
        text: residual,
        sourceLineage: residualLineage,
        startWord: prefix,
        remainingWords: matches.length - prefix,
    };
}
