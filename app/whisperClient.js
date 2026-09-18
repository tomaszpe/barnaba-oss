import { whisperIdentityHeaders } from './whisperIdentity.mjs';
/**
 * Whisper Client - HTTP client for Python Whisper Service
 * Phase C: Integration with faster-whisper backend
 *
 * Provides the gateway Whisper interface by calling the external Python
 * Whisper service via HTTP.
 *
 * Benefits over local transformers.js:
 * - 4x faster inference (CTranslate2)
 * - Swiss German fine-tuned model
 * - Silero VAD for better speech detection
 * - LocalAgreement-n for stable streaming
 * - GPU acceleration
 */

import { createWhisperRequestTracker, safeSnapshot } from './whisperRequestTracker.js';

// Configuration
const CONFIG = {
    // Python Whisper service URL
    serviceUrl: process.env.WHISPER_SERVICE_URL || 'http://localhost:8000',
    // Timeout for transcription requests (ms)
    timeout: 60000,
    // Retry configuration
    maxRetries: 2,
    retryDelayMs: 1000,
    // Buffer settings matching the gateway streaming contract
    minBufferMs: 3000,      // Minimum 3 seconds before transcribing
    maxBufferMs: 30000,     // Maximum 30 seconds per chunk
    sampleRate: 16000       // Whisper's native sample rate
};

// Bookkeeping of OPEN REQUESTS to Whisper. Live state must not come from the response - that
// arrives AFTER inference finishes. The tracker is a separate, pure module: no logging and no
// emission decisions.
const requestTracker = createWhisperRequestTracker();

// Service state
let serviceReady = false;
let lastHealthCheck = null;
let sessionIds = new Map();  // churchId -> sessionId (for streaming)
let sessionCreatePromises = new Map();  // churchId -> in-flight session create promise

// Audio buffers for accumulating chunks
const audioBuffers = new Map();  // churchId -> { samples: Float32Array[], totalSamples: number, lastUpdate: Date }

/**
 * Initialize connection to Python Whisper service
 * Checks health and waits for model to be ready
 */
async function initWhisper() {
    console.log(`[WhisperClient] Connecting to Python Whisper service: ${CONFIG.serviceUrl}`);

    try {
        const status = await checkHealth();

        if (status.model_loaded) {
            serviceReady = true;
            console.log(`[WhisperClient] Service ready - Model: ${status.model_name}, Device: ${status.device}`);
        } else {
            console.log(`[WhisperClient] Service warming up - waiting for model load...`);
            // Wait for model to load (poll every 5 seconds, max 3 minutes)
            for (let i = 0; i < 36; i++) {
                await sleep(5000);
                const newStatus = await checkHealth();
                if (newStatus.model_loaded) {
                    serviceReady = true;
                    console.log(`[WhisperClient] Service ready after ${(i + 1) * 5}s`);
                    break;
                }
            }
        }

        if (!serviceReady) {
            throw new Error('Whisper service failed to initialize within timeout');
        }

        return true;
    } catch (error) {
        console.error(`[WhisperClient] Failed to connect: ${error.message}`);
        throw error;
    }
}

/**
 * Check health of Python Whisper service
 */
async function checkHealth() {
    const response = await fetchWithRetry(`${CONFIG.serviceUrl}/health`, {
        method: 'GET',
        timeout: 10000
    });

    lastHealthCheck = response;
    return response;
}

/**
 * Transcribe audio buffer (Swiss German → Hochdeutsch)
 * Main transcription API
 *
 * @param {Buffer|ArrayBuffer|Float32Array} audioBuffer - Audio data
 * @param {object} options - Transcription options
 * @param {number} options.sample_rate - Source sample rate (default: 16000)
 * @param {string} options.language - Language code (default: 'de')
 * @returns {Promise<{text: string, chunks?: Array, language: string, model: string}>}
 */
