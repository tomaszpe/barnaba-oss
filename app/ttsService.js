/**
 * Azure Cognitive Services Speech - Server-Side TTS
 *
 * Uses Azure Speech REST API (no SDK) to synthesize speech.
 * Returns base64-encoded MP3 audio for client-side playback.
 *
 * Fallback: returns null on any error - client falls back to Web Speech API.
 *
 * Env vars:
 *   USE_SERVER_TTS=true          - Enable server-side TTS
 *   AZURE_SPEECH_KEY=<key>       - Azure Speech resource key
 *   AZURE_SPEECH_REGION=swedencentral - Azure region
 *
 * Progressive mode (Option H, Phase 3a.2):
 *   synthesizeSpeechProgressive() splits text into sentences (via sentenceSplitter)
 *   and emits per-sentence chunks through a callback while firing all TTS calls
 *   in parallel. Chunks are emitted in index order even if later indexes resolve
 *   earlier.
 */

import { splitForTTS } from './sentenceSplitter.js';
import { ConcurrencyLimiter, runProviderRequestWithTimeout } from './concurrencyLimiter.js';
import { ProviderCircuitBreaker } from './providerCircuitBreaker.js';

// Voice map: language -> gender -> Azure Neural voice name
const VOICE_MAP = {
    'ar': {
        male: 'ar-SA-HamedNeural',
        female: 'ar-SA-ZariyahNeural'
    },
    'de': {
        male: 'de-DE-FlorianMultilingualNeural',
        female: 'de-DE-KatjaNeural'
    },
    'en': {
        male: 'en-US-GuyNeural',
        female: 'en-US-JennyNeural'
    },
    'es': {
        male: 'es-ES-AlvaroNeural',
        female: 'es-ES-ElviraNeural'
    },
    'fr': {
        male: 'fr-FR-HenriNeural',
        female: 'fr-FR-DeniseNeural'
    },
    'it': {
        male: 'it-IT-DiegoNeural',
        female: 'it-IT-ElsaNeural'
    },
    'pl': {
        male: 'pl-PL-MarekNeural',
        female: 'pl-PL-ZofiaNeural'
    },
    'pt': {
        male: 'pt-PT-DuarteNeural',
        female: 'pt-PT-RaquelNeural'
    },
    'ru': {
        male: 'ru-RU-DmitryNeural',
        female: 'ru-RU-SvetlanaNeural'
    },
    'sw': {
        male: 'sw-KE-RafikiNeural',
        female: 'sw-KE-ZuriNeural'
    },
    'tr': {
        male: 'tr-TR-AhmetNeural',
        female: 'tr-TR-EmelNeural'
    },
    'uk': {
        male: 'uk-UA-OstapNeural',
        female: 'uk-UA-PolinaNeural'
    },
    'fa': {
        male: 'fa-IR-FaridNeural',
        female: 'fa-IR-DilaraNeural'
    },
    'pt-BR': {
        male: 'pt-BR-AntonioNeural',
        female: 'pt-BR-FranciscaNeural'
    },
    'zh': {
        male: 'zh-CN-YunxiNeural',
        female: 'zh-CN-XiaoxiaoNeural'
    }
};

const AUDIO_FORMAT = 'audio-16khz-32kbitrate-mono-mp3';
const TIMEOUT_MS = 5000;

// Bytes per second implied by AUDIO_FORMAT. The format is CBR MP3, so byte length maps to
// duration without asking Azure for anything. Parsed from the format string rather than
// hard-coded, so changing AUDIO_FORMAT cannot silently keep the old divisor.
const AUDIO_BYTES_PER_SECOND = (() => {
    const match = /(\d+)kbitrate/.exec(AUDIO_FORMAT);
    return match ? (Number(match[1]) * 1000) / 8 : null;
})();

