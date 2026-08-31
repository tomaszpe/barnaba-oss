import { describe, expect, it } from 'vitest';
import { ListenerPlayoutLedger, listenerSessionIdFrom } from '../listenerPlayoutLedger.js';

const listener = 'listener-1234';
const churchId = 'dev-ch';
const family = 'family-a';
const coordinate = 'a'.repeat(24);
const span = [{ logical_chunk_id: coordinate, start_sample: 100, end_sample: 300 }];

const chunk = (sentenceIndex, totalSentences = 2) => ({
    session_epoch: 'epoch-a',
    release_seq: 9,
    language: 'pl',
    sentence_index: sentenceIndex,
    total_sentences: totalSentences,
    is_last: sentenceIndex === totalSentences - 1,
    revision_family_id: family,
    revision_generation: 1,
    source_lineage_status: 'complete',
    synthesized: true,
});
const outcome = (sentenceIndex, kind, id = `${kind}-${sentenceIndex}`) => ({
    outcome_id: id,
    listener_session_id: listener,
    chunk_key: `epoch-a:9:pl:${sentenceIndex}`,
    session_epoch: 'epoch-a',
    outcome: kind,
});

describe('per-listener playout ledger', () => {
    it('accepts only bounded opaque listener ids', () => {
        expect(listenerSessionIdFrom(listener)).toBe(listener);
        expect(listenerSessionIdFrom('short')).toBeNull();
        expect(listenerSessionIdFrom('../not-safe')).toBeNull();
    });

    it('commits a release only after every TTS chunk has started', () => {
        const ledger = new ListenerPlayoutLedger();
        for (const sentenceIndex of [0, 1]) {
            ledger.recordBroadcast({ churchId, listenerSessionId: listener, chunk: chunk(sentenceIndex), sourceSpans: span });
        }

        expect(ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(0, 'play_started'),
        }).committed).toBe(false);
        expect(ledger.committedSourceRanges({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        })).toEqual([]);

        expect(ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(1, 'play_started'),
        }).committed).toBe(true);
        expect(ledger.committedSourceRanges({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        })).toEqual([{ coordinateSpaceId: coordinate, startSample: 100, endSample: 300 }]);
    });

    it('never treats completion without start as a commit', () => {
        const ledger = new ListenerPlayoutLedger();
        ledger.recordBroadcast({ churchId, listenerSessionId: listener, chunk: chunk(0, 1), sourceSpans: span });
        ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(0, 'play_completed'),
        });

        expect(ledger.committedSourceRanges({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        })).toEqual([]);
        expect(ledger.snapshot().anomalies).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'completed_without_start' }),
        ]));
    });

    it('deduplicates retries and rejects another listener or epoch', () => {
        const ledger = new ListenerPlayoutLedger();
        ledger.recordBroadcast({ churchId, listenerSessionId: listener, chunk: chunk(0, 1), sourceSpans: span });
        const event = outcome(0, 'play_started');
        expect(ledger.observeOutcome({ churchId, listenerSessionId: listener, event }).duplicate).toBe(false);
        expect(ledger.observeOutcome({ churchId, listenerSessionId: listener, event }).duplicate).toBe(true);
        expect(ledger.observeOutcome({
            churchId,
            listenerSessionId: 'listener-9999',
            event,
        }).reason).toBe('listener_identity_mismatch');
        expect(ledger.observeOutcome({
            churchId,
            listenerSessionId: listener,
            event: { ...event, outcome_id: 'other-id', session_epoch: 'epoch-b' },
        }).reason).toBe('epoch_mismatch');
    });

    it('finds only the contiguous committed prefix in the newer source lineage', () => {
        const ledger = new ListenerPlayoutLedger();
        ledger.recordBroadcast({ churchId, listenerSessionId: listener, chunk: chunk(0, 1), sourceSpans: span });
        ledger.observeOutcome({ churchId, listenerSessionId: listener, event: outcome(0, 'play_started') });
        const sourceLineage = {
            status: 'complete',
            wordCount: 3,
            wordSpans: [
                { logicalChunkId: coordinate, startSample: 100, endSample: 150 },
                { logicalChunkId: coordinate, startSample: 150, endSample: 250 },
                { logicalChunkId: coordinate, startSample: 300, endSample: 350 },
            ],
        };

        expect(ledger.committedPrefixWordCount({
            churchId,
            listenerSessionId: listener,
            sessionEpoch: 'epoch-a',
            language: 'pl',
            beforeReleaseSeq: 10,
            sourceLineage,
        })).toBe(2);
    });

    it('keeps proof isolated by language and ignores revision-family splits', () => {
        const ledger = new ListenerPlayoutLedger();
        ledger.recordBroadcast({
            churchId,
            listenerSessionId: listener,
            chunk: { ...chunk(0, 1), revision_family_id: 'old-family' },
            sourceSpans: span,
        });
        ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(0, 'play_started'),
        });

        expect(ledger.committedSourceProofs({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        }).proofs).toHaveLength(1);
        expect(ledger.committedSourceProofs({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'en',
            beforeReleaseSeq: 10,
        }).proofs).toHaveLength(0);
    });

    it('quarantines a conflicting rebroadcast instead of attaching an old start', () => {
        const ledger = new ListenerPlayoutLedger();
        expect(ledger.recordBroadcast({
            churchId, listenerSessionId: listener, chunk: chunk(0, 1), sourceSpans: span,
        }).accepted).toBe(true);
        ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(0, 'play_started'),
        });
        expect(ledger.recordBroadcast({
            churchId,
            listenerSessionId: listener,
            chunk: { ...chunk(0, 1), translated_chunk_hash: 'changed' },
            sourceSpans: span,
        })).toMatchObject({ accepted: false, reason: 'broadcast_fingerprint_conflict' });
        expect(ledger.committedSourceProofs({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        }).proofs).toHaveLength(0);
    });

    it('does not consume an outcome id before a retryable broadcast lookup succeeds', () => {
        const ledger = new ListenerPlayoutLedger();
        const event = outcome(0, 'play_started', 'retry-me');
        expect(ledger.observeOutcome({ churchId, listenerSessionId: listener, event }))
            .toMatchObject({ accepted: false, retryable: true, reason: 'broadcast_not_observed' });
        ledger.recordBroadcast({
            churchId, listenerSessionId: listener, chunk: chunk(0, 1), sourceSpans: span,
        });
        expect(ledger.observeOutcome({ churchId, listenerSessionId: listener, event }))
            .toMatchObject({ accepted: true, duplicate: false, committed: true });
    });

    it('accepts trusted partial ranges as a conservative committed proof', () => {
        const ledger = new ListenerPlayoutLedger();
        ledger.recordBroadcast({
            churchId,
            listenerSessionId: listener,
            chunk: { ...chunk(0, 1), source_lineage_status: 'partial' },
            sourceSpans: span,
        });
        ledger.observeOutcome({
            churchId, listenerSessionId: listener, event: outcome(0, 'play_started'),
        });
        expect(ledger.committedSourceProofs({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        }).proofs[0]).toMatchObject({ sourceMapStatus: 'partial' });
    });

    it('binds outcomes to the delivery unit and uses server time for proof order', () => {
        const ledger = new ListenerPlayoutLedger({ now: () => 12_345 });
        ledger.recordBroadcast({
            churchId,
            listenerSessionId: listener,
            chunk: { ...chunk(0, 1), delivery_unit_id: 'd'.repeat(24) },
            sourceSpans: span,
        });
        expect(ledger.observeOutcome({
            churchId,
            listenerSessionId: listener,
            event: {
                ...outcome(0, 'play_started'),
                chunk_key: `epoch-a:9:pl:${'d'.repeat(24)}:0`,
                occurred_at_ms: Number.MAX_SAFE_INTEGER,
            },
        })).toMatchObject({ accepted: true, committed: true });
        expect(ledger.committedSourceProofs({
            churchId, listenerSessionId: listener, sessionEpoch: 'epoch-a', language: 'pl',
            beforeReleaseSeq: 10,
        }).proofs[0].committedAt).toBe(12_345);
    });
});
