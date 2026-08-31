/**
 * hgDedupService — HG-level semantic duplicate detection (Path C).
 *
 * Supports two usage modes:
 * - Streaming mode: instantiate HGDedupService and call process(churchId, emission)
 *   for each incoming Whisper emission (production use in server.js).
 * - Offline replay mode: use runSequence(emissions, config) for batch processing
 *   of historical data. Useful for hyperparameter tuning (e.g., with Optuna)
 *   and regression testing.
 *
 * Per DC1: drop current, keep original approach (no wait window).
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity in [-1, 1]
 */
function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    na = Math.sqrt(na);
    nb = Math.sqrt(nb);
    return na && nb ? dot / (na * nb) : 0;
}

/**
 * Jaccard similarity over word token sets (lowercased).
 * @param {string} textA
 * @param {string} textB
 * @returns {number} overlap ratio in [0, 1]
 */
function tokenJaccard(textA, textB) {
    const toSet = (s) => new Set(s.toLowerCase().match(/\w+/g) || []);
    const a = toSet(textA);
    const b = toSet(textB);
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) {
        if (b.has(w)) intersection++;
    }
    return intersection / (a.size + b.size - intersection);
}

const noop = () => {};

// ── HGDedupService ──────────────────────────────────────────────────────────

class HGDedupService {
    /**
     * @param {object} config
     * @param {function} config.embedFn - Required. async (text: string) => number[]
     * @param {function} [config.logFn=noop] - Optional. (entry: object) => void
     * @param {number} [config.similarityThreshold=0.70] - Cosine sim for P1 detection
     * @param {number} [config.tokenJaccardMax=0.50] - Above = lexical (P2 handles)
     * @param {number} [config.maxPendingAge=10000] - Safety cleanup (ms)
     */
    constructor({ embedFn, logFn, similarityThreshold, tokenJaccardMax, maxPendingAge } = {}) {
        if (!embedFn) throw new Error('hgDedupService: embedFn is required');
        this._embedFn = embedFn;
        this._logFn = logFn || noop;
        this._similarityThreshold = similarityThreshold ?? 0.70;
        this._tokenJaccardMax = tokenJaccardMax ?? 0.50;
        this._maxPendingAge = maxPendingAge ?? 10000;
        /** @type {Map<string, {emission: object, embedding: number[], timestamp: number}>} */
        this._pendingByChurch = new Map();
    }

    /**
     * Process a new HG emission. Decides translate or drop (DC1: drop current if P1).
     *
     * @param {string} churchId
     * @param {{id: string|number, text: string, timestamp?: number}} emission
     * @returns {Promise<{action: string, emission: object, reason: string,
     *   similarity: number|null, tokenJaccard: number|null,
     *   keptEmission: object|null, logEntry: object}>}
     */
    async process(churchId, emission) {
        if (!emission || !emission.text) {
            const entry = this._buildLogEntry(churchId, 'translate', 'invalid_input', emission, null, null, null);
            this._safeLog(entry);
            return { action: 'translate', emission, reason: 'invalid_input', similarity: null, tokenJaccard: null, keptEmission: null, logEntry: entry };
        }

        const embedding = await this._embedFn(emission.text);
        const pending = this._pendingByChurch.get(churchId);

        if (!pending) {
            this._pendingByChurch.set(churchId, { emission, embedding, timestamp: Date.now() });
            const entry = this._buildLogEntry(churchId, 'translate', 'no_pending', emission, null, null, null);
            this._safeLog(entry);
            return { action: 'translate', emission, reason: 'no_pending', similarity: null, tokenJaccard: null, keptEmission: null, logEntry: entry };
        }

        const sim = cosineSim(pending.embedding, embedding);
        const jaccard = tokenJaccard(pending.emission.text, emission.text);

        if (sim >= this._similarityThreshold && jaccard < this._tokenJaccardMax) {
            // P1 correction detected: drop current (E), keep pending (A)
            const entry = this._buildLogEntry(churchId, 'drop', 'P1_correction_detected', emission, pending.emission, sim, jaccard);
            this._safeLog(entry);
            return { action: 'drop', emission, reason: 'P1_correction_detected', similarity: sim, tokenJaccard: jaccard, keptEmission: pending.emission, logEntry: entry };
        }

        // Different content — translate E, replace pending
        const entry = this._buildLogEntry(churchId, 'translate', 'different_content', emission, pending.emission, sim, jaccard);
        this._safeLog(entry);
        this._pendingByChurch.set(churchId, { emission, embedding, timestamp: Date.now() });
        return { action: 'translate', emission, reason: 'different_content', similarity: sim, tokenJaccard: jaccard, keptEmission: null, logEntry: entry };
    }

