import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

describe('admin recorder progressive TTS support', () => {
    it('handles progressive tts_chunk messages while preserving legacy translation audio', () => {
        expect(adminHtml).toContain("else if (msg.type === 'translation') recordOnTranslation(msg)");
        expect(adminHtml).toContain("else if (msg.type === 'tts_chunk') recordOnTtsChunk(msg)");
        expect(adminHtml).toContain('function recordOnTtsChunk(msg)');
        // Recorder timeline change (29.06.2026): helper now also takes the raw msg for
        // per-chunk timing/metadata (received timestamp, emission ids, sentence index).
        expect(adminHtml).toContain('function recordStoreAudioChunk(language, audioBase64, msg');
    });

    it('stores legacy translation audio and progressive chunk audio through the same helper', () => {
        const translationHandler = adminHtml.match(/function recordOnTranslation\(msg\) \{[\s\S]*?\n        \}/)?.[0] || '';
        const chunkHandler = adminHtml.match(/function recordOnTtsChunk\(msg\) \{[\s\S]*?\n        \}/)?.[0] || '';

        expect(translationHandler).toContain('recordStoreAudioChunk(language, audioBase64, msg)');
        expect(chunkHandler).toContain('recordStoreAudioChunk(language, audioBase64, msg)');
        expect(chunkHandler).toContain('if (!audioBase64) return');
    });
});
