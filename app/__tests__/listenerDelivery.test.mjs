import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/listenerDelivery.js', import.meta.url), 'utf8');

const loadPolicy = () => {
    const storageData = new Map();
    const localStorage = {
        getItem: (key) => storageData.get(key) || null,
        setItem: (key, value) => storageData.set(key, value),
    };
    const context = { localStorage };
    context.window = context;
    vm.runInNewContext(source, context);
    return { policy: context.BarnabaListenerDelivery, localStorage };
};

describe('bounded listener delivery scheduler', () => {
    it('uses the full canonical key, not release_seq alone', () => {
        const { policy } = loadPolicy();
        const base = { session_epoch: 'e1', release_seq: 10, language: 'pl', sentence_index: 0 };
        expect(policy.canonicalChunkKey(base)).not.toBe(
            policy.canonicalChunkKey({ ...base, sentence_index: 1 }),
        );
        expect(policy.canonicalChunkKey(base)).not.toBe(
            policy.canonicalChunkKey({ ...base, language: 'en' }),
        );
        expect(policy.canonicalChunkKey(base)).not.toBe(
            policy.canonicalChunkKey({ ...base, delivery_unit_id: 'delivery-v2' }),
        );
    });

    it('finds only older pending revisions in the same epoch, family and language', () => {
        const { policy } = loadPolicy();
        const pending = new Map();
        const old = {
            session_epoch: 'e1', release_seq: 10, language: 'pl', sentence_index: 0,
            revision_family_id: 'family-a', revision_generation: 1,
        };
        const otherLanguage = { ...old, release_seq: 11, language: 'en' };
        const otherEpoch = { ...old, release_seq: 12, session_epoch: 'e2' };
        const current = { ...old, release_seq: 13, revision_generation: 2 };
        for (const item of [old, otherLanguage, otherEpoch, current]) {
            pending.set(policy.canonicalChunkKey(item), item);
        }

        const incoming = { ...old, release_seq: 14, revision_generation: 2 };
        const candidates = policy.selectRevisionSupersessionCandidates(pending, incoming);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].chunk.release_seq).toBe(10);
    });

    it('fails open when revision identity is absent', () => {
        const { policy } = loadPolicy();
        const old = { session_epoch: 'e1', release_seq: 10, language: 'pl', sentence_index: 0 };
        const pending = new Map([[policy.canonicalChunkKey(old), old]]);

        expect(policy.selectRevisionSupersessionCandidates(pending, {
            ...old, release_seq: 11, revision_generation: 2,
        })).toEqual([]);
    });

    it('keeps lexical candidates visible to shadow but requires explicit eligibility on both sides for APPLY', () => {
        const { policy } = loadPolicy();
        const old = {
            session_epoch: 'e1', release_seq: 10, language: 'pl', sentence_index: 0,
            revision_family_id: 'family-a', revision_generation: 1,
            revision_apply_eligible: false,
        };
        const pending = new Map([[policy.canonicalChunkKey(old), old]]);
        const lexicalIncoming = {
            ...old, release_seq: 11, revision_generation: 2,
            revision_apply_eligible: false,
        };

        expect(policy.selectRevisionSupersessionCandidates(pending, lexicalIncoming)).toHaveLength(1);
        expect(policy.isRevisionSupersessionApplyEligible(old, lexicalIncoming)).toBe(false);
        expect(policy.isRevisionSupersessionApplyEligible(
            { ...old, revision_apply_eligible: true },
            { ...lexicalIncoming, revision_apply_eligible: true },
        )).toBe(true);
    });

    it('fails closed for APPLY when eligibility is absent, false or merely truthy', () => {
        const { policy } = loadPolicy();
        const base = { revision_apply_eligible: true };
        for (const value of [undefined, null, false, 'true', 1]) {
            expect(policy.isRevisionSupersessionApplyEligible(
                base,
                { revision_apply_eligible: value },
            )).toBe(false);
            expect(policy.isRevisionSupersessionApplyEligible(
                { revision_apply_eligible: value },
                base,
            )).toBe(false);
        }
    });

    it('scores V2 shadow only when the incoming ticket explicitly supersedes that generation', () => {
        const { policy } = loadPolicy();
        const candidate = {
            session_epoch: 'epoch-1', language: 'pl', revision_family_id: 'family-1',
            revision_generation: 2, source_map_v2_status: 'complete',
        };
        const incoming = {
            session_epoch: 'epoch-1', language: 'pl', revision_family_id: 'family-1',
            revision_generation: 4,
            source_map_v2_status: 'complete',
            t2_supersede_pending_v2_eligible: true,
            revision_supersedes_generations_v2: [2, 3],
        };

        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, incoming)).toBe(true);
        expect(policy.isRevisionSupersessionV2ShadowEligible(
            { revision_generation: 1 }, incoming,
        )).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, session_epoch: 'epoch-2',
        })).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, t2_supersede_pending_v2_eligible: 'true',
        })).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(
            { ...candidate, language: undefined },
            { ...incoming, language: undefined },
        )).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, revision_generation: 4.5,
        })).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, revision_supersedes_generations_v2: [2, '3'],
        })).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, revision_supersedes_generations_v2: [3, 2],
        })).toBe(false);
        expect(policy.isRevisionSupersessionV2ShadowEligible(candidate, {
            ...incoming, source_map_v2_status: 'partial',
        })).toBe(false);
    });

    it('keeps unique chunks from adjacent releases and schedules them in order', () => {
        const { policy } = loadPolicy();
        const pending = new Map();
        const newer = { session_epoch: 'e1', release_seq: 94, language: 'pl', sentence_index: 0 };
        const older = { session_epoch: 'e1', release_seq: 93, language: 'pl', sentence_index: 1 };
        pending.set(policy.canonicalChunkKey(newer), newer);
        pending.set(policy.canonicalChunkKey(older), older);

        expect(pending.size).toBe(2);
        expect(policy.selectNextPendingKey(pending)).toBe(policy.canonicalChunkKey(older));
    });

    it('requires an explicit active epoch instead of ordering UUIDs lexically', () => {
        const { policy } = loadPolicy();
        const pending = new Map();
        const first = { session_epoch: 'z-uuid', release_seq: 1, language: 'pl', sentence_index: 0 };
        const second = { session_epoch: 'a-uuid', release_seq: 1, language: 'pl', sentence_index: 0 };
        pending.set(policy.canonicalChunkKey(first), first);
        pending.set(policy.canonicalChunkKey(second), second);

        expect(() => policy.selectNextPendingKey(pending)).toThrow('multiple session epochs');
        expect(policy.selectNextPendingKey(pending, { sessionEpoch: 'a-uuid' }))
            .toBe(policy.canonicalChunkKey(second));
    });
    it('drops only chunks outside the explicit age/backlog budgets', () => {
        const { policy } = loadPolicy();
        const now = 100000;
        const chunks = [
            { session_epoch: 'e', release_seq: 1, language: 'pl', sentence_index: 0, receivedAt: now - 11000 },
            { session_epoch: 'e', release_seq: 2, language: 'pl', sentence_index: 0, receivedAt: now - 1000 },
            { session_epoch: 'e', release_seq: 3, language: 'pl', sentence_index: 0, receivedAt: now - 500 },
        ];
        const pending = new Map(chunks.map((chunk) => [policy.canonicalChunkKey(chunk), chunk]));
        const drops = policy.selectBudgetDrops({
            pending,
            now,
            maxAgeMs: 10000,
            maxBacklogMs: 5000,
            estimatedChunkDurationMs: 3000,
        });

        expect(drops[0]).toMatchObject({ reason: 'age_budget' });
        expect(drops).toHaveLength(2);
        expect(drops[1]).toMatchObject({ reason: 'backlog_budget' });
    });
});

