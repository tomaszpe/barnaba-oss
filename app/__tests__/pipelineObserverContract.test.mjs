import { describe, expect, it } from 'vitest';
import {
    buildPipelineObserverMessage,
    buildSourceActivityMessage,
} from '../pipelineObserverContract.js';

describe('pipeline observer contract', () => {
    it('publishes only sanitized source decision fields', () => {
        const message = buildPipelineObserverMessage({
            stage: 'source_release_outcome', churchId: 'c', release_seq: 12,
            source_hash: 'abc', outcome: 'translated_blocked', block_stage: 'T5',
            lang: 'pl', reason: 'private detail', text: 'never expose source text',
        });

        expect(message).toEqual({
            type: 'pipeline_decision', decisionType: 'source_release', release_seq: 12,
            source_hash: 'abc', emissionId: null, outcome: 'translated_blocked',
            blockStage: 'T5', language: 'pl', languages: [], terminal: true,
        });
        expect(JSON.stringify(message)).not.toContain('private detail');
        expect(JSON.stringify(message)).not.toContain('never expose');
    });

    it('maps drain timeout to a fail-closed observer event', () => {
        expect(buildPipelineObserverMessage({
            stage: 'disconnect_drain_timeout', churchId: 'c', drainId: 'd1',
            stage_cut: 'queue_drain', residual_queue_depth: 2,
        })).toEqual({
            type: 'pipeline_drain', phase: 'timeout', drainId: 'd1', stageCut: 'queue_drain',
        });
    });

    it('reports source activity without PCM or derived text', () => {
        expect(buildSourceActivityMessage({
            isFinal: true,
            observedAtMs: 1_700_000_000_000,
            vad: { hasSpeech: false, speechRatio: 0.123456, confidence: 0.78901 },
        })).toEqual({
            type: 'source_activity', speechActive: false, speechRatio: 0.1235,
            confidence: 0.789, isFinal: true, observedAt: '2023-11-14T22:13:20.000Z',
        });
    });
});
