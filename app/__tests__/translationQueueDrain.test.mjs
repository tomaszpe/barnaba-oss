import { describe, it, expect } from 'vitest';
import { TranslationQueue } from '../translationQueue.js';

// P-B (disconnect drain) fix #5: drain() must wait for the in-flight worker item,
// not just queue.depth === 0. The worker may have dequeued the last item and still
// be inside translate/TTS when depth hits 0 — draining then would race flushSessionSummary.

describe('TranslationQueue in-flight drain (P-B #5)', () => {
    it('drain() resolves immediately when empty and nothing in-flight', async () => {
        const q = new TranslationQueue();
        await expect(q.drain()).resolves.toBeUndefined();
    });

    it('drain() does NOT resolve while an item is in-flight (depth=0 but worker busy)', async () => {
        const q = new TranslationQueue();
        q.enqueue({ text: 'a' });
        const item = await q.dequeue();          // depth 0, inFlight 1
        expect(item).toBeTruthy();
        expect(q.depth).toBe(0);
        expect(q.inFlight).toBe(1);

        let drained = false;
        const p = q.drain().then(() => { drained = true; });
        await Promise.resolve(); await Promise.resolve();
        expect(drained).toBe(false);             // must wait: emission not out yet

        q.taskDone();                            // worker finished the item
        await p;
        expect(drained).toBe(true);
        expect(q.inFlight).toBe(0);
    });

    it('drain() waits for BOTH queued and in-flight to clear', async () => {
        const q = new TranslationQueue();
        q.enqueue({ text: 'a' });
        q.enqueue({ text: 'b' });
        await q.dequeue();                       // inFlight 1, depth 1
        let done = false;
        const p = q.drain().then(() => { done = true; });

        q.taskDone();                            // 'a' done; 'b' still queued
        await Promise.resolve();
        expect(done).toBe(false);

        await q.dequeue();                       // inFlight 1, depth 0
        q.taskDone();                            // 'b' done
        await p;
        expect(done).toBe(true);
    });

    it('taskDone never drives inFlight negative', () => {
        const q = new TranslationQueue();
        q.taskDone();
        q.taskDone();
        expect(q.inFlight).toBe(0);
    });

    it('stop() unblocks a pending drain', async () => {
        const q = new TranslationQueue();
        q.enqueue({ text: 'a' });
        await q.dequeue();                       // inFlight 1
        const p = q.drain();
        q.stop();
        await expect(p).resolves.toBeUndefined();
    });
});
