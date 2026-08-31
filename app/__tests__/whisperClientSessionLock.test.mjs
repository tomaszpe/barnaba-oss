import { afterEach, describe, expect, it, vi } from 'vitest';

describe('whisperClient streaming sessions', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        delete process.env.WHISPER_SERVICE_URL;
    });

    it('shares one in-flight session create per church', async () => {
        process.env.WHISPER_SERVICE_URL = 'http://whisper.test';
        vi.resetModules();

        const fetchMock = vi.fn(async (url) => {
            if (String(url).endsWith('/session/create')) {
                await new Promise(resolve => setTimeout(resolve, 10));
                return Response.json({ session_id: 'session-1' });
            }

            if (String(url).endsWith('/session/session-1/chunk')) {
                return Response.json({
                    partial_text: '',
                    confirmed_text: '',
                    is_speech: true,
                    has_new_transcription: false,
                });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const { sendStreamingChunk, clearAudioBuffer } = await import('../whisperClient.js');
        const samples = new Float32Array([0.1, 0.2, 0.3]);

        await Promise.all([
            sendStreamingChunk('church-a', samples, 16000, false),
            sendStreamingChunk('church-a', samples, 16000, false),
        ]);

        const createCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session/create'));
        const chunkCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session/session-1/chunk'));

        expect(createCalls).toHaveLength(1);
        expect(chunkCalls).toHaveLength(2);

        clearAudioBuffer('church-a');
    });
});
