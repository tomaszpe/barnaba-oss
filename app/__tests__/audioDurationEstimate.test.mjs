import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateAudioDurationMs, estimateAudioDurationMsFromBase64 } from '../ttsService.js';

const ttsSource = readFileSync(new URL('../ttsService.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('audio duration estimate (Early Catch-up spec §4.1)', () => {
    it('derives the divisor from AUDIO_FORMAT instead of a hard-coded constant', () => {
        // 32 kbit/s = 4000 B/s. If someone changes AUDIO_FORMAT, the divisor must follow —
        // a hard-coded 4000 would keep reporting the old scale silently.
        expect(ttsSource).toContain("const AUDIO_FORMAT = 'audio-16khz-32kbitrate-mono-mp3';");
        expect(ttsSource).toMatch(/\/\(\\d\+\)kbitrate\//);
        expect(estimateAudioDurationMs(4000)).toBe(1000);
        expect(estimateAudioDurationMs(23000)).toBe(5750);  // 5.75 s = measured chunk average
    });

    it('returns null for absent, empty and non-positive audio rather than a fake zero', () => {
        expect(estimateAudioDurationMs(0)).toBeNull();
        expect(estimateAudioDurationMs(-1)).toBeNull();
        expect(estimateAudioDurationMs(undefined)).toBeNull();
        expect(estimateAudioDurationMsFromBase64(null)).toBeNull();
        expect(estimateAudioDurationMsFromBase64('')).toBeNull();
    });

    it('reads the decoded byte length, not the base64 length', () => {
        // 4000 bytes of base64 is 3000 decoded bytes = 750 ms. Measuring the string instead
        // would report 1000 ms — a silent +33% on every chunk in demand_sec.
        const base64 = Buffer.alloc(3000, 7).toString('base64');
        expect(base64.length).toBe(4000);
        expect(estimateAudioDurationMsFromBase64(base64)).toBe(750);
    });

    it('stamps every SENT chunk in the canonical broadcast helper, dropped ones included', () => {
        const helper = serverSource.slice(
            serverSource.indexOf('function broadcastProgressiveTtsChunk'),
            serverSource.indexOf('// ============================================================\n// Configuration'),
        );
        // The helper runs for all sent chunks in both dispatch paths; putting the field here
        // (and not at a play/complete site) is what makes demand_sec cover drops too.
        expect(helper).toContain('audio_duration_estimate_ms: estimateAudioDurationMsFromBase64(audioBase64)');
        expect(helper.indexOf('audio_duration_estimate_ms')).toBeGreaterThan(helper.indexOf("stage: 'tts_chunk_sent'"));
    });
});
