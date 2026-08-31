import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_OUTCOMES = 50000;
const MAX_SOURCE_SPANS = 8192;
const COORDINATE_SPACE_ID = /^[0-9a-f]{24}$/;

const boundedString = (value, max = 128) => (
    value == null || value === '' ? null : String(value).slice(0, max)
);

const positiveInt = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const nonNegativeInt = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const listenerSessionIdFrom = (value) => {
    const candidate = boundedString(value, 64);
    return candidate && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(candidate)
        ? candidate
        : null;
};

const sourceSpansFrom = (value) => {
    if (!Array.isArray(value) || value.length > MAX_SOURCE_SPANS) return null;
    const spans = value.map((span) => ({
        coordinateSpaceId: boundedString(
            span?.coordinateSpaceId ?? span?.logicalChunkId ?? span?.logical_chunk_id, 64,
        ),
        startSample: nonNegativeInt(span?.startSample ?? span?.start_sample),
        endSample: nonNegativeInt(span?.endSample ?? span?.end_sample),
    }));
    if (spans.some((span) => (
        !COORDINATE_SPACE_ID.test(span.coordinateSpaceId || '')
        || span.startSample === null
        || span.endSample === null
        || span.endSample <= span.startSample
    ))) return null;
    return spans;
};

const chunkIdentity = (chunk = {}) => ({
    sessionEpoch: boundedString(chunk.session_epoch ?? chunk.sessionEpoch, 64),
    releaseSeq: nonNegativeInt(chunk.release_seq ?? chunk.releaseSeq),
    language: boundedString(chunk.language ?? chunk.lang, 8) || 'unknown',
    deliveryUnitId: boundedString(chunk.delivery_unit_id ?? chunk.deliveryUnitId, 64),
    sentenceIndex: nonNegativeInt(chunk.sentence_index ?? chunk.sentenceIndex) ?? 0,
});

const canonicalChunkKey = (chunk = {}) => {
    const identity = chunkIdentity(chunk);
    if (!identity.sessionEpoch || identity.releaseSeq === null) return null;
    const delivery = identity.deliveryUnitId ? `:${identity.deliveryUnitId}` : '';
    return `${identity.sessionEpoch}:${identity.releaseSeq}:${identity.language}${delivery}:${identity.sentenceIndex}`;
};

const entryKey = (churchId, listenerSessionId, chunkKey) => (
    `${churchId}|${listenerSessionId}|${chunkKey}`
);

const mergeRanges = (ranges) => {
    const grouped = new Map();
    for (const range of ranges) {
        if (!grouped.has(range.coordinateSpaceId)) grouped.set(range.coordinateSpaceId, []);
        grouped.get(range.coordinateSpaceId).push(range);
    }
    const merged = [];
    for (const [coordinateSpaceId, items] of grouped) {
        items.sort((left, right) => left.startSample - right.startSample);
        for (const item of items) {
            const previous = merged.at(-1);
            if (previous?.coordinateSpaceId === coordinateSpaceId
                && item.startSample <= previous.endSample) {
                previous.endSample = Math.max(previous.endSample, item.endSample);
            } else {
                merged.push({ ...item });
            }
        }
    }
    return merged;
};

const broadcastFingerprint = (chunk, identity, sourceSpans, sourceMapDigest) => digest({
    protocol: 2,
    ...identity,
    gender: boundedString(chunk.gender, 16),
    revisionFamilyId: boundedString(chunk.revision_family_id ?? chunk.revisionFamilyId, 64),
    revisionGeneration: positiveInt(chunk.revision_generation ?? chunk.revisionGeneration),
    totalSentences: positiveInt(chunk.total_sentences ?? chunk.totalSentences),
    sourceLineageStatus: boundedString(
        chunk.source_lineage_status ?? chunk.sourceLineageStatus, 16,
    ),
    sourceMapDigest,
    emittedSourceHash: boundedString(chunk.emitted_source_hash ?? chunk.emittedSourceHash, 128),
    translatedChunkHash: boundedString(
        chunk.translated_chunk_hash ?? chunk.translatedChunkHash, 128,
    ),
    synthesized: chunk.synthesized === true,
    sourceSpans,
});

