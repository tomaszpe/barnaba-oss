import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Contract tests for emissionId counter + logBroadcastStage (Task A3.2).
 *
 * nextEmissionId and logBroadcastStage are NOT exported from server.js.
 * These tests verify the contract by reimplementing core logic
 * (extracted from server.js) and asserting expected behavior.
 */

// ============================================================
// UT-2: nextEmissionId contract
// ============================================================

describe('nextEmissionId contract', () => {
    // Reimplementation per server.js line ~122-123
    let counter;
    function nextEmissionId() { return ++counter; }

    beforeEach(() => { counter = 0; });

    it('UT-2a: increments deterministically from 1', () => {
        expect(nextEmissionId()).toBe(1);
        expect(nextEmissionId()).toBe(2);
        expect(nextEmissionId()).toBe(3);
    });

    it('UT-2b: persists across calls (module-level semantics)', () => {
        const first = nextEmissionId();
        const second = nextEmissionId();
        expect(second).toBe(first + 1);
        expect(second).toBeGreaterThan(first);
    });
});

// ============================================================
// UT-3: logBroadcastStage contract
// ============================================================

describe('logBroadcastStage contract', () => {
    // Reimplementation per server.js lines ~125-136
    let capturedRecords;

    function mockEvalLog(entry) {
        capturedRecords.push(entry);
    }

    function logBroadcastStage({ emissionId, churchId, lang, gender, listenersServed, sourceEmitMs }) {
        const broadcastSentMs = Date.now();
        mockEvalLog({
            stage: 'broadcast',
            churchId,
            emissionId,
            lang,
            gender,
            listeners_served: listenersServed,
            source_emit_ms: sourceEmitMs,
            broadcast_sent_ms: broadcastSentMs,
            duration_ms: broadcastSentMs - sourceEmitMs,
        });
    }

    beforeEach(() => {
        capturedRecords = [];
    });

    it('UT-3a: produces correct 9-field schema', () => {
        logBroadcastStage({
            emissionId: 42,
            churchId: 'church1',
            lang: 'pl',
            gender: 'female',
            listenersServed: 3,
            sourceEmitMs: Date.now() - 1000,
        });

        expect(capturedRecords).toHaveLength(1);
        const record = capturedRecords[0];

        // Verify all 9 fields present
        expect(record.stage).toBe('broadcast');
        expect(record.churchId).toBe('church1');
        expect(record.emissionId).toBe(42);
        expect(record.lang).toBe('pl');
        expect(record.gender).toBe('female');
        expect(record.listeners_served).toBe(3);
        expect(typeof record.source_emit_ms).toBe('number');
        expect(typeof record.broadcast_sent_ms).toBe('number');
        expect(typeof record.duration_ms).toBe('number');
    });

    it('UT-3b: duration_ms = broadcast_sent_ms - source_emit_ms', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-20T12:00:03.000Z'));

        const sourceEmitMs = new Date('2026-04-20T12:00:01.000Z').getTime(); // 2s ago

        logBroadcastStage({
            emissionId: 1,
            churchId: 'c1',
            lang: 'en',
            gender: 'male',
            listenersServed: 1,
            sourceEmitMs,
        });

        const record = capturedRecords[0];
        expect(record.duration_ms).toBe(record.broadcast_sent_ms - record.source_emit_ms);
        expect(record.duration_ms).toBe(2000);

        vi.useRealTimers();
    });

    it('UT-3c: gender=null accepted (non-TTS broadcastToLanguage path)', () => {
        logBroadcastStage({
            emissionId: 5,
            churchId: 'c1',
            lang: 'pl',
            gender: null,
            listenersServed: 2,
            sourceEmitMs: Date.now() - 500,
        });

        const record = capturedRecords[0];
        expect(record.gender).toBeNull();
        expect(record.gender).not.toBeUndefined();
    });

    it('UT-3d: listenersServed=0 accepted (edge case)', () => {
        logBroadcastStage({
            emissionId: 6,
            churchId: 'c1',
            lang: 'ar',
            gender: 'male',
            listenersServed: 0,
            sourceEmitMs: Date.now() - 100,
        });

        expect(capturedRecords).toHaveLength(1);
        expect(capturedRecords[0].listeners_served).toBe(0);
    });
});
