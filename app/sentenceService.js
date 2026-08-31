/**
 * Sentence Boundary Detection Service
 * Phase 6: Intelligent sentence splitting for natural translation chunks
 *
 * Detects sentence boundaries using:
 * - Punctuation-based splitting (. ! ?)
 * - German thought-starting conjunctions
 * - Pause duration analysis (when timestamps available)
 * - Maximum chunk length constraints
 */

import {
    composeSourceLineages,
    missingSourceLineage,
    sliceSourceLineage,
    sourceWords,
} from './sourceLineage.js';

// Configuration
const CONFIG = {
    maxChunkLength: 150,        // Maximum characters per chunk
    minChunkLength: 15,         // Minimum characters before forcing split (was 20)
    minWordCount: 4,            // ADDED (21.01.2026): Minimum words per sentence to reject fragments like "und"
    pauseThreshold: 800,        // Pause duration (ms) that indicates boundary
    shortPauseThreshold: 400    // Short pause for potential boundary
};

// German sentence-ending punctuation
const SENTENCE_ENDERS = /([.!?])\s*/g;

// German thought-starting conjunctions (indicate new thought/sentence)
const THOUGHT_STARTERS = [
    'Aber', 'Denn', 'Deshalb', 'Darum', 'Also', 'Nun', 'Jetzt',
    'Jedoch', 'Trotzdem', 'Dennoch', 'Sondern', 'Doch', 'Weil',
    'Obwohl', 'Wenn', 'Falls', 'Sobald', 'Nachdem', 'Bevor',
    'Damit', 'Sodass', 'Indem', 'Während', 'Seit', 'Bis',
    'Erstens', 'Zweitens', 'Drittens', 'Schließlich', 'Zuletzt',
    'Außerdem', 'Zusätzlich', 'Übrigens', 'Jedenfalls', 'Immerhin'
];

// Build regex for thought starters (case-insensitive, word boundary)
const THOUGHT_STARTER_REGEX = new RegExp(
    `\\b(${THOUGHT_STARTERS.join('|')})\\b`,
    'gi'
);

// Clause separators (commas with specific patterns)
const CLAUSE_SEPARATORS = /,\s*(und|oder|aber|denn|sondern)\s+/gi;

/**
 * Detect sentence boundaries in German text
 * @param {string} text - Input text to analyze
 * @param {Array|null} timestamps - Optional array of {word, start, end} for pause analysis
 * @returns {Array} Array of sentence chunks with metadata
 */
export function detectSentenceBoundaries(text, timestamps = null) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
        return [];
    }

    // Step 1: Split by sentence-ending punctuation
    let chunks = splitByPunctuation(trimmedText);

    // Step 2: Further split long chunks by thought starters
    chunks = splitByThoughtStarters(chunks);

    // Step 3: If timestamps available, use pause analysis
    if (timestamps && timestamps.length > 0) {
        chunks = refineBoundariesWithPauses(chunks, timestamps);
    }

    // Step 4: Enforce maximum chunk length
    chunks = enforceMaxLength(chunks);

    // Step 5: Clean up and add metadata
    // ADDED (21.01.2026): Filter by minWordCount to reject fragments like "und", "»»"
    return chunks.map((chunk, index) => {
        const trimmed = chunk.trim();
        const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
        return {
            text: trimmed,
            index,
            length: trimmed.length,
            wordCount,
            isComplete: endsWithPunctuation(chunk)
        };
    }).filter(chunk => chunk.text.length > 0);
}

/**
 * Split text by sentence-ending punctuation
 * @param {string} text - Input text
 * @returns {Array} Array of text chunks
 */
function splitByPunctuation(text) {
    const chunks = [];
    let lastIndex = 0;
    let match;

    // Reset regex
    SENTENCE_ENDERS.lastIndex = 0;

    while ((match = SENTENCE_ENDERS.exec(text)) !== null) {
        const endIndex = match.index + match[0].length;
        const chunk = text.slice(lastIndex, endIndex).trim();
        if (chunk.length > 0) {
            chunks.push(chunk);
        }
        lastIndex = endIndex;
    }

    // Add remaining text
    const remaining = text.slice(lastIndex).trim();
    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks.length > 0 ? chunks : [text];
}