async function transcribeSwissGerman(audioBuffer, options = {}) {
    if (!serviceReady) {
        await initWhisper();
    }

    // Convert audio to Float32Array
    const audioArray = convertToFloat32Array(audioBuffer);

    if (audioArray.length === 0) {
        return { text: '', chunks: [], language: 'de', model: 'remote' };
    }

    // Use provided sample_rate or default to CONFIG.sampleRate
    // Python backend handles resampling to 16kHz if needed
    const sampleRate = options.sample_rate || CONFIG.sampleRate;

    console.log(`[WhisperClient] Transcribing ${audioArray.length} samples at ${sampleRate}Hz...`);

    const response = await fetchWithRetry(`${CONFIG.serviceUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio: Array.from(audioArray),
            sample_rate: sampleRate,
            language: options.language || 'de',
            task: 'transcribe'
        }),
        timeout: CONFIG.timeout
    });

    return {
        text: response.text || '',
        chunks: response.segments || [],
        language: response.language || 'de',
        model: 'faster-whisper-swiss-german'
    };
}

/**
 * Transcribe audio for real-time streaming
 * Streaming transcription API
 *
 * @param {Buffer|ArrayBuffer|Float32Array} audioChunk - Audio chunk
 * @param {number} sampleRate - Source sample rate (default: 16000)
 * @returns {Promise<{text: string, language: string}>}
 */
async function transcribeStream(audioChunk, sampleRate = CONFIG.sampleRate) {
    if (!serviceReady) {
        await initWhisper();
    }

    // Convert audio to Float32Array
    const audioArray = convertToFloat32Array(audioChunk);

    if (audioArray.length === 0) {
        return { text: '', language: 'de' };
    }

    // Python backend handles resampling to 16kHz if needed
    console.log(`[WhisperClient] Stream transcribing ${audioArray.length} samples at ${sampleRate}Hz...`);

    const response = await fetchWithRetry(`${CONFIG.serviceUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio: Array.from(audioArray),
            sample_rate: sampleRate,
            language: 'de',
            task: 'transcribe'
        }),
        timeout: CONFIG.timeout
    });

    return {
        text: response.text || '',
        language: 'de'
    };
}

/**
 * Accumulate audio chunks for a church session
 * Accumulate browser audio chunks
 *
 * IMPORTANT: This handles WebM chunks from MediaRecorder
 * and converts them to raw PCM for the Python service.
 *
 * @param {string} churchId - Church identifier
 * @param {Buffer} audioChunk - Audio chunk to add (WebM format)
 * @returns {Buffer|null} - Combined buffer if ready, null if still accumulating
 */
function accumulateAudio(churchId, audioChunk) {
    // WebM/EBML signature check
    const isWebMHeader = audioChunk.length >= 4 &&
        audioChunk[0] === 0x1A &&
        audioChunk[1] === 0x45 &&
        audioChunk[2] === 0xDF &&
        audioChunk[3] === 0xA3;

    if (!audioBuffers.has(churchId) || isWebMHeader) {
        if (isWebMHeader) {
            console.log(`[WhisperClient] New WebM header for ${churchId}: ${audioChunk.length} bytes`);
        } else {
            console.log(`[WhisperClient] First chunk for ${churchId}: ${audioChunk.length} bytes (no header - skipping)`);
            return null;
        }
        audioBuffers.set(churchId, {
            headerChunk: audioChunk,
            chunks: [],
            totalLength: 0,
            lastUpdate: Date.now()
        });
        return null;
    }

    const buffer = audioBuffers.get(churchId);
    buffer.chunks.push(audioChunk);
    buffer.totalLength += audioChunk.length;
    buffer.lastUpdate = Date.now();

    // Roughly 5 seconds of WebM audio
    const MIN_BUFFER_SIZE = 30000;

    if (buffer.totalLength >= MIN_BUFFER_SIZE) {
        const combined = Buffer.concat([buffer.headerChunk, ...buffer.chunks]);
        console.log(`[WhisperClient] Accumulated ${combined.length} bytes for ${churchId}`);
        buffer.chunks = [];
        buffer.totalLength = 0;
        return combined;
    }

    return null;
}

/**
 * Flush remaining audio for a church
 * Flush accumulated audio
 *
 * @param {string} churchId - Church identifier
 * @returns {Buffer|null} - Remaining audio buffer or null
 */
function flushAudioBuffer(churchId) {
    const buffer = audioBuffers.get(churchId);
    if (!buffer || !buffer.headerChunk || buffer.chunks.length === 0) {
        audioBuffers.delete(churchId);
        return null;
    }

    const combined = Buffer.concat([buffer.headerChunk, ...buffer.chunks]);
    console.log(`[WhisperClient] Flushing ${combined.length} bytes for ${churchId}`);
    audioBuffers.delete(churchId);

    return combined.length > 5000 ? combined : null;
}