    /**
     * Remove stale pending entries older than maxPendingAge.
     */
    cleanup() {
        const now = Date.now();
        for (const [churchId, entry] of this._pendingByChurch) {
            if (now - entry.timestamp > this._maxPendingAge) {
                this._pendingByChurch.delete(churchId);
            }
        }
    }

    /**
     * Reset all state (used by runSequence between calls).
     */
    reset() {
        this._pendingByChurch.clear();
    }

    // ── Internal ────────────────────────────────────────────────────────────

    _buildLogEntry(churchId, action, reason, currentEmission, pendingEmission, similarity, jaccard) {
        return {
            stage: 'hg_dedup',
            churchId,
            action,
            reason,
            similarity: similarity !== null ? Math.round(similarity * 10000) / 10000 : null,
            tokenJaccard: jaccard !== null ? Math.round(jaccard * 10000) / 10000 : null,
            currentEmission: currentEmission ? { id: currentEmission.id, text: (currentEmission.text || '').substring(0, 200), length: (currentEmission.text || '').length } : null,
            pendingEmission: pendingEmission ? { id: pendingEmission.id, text: (pendingEmission.text || '').substring(0, 200), length: (pendingEmission.text || '').length } : null,
        };
    }

    _safeLog(entry) {
        try { this._logFn(entry); } catch { /* telemetry failures don't block pipeline */ }
    }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new HGDedupService instance.
 * @param {object} config - Same as HGDedupService constructor
 * @returns {HGDedupService}
 */
function createHGDedupService(config) {
    return new HGDedupService(config);
}

// ── Offline replay ──────────────────────────────────────────────────────────

/**
 * Process a sequence of emissions offline (batch mode).
 * Creates a fresh, isolated HGDedupService per call — no shared state.
 *
 * @param {Array<{id: string|number, text: string, timestamp?: number, churchId?: string}>} emissions
 * @param {object} [config={}] - Override HGDedupService constructor params
 * @param {function} config.embedFn - Required: async (text) => number[]
 * @param {number} [config.similarityThreshold=0.70]
 * @param {number} [config.tokenJaccardMax=0.50]
 * @param {function} [config.logFn]
 * @returns {Promise<Array<{action: string, emission: object, reason: string,
 *   similarity: number|null, tokenJaccard: number|null, keptEmission: object|null}>>}
 */
async function runSequence(emissions, config = {}) {
    const service = new HGDedupService({
        embedFn: config.embedFn,
        logFn: config.logFn,
        similarityThreshold: config.similarityThreshold,
        tokenJaccardMax: config.tokenJaccardMax,
        maxPendingAge: config.maxPendingAge,
    });

    const results = [];
    for (const emission of emissions) {
        const churchId = emission.churchId || '_default';
        const result = await service.process(churchId, emission);
        results.push({
            action: result.action,
            emission: result.emission,
            reason: result.reason,
            similarity: result.similarity,
            tokenJaccard: result.tokenJaccard,
            keptEmission: result.keptEmission,
        });
    }
    return results;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { HGDedupService, createHGDedupService, runSequence, cosineSim, tokenJaccard };