/**
 * Split chunks that are too long by thought-starting conjunctions
 * @param {Array} chunks - Array of text chunks
 * @returns {Array} Refined array of chunks
 */
function splitByThoughtStarters(chunks) {
    const result = [];

    for (const chunk of chunks) {
        if (chunk.length <= CONFIG.maxChunkLength) {
            result.push(chunk);
            continue;
        }

        // Try to split by thought starters
        const subChunks = splitChunkByConjunctions(chunk);
        result.push(...subChunks);
    }

    return result;
}

/**
 * Split a single chunk by conjunctions
 * @param {string} chunk - Text chunk to split
 * @returns {Array} Array of smaller chunks
 */
function splitChunkByConjunctions(chunk) {
    const parts = [];
    let remaining = chunk;

    // Reset regex
    THOUGHT_STARTER_REGEX.lastIndex = 0;

    // Find all thought starters in the chunk
    const matches = [];
    let match;
    while ((match = THOUGHT_STARTER_REGEX.exec(chunk)) !== null) {
        // Only split if not at the very beginning
        if (match.index > CONFIG.minChunkLength) {
            matches.push(match.index);
        }
    }

    if (matches.length === 0) {
        return [chunk];
    }

    // Split at each thought starter position
    let lastIndex = 0;
    for (const splitIndex of matches) {
        const part = chunk.slice(lastIndex, splitIndex).trim();
        if (part.length > 0) {
            parts.push(part);
        }
        lastIndex = splitIndex;
    }

    // Add remaining
    const lastPart = chunk.slice(lastIndex).trim();
    if (lastPart.length > 0) {
        parts.push(lastPart);
    }

    return parts.length > 0 ? parts : [chunk];
}

/**
 * Refine boundaries using pause duration analysis
 * @param {Array} chunks - Current chunks
 * @param {Array} timestamps - Word timestamps [{word, start, end}, ...]
 * @returns {Array} Refined chunks
 */
function refineBoundariesWithPauses(chunks, timestamps) {
    if (!timestamps || timestamps.length < 2) {
        return chunks;
    }

    // Detect significant pauses between words
    const pausePoints = [];
    for (let i = 1; i < timestamps.length; i++) {
        const pause = timestamps[i].start - timestamps[i - 1].end;
        if (pause >= CONFIG.pauseThreshold) {
            pausePoints.push({
                afterWord: timestamps[i - 1].word,
                beforeWord: timestamps[i].word,
                duration: pause,
                position: i
            });
        }
    }

    // If no significant pauses, return original chunks
    if (pausePoints.length === 0) {
        return chunks;
    }

    // Reconstruct text with pause markers
    const fullText = chunks.join(' ');
    const result = [];
    let currentChunk = '';

    for (const ts of timestamps) {
        currentChunk += (currentChunk ? ' ' : '') + ts.word;

        // Check if this is a pause point
        const isPausePoint = pausePoints.some(p => p.afterWord === ts.word);

        if (isPausePoint && currentChunk.length >= CONFIG.minChunkLength) {
            result.push(currentChunk.trim());
            currentChunk = '';
        }
    }

    // Add remaining
    if (currentChunk.trim().length > 0) {
        result.push(currentChunk.trim());
    }

    return result.length > 0 ? result : chunks;
}

/**
 * Enforce maximum chunk length by splitting long chunks
 * @param {Array} chunks - Array of chunks
 * @returns {Array} Array with enforced max length
 */
function enforceMaxLength(chunks) {
    const result = [];

    for (const chunk of chunks) {
        if (chunk.length <= CONFIG.maxChunkLength) {
            result.push(chunk);
            continue;
        }

        // Split by clause separators first
        const clauseSplit = splitByClauseSeparators(chunk);

        for (const subChunk of clauseSplit) {
            if (subChunk.length <= CONFIG.maxChunkLength) {
                result.push(subChunk);
            } else {
                // Last resort: split by word count
                result.push(...splitByWordCount(subChunk));
            }
        }
    }

    return result;
}

/**
 * Split chunk by clause separators (comma + conjunction)
 * @param {string} chunk - Text chunk
 * @returns {Array} Split chunks
 */