/**
 * Clear audio buffer for a church
 * Clear accumulated audio
 *
 * @param {string} churchId - Church identifier
 */
function clearAudioBuffer(churchId) {
    audioBuffers.delete(churchId);
    sessionCreatePromises.delete(churchId);

    // Also clean up any streaming session
    if (sessionIds.has(churchId)) {
        const sessionId = sessionIds.get(churchId);
        // Fire and forget session cleanup
        fetchWithRetry(`${CONFIG.serviceUrl}/session/${sessionId}`, { method: 'DELETE', maxRetries: 0 })
            .catch(() => {});
        sessionIds.delete(churchId);
    }
}

/**
 * Get Whisper service status
 * Service status
 *
 * @returns {object} - Service status
 */
function getWhisperStatus() {
    return {
        initialized: serviceReady,
        initializing: false,
        model: lastHealthCheck?.model_name || 'remote-service',
        device: lastHealthCheck?.device || 'unknown',
        activeBuffers: audioBuffers.size,
        streamingSessions: sessionIds.size,
        pendingSessionCreates: sessionCreatePromises.size,
        serviceUrl: CONFIG.serviceUrl,
        config: {
            language: 'de',
            backend: 'faster-whisper',
            mode: 'remote'
        }
    };
}

/**
 * Get service statistics
 * Service stats
 *
 * @returns {object} - Statistics
 */
function getWhisperStats() {
    return {
        version: '2.0.0',
        model: lastHealthCheck?.model_name || 'not connected',
        device: lastHealthCheck?.device || 'unknown',
        activeBuffers: audioBuffers.size,
        streamingSessions: sessionIds.size,
        pendingSessionCreates: sessionCreatePromises.size,
        isReady: serviceReady,
        backend: 'faster-whisper',
        serviceUrl: CONFIG.serviceUrl
    };
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Convert various audio formats to Float32Array
 */
function convertToFloat32Array(audioData) {
    if (audioData instanceof Float32Array) {
        return audioData;
    }

    if (audioData instanceof Buffer) {
        // Assume 16-bit PCM if raw buffer
        // For WebM, we need ffmpeg conversion - delegate to Python service
        // which will handle the format detection
        const int16 = new Int16Array(
            audioData.buffer,
            audioData.byteOffset,
            Math.floor(audioData.length / 2)
        );
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }
        return float32;
    }

    if (audioData instanceof ArrayBuffer) {
        return convertToFloat32Array(Buffer.from(audioData));
    }

    if (Array.isArray(audioData)) {
        return new Float32Array(audioData);
    }

    throw new Error(`Unsupported audio format: ${typeof audioData}`);
}

/**
 * Fetch with timeout and retry support
 */
