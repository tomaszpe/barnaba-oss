/**
 * Latency Tracking Service for Barnaba
 * =====================================
 * Measures TRUE end-to-end latency across the translation pipeline:
 *
 * Full pipeline stages:
 * 0. audio_captured     - AudioWorklet captures PCM (broadcaster browser)
 * 1. audio_received     - PCM arrives at Gateway (server.js)
 * 2. whisper_sent       - Audio sent to Whisper service
 * 3. whisper_done       - Transcription received from Whisper
 * 4. translation_sent   - Text sent to GPT-4.1-mini
 * 5. translation_done   - Translation received
 * 6. broadcast_done     - Sent to listeners via WebSocket
 * 7. listener_received  - Listener browser receives translation
 *
 * Metrics calculated:
 * - capture_to_gateway: Upload latency (broadcaster → server)
 * - gateway_to_whisper: Time to forward audio
 * - whisper_processing: ASR time (Whisper)
 * - whisper_to_translation: Time between transcription and translation start
 * - queue_wait: Time spent in translation queue (R1.4: 0 when synchronous)
 * - translation_processing: LLM time (GPT-4.1-mini)
 * - translation_to_broadcast: Time to deliver to clients
 * - gateway_to_listener: Download latency (server → listener)
 * - end_to_end: Server-only latency (audio_received → broadcast_done)
 * - true_end_to_end: Full latency (audio_captured → listener_received)
 */

// Circular buffer for recent measurements (last N transactions)
const BUFFER_SIZE = 100;

// All tracked latency keys (for stats arrays and _updateStats)
const LATENCY_KEYS = [
    'capture_to_gateway',
    'gateway_to_whisper',
    'whisper_processing',
    'whisper_to_translation',
    'queue_wait',
    'translation_processing',
    'translation_to_broadcast',
    'gateway_to_listener',
    'end_to_end',
    'true_end_to_end'
];

function _emptyStatsArrays() {
    const obj = {};
    for (const key of LATENCY_KEYS) obj[key] = [];
    return obj;
}

class LatencyTracker {
    constructor() {
        // Active transactions (by transactionId)
        this.activeTransactions = new Map();

        // Completed measurements (circular buffer — all transactions)
        this.measurements = [];
        this.measurementIndex = 0;

        // Recent translations only (with end_to_end !== null) — for latency chart
        this.recentTranslations = [];

        // Aggregated stats
        this.stats = {
            totalTransactions: 0,
            completedTransactions: 0,
            ..._emptyStatsArrays()
        };

        // Per-church stats
        this.churchStats = new Map();
    }

    /**
     * Start tracking a new transaction
     * @param {string} transactionId - Unique ID
     * @param {string} churchId - Church identifier
     * @param {number|null} audioCapturedAt - Broadcaster capture timestamp (server-adjusted)
     * @returns {string} transactionId for later reference
     */
    startTransaction(transactionId, churchId, audioCapturedAt = null) {
        const now = Date.now();

        this.activeTransactions.set(transactionId, {
            churchId,
            timestamps: {
                audio_captured: audioCapturedAt,
                audio_received: now
            },
            metadata: {}
        });

        this.stats.totalTransactions++;
        return transactionId;
    }

    /**
     * Record a timestamp for a pipeline stage
     * @param {string} transactionId
     * @param {string} stage - Stage name (whisper_sent, whisper_done, etc.)
     * @param {object} metadata - Optional metadata (e.g., audio_duration_ms)
     */
    recordStage(transactionId, stage, metadata = {}) {
        const tx = this.activeTransactions.get(transactionId);
        if (!tx) return;

        tx.timestamps[stage] = Date.now();
        Object.assign(tx.metadata, metadata);
    }