describe('persistent listener outcome ledger', () => {
    it('retains events until the server acknowledges their outcome ids', () => {
        const { policy, localStorage } = loadPolicy();
        const chunk = {
            session_epoch: 'e1',
            release_seq: 9,
            language: 'pl',
            sentence_index: 0,
            chunk_word_count: 5,
            source_lineage_status: 'complete',
            revision_family_id: 'family-a',
            revision_generation: 2,
            revision_apply_eligible: false,
            delivery_unit_id: 'delivery-unit-1',
            source_map_digest: 'map-digest-1',
        };
        const ledger = new policy.DeliveryLedger({ listenerSessionId: 'listener-1', storage: localStorage });
        const received = ledger.record(chunk, 'chunk_received');
        ledger.record(chunk, 'play_completed');

        expect(ledger.peekBatch()).toHaveLength(2);
        expect(received.source_lineage_status).toBe('complete');
        expect(received).toMatchObject({
            revision_family_id: 'family-a',
            revision_generation: 2,
            revision_apply_eligible: false,
            delivery_unit_id: 'delivery-unit-1',
            source_map_digest: 'map-digest-1',
        });
        ledger.acknowledge([received.outcome_id]);
        expect(ledger.peekBatch()).toHaveLength(1);

        const otherListener = new policy.DeliveryLedger({ listenerSessionId: 'listener-2', storage: localStorage });
        expect(otherListener.peekBatch()).toHaveLength(0);
        const restored = new policy.DeliveryLedger({ listenerSessionId: 'listener-1', storage: localStorage });
        expect(restored.peekBatch()).toHaveLength(1);
        expect(restored.peekBatch()[0].outcome).toBe('play_completed');
    });
});

describe('urgent playback-started telemetry', () => {
    it('flushes play_started immediately but leaves other outcomes on the regular batch', async () => {
        const { policy } = loadPolicy();
        const scheduled = [];
        const pending = [{ outcome: 'play_started' }];
        let flushCalls = 0;
        const flusher = new policy.UrgentOutcomeFlusher({
            peekPending: () => pending,
            flush: async () => {
                flushCalls++;
                pending.length = 0;
            },
            schedule: (callback, delayMs) => {
                scheduled.push({ callback, delayMs });
                return scheduled.length;
            },
        });

        flusher.notify('chunk_received');
        expect(scheduled).toHaveLength(0);
        flusher.notify('play_started');
        flusher.notify('play_started');
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0].delayMs).toBe(0);

        await scheduled.shift().callback();
        expect(flushCalls).toBe(1);
        expect(scheduled).toHaveLength(0);
    });

    it('retries when an in-flight or failed send leaves play_started unacknowledged', async () => {
        const { policy } = loadPolicy();
        const scheduled = [];
        const pending = [{ outcome: 'play_started' }];
        const flusher = new policy.UrgentOutcomeFlusher({
            peekPending: () => pending,
            flush: async () => {},
            retryMs: 750,
            schedule: (callback, delayMs) => {
                scheduled.push({ callback, delayMs });
                return scheduled.length;
            },
        });

        flusher.notify('play_started');
        await scheduled.shift().callback();

        expect(scheduled).toHaveLength(1);
        expect(scheduled[0].delayMs).toBe(750);
    });
});
