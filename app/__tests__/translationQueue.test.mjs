/**
 * Unit tests for TranslationQueue, incl. fix #3 — merge carries context forward.
 *
 * Bug ("TRANSLATION CONTEXT BUGS", issue #3):
 * When the queue is full, enqueue() merges the oldest two items but only concatenates
 * `text` and copies `latencyTxId`. The oldest chunk's `sourceContext`/`sermonContext`
 * were silently dropped → merged chunk translated without its local context.
 *
 * Fix: merged item inherits the OLDEST item's sourceContext/sermonContext (it now leads
 * the merged text).
 */

import { describe, it, expect } from 'vitest';
import { TranslationQueue } from '../translationQueue.js';
import { sourceLineageFromWhisper } from '../sourceLineage.js';

function makeLineage(i) {
    return sourceLineageFromWhisper(`t${i}`, {
        whisperSessionId: '7f8164eb-960d-4cfe-982b-3738d87cf0b9',
        decodeId: `d${i}`,
        inputPcmSha256: String(i).repeat(64),
        inputStartSample: i * 10,
        inputEndSample: i * 10 + 10,
        provenanceStatus: 'complete',
        alignmentStatus: 'exact',
        confirmedWordSpans: [{ text: `t${i}`, start_sample: i * 10, end_sample: i * 10 + 5 }],
    });
}

function makeItem(i, extra = {}) {
    return {
        churchId: 'c1',
        text: `t${i}`,
        languages: ['pl', 'en'],
        latencyTxId: `tx${i}`,
        sourceContext: `src${i}`,
        sermonContext: `serm${i}`,
        createdAt: 1000 + i,
        dedupHistoryCandidates: [{
            p2Text: `p2-${i}`,
            b4Text: `b4-${i}`,
            releaseMeta: { sessionEpoch: 'epoch', releaseSeq: i },
        }],
        sourceLineage: makeLineage(i),
        revisionTicket: Object.freeze({
            version: 1,
            kind: 'single',
            ticketId: `ticket-${i}`,
            familyId: `family-${i}`,
            generation: 1,
            sessionEpoch: 'epoch',
            componentCount: 1,
        }),
        releaseMeta: { sessionEpoch: 'epoch', releaseSeq: i },
        ...extra,
    };
}

describe('TranslationQueue basics', () => {
    it('FIFO without merge below maxDepth', () => {
        const q = new TranslationQueue(8);
        q.enqueue(makeItem(1));
        q.enqueue(makeItem(2));
        expect(q.depth).toBe(2);
        expect(q.stats.merged).toBe(0);
    });

    it('tracks maxObservedDepth and enqueued count', () => {
        const q = new TranslationQueue(8);
        for (let i = 0; i < 5; i++) q.enqueue(makeItem(i));
        expect(q.stats.enqueued).toBe(5);
        expect(q.stats.maxObservedDepth).toBe(5);
    });

    it('reports whether the item was accepted without changing queue behavior', () => {
        const q = new TranslationQueue(8);
        expect(q.enqueue(makeItem(1))).toBe(true);
        q.stop();
        expect(q.enqueue(makeItem(2))).toBe(false);
        expect(q.depth).toBe(1);
        expect(q.stats.enqueued).toBe(1);
    });
});

describe('TranslationQueue merge on full (fix #3)', () => {
    it('concatenates text and keeps oldest latencyTxId', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1)); // [1]
        q.enqueue(makeItem(2)); // [1,2]
        q.enqueue(makeItem(3)); // full → merge oldest(1) into second(2), then push 3
        expect(q.stats.merged).toBe(1);
        const merged = q._queue[0];
        expect(merged.text).toBe('t1 t2');
        expect(merged.latencyTxId).toBe('tx1'); // oldest txId
    });

    it('merged item inherits OLDEST sourceContext and sermonContext', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1));
        q.enqueue(makeItem(2));
        q.enqueue(makeItem(3));
        const merged = q._queue[0];
        // The bug dropped these (kept src2/serm2). Fix carries the leading chunk's context.
        expect(merged.sourceContext).toBe('src1');
        expect(merged.sermonContext).toBe('serm1');
    });

    it('falls back to second context when oldest has none', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1, { sourceContext: null, sermonContext: null }));
        q.enqueue(makeItem(2));
        q.enqueue(makeItem(3));
        const merged = q._queue[0];
        expect(merged.sourceContext).toBe('src2');
        expect(merged.sermonContext).toBe('serm2');
    });

    it('preserves owner-specific dedup candidates from every merged source item', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1));
        q.enqueue(makeItem(2));
        q.enqueue(makeItem(3));

        expect(q._queue[0].dedupHistoryCandidates).toEqual([
            { p2Text: 'p2-1', b4Text: 'b4-1', releaseMeta: { sessionEpoch: 'epoch', releaseSeq: 1 } },
            { p2Text: 'p2-2', b4Text: 'b4-2', releaseMeta: { sessionEpoch: 'epoch', releaseSeq: 2 } },
        ]);
    });

    it('composes source lineage in the same order as merged text', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1));
        q.enqueue(makeItem(2));
        q.enqueue(makeItem(3));

        expect(q._queue[0].sourceLineage.status).toBe('complete');
        expect(q._queue[0].sourceLineage.wordSpans.map((span) => span.decodeId)).toEqual(['d1', 'd2']);
    });

    it('marks merged revision variants as one fail-open composite ticket', () => {
        const q = new TranslationQueue(2);
        q.enqueue(makeItem(1));
        q.enqueue(makeItem(2));
        q.enqueue(makeItem(3));

        expect(q._queue[0].revisionTicket).toMatchObject({
            kind: 'composite',
            evidence: 'composite_queue_merge',
            scorable: false,
            componentCount: 2,
        });
        expect(q._queue[0].releaseMeta.revisionTicket).toBe(q._queue[0].revisionTicket);
    });
});

describe('TranslationQueue controller actions', () => {
    it('mergeIntoNext prepends current item into the next queued item', () => {
        const q = new TranslationQueue(8);
        q.enqueue(makeItem(2));

        expect(q.mergeIntoNext(makeItem(1))).toBe(true);

        const merged = q._queue[0];
        expect(merged.text).toBe('t1 t2');
        expect(merged.latencyTxId).toBe('tx1');
        expect(merged.sourceContext).toBe('src1');
        expect(merged.sermonContext).toBe('serm1');
        expect(merged.dedupHistoryCandidates).toEqual([
            { p2Text: 'p2-1', b4Text: 'b4-1', releaseMeta: { sessionEpoch: 'epoch', releaseSeq: 1 } },
            { p2Text: 'p2-2', b4Text: 'b4-2', releaseMeta: { sessionEpoch: 'epoch', releaseSeq: 2 } },
        ]);
        expect(q.stats.merged).toBe(1);
        expect(merged.sourceLineage.wordSpans.map((span) => span.decodeId)).toEqual(['d1', 'd2']);
        expect(merged.revisionTicket).toMatchObject({ kind: 'composite', componentCount: 2 });
        expect(merged.releaseMeta.revisionTicket).toBe(merged.revisionTicket);
    });

    it('tracks controller drops', () => {
        const q = new TranslationQueue(8);
        q.drop(makeItem(1));
        expect(q.stats.dropped).toBe(1);
    });
});

describe('TranslationQueue dequeue/stop', () => {
    it('dequeue returns items FIFO then null when stopped+empty', async () => {
        const q = new TranslationQueue(8);
        q.enqueue(makeItem(1));
        expect((await q.dequeue()).text).toBe('t1');
        q.stop();
        expect(await q.dequeue()).toBeNull();
    });
});
