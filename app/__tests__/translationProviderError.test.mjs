import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIUserAbortError } from 'openai';
import { createResponseHeaders } from 'openai/core';
import { ProviderCircuitBreaker } from '../providerCircuitBreaker.js';
import {
    TranslationProviderError,
    assertNoFilteredCompletion,
    classifyTranslationProviderError,
    executeTranslationProviderRequestPolicy,
    sanitizeProviderOutcome,
    shouldAffectTranslationCircuit,
    translationFailureFields,
} from '../translationProviderError.js';

const azurePromptBlock = () => ({
    status: 400,
    code: 'content_filter',
    param: 'prompt',
    error: {
        code: 'content_filter',
        param: 'prompt',
        innererror: {
            code: 'ResponsibleAIPolicyViolation',
            content_filter_result: {
                hate: { filtered: true, severity: 'medium' },
                self_harm: { filtered: false, severity: 'safe' },
                jailbreak: { filtered: false, detected: false },
                protected_material_code: { filtered: false, detected: false },
                custom_blocklists: [{ id: 'private-list-name', filtered: true }],
            },
        },
    },
    headers: createResponseHeaders(new Headers({
        'apim-request-id': 'apim-123',
        'x-ms-request-id': 'ms-456',
        authorization: 'must-not-leak',
    })),
});

describe('translation provider error classification', () => {
    it('classifies the real Azure prompt content-filter payload and whitelists headers', () => {
        const error = classifyTranslationProviderError(azurePromptBlock());

        expect(error).toBeInstanceOf(TranslationProviderError);
        expect(error).toMatchObject({
            kind: 'content_filter',
            status: 400,
            code: 'content_filter',
            param: 'prompt',
            filterSource: 'prompt',
            correlationIds: {
                apimRequestId: 'apim-123',
                xMsRequestId: 'ms-456',
            },
        });
        expect(error.filterResults).toEqual(expect.arrayContaining([
            expect.objectContaining({ category: 'hate', severity: 'medium', filtered: true }),
            expect.objectContaining({ category: 'self_harm', severity: 'safe', filtered: false }),
            expect.objectContaining({ category: 'custom_blocklists_0', filtered: true }),
        ]));
        expect(JSON.stringify(error.filterResults)).not.toContain('private-list-name');
        expect(JSON.stringify(error.correlationIds)).not.toContain('authorization');
        expect(shouldAffectTranslationCircuit(error)).toBe(false);
    });

    it('handles connection errors without headers', () => {
        const error = classifyTranslationProviderError(new APIConnectionError({}));

        expect(error.kind).toBe('network');
        expect(error.status).toBeNull();
        expect(error.correlationIds).toEqual({});
        expect(shouldAffectTranslationCircuit(error)).toBe(true);
    });

    it('classifies the SDK abort error from the application timeout as timeout', () => {
        const error = classifyTranslationProviderError(new APIUserAbortError());
        expect(error).toMatchObject({ kind: 'timeout', status: null });
        expect(shouldAffectTranslationCircuit(error)).toBe(true);
    });

    it('uses a message hash only for compatibility fallback and never exposes the message', () => {
        const raw = new Error('Response blocked by the content filter policy');
        const error = classifyTranslationProviderError(raw);
        const event = sanitizeProviderOutcome(error);

        expect(error.kind).toBe('content_filter');
        expect(event.provider_message_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(event)).not.toContain(raw.message);
    });

    it.each([
        ['The prompt was filtered due to the content management policy', 'prompt'],
        ['The response was filtered due to the content management policy', 'completion'],
    ])('derives filter source from a compatibility message (%s)', (message, source) => {
        const error = classifyTranslationProviderError(new Error(message));
        expect(error).toMatchObject({ kind: 'content_filter', filterSource: source });
    });

    it('derives prompt source from the structured Azure error when param is absent', () => {
        const raw = azurePromptBlock();
        delete raw.param;
        delete raw.error.param;
        const error = classifyTranslationProviderError(raw);
        expect(error).toMatchObject({ kind: 'content_filter', filterSource: 'prompt' });
    });

    it('keeps a non-enumerable cause and a redacted operator diagnostic outside telemetry', () => {
        const raw = Object.assign(
            new Error(
                "Unsupported parameter: 'max_tokens'; api-key=secret-value; "
                + '{"content":"sermon secret"}; <sermon_text>private homily</sermon_text>',
            ),
            { status: 400, code: 'invalid_parameter' },
        );
        const error = classifyTranslationProviderError(raw);

        expect(error.cause).toBe(raw);
        expect(error.operatorDiagnostic).toContain('Unsupported parameter');
        expect(error.operatorDiagnostic).not.toContain('secret-value');
        expect(error.operatorDiagnostic).not.toContain('sermon secret');
        expect(error.operatorDiagnostic).not.toContain('private homily');
        expect(Object.keys(error)).not.toContain('cause');
        expect(Object.keys(error)).not.toContain('operatorDiagnostic');
        expect(JSON.stringify(sanitizeProviderOutcome(error))).not.toContain('Unsupported parameter');
    });

    it('re-sanitizes metadata supplied through a typed error', () => {
        const error = new TranslationProviderError({
            kind: 'content_filter',
            filterResults: [{
                source: 'prompt',
                category: 'hate',
                severity: 'medium',
                filtered: true,
                raw_text: 'must not leak',
            }],
            correlationIds: {
                apimRequestId: 'apim-1',
                authorization: 'must not leak',
            },
        });
        const event = sanitizeProviderOutcome(error);
        expect(event.filter_results).toEqual([{
            source: 'prompt',
            category: 'hate',
            severity: 'medium',
            filtered: true,
        }]);
        expect(event.apim_request_id).toBe('apim-1');
        expect(JSON.stringify(event)).not.toContain('must not leak');
    });

    it.each([
        [{ status: 429, code: 'rate_limit_exceeded' }, 'rate_limit', true],
        [Object.assign(new Error('timed out'), { name: 'APIConnectionTimeoutError' }), 'timeout', true],
        [{ status: 503, code: 'service_unavailable' }, 'provider_5xx', true],
        [{ status: 401, code: 'invalid_api_key' }, 'auth_or_deployment', true],
        [{ status: 404, code: 'DeploymentNotFound' }, 'auth_or_deployment', true],
        [{ status: 422, code: 'invalid_request' }, 'request_invalid', false],
    ])('maps provider failures without conflating policy blocks (%s)', (raw, kind, affectsCircuit) => {
        const error = classifyTranslationProviderError(raw);
        expect(error.kind).toBe(kind);
        expect(shouldAffectTranslationCircuit(error)).toBe(affectsCircuit);
    });
});