const outcomeFingerprint = (event) => digest({
    chunkKey: boundedString(event?.chunk_key, 256),
    sessionEpoch: boundedString(event?.session_epoch, 64),
    listenerSessionId: boundedString(event?.listener_session_id, 64),
    outcome: boundedString(event?.outcome, 32),
    occurredAtMs: nonNegativeInt(event?.occurred_at_ms),
    reason: boundedString(event?.reason, 64),
});

export class ListenerPlayoutLedger {
    constructor({
        ttlMs = DEFAULT_TTL_MS,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxOutcomeIds = DEFAULT_MAX_OUTCOMES,
        now = () => Date.now(),
    } = {}) {
        this.ttlMs = Math.max(60000, Number(ttlMs) || DEFAULT_TTL_MS);
        this.maxEntries = Math.max(100, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
        this.maxOutcomeIds = Math.max(100, Number(maxOutcomeIds) || DEFAULT_MAX_OUTCOMES);
        this.now = now;
        this.entries = new Map();
        this.outcomeIds = new Map();
        this.anomalies = [];
        this.version = 0;
        this.nextCleanupAt = 0;
    }

    recordBroadcast({ churchId, listenerSessionId, chunk, sourceSpans = [] }) {
        const safeChurch = boundedString(churchId, 64);
        const safeListener = listenerSessionIdFrom(listenerSessionId);
        const chunkKey = canonicalChunkKey(chunk);
        const identity = chunkIdentity(chunk);
        const safeSpans = sourceSpansFrom(sourceSpans);
        if (!safeChurch || !safeListener || !chunkKey || safeSpans === null) {
            return { accepted: false, reason: 'invalid_broadcast' };
        }

        this.cleanup();
        const key = entryKey(safeChurch, safeListener, chunkKey);
        const previous = this.entries.get(key);
        const sourceMapDigest = boundedString(
            chunk.source_map_digest ?? chunk.sourceMapDigest, 128,
        ) || digest({
            status: chunk.source_lineage_status ?? chunk.sourceLineageStatus ?? null,
            sourceSpans: safeSpans,
        });
        const fingerprint = broadcastFingerprint(chunk, identity, safeSpans, sourceMapDigest);
        if (previous) {
            if (previous.broadcastFingerprint === fingerprint) {
                return { accepted: true, duplicate: true, entry: { ...previous } };
            }
            previous.conflicted = true;
            previous.updatedAt = this.now();
            this._anomaly('broadcast_fingerprint_conflict', previous);
            this.version += 1;
            return { accepted: false, reason: 'broadcast_fingerprint_conflict' };
        }

        const now = this.now();
        const entry = {
            churchId: safeChurch,
            listenerSessionId: safeListener,
            chunkKey,
            ...identity,
            revisionFamilyId: boundedString(
                chunk.revision_family_id ?? chunk.revisionFamilyId, 64,
            ),
            revisionGeneration: positiveInt(
                chunk.revision_generation ?? chunk.revisionGeneration,
            ),
            totalSentences: positiveInt(chunk.total_sentences ?? chunk.totalSentences),
            isLast: (chunk.is_last ?? chunk.isLast) === true,
            sourceLineageStatus: boundedString(
                chunk.source_lineage_status ?? chunk.sourceLineageStatus, 16,
            ),
            sourceMapDigest,
            sourceSpans: safeSpans,
            broadcastFingerprint: fingerprint,
            synthesized: chunk.synthesized === true,
            broadcast: true,
            started: false,
            startedAt: null,
            completed: false,
            dropped: false,
            dropReason: null,
            conflicted: false,
            createdAt: now,
            updatedAt: now,
        };
        this.entries.set(key, entry);
        this.version += 1;
        this._capEntries();
        return { accepted: true, duplicate: false, entry: { ...entry } };
    }

    observeOutcome({ churchId, listenerSessionId, event }) {
        const safeChurch = boundedString(churchId, 64);
        const safeListener = listenerSessionIdFrom(listenerSessionId);
        const outcomeId = boundedString(event?.outcome_id, 128);
        const chunkKey = boundedString(event?.chunk_key, 256);
        if (!safeChurch || !safeListener || !outcomeId || !chunkKey) {
            return { accepted: false, retryable: false, reason: 'invalid_identity' };
        }
        if (event.listener_session_id !== safeListener) {
            return { accepted: false, retryable: false, reason: 'listener_identity_mismatch' };
        }

        this.cleanup();
        const eventFingerprint = outcomeFingerprint(event);
        const previousOutcome = this.outcomeIds.get(outcomeId);
        if (previousOutcome) {
            if (previousOutcome.fingerprint !== eventFingerprint) {
                return { accepted: false, retryable: false, reason: 'outcome_id_conflict' };
            }
            return { accepted: true, duplicate: true };
        }

        const key = entryKey(safeChurch, safeListener, chunkKey);
        const entry = this.entries.get(key);
        if (!entry) {
            return { accepted: false, retryable: true, reason: 'broadcast_not_observed' };
        }
        if (event.session_epoch !== entry.sessionEpoch) {
            return { accepted: false, retryable: false, reason: 'epoch_mismatch' };
        }
        if (entry.conflicted) {
            return { accepted: false, retryable: false, reason: 'broadcast_conflicted' };
        }

        const transition = this._applyOutcome(entry, event);
        if (!transition.accepted) return transition;

        const now = this.now();
        entry.updatedAt = now;
        this.outcomeIds.set(outcomeId, { observedAt: now, fingerprint: eventFingerprint });
        this.version += 1;
        this._capOutcomes();
        return {
            accepted: true,
            duplicate: false,
            committed: this._releaseCommitted(entry),
        };
    }

    committedSourceProofs({
        churchId,
        listenerSessionId,
        sessionEpoch,
        language,
        beforeReleaseSeq = Number.MAX_SAFE_INTEGER,
    }) {
        const safeChurch = boundedString(churchId, 64);
        const safeListener = listenerSessionIdFrom(listenerSessionId);
        const safeEpoch = boundedString(sessionEpoch, 64);
        const safeLanguage = boundedString(language, 8);
        const releaseLimit = nonNegativeInt(beforeReleaseSeq);
        if (!safeChurch || !safeListener || !safeEpoch || !safeLanguage
            || releaseLimit === null) return { ledgerVersion: this.version, proofs: [] };

        this.cleanup();
        const releases = new Map();
        for (const entry of this.entries.values()) {
            if (entry.churchId !== safeChurch
                || entry.listenerSessionId !== safeListener
                || entry.sessionEpoch !== safeEpoch
                || entry.language !== safeLanguage
                || entry.releaseSeq >= releaseLimit) continue;
            const releaseKey = `${entry.releaseSeq}:${entry.deliveryUnitId || 'legacy'}`;
            if (!releases.has(releaseKey)) releases.set(releaseKey, []);
            releases.get(releaseKey).push(entry);
        }

        const proofs = [];
        for (const entries of releases.values()) {
            if (!this._releaseCommitted(entries[0], entries)) continue;
            proofs.push(Object.freeze({
                proofVersion: 2,
                churchId: safeChurch,
                listenerSessionId: safeListener,
                sessionEpoch: safeEpoch,
                language: safeLanguage,
                releaseSeq: entries[0].releaseSeq,
                deliveryUnitId: entries[0].deliveryUnitId,
                revisionFamilyId: entries[0].revisionFamilyId,
                revisionGeneration: entries[0].revisionGeneration,
                sourceMapStatus: entries[0].sourceLineageStatus,
                sourceMapDigest: entries[0].sourceMapDigest,
                totalSentences: entries[0].totalSentences,
                startedSentenceIndexes: Object.freeze(entries
                    .map((candidate) => candidate.sentenceIndex).sort((left, right) => left - right)),
                committedAt: Math.max(...entries.map((candidate) => candidate.startedAt || 0)),
                ranges: Object.freeze(mergeRanges(entries[0].sourceSpans)
                    .map((range) => Object.freeze(range))),
            }));
        }
        proofs.sort((left, right) => left.committedAt - right.committedAt
            || left.releaseSeq - right.releaseSeq);
        return { ledgerVersion: this.version, proofs: Object.freeze(proofs) };
    }

    committedSourceRanges(args) {
        const snapshot = this.committedSourceProofs(args);
        return mergeRanges(snapshot.proofs.flatMap((proof) => proof.ranges));
    }

    committedPrefixWordCount({ sourceLineage, ...scope }) {
        if (sourceLineage?.status !== 'complete'
            || !Array.isArray(sourceLineage.wordSpans)
            || sourceLineage.wordSpans.length !== sourceLineage.wordCount) return 0;
        const committed = this.committedSourceRanges(scope);
        let count = 0;
        for (const span of sourceLineage.wordSpans) {
            const coordinateSpaceId = span.coordinateSpaceId ?? span.logicalChunkId;
            const covered = committed.some((range) => (
                range.coordinateSpaceId === coordinateSpaceId
                && range.startSample <= span.startSample
                && range.endSample >= span.endSample
            ));
            if (!covered) break;
            count += 1;
        }
        return count;
    }

    cleanup() {
        const now = this.now();
        if (now < this.nextCleanupAt) return;
        this.nextCleanupAt = now + Math.min(60000, Math.max(1000, Math.floor(this.ttlMs / 10)));
        const threshold = now - this.ttlMs;
        let changed = false;
        for (const [key, entry] of this.entries) {
            if (entry.updatedAt < threshold) {
                this.entries.delete(key);
                changed = true;
            }
        }
        for (const [outcomeId, observed] of this.outcomeIds) {
            if (observed.observedAt < threshold) {
                this.outcomeIds.delete(outcomeId);
                changed = true;
            }
        }
        if (changed) this.version += 1;
    }

    snapshot() {
        return {
            version: this.version,
            entries: this.entries.size,
            outcomeIds: this.outcomeIds.size,
            anomalies: this.anomalies.slice(-20),
        };
    }

    _applyOutcome(entry, event) {
        const outcome = String(event.outcome || '');
        if (outcome === 'play_started') {
            if (entry.dropped && !entry.started) {
                return { accepted: false, retryable: false, reason: 'start_after_terminal_drop' };
            }
            entry.started = true;
            // The listener clock is telemetry, not a proof authority. Server observation
            // order cannot be forged into an earlier committed prefix by the payload.
            entry.startedAt ||= this.now();
            return { accepted: true };
        }
        if (outcome === 'play_completed') {
            if (!entry.started) {
                this._anomaly('completed_without_start', entry);
                return { accepted: false, retryable: false, reason: 'completed_without_start' };
            }
            entry.completed = true;
            return { accepted: true };
        }
        if (['explicit_drop', 'superseded', 'null_audio', 'playback_error'].includes(outcome)) {
            entry.dropped = true;
            entry.dropReason = boundedString(event.reason || outcome, 64);
            return { accepted: true };
        }
        if (outcome === 'chunk_received' || outcome === 'supersession_shadow') {
            return { accepted: true };
        }
        return { accepted: false, retryable: false, reason: 'unsupported_outcome' };
    }

    _releaseCommitted(entry, knownEntries = null) {
        const siblings = knownEntries || [...this.entries.values()].filter((candidate) => (
            candidate.churchId === entry.churchId
            && candidate.listenerSessionId === entry.listenerSessionId
            && candidate.sessionEpoch === entry.sessionEpoch
            && candidate.releaseSeq === entry.releaseSeq
            && candidate.language === entry.language
            && candidate.deliveryUnitId === entry.deliveryUnitId
        ));
        if (siblings.length === 0 || siblings.some((candidate) => candidate.conflicted)) return false;
        const totals = new Set(siblings.map((candidate) => candidate.totalSentences));
        const mapDigests = new Set(siblings.map((candidate) => candidate.sourceMapDigest));
        const lineageStatuses = new Set(siblings.map((candidate) => candidate.sourceLineageStatus));
        const sourceSpanDigests = new Set(siblings.map((candidate) => digest(candidate.sourceSpans)));
        const total = siblings[0].totalSentences;
        if (!total || totals.size !== 1 || mapDigests.size !== 1
            || lineageStatuses.size !== 1 || sourceSpanDigests.size !== 1
            || !['complete', 'partial'].includes(siblings[0].sourceLineageStatus)
            || siblings[0].sourceSpans.length === 0
            || siblings.some((candidate) => !candidate.synthesized || !candidate.broadcast)) return false;
        const started = new Set(
            siblings.filter((candidate) => candidate.started).map((candidate) => candidate.sentenceIndex),
        );
        return Array.from({ length: total }, (_, index) => index)
            .every((index) => started.has(index));
    }

    _anomaly(type, entry) {
        this.anomalies.push({ type, chunkKey: entry.chunkKey, at: this.now() });
        if (this.anomalies.length > 200) this.anomalies.shift();
    }

    _capEntries() {
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    _capOutcomes() {
        while (this.outcomeIds.size > this.maxOutcomeIds) {
            this.outcomeIds.delete(this.outcomeIds.keys().next().value);
        }
    }
}
