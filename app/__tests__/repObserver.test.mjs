import { describe, expect, it, vi } from 'vitest';
import { createRepObserver, tokensFor } from '../repObserver.js';

const lineage = (coordinate = 'a'.repeat(24), decodeId = 7) => ({
    status: 'complete',
    reason: null,
    wordSpans: Array.from({ length: 8 }, (_, index) => ({
        logicalChunkId: coordinate,
        decodeId,
        startSample: index * 320,
        endSample: (index + 1) * 320,
    })),
});

describe('REP gateway observer', () => {
    it('normalizes Unicode German tokens', () => {
        expect(tokensFor('Ärger, L’Amour 42')).toEqual(['ärger', 'l’amour', '42']);
    });

    it('is silent in off mode', () => {
        const evalLog = vi.fn();
        const observer = createRepObserver({ mode: 'off', evalLog });
        expect(observer.observe({ stage: 'asr_gateway_ingress', churchId: 'c', text: 'secret' })).toBeNull();
        expect(evalLog).not.toHaveBeenCalled();
    });

    it('logs only HMAC and anonymous lineage', () => {
        const evalLog = vi.fn();
        const observer = createRepObserver({
            mode: 'shadow', evalLog, keyFactory: () => Buffer.alloc(32, 1),
        });
        const text = 'eins zwei drei vier fünf sechs sieben acht';
        const event = observer.observe({
            stage: 'asr_gateway_ingress', churchId: 'c', text, lineage: lineage(), decodeId: 7,
        });
        expect(JSON.stringify(event)).not.toContain(text);
        expect(event.decode_ids).toEqual([7]);
        expect(event.word_span_count).toBe(8);
        expect(event.policy_applied).toBe(false);
        expect(text).toBe('eins zwei drei vier fünf sechs sieben acht');
        expect(evalLog).toHaveBeenCalledWith(event);
    });

    it('counts coordinate-space changes per sermon', () => {
        const observer = createRepObserver({ mode: 'shadow', keyFactory: () => Buffer.alloc(32, 1) });
        observer.observe({ stage: 'asr_gateway_ingress', churchId: 'c', text: 'a', lineage: lineage('a'.repeat(24)) });
        const event = observer.observe({ stage: 'asr_gateway_ingress', churchId: 'c', text: 'b', lineage: lineage('b'.repeat(24)) });
        expect(event.whisper_session_change_count).toBe(1);
        const closed = observer.closeChurch('c');
        expect(closed.whisper_session_change_count).toBe(1);
        const next = observer.observe({
            stage: 'asr_gateway_ingress', churchId: 'c', text: 'c', lineage: lineage('c'.repeat(24)),
        });
        expect(next.whisper_session_change_count).toBe(0);
    });
});