describe('successful response policy', () => {
    it('rejects completion filtering before the breaker can record success and discards partial text', async () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
        const partial = {
            choices: [{
                finish_reason: 'content_filter',
                message: { content: 'partial text that must not be emitted' },
                content_filter_results: { violence: { filtered: true, severity: 'medium' } },
            }],
        };

        await expect(executeTranslationProviderRequestPolicy({
            circuitBreaker: breaker,
            request: async () => partial,
        })).rejects.toMatchObject({ kind: 'content_filter', filterSource: 'completion' });
        expect(breaker.getStatus()).toMatchObject({
            successes: 0,
            failures: 0,
            consecutiveFailures: 0,
        });
    });

    it('rejects an empty choices array as an invalid provider response', () => {
        expect(() => assertNoFilteredCompletion({ choices: [] })).toThrowError(
            expect.objectContaining({ kind: 'provider_invalid_response', code: 'empty_choices' }),
        );
    });

    it.each([null, '', '   ', { text: 'not a string' }])(
        'rejects a completion without usable text before recording success (%s)',
        async (content) => {
            const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
            await expect(executeTranslationProviderRequestPolicy({
                circuitBreaker: breaker,
                request: async () => ({
                    choices: [{ finish_reason: 'stop', message: { content } }],
                }),
            })).rejects.toMatchObject({
                kind: 'provider_invalid_response',
                code: 'empty_completion',
            });
            expect(breaker.getStatus()).toMatchObject({ successes: 0, failures: 1 });
        },
    );

    it('returns only sanitized success annotations', () => {
        const annotations = assertNoFilteredCompletion({
            prompt_filter_results: [{
                prompt_index: 0,
                content_filter_results: { hate: { filtered: false, severity: 'safe' } },
            }],
            choices: [{
                finish_reason: 'stop',
                message: { content: 'translated sermon text' },
                content_filter_results: { violence: { filtered: false, severity: 'safe' } },
            }],
        });

        expect(annotations).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'prompt', category: 'hate', filtered: false }),
            expect.objectContaining({ source: 'completion', category: 'violence', filtered: false }),
        ]));
        expect(JSON.stringify(annotations)).not.toContain('translated sermon text');
    });

    it('extracts Azure correlation IDs from a successful withResponse envelope', async () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
        const settled = await executeTranslationProviderRequestPolicy({
            circuitBreaker: breaker,
            request: async () => ({
                data: {
                    choices: [{ finish_reason: 'stop', message: { content: 'translation' } }],
                },
                response: new Response('{}', {
                    headers: {
                        'apim-request-id': 'apim-success-1',
                        'x-ms-request-id': 'ms-success-1',
                    },
                }),
                request_id: null,
            }),
        });

        expect(settled.correlationIds).toEqual({
            apimRequestId: 'apim-success-1',
            xMsRequestId: 'ms-success-1',
        });
    });
});