function splitByClauseSeparators(chunk) {
    CLAUSE_SEPARATORS.lastIndex = 0;
    const parts = chunk.split(CLAUSE_SEPARATORS).filter(p => p && p.trim().length > 0);
    return parts.length > 1 ? parts : [chunk];
}

/**
 * Split chunk by word count as last resort
 * @param {string} chunk - Text chunk
 * @returns {Array} Split chunks
 */
function splitByWordCount(chunk) {
    const words = chunk.split(/\s+/);
    const result = [];
    let current = [];
    let currentLength = 0;

    for (const word of words) {
        const wordLength = word.length + (current.length > 0 ? 1 : 0);

        if (currentLength + wordLength > CONFIG.maxChunkLength && current.length > 0) {
            result.push(current.join(' '));
            current = [word];
            currentLength = word.length;
        } else {
            current.push(word);
            currentLength += wordLength;
        }
    }

    if (current.length > 0) {
        result.push(current.join(' '));
    }

    return result;
}

/**
 * Check if text ends with sentence-ending punctuation
 * @param {string} text - Text to check
 * @returns {boolean} True if ends with punctuation
 */
function endsWithPunctuation(text) {
    return /[.!?]$/.test(text.trim());
}

/**
 * Detect if text appears to be a complete sentence
 * @param {string} text - Text to analyze
 * @returns {object} Analysis result
 */
export function analyzeSentenceCompleteness(text) {
    const trimmed = text.trim();

    return {
        text: trimmed,
        length: trimmed.length,
        endsWithPunctuation: endsWithPunctuation(trimmed),
        startsWithCapital: /^[A-ZÄÖÜ]/.test(trimmed),
        hasVerb: /\b(ist|sind|hat|haben|war|waren|wird|werden|kann|können|soll|sollen|muss|müssen|möchte|möchten|geht|kommt|macht|gibt|sagt|heißt)\b/i.test(trimmed),
        wordCount: trimmed.split(/\s+/).length,
        isLikelyComplete: endsWithPunctuation(trimmed) && trimmed.split(/\s+/).length >= 3
    };
}

/**
 * Buffer for accumulating partial text until sentence boundary
 */
export class SentenceBuffer {
    constructor() {
        this.buffer = '';
        this.pendingChunks = [];
    }

    /**
     * Add text to buffer and extract complete sentences
     * @param {string} text - New text to add
     * @param {boolean} isFinal - Whether this is final (force flush)
     * @returns {Array} Array of complete sentence chunks
     */
    add(text, isFinal = false) {
        this.buffer += (this.buffer ? ' ' : '') + text;

        if (isFinal) {
            // Force flush everything
            const chunks = detectSentenceBoundaries(this.buffer);
            this.buffer = '';
            return chunks;
        }

        // Check for complete sentences
        const sentences = detectSentenceBoundaries(this.buffer);

        if (sentences.length === 0) {
            return [];
        }

        // Keep last incomplete sentence in buffer
        const lastSentence = sentences[sentences.length - 1];

        if (!lastSentence.isComplete) {
            // Keep incomplete part in buffer
            this.buffer = lastSentence.text;
            return sentences.slice(0, -1);
        }

        // All sentences complete
        this.buffer = '';
        return sentences;
    }

    /**
     * Get current buffer contents without clearing
     * @returns {string} Current buffer
     */
    peek() {
        return this.buffer;
    }

    /**
     * Clear buffer
     */
    clear() {
        this.buffer = '';
        this.pendingChunks = [];
    }

    /**
     * Flush all content as a single chunk
     * @returns {Array} Remaining chunks
     */
    flush() {
        if (this.buffer.length === 0) {
            return [];
        }
        const chunks = detectSentenceBoundaries(this.buffer);
        this.buffer = '';
        return chunks;
    }
}

/**
 * Get sentence service statistics
 * @returns {object} Configuration and stats
 */
export function getSentenceServiceStats() {
    return {
        config: { ...CONFIG },
        thoughtStarters: THOUGHT_STARTERS.length,
        version: '1.0.0'
    };
}

/**
 * SentenceAccumulator for Smooth Mode (26.01.2026)
 * Accumulates complete sentences and releases them in batches.
 *
 * Unlike SentenceBuffer which releases sentences immediately,
 * SentenceAccumulator holds sentences until:
 * - Minimum sentence count reached (default: 2)
 * - Minimum character count reached (default: 50)
 * - Maximum hold time exceeded (default: 15s) - safety valve
 *
 * This provides smoother translations at cost of latency.
 */
