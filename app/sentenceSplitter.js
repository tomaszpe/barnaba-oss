/**
 * TTS Sentence Splitter (Option H, Phase 3a.2)
 *
 * Thin wrapper on top of sentenceService.detectSentenceBoundaries — applies
 * TTS-specific heuristics: short-text passthrough + small-fragment merging.
 *
 * Purpose: split a full translation string into sentences for parallel TTS
 * synthesis. Returns plain strings (not sentence metadata objects).
 *
 * Design:
 * - Does NOT modify sentenceService. Import only.
 * - Short texts (< singleThreshold chars) returned as single-element array
 *   (parallelizing TTS for short texts adds overhead without latency win).
 * - Merges ultra-short fragments (< minPieceLength) with the previous piece
 *   to avoid spawning Azure calls for "A." style tail fragments.
 */

import { detectSentenceBoundaries } from './sentenceService.js';

const DEFAULT_OPTIONS = {
    // Below this total text length, return single piece (no split).
    // Rationale: TTS overhead dominates for short texts; parallelization
    // provides no gain when one sentence already fits in ~400ms envelope.
    singleThreshold: 60,

    // Pieces shorter than this are merged with the previous piece to
    // avoid wasteful Azure calls for orphan fragments.
    minPieceLength: 25,
};

/**
 * Split text into sentences suitable for parallel TTS synthesis.
 *
 * @param {string} text - Full translation text
 * @param {object} [options]
 * @param {number} [options.singleThreshold=60] - Below this length, no split
 * @param {number} [options.minPieceLength=25] - Below this, merge with previous
 * @returns {string[]} Array of sentence strings (empty array if input empty)
 */
export function splitForTTS(text, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (typeof text !== 'string') {
        return [];
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return [];
    }

    // Short text: no split — TTS overhead would dominate.
    if (trimmed.length <= opts.singleThreshold) {
        return [trimmed];
    }

    // Use existing Barnaba sentence detection.
    const chunks = detectSentenceBoundaries(trimmed);

    // detectSentenceBoundaries may return [] if it filters everything
    // (e.g., fragments below minWordCount). Fallback to single-element.
    if (chunks.length === 0) {
        return [trimmed];
    }

    // Extract text + apply TTS-specific merging.
    const pieces = [];
    for (const chunk of chunks) {
        const piece = chunk.text;
        if (!piece || piece.trim().length === 0) continue;

        // If this piece is tiny and we have a previous piece, merge.
        if (piece.length < opts.minPieceLength && pieces.length > 0) {
            pieces[pieces.length - 1] = pieces[pieces.length - 1] + ' ' + piece;
        } else {
            pieces.push(piece);
        }
    }

    // Edge case: pipeline filtered down to a single piece — return it as-is.
    // Edge case: empty after processing — return whole trimmed string.
    if (pieces.length === 0) {
        return [trimmed];
    }

    return pieces;
}

export default { splitForTTS };