async function fetchWithRetry(url, options = {}) {
    // `onAttemptStart` MUST be removed from the options passed to `fetch` - a function has no
    // business in a `RequestInit`. Without this callback the attempt counter would have to be
    // guessed by the caller, and one logical call makes up to 3 HTTP attempts.
    const { timeout = 30000, maxRetries = CONFIG.maxRetries, onAttemptStart, ...fetchOptions } = options;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            if (onAttemptStart) {
                // Telemetry must not break the request - fail-open.
                try {
                    onAttemptStart(attempt + 1);
                } catch (telemetryError) {
                    console.warn(`[WhisperClient] onAttemptStart failed: ${telemetryError.message}`);
                }
            }

            const identityHeaders = await whisperIdentityHeaders(url);
            const response = await fetch(url, {
                ...fetchOptions,
                headers: { ...fetchOptions.headers, ...identityHeaders },
                redirect: 'error',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            return await response.json();

        } catch (error) {
            lastError = error;

            if (attempt < maxRetries) {
                console.warn(`[WhisperClient] Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
                await sleep(CONFIG.retryDelayMs * (attempt + 1));
            }
        }
    }

    throw lastError;
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Streaming Session API (advanced, for Phase B AudioWorklet)
// ============================================================

/**
 * Create a streaming transcription session
 * Used with AudioWorklet for real-time streaming
 *
 * @param {string} churchId - Church identifier
 * @returns {Promise<string>} - Session ID
 */
async function createStreamingSession(churchId) {
    const response = await fetchWithRetry(`${CONFIG.serviceUrl}/session/create`, {
        method: 'POST'
    });

    sessionIds.set(churchId, response.session_id);
    console.log(`[WhisperClient] Created streaming session for ${churchId}: ${response.session_id}`);

    return response.session_id;
}

async function getOrCreateStreamingSession(churchId) {
    const existingSessionId = sessionIds.get(churchId);
    if (existingSessionId) {
        return existingSessionId;
    }

    let createPromise = sessionCreatePromises.get(churchId);
    if (!createPromise) {
        createPromise = createStreamingSession(churchId)
            .finally(() => {
                sessionCreatePromises.delete(churchId);
            });
        sessionCreatePromises.set(churchId, createPromise);
    }

    return createPromise;
}

/**
 * Send audio chunk to streaming session
 * Uses LocalAgreement-2 for stable transcription output
 *
 * @param {string} churchId - Church identifier
 * @param {Float32Array} audioChunk - PCM audio (any sample rate)
 * @param {number} sampleRate - Audio sample rate (default: 16000)
 * @param {boolean} isFinal - True if this is the last chunk
 * @returns {Promise<{partial: string, confirmed: string, isSpeech: boolean, hasNew: boolean}>}
 */
async function sendStreamingChunk(churchId, audioChunk, sampleRate = 16000, isFinal = false, context = {}) {
    // Waiting for the session to be created is NOT a chunk request - it is measured separately
    // (`sessionWaitMs`) and deliberately kept outside the request age. The DURATION is measured
    // with the MONOTONIC clock, exactly like the request age in the tracker: `Date.now()` would
    // give a negative or hour-long duration across an NTP jump.
    const sessionWaitStart = performance.now();
    const sessionId = await getOrCreateStreamingSession(churchId);
    const sessionWaitMs = Math.round((performance.now() - sessionWaitStart) * 10) / 10;

    // Registered AFTER obtaining the session, just before the first send attempt.
    const requestId = requestTracker.register({
        churchId,
        whisperSessionId: sessionId,
        sampleCount: audioChunk?.length ?? null,
        sampleRate,
        isFinal,
        latencyTxId: context.latencyTxId ?? null,
        sessionWaitMs,
    });

    let response = null;
    let failure = null;
    try {
        response = await fetchWithRetry(`${CONFIG.serviceUrl}/session/${sessionId}/chunk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                audio: Array.from(audioChunk),
                sample_rate: sampleRate,
                is_final: isFinal
            }),
            timeout: 30000,
            onAttemptStart: (attempt) => requestTracker.markAttempt(churchId, requestId, attempt),
        });
        // The session is cleaned up ONLY after a successful response. Doing it in `finally`
        // would also drop the session after an ERROR on the final chunk, so the next send would
        // assume a new Whisper session and start from an empty buffer.
        // The tracker record is always released; these are two different things.
        if (isFinal) {
            sessionCreatePromises.delete(churchId);
            sessionIds.delete(churchId);
        }
        return buildStreamingResult(response, sessionId);
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        // ALWAYS released: success, HTTP error, timeout, abort. Leaking a record is not a
        // transient error but a permanent falsification of every later measurement.
        const completion = requestTracker.complete(churchId, requestId, {
            provenance: response ? extractProvenance(response, sessionId) : null,
            error: failure,
        });
        // Telemetry is FAIL-OPEN and must not change the result of the request.
        if (completion && context.onRequestCompleted) {
            try {
                context.onRequestCompleted(completion);
            } catch (telemetryError) {
                console.warn(`[WhisperClient] onRequestCompleted failed: ${telemetryError.message}`);
            }
        }
    }
}

function buildStreamingResult(response, whisperSessionId) {
    const provenance = extractProvenance(response, whisperSessionId);
    return {
        partial: response.partial_text || '',
        confirmed: response.confirmed_text || '',
        isSpeech: response.is_speech,
        hasNew: response.has_new_transcription,
        // Phase 2 part 1 (28.06.2026): cumulative LA stable prefix, separate from confirmed delta.
        // On a stall (hasNew=false) confirmed='' but stable may hold words. Default '' / 0 for
        // back-compat if whisper has not been redeployed yet.
        stable: response.stable_text || '',
        laConfirmedWordCount: response.la_confirmed_word_count || 0,
        laConfirmedCharCount: response.la_confirmed_char_count || 0,
        // Provenance is FORWARDED, not discarded. The client used to strip all of these fields,
        // so the join between a fallback decision and a decode had nothing to join on.
        // `undefined` against an older Whisper - the fields are optional on both sides.
        provenance,
        partialProvenance: extractHypothesisProvenance(provenance, 'partial'),
        stableProvenance: extractHypothesisProvenance(provenance, 'stable'),
    };
}