/**
 * ESTIMATE, not a measurement: MP3 carries frame headers and padding, and the buffer may
 * contain metadata (e.g. an ID3 tag), so bytes/rate is a very good but not exact
 * approximation. Validated against the client decoder before it feeds any gate
 * (validated against the client decoder before it feeds any gate).
 * @param {number} byteLength - decoded MP3 byte length
 * @returns {number|null} milliseconds, or null when the format has no parsable bitrate
 */
export function estimateAudioDurationMs(byteLength) {
    const bytes = Number(byteLength);
    if (!AUDIO_BYTES_PER_SECOND || !Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.round((bytes / AUDIO_BYTES_PER_SECOND) * 1000);
}

/**
 * Same estimate from the wire representation. `Buffer.byteLength(str, 'base64')` returns
 * the decoded length without allocating the buffer, so this is exactly the byteLength the
 * synthesizer saw.
 * @param {string|null} audioBase64
 * @returns {number|null}
 */
export function estimateAudioDurationMsFromBase64(audioBase64) {
    if (typeof audioBase64 !== 'string' || audioBase64.length === 0) return null;
    return estimateAudioDurationMs(Buffer.byteLength(audioBase64, 'base64'));
}
const ttsLimiter = new ConcurrencyLimiter({
    name: 'azure_tts',
    maxConcurrency: process.env.TTS_CONCURRENCY_LIMIT || 6,
});
const ttsCircuitBreaker = new ProviderCircuitBreaker({
    name: 'azure_tts',
    failureThreshold: process.env.TTS_CIRCUIT_FAILURE_THRESHOLD || 3,
    cooldownMs: process.env.TTS_CIRCUIT_COOLDOWN_MS || 30000,
});

/**
 * Check if server-side TTS is enabled and configured
 */
export function isTtsEnabled() {
    return process.env.USE_SERVER_TTS === 'true' &&
           !!process.env.AZURE_SPEECH_KEY &&
           !!process.env.AZURE_SPEECH_REGION;
}

/**
 * Get TTS service status for health endpoint
 */
export function getTtsStatus() {
    return {
        enabled: process.env.USE_SERVER_TTS === 'true',
        configured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
        region: process.env.AZURE_SPEECH_REGION || null,
        audioFormat: AUDIO_FORMAT,
        voices: Object.keys(VOICE_MAP),
        concurrency: ttsLimiter.getStats(),
        circuitBreaker: ttsCircuitBreaker.getStatus(),
        timeoutMs: TIMEOUT_MS,
    };
}

/**
 * Build SSML XML for Azure Speech API
 * @param {string} text - Text to synthesize
 * @param {string} language - Language code (pl, en, uk, de, it)
 * @param {string} gender - 'male' or 'female'
 * @returns {string} SSML XML string
 */
// Languages in which the dot is a THOUSANDS separator. In English the dot is the DECIMAL
// separator (`3.141` = three and one hundred forty-one thousandths), so the same normalisation
// would turn a number into a different number there - hence a list, not a global rule.
const THOUSANDS_DOT_LANGUAGES = new Set(['de']);

/**
 * Thousands separator -> a bare digit string, ONLY on the audio input path.
 *
 * SYMPTOM: "3.000 Rindern" read aloud as "three - zero zero zero".
 * THE CAUSE IS NOT IN AZURE: `buildSsml` replaces EVERY dot with `<break time="300ms"/>`, so
 * `3.000` falls apart into `3 <break/> 000` before it is even sent. The normalisation therefore
 * has to run BEFORE punctuation substitution, not after it.
 * The formatting originates from GPT: Whisper produces `3000`, the translating model adds the
 * dots. It is fixed deterministically here, because a prompt gives no guarantee.
 *
 * DISPLAYED and LOGGED text is unchanged - this affects only what is heard.
 */
export function normalizeNumeralsForSpeech(text, language) {
    if (!text || !THOUSANDS_DOT_LANGUAGES.has(language)) return text;
    // `\d{1,3}(\.\d{3})+` requires groups of EXACTLY three digits, so `3.14` and `4.52` do not
    // match; the lookahead excludes `3.000,50`, where the dot is adjacent to a decimal part.
    return text.replace(/\b\d{1,3}(?:\.\d{3})+\b(?![.,]\d)/g, value => value.replaceAll('.', ''));
}

export function buildSsml(text, language, gender) {
    const voiceName = VOICE_MAP[language]?.[gender] || VOICE_MAP[language]?.male || 'en-US-GuyNeural';

    // Replace sentence punctuation with placeholders (before XML escaping)
    // Prevents TTS from reading "." as "kropka", "punkt", "period" etc.
    // Also fixes short words before "." being treated as abbreviations (e.g., "co." → "Ce O")
    let processed = normalizeNumeralsForSpeech(text, language)
        .replace(/\.\s*/g, ' {{BREAK300}} ')
        .replace(/\?\s*/g, ' {{BREAK200}} ')
        .replace(/!\s*/g, ' {{BREAK200}} ');

    // Escape XML special characters
    processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    // Replace placeholders with SSML break tags (after escaping)
    processed = processed
        .replace(/\{\{BREAK300\}\}/g, '<break time="300ms"/>')
        .replace(/\{\{BREAK200\}\}/g, '<break time="200ms"/>');

    return `<speak version='1.0' xml:lang='${language}'>` +
           `<voice name='${voiceName}'>${processed}</voice>` +
           `</speak>`;
}

/**
 * Synthesize speech using Azure Speech REST API
 * @param {string} text - Text to synthesize
 * @param {string} language - Language code (pl, en, uk, de, it)
 * @param {string} gender - 'male' or 'female'
 * @param {{onRequestStart?: Function, sentenceIndex?: number}} options - Optional request telemetry
 * @returns {Promise<string|null>} Base64-encoded MP3 audio, or null on error
 */
export async function synthesizeSpeech(text, language, gender, options = {}) {
    if (!isTtsEnabled()) {
        return null;
    }

    if (!text || !text.trim()) {
        return null;
    }

    if (!ttsCircuitBreaker.canRequest()) {
        console.error('[TTS] Circuit open - skipping Azure TTS request');
        return null;
    }

    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;
    const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const ssml = buildSsml(text, language, gender);

    try {
        const { response, arrayBuffer } = await runProviderRequestWithTimeout({
            limiter: ttsLimiter,
            timeoutMs: TIMEOUT_MS,
            onStart: () => {
                if (typeof options.onRequestStart !== 'function') return;
                const startedAtMs = Date.now();
                try {
                    options.onRequestStart({
                        language,
                        gender,
                        sentenceIndex: Number.isInteger(options.sentenceIndex) ? options.sentenceIndex : 0,
                        startedAtMs,
                    });
                } catch (error) {
                    console.warn(`[TTS] Request telemetry failed: ${error.message}`);
                }
            },
            request: async (signal) => {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Ocp-Apim-Subscription-Key': key,
                        'Content-Type': 'application/ssml+xml',
                        'X-Microsoft-OutputFormat': AUDIO_FORMAT,
                        'User-Agent': 'Barnaba-TTS/1.0'
                    },
                    body: ssml,
                    signal,
                });
                const arrayBuffer = response.ok ? await response.arrayBuffer() : null;
                return { response, arrayBuffer };
            },
        });

        if (!response.ok) {
            console.error(`[TTS] Azure API error: ${response.status} ${response.statusText}`);
            ttsCircuitBreaker.recordFailure(new Error(`HTTP ${response.status}`));
            return null;
        }

        const base64 = Buffer.from(arrayBuffer).toString('base64');

        const sizeKB = (arrayBuffer.byteLength / 1024).toFixed(1);
        console.log(`[TTS] Synthesized ${language}/${gender}: ${sizeKB}KB MP3`);

        ttsCircuitBreaker.recordSuccess();
        return base64;

    } catch (error) {
        ttsCircuitBreaker.recordFailure(error);
        if (error.name === 'AbortError') {
            console.error(`[TTS] Timeout (${TIMEOUT_MS}ms) for ${language}/${gender}`);
        } else {
            console.error(`[TTS] Error for ${language}/${gender}: ${error.message}`);
        }
        return null;
    }
}