export class SentenceAccumulator {
    constructor(config = {}) {
        this.minSentences = config.minSentences || 2;
        this.minChars = config.minChars || 50;
        this.maxHoldMs = config.maxHoldMs || 10000;
        this.earlyReleaseMs = config.earlyReleaseMs || 7000;
        this.catchupMinSentences = config.catchupMinSentences || 3;

        // Accumulated complete sentences
        this.sentences = [];
        this.totalChars = 0;

        // Timing
        this.holdStartTime = null;
        this.catchupMode = false;

        // Stats
        this.stats = {
            sentencesReceived: 0,
            batchesReleased: 0,
            forcedReleases: 0,
            catchupReleases: 0
        };

        // Internal sentence buffer for incomplete sentences
        this._sentenceBuffer = new SentenceBuffer();
        // FQF-4B: one lineage entry per buffered source word. Text remains owned by
        // SentenceBuffer; this parallel ledger is deliberately fail-closed on mismatch.
        this._pendingLineageWords = [];
    }

    /**
     * Add text and potentially release accumulated sentences
     * @param {string} text - Confirmed text from LocalAgreement
     * @param {boolean} isFinal - Whether this is final (flush everything)
     * @returns {object|null} { text, sentenceCount } to release, or null if still accumulating
     */
    add(text, isFinal = false, sourceLineage = null) {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return this._checkTimeoutOrFinal(isFinal);
        }

        if (sourceLineage || this._pendingLineageWords.length > 0) {
            const inputWords = sourceWords(text);
            const lineage = sourceLineage || missingSourceLineage('accumulator_input_unscoped');
            for (let index = 0; index < inputWords.length; index++) {
                this._pendingLineageWords.push({
                    token: inputWords[index],
                    lineage: sliceSourceLineage(lineage, index, 1),
                });
            }
        }

        // Use SentenceBuffer to detect complete sentences
        const completeSentences = this._sentenceBuffer.add(text, isFinal);

        // Add complete sentences to accumulator
        for (const sentence of completeSentences) {
            this.sentences.push({
                text: sentence.text,
                sourceLineage: this._consumeLineage(sentence.text),
            });
            this.totalChars += sentence.text.length;
            this.stats.sentencesReceived++;

            // Start hold timer on first sentence
            if (!this.holdStartTime) {
                this.holdStartTime = Date.now();
            }
        }