    /**
     * Complete transaction and calculate metrics
     * @param {string} transactionId
     * @returns {object} Calculated latencies
     */
    completeTransaction(transactionId) {
        const tx = this.activeTransactions.get(transactionId);
        if (!tx) return null;

        const ts = tx.timestamps;
        const now = Date.now();
        ts.broadcast_done = now;

        // Calculate latencies
        const latencies = {
            transactionId,
            churchId: tx.churchId,
            timestamp: new Date().toISOString(),
            audio_duration_ms: tx.metadata.audio_duration_ms || 0,

            // Upload latency (broadcaster → server) — clamp to 0 if clock sync offset is inaccurate
            capture_to_gateway: ts.audio_captured ? Math.max(0, ts.audio_received - ts.audio_captured) : null,

            // Individual stage latencies (ms)
            gateway_to_whisper: ts.whisper_sent ? ts.whisper_sent - ts.audio_received : null,
            whisper_processing: ts.whisper_done && ts.whisper_sent ? ts.whisper_done - ts.whisper_sent : null,
            whisper_to_translation: ts.translation_sent && ts.whisper_done ? ts.translation_sent - ts.whisper_done : null,
            queue_wait: ts.translation_sent && ts.queue_entered ? ts.translation_sent - ts.queue_entered : null,
            translation_processing: ts.translation_done && ts.translation_sent ? ts.translation_done - ts.translation_sent : null,
            translation_to_broadcast: ts.broadcast_done && ts.translation_done ? ts.broadcast_done - ts.translation_done : null,

            // Download latency — filled later by recordListenerAck()
            gateway_to_listener: null,

            // Server-only end-to-end
            end_to_end: ts.broadcast_done - ts.audio_received,

            // True end-to-end — filled later by recordListenerAck() if audio_captured available
            true_end_to_end: null,

            // Whisper-only (ASR without translation)
            audio_to_transcription: ts.whisper_done ? ts.whisper_done - ts.audio_received : null,

            // Store raw timestamps for later ACK processing
            _ts: {
                audio_captured: ts.audio_captured,
                broadcast_done: ts.broadcast_done
            }
        };

        // Store in circular buffer
        this._storeMeasurement(latencies);

        // Store in recent translations (for latency chart — only full pipeline)
        this.recentTranslations.push(latencies);
        if (this.recentTranslations.length > 10) this.recentTranslations.shift();

        // Update aggregate stats
        this._updateStats(latencies);
        this._updateChurchStats(tx.churchId, latencies);

        // Clean up
        this.activeTransactions.delete(transactionId);
        this.stats.completedTransactions++;

        return latencies;
    }

    /**
     * Record listener ACK — patches completed measurement with download latency
     * Called when a listener sends back a latency_ack with their receivedAt timestamp.
     * Only the first ACK per transaction is recorded (fastest listener).
     *
     * @param {string} transactionId
     * @param {number} listenerReceivedAt - Listener timestamp (server-adjusted via clock offset)
     */
    recordListenerAck(transactionId, listenerReceivedAt) {
        // Find measurement in circular buffer
        const measurement = this.measurements.find(m => m && m.transactionId === transactionId);
        if (!measurement) return null;

        // Only record first ACK
        if (measurement.gateway_to_listener !== null) return measurement;

        const broadcastDone = measurement._ts?.broadcast_done;
        const audioCaptured = measurement._ts?.audio_captured;

        if (broadcastDone) {
            measurement.gateway_to_listener = Math.max(0, listenerReceivedAt - broadcastDone);
            this._pushStat('gateway_to_listener', measurement.gateway_to_listener);
        }

        if (audioCaptured) {
            measurement.true_end_to_end = Math.max(0, listenerReceivedAt - audioCaptured);
            this._pushStat('true_end_to_end', measurement.true_end_to_end);
        }

        // Update per-church stats with ACK-derived values
        const churchId = measurement.churchId;
        if (churchId && this.churchStats.has(churchId)) {
            const church = this.churchStats.get(churchId);
            if (measurement.true_end_to_end !== null) {
                church.true_end_to_end.push(measurement.true_end_to_end);
                if (church.true_end_to_end.length > 50) church.true_end_to_end.shift();
            }
        }

        return measurement;
    }

    /**
     * Complete transaction without translation (Whisper-only)
     * @param {string} transactionId
     */
    completeWhisperOnly(transactionId) {
        const tx = this.activeTransactions.get(transactionId);
        if (!tx) return null;

        const ts = tx.timestamps;

        const latencies = {
            transactionId,
            churchId: tx.churchId,
            timestamp: new Date().toISOString(),
            audio_duration_ms: tx.metadata.audio_duration_ms || 0,

            capture_to_gateway: ts.audio_captured ? Math.max(0, ts.audio_received - ts.audio_captured) : null,
            gateway_to_whisper: ts.whisper_sent ? ts.whisper_sent - ts.audio_received : null,
            whisper_processing: ts.whisper_done && ts.whisper_sent ? ts.whisper_done - ts.whisper_sent : null,
            audio_to_transcription: ts.whisper_done ? ts.whisper_done - ts.audio_received : null,

            // No translation
            whisper_to_translation: null,
            queue_wait: null,
            translation_processing: null,
            translation_to_broadcast: null,
            gateway_to_listener: null,
            end_to_end: null,
            true_end_to_end: null
        };

        this._storeMeasurement(latencies);
        this._updateStats(latencies);
        this.activeTransactions.delete(transactionId);
        this.stats.completedTransactions++;

        return latencies;
    }

    _storeMeasurement(latencies) {
        if (this.measurements.length < BUFFER_SIZE) {
            this.measurements.push(latencies);
        } else {
            this.measurements[this.measurementIndex] = latencies;
            this.measurementIndex = (this.measurementIndex + 1) % BUFFER_SIZE;
        }
    }

    _pushStat(key, value) {
        if (value === null || value === undefined) return;
        this.stats[key].push(value);
        if (this.stats[key].length > BUFFER_SIZE) this.stats[key].shift();
    }