/**
 * Core progressive emission helper — exported for unit testing.
 *
 * Fires `generator(sentence)` for every sentence in parallel, then awaits
 * each result in index order and emits via onChunk(audio, idx, total, isLast).
 * Later indexes that resolve earlier are held until their turn.
 *
 * Null/error results are emitted as `onChunk(null, idx, total, isLast)` so
 * the caller can still observe stream-end (is_last=true) even on failure.
 *
 * @param {string[]} sentences - Array of sentence strings
 * @param {(sentence: string, index: number) => Promise<string|null>} generator
 * @param {(audioBase64: string|null, sentenceIndex: number, totalSentences: number, isLast: boolean, sentence: string) => void} onChunk
 * @returns {Promise<{ total: number, emitted: number, nullCount: number }>}
 */
export async function emitChunksInOrder(sentences, generator, onChunk) {
    const total = sentences.length;
    if (total === 0) {
        return { total: 0, emitted: 0, nullCount: 0 };
    }

    // Fire all in parallel. Individual failures become resolved null rather
    // than rejections so the ordered-await loop below never throws.
    const promises = sentences.map(async (sentence, index) => {
        try {
            return await generator(sentence, index);
        } catch (err) {
            console.error(`[TTS] progressive generator error: ${err && err.message}`);
            return null;
        }
    });

    let emitted = 0;
    let nullCount = 0;
    for (let i = 0; i < total; i++) {
        const audioBase64 = await promises[i];
        const isLast = i === total - 1;
        if (audioBase64 === null || audioBase64 === undefined) {
            nullCount++;
        }
        onChunk(audioBase64 || null, i, total, isLast, sentences[i]);
        emitted++;
    }

    return { total, emitted, nullCount };
}

