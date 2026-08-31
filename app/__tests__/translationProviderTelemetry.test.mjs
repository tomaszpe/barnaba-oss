import { describe, expect, it, vi } from 'vitest';
import {
    SuccessAnnotationSampler,
    createTranslationRequestTelemetry,
} from '../translationProviderTelemetry.js';

describe('translation provider telemetry', () => {
    it('builds whitelisted behavioral events without provider text or headers', () => {
        const evalLog = vi.fn();
        const telemetry = createTranslationRequestTelemetry({
            evalLog,
            churchId: 'church-1',
            emissionId: 17,
            releaseFields: { release_seq: 4, source_hash: 'hash-1' },
            queuedAt: 900,
        });

        expect(telemetry.queuedAt).toBe(900);

        telemetry.onRequestStart({
            targetLang: 'pl',
            model: 'gpt-5.4',
            startedAtMs: 1000,
            attempt: 2,
            contextMode: 'source_only',
        });
        telemetry.onProviderOutcome({
            targetLang: 'pl',
            model: 'gpt-5.4',
            outcome: 'policy_block',
            failure_kind: 'content_filter',
            http_status: 400,
            provider_code: 'content_filter',
            filter_source: 'prompt',
            filter_results: [{ source: 'prompt', category: 'hate', filtered: true }],
            filter_annotations_sampled: true,
            filter_annotation_count: 1,
            attempt: 1,
            context_mode: 'full',
            apim_request_id: 'apim-1',
            x_ms_request_id: null,
            x_request_id: null,
            provider_message_hash: null,
            latency_ms: 40,
            queue_wait_ms: 5,
            raw_message: 'must not appear',
            headers: { authorization: 'must not appear' },
        });

        expect(evalLog).toHaveBeenCalledTimes(2);
        expect(evalLog.mock.calls[0][0]).toMatchObject({
            stage: 'translation_request_started',
            attempt: 2,
            context_mode: 'source_only',
        });
        const outcome = evalLog.mock.calls[1][0];
        expect(outcome).toMatchObject({
            stage: 'translation_provider_outcome',
            churchId: 'church-1',
            emissionId: 17,
            release_seq: 4,
            failure_kind: 'content_filter',
            apim_request_id: 'apim-1',
        });
        expect(JSON.stringify(outcome)).not.toContain('must not appear');
    });

    it('samples safe annotations but always keeps actionable annotations', () => {
        const sampler = new SuccessAnnotationSampler({ sampleEvery: 3 });
        const safe = [{ source: 'prompt', category: 'hate', severity: 'safe', filtered: false }];
        const unsafe = [{ source: 'prompt', category: 'hate', severity: 'medium', filtered: false }];

        expect(sampler.select(safe)).toMatchObject({ filterResults: [], sampled: false, total: 1 });
        expect(sampler.select(safe)).toMatchObject({ filterResults: [], sampled: false, total: 1 });
        expect(sampler.select(safe)).toMatchObject({ filterResults: safe, sampled: true, total: 1 });
        expect(sampler.select(unsafe)).toMatchObject({ filterResults: unsafe, sampled: true, total: 1 });
    });
});