describe('translation circuit policy', () => {
    it('resets the outage streak on a policy response without counting a translation success', async () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
        const fail503 = () => Promise.reject({ status: 503, code: 'service_unavailable' });

        await expect(executeTranslationProviderRequestPolicy({ circuitBreaker: breaker, request: fail503 })).rejects.toBeTruthy();
        await expect(executeTranslationProviderRequestPolicy({ circuitBreaker: breaker, request: fail503 })).rejects.toBeTruthy();
        await expect(executeTranslationProviderRequestPolicy({
            circuitBreaker: breaker,
            request: async () => { throw azurePromptBlock(); },
        })).rejects.toMatchObject({ kind: 'content_filter' });
        await expect(executeTranslationProviderRequestPolicy({ circuitBreaker: breaker, request: fail503 })).rejects.toBeTruthy();

        expect(breaker.getStatus()).toMatchObject({
            open: false,
            consecutiveFailures: 1,
            failures: 3,
            successes: 0,
        });
    });

    it('keeps P0A active when the P0B recovery flag is false', async () => {
        const previous = process.env.CONTENT_FILTER_RECOVERY_ENABLED;
        process.env.CONTENT_FILTER_RECOVERY_ENABLED = 'false';
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3 });
        try {
            for (let i = 0; i < 100; i++) {
                await expect(executeTranslationProviderRequestPolicy({
                    circuitBreaker: breaker,
                    request: async () => { throw azurePromptBlock(); },
                })).rejects.toMatchObject({ kind: 'content_filter' });
            }
            expect(breaker.getStatus()).toMatchObject({ failures: 0, opened: 0, open: false });
        } finally {
            if (previous === undefined) delete process.env.CONTENT_FILTER_RECOVERY_ENABLED;
            else process.env.CONTENT_FILTER_RECOVERY_ENABLED = previous;
        }
    });

    it('returns a typed zero-attempt circuit_open without invoking the request', async () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 10000 });
        breaker.recordFailure(new Error('503'));
        let invoked = false;

        await expect(executeTranslationProviderRequestPolicy({
            circuitBreaker: breaker,
            request: async () => {
                invoked = true;
            },
        })).rejects.toMatchObject({ kind: 'circuit_open', attempts: 0 });
        expect(invoked).toBe(false);
    });

    it('still opens after three real 503 responses', async () => {
        const breaker = new ProviderCircuitBreaker({ failureThreshold: 3, cooldownMs: 10000 });
        const request = async () => { throw { status: 503, code: 'service_unavailable' }; };
        for (let i = 0; i < 3; i++) {
            await expect(executeTranslationProviderRequestPolicy({ circuitBreaker: breaker, request }))
                .rejects.toMatchObject({ kind: 'provider_5xx' });
        }
        expect(breaker.getStatus()).toMatchObject({ open: true, failures: 3, opened: 1 });
    });

    it('preserves the complete failure envelope', () => {
        const fields = translationFailureFields(new TranslationProviderError({
            kind: 'content_filter',
            attempts: 2,
            contextMode: 'source_only',
            recoveredFromContentFilter: true,
            filterSource: 'prompt',
        }));
        expect(fields).toMatchObject({
            failureKind: 'content_filter',
            attempts: 2,
            contextMode: 'source_only',
            recoveredFromContentFilter: true,
            filterSource: 'prompt',
        });
    });
});
