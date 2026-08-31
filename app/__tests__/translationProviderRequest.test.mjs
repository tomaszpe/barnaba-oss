import { describe, expect, it, vi } from 'vitest';
import { createTranslationCompletionRequest } from '../translationProviderRequest.js';

describe('createTranslationCompletionRequest', () => {
    it('executes exactly one SDK request and exposes the raw response metadata', async () => {
        const envelope = { data: { choices: [] }, response: new Response('{}'), request_id: null };
        const withResponse = vi.fn(async () => envelope);
        const create = vi.fn(() => ({ withResponse }));
        const client = { chat: { completions: { create } } };
        const signal = new AbortController().signal;
        const payload = { model: 'gpt-5.4', messages: [] };

        await expect(createTranslationCompletionRequest({ client, payload, signal })).resolves.toBe(envelope);
        expect(create).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(payload, { signal });
        expect(withResponse).toHaveBeenCalledOnce();
    });
});
