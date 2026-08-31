import { composeSourceLineages } from './sourceLineage.js';
import { composeRevisionAdmissionTickets } from './revisionAdmissionEvidence.js';

// ============================================================
// R1.4: Translation Queue — decouples Whisper from GPT
// PCM handler enqueues items; GPT worker processes them FIFO.
// JS single-threaded = natural mutex, no race conditions.
// Extracted from server.js (29.05.2026) so the merge logic is unit-testable.
// ============================================================

class TranslationQueue {
    constructor(maxDepth = 8) {
        this.maxDepth = maxDepth;
        this._queue = [];
        this._resolve = null; // resolve callback for dequeue() Promise
        this._drainResolve = null;
        this._stopped = false;
        this._inFlight = 0; // P-B: items dequeued by the worker but not yet fully processed
        this.stats = { enqueued: 0, processed: 0, merged: 0, dropped: 0, maxObservedDepth: 0 };
    }

    enqueue(item) {
        if (this._stopped) return false;

        // If queue is full, merge oldest two items (concatenate text)
        if (this._queue.length >= this.maxDepth) {
            const oldest = this._queue.shift();
            const second = this._queue[0];
            if (second) {
                second.text = oldest.text + ' ' + second.text;
                second.latencyTxId = oldest.latencyTxId; // keep oldest txId for e2e tracking
                // Fix #3 (29.05.2026): carry the oldest chunk's context forward.
                // The merged text now starts with the oldest content, so the relevant
                // "immediately preceding" source context is the oldest item's, not the
                // newer one's. Previously both were silently dropped → merged chunk lost
                // its local context (terminology drift on rare queue-full merges).
                second.sourceContext = oldest.sourceContext ?? second.sourceContext;
                second.sermonContext = oldest.sermonContext ?? second.sermonContext;
                second.dedupHistoryCandidates = [
                    ...(oldest.dedupHistoryCandidates || []),
                    ...(second.dedupHistoryCandidates || []),
                ];
                second.sourceLineage = composeSourceLineages([
                    oldest.sourceLineage,
                    second.sourceLineage,
                ], { reason: 'translation_queue_merge_incomplete_lineage' });
                second.revisionTicket = composeRevisionAdmissionTickets([
                    oldest.revisionTicket,
                    second.revisionTicket,
                ], 'translation_queue_capacity_merge');
                if (second.releaseMeta && second.revisionTicket) {
                    second.releaseMeta = { ...second.releaseMeta, revisionTicket: second.revisionTicket };
                }
                this.stats.merged++;
                console.log(`[TranslationQueue] Merged items (depth=${this._queue.length}, merged_total=${this.stats.merged})`);
            }
        }

        this._queue.push(item);
        this.stats.enqueued++;
        if (this._queue.length > this.stats.maxObservedDepth) {
            this.stats.maxObservedDepth = this._queue.length;
        }

        // Wake up dequeue() if it's waiting
        if (this._resolve) {
            const resolve = this._resolve;
            this._resolve = null;
            resolve();
        }
        return true;
    }

    async dequeue() {
        while (this._queue.length === 0 && !this._stopped) {
            await new Promise(r => { this._resolve = r; });
        }
        if (this._stopped && this._queue.length === 0) return null;
        const item = this._queue.shift();
        if (item) this._inFlight++; // P-B: track in-flight so drain() waits for the worker to finish
        return item;
    }

    get depth() { return this._queue.length; }

    mergeIntoNext(item) {
        const next = this._queue[0];
        if (!next) return false;

        next.text = item.text + ' ' + next.text;
        next.latencyTxId = item.latencyTxId ?? next.latencyTxId;
        next.sourceContext = item.sourceContext ?? next.sourceContext;
        next.sermonContext = item.sermonContext ?? next.sermonContext;
        next.dedupHistoryCandidates = [
            ...(item.dedupHistoryCandidates || []),
            ...(next.dedupHistoryCandidates || []),
        ];
        next.sourceLineage = composeSourceLineages([
            item.sourceLineage,
            next.sourceLineage,
        ], { reason: 'translation_queue_controller_merge_incomplete_lineage' });
        next.revisionTicket = composeRevisionAdmissionTickets([
            item.revisionTicket,
            next.revisionTicket,
        ], 'translation_queue_controller_merge');
        if (next.releaseMeta && next.revisionTicket) {
            next.releaseMeta = { ...next.releaseMeta, revisionTicket: next.revisionTicket };
        }
        next.createdAt = Math.min(item.createdAt || Date.now(), next.createdAt || Date.now());
        this.stats.merged++;
        this._checkDrain();
        return true;
    }

    drop(item = null) {
        this.stats.dropped++;
        if (item) this._checkDrain();
    }

    stop() {
        this._stopped = true;
        if (this._resolve) {
            this._resolve();
            this._resolve = null;
        }
        if (this._drainResolve) {
            this._drainResolve();
            this._drainResolve = null;
        }
    }

    async drain() {
        // P-B fix #5: wait for BOTH queued items AND the in-flight worker item.
        // depth===0 alone is too weak — the worker may have dequeued the last item and
        // still be inside translateAndBroadcast (translate/TTS) when depth hits 0.
        if (this._queue.length === 0 && this._inFlight === 0) return;
        return new Promise(r => { this._drainResolve = r; });
    }

    // P-B: called by the worker after each item is fully processed (drop/merge/emit/error).
    taskDone() {
        if (this._inFlight > 0) this._inFlight--;
        this._checkDrain();
    }

    get inFlight() { return this._inFlight; }

    _checkDrain() {
        if (this._drainResolve && this._queue.length === 0 && this._inFlight === 0) {
            this._drainResolve();
            this._drainResolve = null;
        }
    }
}

export { TranslationQueue };