export function splitForProgressiveTTS(text, options = {}) {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }

    const batchShortEmissions = options.batchShortEmissions ?? process.env.TTS_BATCH_SHORT_EMISSIONS === 'true';
    const batchMaxChars = Math.max(0, parseInt(options.batchMaxChars ?? process.env.TTS_BATCH_MAX_CHARS ?? '0', 10) || 0);
    const trimmed = text.trim();

    if (batchShortEmissions && batchMaxChars > 0 && trimmed.length <= batchMaxChars) {
        return [trimmed];
    }

    return splitForTTS(trimmed);
}

/**
 * Progressive synthesis: split text into sentences, synthesize in parallel,
 * emit chunks in index order.
 *
 * Backward-safe: if TTS disabled or text empty, returns without invoking
 * the callback. If splitForTTS returns a single piece (short text), behaves
 * identically to a single synthesizeSpeech call wrapped as one chunk.
 *
 * @param {string} text - Full translation text
 * @param {string} language - Language code (pl, en, ...)
 * @param {string} gender - 'male' or 'female'
 * @param {(audioBase64: string|null, sentenceIndex: number, totalSentences: number, isLast: boolean, sentence: string) => void} onChunk
 * @param {{onRequestStart?: Function}} options - Optional request telemetry
 * @returns {Promise<{ total: number, emitted: number, nullCount: number } | null>}
 */
export async function synthesizeSpeechProgressive(text, language, gender, onChunk, options = {}) {
    if (!isTtsEnabled()) {
        return null;
    }
    if (typeof text !== 'string' || !text.trim()) {
        return null;
    }

    const sentences = splitForProgressiveTTS(text);
    if (sentences.length === 0) {
        return null;
    }

    return emitChunksInOrder(
        sentences,
        (sentence, sentenceIndex) => synthesizeSpeech(sentence, language, gender, {
            ...options,
            sentenceIndex,
        }),
        onChunk,
    );
}