function extractHypothesisProvenance(provenance, kind) {
    if (!provenance) return null;
    const status = kind === 'partial'
        ? provenance.partialProvenanceStatus
        : provenance.stableProvenanceStatus;
    const wordSpans = kind === 'partial'
        ? provenance.partialWordSpans
        : provenance.stableWordSpans;
    const alignmentStatus = kind === 'partial'
        ? provenance.partialAlignmentStatus
        : provenance.stableAlignmentStatus;
    if (status == null && wordSpans == null && alignmentStatus == null) return null;
    return {
        ...provenance,
        provenanceStatus: status,
        provenanceReason: null,
        confirmedWordSpans: wordSpans,
        alignmentStatus,
    };
}

/**
 * Provenance from the Whisper response plus the locally known streaming session id.
 * The client does not interpret the response fields:
 * `decodeId == null` means "this response carries no decode evidence", not "there was no
 * decode" - resolving that belongs to the report, not to the transport.
 */
function extractProvenance(response, whisperSessionId = null) {
    if (!response) return null;
    return {
        whisperSessionId,
        decodeId: response.decode_id ?? null,
        inputPcmSha256: response.input_pcm_sha256 ?? null,
        inputStartSample: response.input_start_sample ?? null,
        inputEndSample: response.input_end_sample ?? null,
        decodeRequestedAtMs: response.decode_requested_at_ms ?? null,
        decodeStartedAtMs: response.decode_started_at_ms ?? null,
        decodeFinishedAtMs: response.decode_finished_at_ms ?? null,
        executorWaitMs: response.executor_wait_ms ?? null,
        inferenceMs: response.inference_ms ?? null,
        workerTotalMs: response.worker_total_ms ?? null,
        decodeTotalMs: response.decode_total_ms ?? null,
        transcribeStatus: response.transcribe_status ?? null,
        provenanceStatus: response.provenance_status ?? null,
        provenanceReason: response.provenance_reason ?? null,
        confirmedWordSpans: response.confirmed_word_spans ?? null,
        partialProvenanceStatus: response.partial_provenance_status ?? null,
        partialWordSpans: response.partial_word_spans ?? null,
        partialAlignmentStatus: response.partial_alignment_status ?? null,
        stableProvenanceStatus: response.stable_provenance_status ?? null,
        stableWordSpans: response.stable_word_spans ?? null,
        stableAlignmentStatus: response.stable_alignment_status ?? null,
        textTokenCount: response.text_token_count ?? null,
        spanTokenCount: response.span_token_count ?? null,
        alignmentStatus: response.alignment_status ?? null,
        alignmentReason: response.alignment_reason ?? null,
        unalignedWordCount: response.unaligned_word_count ?? null,
        nonWordLevelChunk: response.non_word_level_chunk ?? null,
        alignedSpan: response.aligned_span ?? null,
    };
}

/**
 * Get full transcript from streaming session
 *
 * @param {string} churchId - Church identifier
 * @returns {Promise<string>} - Full transcript
 */
async function getStreamingTranscript(churchId) {
    const sessionId = sessionIds.get(churchId);
    if (!sessionId) {
        return '';
    }

    const response = await fetchWithRetry(`${CONFIG.serviceUrl}/session/${sessionId}/transcript`, {
        method: 'GET'
    });

    return response.full_text || '';
}

/**
 * Reads live state AT THE MOMENT OF DECISION. Fail-open - `{ unavailable, reason }` means
 * "we do not know" and is different from `count: 0` ("we know nothing is in progress").
 */
function getWhisperRequestsInFlight(churchId) {
    return safeSnapshot(requestTracker, churchId);
}

export {
    initWhisper,
    transcribeSwissGerman,
    transcribeStream,
    accumulateAudio,
    flushAudioBuffer,
    clearAudioBuffer,
    getWhisperStatus,
    getWhisperStats,
    // Streaming session API (for Phase B)
    createStreamingSession,
    sendStreamingChunk,
    getStreamingTranscript,
    getWhisperRequestsInFlight,
    CONFIG as WHISPER_CONFIG
};