    _updateStats(latencies) {
        for (const key of LATENCY_KEYS) {
            this._pushStat(key, latencies[key]);
        }
    }

    _updateChurchStats(churchId, latencies) {
        if (!this.churchStats.has(churchId)) {
            this.churchStats.set(churchId, {
                transactions: 0,
                end_to_end: [],
                true_end_to_end: [],
                whisper_processing: []
            });
        }

        const church = this.churchStats.get(churchId);
        church.transactions++;

        for (const key of ['end_to_end', 'true_end_to_end', 'whisper_processing']) {
            if (latencies[key] !== null && latencies[key] !== undefined) {
                church[key].push(latencies[key]);
                if (church[key].length > 50) church[key].shift();
            }
        }
    }

    /**
     * Calculate statistics for an array of values
     */
    _calcStats(values) {
        if (!values || values.length === 0) {
            return { count: 0, min: null, max: null, avg: null, p50: null, p95: null, p99: null };
        }

        const sorted = [...values].sort((a, b) => a - b);
        const count = sorted.length;

        return {
            count,
            min: sorted[0],
            max: sorted[count - 1],
            avg: Math.round(sorted.reduce((a, b) => a + b, 0) / count),
            p50: sorted[Math.floor(count * 0.5)],
            p95: sorted[Math.floor(count * 0.95)],
            p99: sorted[Math.floor(count * 0.99)]
        };
    }

    /**
     * Get comprehensive latency statistics
     * @returns {object} Latency stats for API response
     */
    getStats() {
        const latencies_ms = {};
        for (const key of LATENCY_KEYS) {
            latencies_ms[key] = this._calcStats(this.stats[key]);
        }

        const result = {
            summary: {
                total_transactions: this.stats.totalTransactions,
                completed_transactions: this.stats.completedTransactions,
                active_transactions: this.activeTransactions.size,
                measurement_buffer_size: this.measurements.length
            },

            latencies_ms,

            // Recent translations with end_to_end (for latency chart)
            recent: this.recentTranslations.slice(-10).reverse().map(m => {
                const { _ts, ...rest } = m;
                return rest;
            }),

            // Per-church breakdown
            by_church: {}
        };

        // Add per-church stats
        for (const [churchId, church] of this.churchStats) {
            const avg = arr => arr.length > 0
                ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
                : null;

            result.by_church[churchId] = {
                transactions: church.transactions,
                end_to_end_avg_ms: avg(church.end_to_end),
                true_end_to_end_avg_ms: avg(church.true_end_to_end),
                whisper_avg_ms: avg(church.whisper_processing)
            };
        }

        return result;
    }

    /**
     * Reset all statistics
     */
    reset() {
        this.activeTransactions.clear();
        this.measurements = [];
        this.measurementIndex = 0;
        this.recentTranslations = [];
        this.stats = {
            totalTransactions: 0,
            completedTransactions: 0,
            ..._emptyStatsArrays()
        };
        this.churchStats.clear();
    }
}

// Singleton instance
const latencyTracker = new LatencyTracker();

/**
 * Get the audio_captured timestamp (server-time ms) for a transaction.
 * Used by TTS broadcast to embed in tts_chunk messages for listener-side
 * audible drift calculation (broadcaster speech start → listener playback).
 *
 * Checks active transactions first (transaction in-flight), then completed
 * measurements buffer (transaction already completeTransaction()'d).
 * Returns null if transactionId unknown OR audio_captured was null
 * (broadcaster didn't send capturedAt OR clockSync.offset wasn't ready).
 *
 * @param {string} transactionId
 * @returns {number|null} server-time ms when broadcaster captured this audio
 */
export function getAudioCapturedAt(transactionId) {
    if (!transactionId) return null;
    const active = latencyTracker.activeTransactions.get(transactionId);
    if (active?.timestamps?.audio_captured) return active.timestamps.audio_captured;
    const measured = latencyTracker.measurements.find(m => m && m.transactionId === transactionId);
    return measured?._ts?.audio_captured || null;
}

// Export functions
export function startLatencyTracking(churchId, audioCapturedAt = null) {
    const transactionId = `${churchId}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    return latencyTracker.startTransaction(transactionId, churchId, audioCapturedAt);
}

export function recordLatencyStage(transactionId, stage, metadata = {}) {
    latencyTracker.recordStage(transactionId, stage, metadata);
}

export function completeLatencyTracking(transactionId) {
    return latencyTracker.completeTransaction(transactionId);
}

export function completeWhisperOnlyTracking(transactionId) {
    return latencyTracker.completeWhisperOnly(transactionId);
}

export function recordListenerAck(transactionId, listenerReceivedAt) {
    return latencyTracker.recordListenerAck(transactionId, listenerReceivedAt);
}

export function getLatencyStats() {
    return latencyTracker.getStats();
}

export function resetLatencyStats() {
    latencyTracker.reset();
}

export default latencyTracker;
