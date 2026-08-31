/**
 * Unit tests for hgDedupService — Path C semantic dedup (Project B, B3.1).
 *
 * UT-B1..UT-B8: standalone contract tests with mock embedFn.
 * No server.js dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HGDedupService, createHGDedupService, runSequence, cosineSim, tokenJaccard } from '../hgDedupService.js';

// ── Embedding fixtures ──────────────────────────────────────────────────────
// Simple 4-dim vectors for testability. Cosine similarity pre-computed.

const VEC_A = [1, 0, 0, 0];       // basis vector 1
const VEC_B_SIMILAR = [0.95, 0.31, 0, 0]; // cos(A, B_SIMILAR) ≈ 0.95
const VEC_C_DIFFERENT = [0, 0, 1, 0];     // cos(A, C_DIFFERENT) = 0
const VEC_D_BORDERLINE = [0.71, 0.71, 0, 0]; // cos(A, D_BORDERLINE) ≈ 0.71

// Verify fixtures
const _simAB = cosineSim(VEC_A, VEC_B_SIMILAR);
const _simAC = cosineSim(VEC_A, VEC_C_DIFFERENT);
const _simAD = cosineSim(VEC_A, VEC_D_BORDERLINE);
// console.log(`Fixture sims: A-B=${_simAB.toFixed(3)}, A-C=${_simAC.toFixed(3)}, A-D=${_simAD.toFixed(3)}`);

// ── Mock factory ────────────────────────────────────────────────────────────

function makeMockEmbed(vectorSequence) {
    let idx = 0;
    return vi.fn(async () => {
        const vec = vectorSequence[idx % vectorSequence.length];
        idx++;
        return vec;
    });
}

// ── Helper tests ────────────────────────────────────────────────────────────

describe('cosineSim', () => {
    it('returns 1 for identical vectors', () => {
        expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1.0, 5);
    });
    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
    });
});

describe('tokenJaccard', () => {
    it('returns 1 for identical text', () => {
        expect(tokenJaccard('hello world', 'hello world')).toBeCloseTo(1.0, 5);
    });
    it('returns 0 for disjoint text', () => {
        expect(tokenJaccard('hello world', 'foo bar')).toBeCloseTo(0.0, 5);
    });
    it('returns partial overlap', () => {
        // {hello, world} ∩ {hello, foo} = {hello}, union = {hello, world, foo}
        expect(tokenJaccard('hello world', 'hello foo')).toBeCloseTo(1 / 3, 3);
    });
});

// ── UT-B1: Single emission, no pending → translate ──────────────────────────

describe('UT-B1: single emission, no pending', () => {
    it('returns translate with reason no_pending', async () => {
        const mockEmbed = makeMockEmbed([VEC_A]);
        const mockLog = vi.fn();
        const service = new HGDedupService({ embedFn: mockEmbed, logFn: mockLog });

        const result = await service.process('church1', { id: '1', text: 'Paulus lebte vor 2000 Jahren' });

        expect(result.action).toBe('translate');
        expect(result.reason).toBe('no_pending');
        expect(result.similarity).toBeNull();
        expect(mockEmbed).toHaveBeenCalledOnce();
        expect(mockLog).toHaveBeenCalledOnce();
        expect(mockLog.mock.calls[0][0].stage).toBe('hg_dedup');
    });
});

// ── UT-B2: Pending + high sim + low jaccard (P1) → drop current ─────────────

describe('UT-B2: P1 correction detected → drop current', () => {
    it('drops the revision and keeps the original', async () => {
        // A and B have high embedding similarity but different words
        const mockEmbed = makeMockEmbed([VEC_A, VEC_B_SIMILAR]);
        const mockLog = vi.fn();
        const service = new HGDedupService({
            embedFn: mockEmbed,
            logFn: mockLog,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        // Emission A — original (low token overlap with B)
        const rA = await service.process('church1', { id: '1', text: 'Richterseiten sieben Komma fünf' });
        expect(rA.action).toBe('translate');

        // Emission B — revision (different words, high embedding sim)
        const rB = await service.process('church1', { id: '2', text: 'Richterskala sieben Punkt fünfundvierzig' });
        expect(rB.action).toBe('drop');
        expect(rB.reason).toBe('P1_correction_detected');
        expect(rB.similarity).toBeGreaterThan(0.70);
        expect(rB.keptEmission).toBeTruthy();
        expect(rB.keptEmission.id).toBe('1');
    });
});

// ── UT-B3: Pending + low sim → translate both ───────────────────────────────

describe('UT-B3: different content → translate both', () => {
    it('translates the new emission and replaces pending', async () => {
        const mockEmbed = makeMockEmbed([VEC_A, VEC_C_DIFFERENT]);
        const service = new HGDedupService({ embedFn: mockEmbed });

        const rA = await service.process('church1', { id: '1', text: 'Philipper vier dreizehn' });
        expect(rA.action).toBe('translate');

        const rB = await service.process('church1', { id: '2', text: 'Etwas völlig anderes heute' });
        expect(rB.action).toBe('translate');
        expect(rB.reason).toBe('different_content');
        expect(rB.similarity).toBeCloseTo(0, 1);
    });
});

// ── UT-B4: Chain corrections A→B→C all P1 → only A translated ──────────────

describe('UT-B4: chain corrections (A, B, C all P1-similar)', () => {
    it('translates only A, drops B and C', async () => {
        // All 3 get VEC_A-like embeddings (high mutual sim), different words
        const mockEmbed = makeMockEmbed([VEC_A, VEC_B_SIMILAR, VEC_B_SIMILAR]);
        const service = new HGDedupService({
            embedFn: mockEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        const rA = await service.process('ch1', { id: 'A', text: 'Alpha bravo charlie delta' });
        expect(rA.action).toBe('translate');

        const rB = await service.process('ch1', { id: 'B', text: 'Echo foxtrot golf hotel' });
        expect(rB.action).toBe('drop');

        const rC = await service.process('ch1', { id: 'C', text: 'India juliet kilo lima' });
        expect(rC.action).toBe('drop');
    });
});

// ── UT-B5: Borderline sim + high jaccard → translate (conservative) ─────────

describe('UT-B5: borderline similarity + high token overlap → conservative translate', () => {
    it('does not drop when token jaccard exceeds threshold', async () => {
        // D_BORDERLINE has sim ≈ 0.71 to A (above 0.70 threshold)
        const mockEmbed = makeMockEmbed([VEC_A, VEC_D_BORDERLINE]);
        const service = new HGDedupService({
            embedFn: mockEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        const rA = await service.process('ch1', { id: '1', text: 'Gott liebt die Menschen sehr' });
        expect(rA.action).toBe('translate');

        // B has HIGH token overlap with A (shared words) → jaccard > 0.50 → not P1
        const rB = await service.process('ch1', { id: '2', text: 'Gott liebt die Menschen alle sehr' });
        expect(rB.action).toBe('translate');
        expect(rB.reason).toBe('different_content');
    });
});

// ── UT-B6: Per-church isolation ──────────────────────────────────────────────

describe('UT-B6: per-church state isolation', () => {
    it('does not cross-contaminate between churches', async () => {
        // church1 gets VEC_A, VEC_B_SIMILAR (P1 pair)
        // church2 gets VEC_C_DIFFERENT, VEC_C_DIFFERENT (same but independent)
        const vectors = [VEC_A, VEC_C_DIFFERENT, VEC_B_SIMILAR, VEC_C_DIFFERENT];
        const mockEmbed = makeMockEmbed(vectors);
        const service = new HGDedupService({
            embedFn: mockEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        const r1A = await service.process('church1', { id: '1A', text: 'Alpha bravo charlie' });
        const r2A = await service.process('church2', { id: '2A', text: 'Totally different text here' });
        expect(r1A.action).toBe('translate');
        expect(r2A.action).toBe('translate');

        // church1's second emission is P1-similar to its first
        const r1B = await service.process('church1', { id: '1B', text: 'Delta echo foxtrot golf' });
        // church2's second emission has same vector = high sim to its own first → but also high jaccard
        const r2B = await service.process('church2', { id: '2B', text: 'Totally different text here now' });

        // church1: P1 detected (high sim, low token overlap)
        expect(r1B.action).toBe('drop');
        // church2: translate (words overlap → high jaccard → not P1)
        expect(r2B.action).toBe('translate');
    });
});

// ── UT-B7: Cleanup stale entries ────────────────────────────────────────────

describe('UT-B7: cleanup stale pending entries', () => {
    it('removes entries older than maxPendingAge', async () => {
        vi.useFakeTimers();
        const mockEmbed = makeMockEmbed([VEC_A]);
        const service = new HGDedupService({
            embedFn: mockEmbed,
            maxPendingAge: 5000,
        });

        await service.process('church1', { id: '1', text: 'Some text here' });
        expect(service._pendingByChurch.size).toBe(1);

        // Advance time beyond maxPendingAge
        vi.advanceTimersByTime(6000);
        service.cleanup();
        expect(service._pendingByChurch.size).toBe(0);

        vi.useRealTimers();
    });
});

// ── UT-B8: runSequence offline replay ───────────────────────────────────────

describe('UT-B8: runSequence offline replay', () => {
    it('processes sequence [A, B(P1), C(different)] → [translate, drop, translate]', async () => {
        const emissions = [
            { id: 'A', text: 'Alpha bravo charlie delta echo', churchId: 'ch1' },
            { id: 'B', text: 'Foxtrot golf hotel india juliet', churchId: 'ch1' },
            { id: 'C', text: 'Something completely unrelated now', churchId: 'ch1' },
        ];

        // A→VEC_A, B→VEC_B_SIMILAR (P1 of A), C→VEC_C_DIFFERENT
        const mockEmbed = makeMockEmbed([VEC_A, VEC_B_SIMILAR, VEC_C_DIFFERENT]);

        const results = await runSequence(emissions, {
            embedFn: mockEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        expect(results).toHaveLength(3);
        expect(results[0].action).toBe('translate');
        expect(results[1].action).toBe('drop');
        expect(results[1].reason).toBe('P1_correction_detected');
        expect(results[2].action).toBe('translate');
        expect(results[2].reason).toBe('different_content');
    });

    it('isolates state between separate runSequence calls', async () => {
        const emissions = [
            { id: 'X', text: 'Only one emission', churchId: 'ch1' },
        ];
        const mockEmbed = makeMockEmbed([VEC_A, VEC_A]);

        const r1 = await runSequence(emissions, { embedFn: mockEmbed });
        const r2 = await runSequence(emissions, { embedFn: mockEmbed });

        // Both should be 'no_pending' (fresh state each time)
        expect(r1[0].reason).toBe('no_pending');
        expect(r2[0].reason).toBe('no_pending');
    });
});