        // Check if we should release
        return this._checkRelease(isFinal);
    }

    _consumeLineage(text) {
        const emittedWords = sourceWords(text);
        const consumed = this._pendingLineageWords.splice(0, emittedWords.length);
        if (consumed.length !== emittedWords.length
            || consumed.some((entry, index) => entry.token !== emittedWords[index])) {
            return composeSourceLineages(consumed.map((entry) => entry.lineage), {
                reason: 'sentence_buffer_alignment_mismatch',
                forceAmbiguous: true,
            });
        }
        return composeSourceLineages(consumed.map((entry) => entry.lineage), {
            reason: 'sentence_buffer_incomplete_lineage',
        });
    }

    /**
     * Check if accumulated sentences should be released
     * @private
     */
    _checkRelease(isFinal, overrideConfig = null) {
        // Force release on final
        if (isFinal && this.sentences.length > 0) {
            return this._release('final');
        }

        // Check timeout (safety valve)
        if (this._isTimeout()) {
            this.stats.forcedReleases++;
            return this._release('timeout');
        }

        // Early release: 1+ sentence held for configured time; don't wait for minSentences=2.
        if (this.sentences.length >= 1 && this.holdStartTime &&
            Date.now() - this.holdStartTime > this.earlyReleaseMs) {
            return this._release('early');
        }

        // Determine required thresholds: override (warmup) > catchup > normal
        let requiredSentences, requiredChars;
        if (overrideConfig) {
            requiredSentences = overrideConfig.minSentences;
            requiredChars = overrideConfig.minChars;
        } else if (this.catchupMode) {
            requiredSentences = this.catchupMinSentences;
            requiredChars = this.minChars;
        } else {
            requiredSentences = this.minSentences;
            requiredChars = this.minChars;
        }

        // Check if we have enough
        const hasSentences = this.sentences.length >= requiredSentences;
        const hasChars = this.totalChars >= requiredChars;

        if (hasSentences && hasChars) {
            if (this.catchupMode) {
                this.stats.catchupReleases++;
            }
            return this._release(overrideConfig ? 'warmup' : 'threshold');
        }

        return null;
    }

    /**
     * Check timeout without adding text
     * @private
     */
    _checkTimeoutOrFinal(isFinal) {
        if (isFinal && this.sentences.length > 0) {
            return this._release('final');
        }
        if (this._isTimeout()) {
            this.stats.forcedReleases++;
            return this._release('timeout');
        }
        return null;
    }

    /**
     * Check if hold timeout exceeded
     * @private
     */
    _isTimeout() {
        if (!this.holdStartTime || this.sentences.length === 0) {
            return false;
        }
        return Date.now() - this.holdStartTime > this.maxHoldMs;
    }

    /**
     * Release accumulated sentences
     * @private
     */
    _release(reason) {
        if (this.sentences.length === 0) {
            return null;
        }

        const result = {
            text: this.sentences.map((sentence) => sentence.text).join(' '),
            sentenceCount: this.sentences.length,
            charCount: this.totalChars,
            reason: reason,
            wasCatchup: this.catchupMode,
            sourceLineage: composeSourceLineages(
                this.sentences.map((sentence) => sentence.sourceLineage),
                { reason: 'accumulator_release_incomplete_lineage' },
            ),
        };

        // Reset state
        this.sentences = [];
        this.totalChars = 0;
        this.holdStartTime = null;
        this.catchupMode = false;
        this.stats.batchesReleased++;

        console.log(`[SentenceAccumulator] Released ${result.sentenceCount} sentences (${result.charCount} chars) - reason: ${reason}`);

        return result;
    }

    /**
     * Enable catch-up mode (release more sentences per batch)
     * @param {boolean} enabled
     */
    setCatchupMode(enabled) {
        if (enabled && !this.catchupMode) {
            console.log('[SentenceAccumulator] Entering catch-up mode');
        }
        this.catchupMode = enabled;
    }

    /**
     * Get pending text preview
     * @returns {string}
     */
    peek() {
        const pending = this.sentences.map((sentence) => sentence.text).join(' ');
        const buffered = this._sentenceBuffer.peek();
        return (pending + ' ' + buffered).trim();
    }

    /**
     * Clear all state
     */
    clear() {
        this.sentences = [];
        this.totalChars = 0;
        this.holdStartTime = null;
        this.catchupMode = false;
        this._sentenceBuffer.clear();
        this._pendingLineageWords = [];
    }

    /**
     * Force flush everything
     * @returns {object|null}
     */
    flush() {
        // Flush sentence buffer first
        const remaining = this._sentenceBuffer.flush();
        for (const sentence of remaining) {
            this.sentences.push({
                text: sentence.text,
                sourceLineage: this._consumeLineage(sentence.text),
            });
            this.totalChars += sentence.text.length;
        }

        // Release all
        if (this.sentences.length > 0) {
            return this._release('flush');
        }
        return null;
    }

    /**
     * Check for timeout and release if needed (external call, no text added)
     * Safety valve for when no new audio arrives
     * @returns {object|null}
     */
    checkTimeout() {
        return this._checkTimeoutOrFinal(false);
    }

    /**
     * Get accumulator statistics
     * @returns {object}
     */
    getStats() {
        return {
            ...this.stats,
            currentSentences: this.sentences.length,
            currentChars: this.totalChars,
            holdTimeMs: this.holdStartTime ? Date.now() - this.holdStartTime : 0,
            catchupMode: this.catchupMode,
            config: {
                minSentences: this.minSentences,
                minChars: this.minChars,
                maxHoldMs: this.maxHoldMs,
                catchupMinSentences: this.catchupMinSentences
            }
        };
    }
}

export default {
    detectSentenceBoundaries,
    analyzeSentenceCompleteness,
    SentenceBuffer,
    SentenceAccumulator,
    getSentenceServiceStats
};
