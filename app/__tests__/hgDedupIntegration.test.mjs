/**
 * Integration tests for HG dedup pipeline integration (Project B, B3.2).
 *
 * IT-B1..IT-B4: verify hgDedupService behavior within the pipeline decision flow.
 * Standalone contract tests — replicate pipeline decision logic, mock boundaries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHGDedupService } from '../hgDedupService.js';

// ── Fixture embeddings (4-dim for testability) ──────────────────────────────

const VEC_A = [1, 0, 0, 0];
const VEC_B_P1 = [0.95, 0.31, 0, 0];   // high sim to A (~0.95), will be P1
const VEC_C_DIFF = [0, 0, 1, 0];         // orthogonal to A (sim=0)

// ── Pipeline simulation ─────────────────────────────────────────────────────

/**
 * Simulates the pipeline decision logic from server.js processCompleteSentence:
 *   P2 filter (mocked as pass) → Path C gate → JOG filter (mocked as pass) → translate
 *
 * @param {object} opts
 * @param {boolean} opts.hgDedupEnabled
 * @param {object|null} opts.hgDedupService
 * @param {Array<{id, text, churchId}>} opts.emissions
 * @returns {Promise<{translated: object[], dropped: object[], fallbacks: object[], logs: object[]}>}
 */
async function simulatePipeline({ hgDedupEnabled, hgDedupService, emissions }) {
    const translated = [];
    const dropped = [];
    const fallbacks = [];
    const logs = [];

    for (const emission of emissions) {
        const churchId = emission.churchId || 'test-church';

        // Path C gate (mirrors server.js logic)
        if (hgDedupEnabled && hgDedupService) {
            try {
                const decision = await hgDedupService.process(churchId, {
                    id: emission.id,
                    text: emission.text,
                    timestamp: Date.now(),
                });
                if (decision.action === 'drop') {
                    dropped.push({ emission, decision });
                    continue; // skip translation
                }
            } catch (err) {
                // Conservative fallback — translate anyway
                fallbacks.push({ emission, error: err.message });
                logs.push({ stage: 'hg_dedup', action: 'fallback_translate', reason: 'embedding_error', error: err.message });
            }
        }

        // Translate (mock — just record it)
        translated.push(emission);
    }

    return { translated, dropped, fallbacks, logs };
}

// ── IT-B1: HG_DEDUP_ENABLED=true — drops P1 duplicates ─────────────────────

describe('IT-B1: HG_DEDUP_ENABLED=true — drops P1, translates rest', () => {
    it('translates A and C, drops B (P1 correction of A)', async () => {
        let embedIdx = 0;
        const vectors = [VEC_A, VEC_B_P1, VEC_C_DIFF];
        const mockEmbed = vi.fn(async () => vectors[embedIdx++]);
        const mockLog = vi.fn();

        const service = createHGDedupService({
            embedFn: mockEmbed,
            logFn: mockLog,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        const emissions = [
            { id: 'A', text: 'Paulus lebte vor zweitausend Jahren', churchId: 'ch1' },
            { id: 'B', text: 'Der Apostel existierte vor zwei Jahrtausenden', churchId: 'ch1' },
            { id: 'C', text: 'Etwas komplett anderes zum Thema Gebet', churchId: 'ch1' },
        ];

        const result = await simulatePipeline({
            hgDedupEnabled: true,
            hgDedupService: service,
            emissions,
        });

        expect(result.translated).toHaveLength(2);
        expect(result.translated[0].id).toBe('A');
        expect(result.translated[1].id).toBe('C');
        expect(result.dropped).toHaveLength(1);
        expect(result.dropped[0].emission.id).toBe('B');
        expect(result.dropped[0].decision.reason).toBe('P1_correction_detected');

        // Verify telemetry: 3 log calls (1 translate, 1 drop, 1 translate)
        expect(mockLog).toHaveBeenCalledTimes(3);
        const dropLog = mockLog.mock.calls.find(c => c[0].action === 'drop');
        expect(dropLog).toBeTruthy();
        expect(dropLog[0].reason).toBe('P1_correction_detected');
    });
});

// ── IT-B2: HG_DEDUP_ENABLED=false — legacy behavior ────────────────────────

describe('IT-B2: HG_DEDUP_ENABLED=false — all emissions translated', () => {
    it('translates all 3 emissions without dedup', async () => {
        const emissions = [
            { id: 'A', text: 'Paulus lebte vor zweitausend Jahren', churchId: 'ch1' },
            { id: 'B', text: 'Der Apostel existierte vor zwei Jahrtausenden', churchId: 'ch1' },
            { id: 'C', text: 'Etwas komplett anderes zum Thema Gebet', churchId: 'ch1' },
        ];

        const result = await simulatePipeline({
            hgDedupEnabled: false,
            hgDedupService: null,
            emissions,
        });

        expect(result.translated).toHaveLength(3);
        expect(result.dropped).toHaveLength(0);
        expect(result.fallbacks).toHaveLength(0);
    });
});

// ── IT-B3: Embedding API failure → fallback translate ───────────────────────

describe('IT-B3: Embedding failure → fallback, all translated', () => {
    it('falls back to translate when embedding throws', async () => {
        let callCount = 0;
        const failingEmbed = vi.fn(async () => {
            callCount++;
            if (callCount === 2) throw new Error('Azure API timeout');
            return VEC_A;
        });

        const service = createHGDedupService({
            embedFn: failingEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        const emissions = [
            { id: 'A', text: 'Erste Emission zum Testen', churchId: 'ch1' },
            { id: 'B', text: 'Zweite Emission bricht ab', churchId: 'ch1' },
        ];

        const result = await simulatePipeline({
            hgDedupEnabled: true,
            hgDedupService: service,
            emissions,
        });

        // A translated normally, B triggers embed failure → fallback translate
        expect(result.translated).toHaveLength(2);
        expect(result.fallbacks).toHaveLength(1);
        expect(result.fallbacks[0].error).toContain('Azure API timeout');
        expect(result.dropped).toHaveLength(0);
    });
});

// ── IT-B4: Path C standalone (no Path D dependency) ─────────────────────────

describe('IT-B4: Path C works standalone without Path D', () => {
    it('drops P1 without requiring TRANSLATION_CONSOLIDATION flag', async () => {
        let embedIdx = 0;
        const vectors = [VEC_A, VEC_B_P1];
        const mockEmbed = vi.fn(async () => vectors[embedIdx++]);

        const service = createHGDedupService({
            embedFn: mockEmbed,
            similarityThreshold: 0.70,
            tokenJaccardMax: 0.50,
        });

        // Only 2 emissions: A (original) + B (P1 revision)
        const emissions = [
            { id: 'A', text: 'Alpha bravo charlie delta echo', churchId: 'ch1' },
            { id: 'B', text: 'Foxtrot golf hotel india juliet', churchId: 'ch1' },
        ];

        const result = await simulatePipeline({
            hgDedupEnabled: true,
            hgDedupService: service,
            emissions,
        });

        expect(result.translated).toHaveLength(1);
        expect(result.translated[0].id).toBe('A');
        expect(result.dropped).toHaveLength(1);
        expect(result.dropped[0].emission.id).toBe('B');

        // Path D (TRANSLATION_CONSOLIDATION) not wired — no dependency
        // This test proves Path C is independently functional
    });
});
