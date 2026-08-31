(function attachListenerDelivery(root) {
    const STORAGE_KEY = 'barnaba_listener_delivery_v1';

    const finiteInt = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    };

    const canonicalChunkKey = (chunk = {}) => {
        const epoch = String(chunk.session_epoch || chunk.sessionEpoch || 'legacy');
        const release = finiteInt(chunk.release_seq ?? chunk.releaseKey ?? chunk.emissionId, 0);
        const lang = String(chunk.language || chunk.lang || 'unknown');
        const deliveryUnitId = chunk.delivery_unit_id ?? chunk.deliveryUnitId;
        const delivery = deliveryUnitId ? `:${String(deliveryUnitId).slice(0, 64)}` : '';
        const sentence = finiteInt(chunk.sentence_index ?? chunk.sentenceIndex, 0);
        return `${epoch}:${release}:${lang}${delivery}:${sentence}`;
    };

    const sessionEpochOf = (chunk = {}) => String(chunk.session_epoch || chunk.sessionEpoch || 'legacy');

    const compareChunks = (left = {}, right = {}) => {
        const leftEpoch = sessionEpochOf(left);
        const rightEpoch = sessionEpochOf(right);
        // UUID epochs identify a stream; they are not a chronological order.
        if (leftEpoch !== rightEpoch) return 0;
        const leftRelease = finiteInt(left.release_seq ?? left.releaseKey ?? left.emissionId, 0);
        const rightRelease = finiteInt(right.release_seq ?? right.releaseKey ?? right.emissionId, 0);
        if (leftRelease !== rightRelease) return leftRelease - rightRelease;
        return finiteInt(left.sentence_index ?? left.sentenceIndex, 0)
            - finiteInt(right.sentence_index ?? right.sentenceIndex, 0);
    };

    const orderedPendingKeys = (pending, { sessionEpoch } = {}) => {
        const requestedEpoch = sessionEpoch == null ? null : String(sessionEpoch);
        const entries = Array.from(pending.entries()).filter(([, chunk]) => (
            requestedEpoch === null || sessionEpochOf(chunk) === requestedEpoch
        ));
        const epochs = new Set(entries.map(([, chunk]) => sessionEpochOf(chunk)));
        if (requestedEpoch === null && epochs.size > 1) {
            throw new Error('Cannot order pending chunks from multiple session epochs');
        }
        return entries
            .sort(([, left], [, right]) => compareChunks(left, right))
            .map(([key]) => key);
    };

    const selectNextPendingKey = (pending, options) => orderedPendingKeys(pending, options)[0] || null;

    const revisionFamilyOf = (chunk = {}) => {
        const value = chunk.revision_family_id ?? chunk.revisionFamilyId;
        return value == null || value === '' ? null : String(value);
    };

    const revisionGenerationOf = (chunk = {}) => {
        const value = finiteInt(chunk.revision_generation ?? chunk.revisionGeneration, 0);
        return value > 0 ? value : null;
    };

    const revisionApplyEligibleOf = (chunk = {}) => {
        const value = chunk.revision_apply_eligible ?? chunk.revisionApplyEligible;
        return typeof value === 'boolean' ? value : null;
    };

    const revisionT2V2EligibleOf = (chunk = {}) => {
        const value = chunk.t2_supersede_pending_v2_eligible ?? chunk.t2SupersedePendingV2Eligible;
        return typeof value === 'boolean' ? value : null;
    };

    const revisionSupersedesGenerationsV2Of = (chunk = {}) => {
        const value = chunk.revision_supersedes_generations_v2 ?? chunk.supersedesGenerationsV2;
        if (!Array.isArray(value) || value.length > 64
            || value.some((item, index) => (
                !Number.isSafeInteger(item) || item <= 0
                || (index > 0 && item <= value[index - 1])
            ))) return null;
        return value;
    };

    const strictIdentity = (value, maxLength) => (
        typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
    );

    const revisionGenerationV2Of = (chunk = {}) => {
        const value = chunk.revision_generation ?? chunk.revisionGeneration;
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    };

    const isRevisionSupersessionV2ShadowEligible = (candidate = {}, incoming = {}) => {
        const candidateGeneration = revisionGenerationV2Of(candidate);
        const incomingGeneration = revisionGenerationV2Of(incoming);
        const candidateEpoch = strictIdentity(candidate.session_epoch ?? candidate.sessionEpoch, 64);
        const incomingEpoch = strictIdentity(incoming.session_epoch ?? incoming.sessionEpoch, 64);
        const candidateFamily = strictIdentity(
            candidate.revision_family_id ?? candidate.revisionFamilyId, 64,
        );
        const incomingFamily = strictIdentity(
            incoming.revision_family_id ?? incoming.revisionFamilyId, 64,
        );
        const candidateLanguage = strictIdentity(candidate.language ?? candidate.lang, 8);
        const incomingLanguage = strictIdentity(incoming.language ?? incoming.lang, 8);
        const supersededGenerations = revisionSupersedesGenerationsV2Of(incoming);
        return candidateGeneration !== null
            && incomingGeneration !== null
            && candidateGeneration < incomingGeneration
            && candidateEpoch !== null
            && candidateEpoch !== 'legacy'
            && candidateEpoch === incomingEpoch
            && candidateFamily !== null
            && candidateFamily === incomingFamily
            && candidateLanguage !== null
            && candidateLanguage === incomingLanguage
            && candidate.source_map_v2_status === 'complete'
            && incoming.source_map_v2_status === 'complete'
            && revisionT2V2EligibleOf(incoming) === true
            && supersededGenerations !== null
            && supersededGenerations.includes(candidateGeneration);
    };

    const isRevisionSupersessionApplyEligible = (candidate = {}, incoming = {}) => (
        revisionApplyEligibleOf(candidate) === true
        && revisionApplyEligibleOf(incoming) === true
    );

    const selectRevisionSupersessionCandidates = (pending, incoming = {}) => {
        const incomingEpoch = sessionEpochOf(incoming);
        const incomingFamily = revisionFamilyOf(incoming);
        const incomingGeneration = revisionGenerationOf(incoming);
        const incomingLanguage = String(incoming.language || incoming.lang || 'unknown');
        if (incomingEpoch === 'legacy' || !incomingFamily || incomingGeneration === null) return [];

        return Array.from(pending.entries())
            .filter(([, candidate]) => (
                sessionEpochOf(candidate) === incomingEpoch
                && revisionFamilyOf(candidate) === incomingFamily
                && String(candidate.language || candidate.lang || 'unknown') === incomingLanguage
                && revisionGenerationOf(candidate) !== null
                && revisionGenerationOf(candidate) < incomingGeneration
            ))
            .sort(([, left], [, right]) => compareChunks(left, right))
            .map(([key, chunk]) => ({ key, chunk }));
    };

    const selectBudgetDrops = ({
        pending,
        sessionEpoch,
        now = Date.now(),
        maxAgeMs,
        maxBacklogMs,
        estimatedChunkDurationMs,
    }) => {
        const ordered = orderedPendingKeys(pending, { sessionEpoch });
        const drops = [];
        const dropped = new Set();
        const ageBudget = Math.max(1000, Number(maxAgeMs) || 10000);
        const backlogBudget = Math.max(1000, Number(maxBacklogMs) || 15000);
        const chunkDuration = Math.max(500, Number(estimatedChunkDurationMs) || 4000);

        for (const key of ordered) {
            const chunk = pending.get(key);
            const age = chunk?.receivedAt ? Math.max(0, now - chunk.receivedAt) : 0;
            if (age > ageBudget) {
                drops.push({ key, reason: 'age_budget' });
                dropped.add(key);
            }
        }

        let retainedCount = pending.size - dropped.size;
        for (const key of ordered) {
            if (retainedCount * chunkDuration <= backlogBudget) break;
            if (dropped.has(key)) continue;
            drops.push({ key, reason: 'backlog_budget' });
            dropped.add(key);
            retainedCount--;
        }
        return drops;
    };

    class DeliveryLedger {
        constructor({ listenerSessionId, storage = root.localStorage, storageKey = STORAGE_KEY } = {}) {
            this.listenerSessionId = String(listenerSessionId || `listener-${Date.now()}`);
            this.storage = storage || null;
            this.storageKey = `${storageKey}:${this.listenerSessionId}`;
            this.sequence = 0;
            this.events = this._restore();
            this.sequence = this.events.reduce((maximum, event) => (
                Math.max(maximum, finiteInt(event?.sequence, 0))
            ), 0);
        }

        _restore() {
            if (!this.storage) return [];
            try {
                const parsed = JSON.parse(this.storage.getItem(this.storageKey) || '[]');
                return Array.isArray(parsed) ? parsed
                    .filter((event) => event?.listener_session_id === this.listenerSessionId)
                    .slice(-2000) : [];
            } catch {
                return [];
            }
        }

        _persist() {
            if (!this.storage) return;
            try {
                this.storage.setItem(this.storageKey, JSON.stringify(this.events.slice(-2000)));
            } catch {
                // Telemetry must never interrupt playback.
            }
        }

        record(chunk, outcome, extra = {}) {
            const sequence = ++this.sequence;
            const event = {
                outcome_id: `${this.listenerSessionId}:${sequence}`,
                listener_session_id: this.listenerSessionId,
                sequence,
                occurred_at_ms: Date.now(),
                chunk_key: canonicalChunkKey(chunk),
                session_epoch: chunk?.session_epoch ?? chunk?.sessionEpoch ?? null,
                release_seq: chunk?.release_seq ?? chunk?.releaseKey ?? null,
                language: chunk?.language || chunk?.lang || 'unknown',
                sentence_index: finiteInt(chunk?.sentence_index ?? chunk?.sentenceIndex, 0),
                emitted_source_hash: chunk?.emitted_source_hash ?? chunk?.emittedSourceHash ?? null,
                chunk_word_count: finiteInt(chunk?.chunk_word_count ?? chunk?.chunkWordCount, 0),
                delivery_unit_id: chunk?.delivery_unit_id ?? chunk?.deliveryUnitId ?? null,
                source_map_digest: chunk?.source_map_digest ?? chunk?.sourceMapDigest ?? null,
                ...(chunk?.source_lineage_status
                    ? { source_lineage_status: String(chunk.source_lineage_status) }
                    : {}),
                ...(chunk?.source_map_v2_status
                    ? { source_map_v2_status: String(chunk.source_map_v2_status) }
                    : {}),
                ...(revisionFamilyOf(chunk)
                    ? { revision_family_id: revisionFamilyOf(chunk) }
                    : {}),
                ...(revisionGenerationOf(chunk) !== null
                    ? { revision_generation: revisionGenerationOf(chunk) }
                    : {}),
                ...(chunk?.revision_ticket_id
                    ? { revision_ticket_id: String(chunk.revision_ticket_id) }
                    : {}),
                ...(chunk?.revision_evidence
                    ? { revision_evidence: String(chunk.revision_evidence) }
                    : {}),
                ...(revisionApplyEligibleOf(chunk) !== null
                    ? { revision_apply_eligible: revisionApplyEligibleOf(chunk) }
                    : {}),
                ...(revisionT2V2EligibleOf(chunk) !== null
                    ? { t2_supersede_pending_v2_eligible: revisionT2V2EligibleOf(chunk) }
                    : {}),
                outcome: String(outcome),
                ...extra,
            };
            this.events.push(event);
            if (this.events.length > 2000) this.events.shift();
            this._persist();
            return event;
        }

        peekBatch(limit = 100) {
            return this.events.slice(0, Math.max(1, finiteInt(limit, 100)));
        }

        acknowledge(outcomeIds = []) {
            const acknowledged = new Set(outcomeIds.map(String));
            if (acknowledged.size === 0) return;
            this.events = this.events.filter((event) => !acknowledged.has(event.outcome_id));
            this._persist();
        }
    }

    class UrgentOutcomeFlusher {
        constructor({
            peekPending,
            flush,
            schedule = (callback, delayMs) => root.setTimeout(callback, delayMs),
            retryMs = 500,
        } = {}) {
            this.peekPending = peekPending;
            this.flush = flush;
            this.schedule = schedule;
            this.retryMs = Math.max(100, finiteInt(retryMs, 500));
            this.timerId = null;
        }

        notify(outcome) {
            if (!this._isUrgent(outcome)) return;
            this._schedule(0);
        }

        _isUrgent(outcome) {
            return ['play_started', 'play_completed', 'explicit_drop', 'superseded',
                'null_audio', 'playback_error'].includes(outcome);
        }

        _hasPendingLifecycleOutcome() {
            const pending = typeof this.peekPending === 'function' ? this.peekPending() : [];
            return Array.isArray(pending) && pending.some((event) => this._isUrgent(event?.outcome));
        }

        _schedule(delayMs) {
            if (this.timerId !== null || typeof this.flush !== 'function') return;
            this.timerId = this.schedule(async () => {
                this.timerId = null;
                try {
                    await this.flush();
                } catch {
                    // The persisted ledger remains authoritative; retry below.
                }
                if (this._hasPendingLifecycleOutcome()) this._schedule(this.retryMs);
            }, delayMs);
        }
    }

    root.BarnabaListenerDelivery = Object.freeze({
        canonicalChunkKey,
        compareChunks,
        selectNextPendingKey,
        selectRevisionSupersessionCandidates,
        isRevisionSupersessionApplyEligible,
        isRevisionSupersessionV2ShadowEligible,
        selectBudgetDrops,
        DeliveryLedger,
        UrgentOutcomeFlusher,
    });
})(typeof window !== 'undefined' ? window : globalThis);
