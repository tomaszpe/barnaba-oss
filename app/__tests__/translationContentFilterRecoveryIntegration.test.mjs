import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const restoreEnvironment = () => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
};

describe('translation service content-filter recovery integration', () => {
    afterEach(() => {
        restoreEnvironment();
        vi.doUnmock('openai');
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('retries with only the current source and prevents suppressed context writes', async () => {
        process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
        process.env.AZURE_OPENAI_KEY = 'test-key';
        process.env.TRANSLATION_VARIANT = 'A';
        process.env.COMMITTED_PREFIX_ENABLED_LANGS = 'pl';
        process.env.TRANSLATION_CONTEXT_PAIRS = '2';
        process.env.CONTENT_FILTER_RECOVERY_ENABLED = 'true';
        process.env.CONTENT_FILTER_RECOVERY_LANGS = 'pl';
        process.env.CONTENT_FILTER_SOURCE_ONLY_FOR_SESSION = 'true';

        const requests = [];
        let providerAttempt = 0;
        const create = vi.fn((payload) => {
            requests.push(payload);
            return {
                withResponse: async () => {
                    providerAttempt++;
                    if (providerAttempt === 1) {
                        throw Object.assign(new Error('The prompt was filtered'), {
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
                                    },
                                },
                            },
                        });
                    }
                    return {
                        data: {
                            choices: [{ finish_reason: 'stop', message: { content: 'Bieżące tłumaczenie.' } }],
                            usage: { prompt_tokens: 10 },
                        },
                        response: new Response('{}', {
                            headers: { 'apim-request-id': 'recovery-success-2' },
                        }),
                        request_id: null,
                    };
                },
            };
        });
        vi.doMock('openai', () => ({
            default: class OpenAIMock {
                constructor() {
                    this.chat = { completions: { create } };
                }
            },
        }));

        const service = await import('../translationService.js');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        service.initTranslationService();

        service.preWarmContextBuffer('church-recovery', 'tajny prewarm seed');
        service.updateContextBuffer('church-recovery', 'pl', 'stare źródło', 'stary kontekst');
        service.commitTranslation('church-recovery', 'pl', 'tajny committed prefix');
        const onRequestStart = vi.fn();
        const onProviderOutcome = vi.fn();
        const result = await service.translateText(
            'Aktueller neutraler Satz.',
            'pl',
            'church-recovery',
            'tajny B4 context',
            'tajny sermon context',
            { queuedAt: Date.now(), onRequestStart, onProviderOutcome },
        );

        expect(result).toMatchObject({
            text: 'Bieżące tłumaczenie.',
            providerMeta: {
                attempts: 2,
                contextMode: 'source_only',
                recoveredFromContentFilter: true,
                filterSource: 'prompt',
            },
        });
        expect(create).toHaveBeenCalledTimes(2);
        const firstUserMessage = requests[0].messages[1].content;
        const retryUserMessage = requests[1].messages[1].content;
        expect(firstUserMessage).toContain('tajny committed prefix');
        expect(firstUserMessage).toContain('tajny sermon context');
        expect(retryUserMessage).toContain('Aktueller neutraler Satz.');
        expect(retryUserMessage).not.toContain('tajny committed prefix');
        expect(retryUserMessage).not.toContain('tajny sermon context');
        expect(retryUserMessage).not.toContain('tajny B4 context');
        expect(service.getPreviousContext('church-recovery', 'pl')).toBeNull();
        expect(service.formatSourceTargetContext('church-recovery', 'pl', 2)).toBeNull();
        service.commitTranslation('church-recovery', 'pl', result.text);
        expect(service.getCommittedText('church-recovery', 'pl')).toBeNull();
        expect(onRequestStart.mock.calls.map(([event]) => [event.attempt, event.contextMode])).toEqual([
            [1, 'full'],
            [2, 'source_only'],
        ]);
        expect(onProviderOutcome.mock.calls.map(([event]) => [event.attempt, event.context_mode])).toEqual([
            [1, 'full'],
            [2, 'source_only'],
        ]);
        expect(onProviderOutcome.mock.calls[1][0].apim_request_id).toBe('recovery-success-2');
        expect(service.getServiceStatus().contentFilter).toMatchObject({
            sourceOnlyRetries: 1,
            recovered: 1,
            activeSuppressions: 1,
        });

        service.clearContextBuffer('church-recovery');
        expect(service.getServiceStatus().contentFilter.activeSuppressions).toBe(0);
        service.updateContextBuffer(
            'church-recovery',
            'pl',
            'source-only source',
            'source-only translation',
            { contextMode: 'source_only' },
        );
        service.commitTranslation(
            'church-recovery',
            'pl',
            'source-only translation',
            { contextMode: 'source_only' },
        );
        expect(service.getPreviousContext('church-recovery', 'pl')).toBeNull();
        expect(service.getCommittedText('church-recovery', 'pl')).toBeNull();

        providerAttempt = 0;
        await service.translateText(
            'Noch ein neutraler Satz.',
            'pl',
            'church-recovery',
            null,
            null,
            { queuedAt: Date.now() },
        );
        expect(service.getServiceStatus().contentFilter.activeSuppressions).toBe(1);
        service.clearCommittedTranslations('church-recovery');
        expect(service.getServiceStatus().contentFilter.activeSuppressions).toBe(0);
    });
});
