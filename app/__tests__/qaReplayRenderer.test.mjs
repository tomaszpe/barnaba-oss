import { describe, expect, it } from 'vitest';
import { buildQaReplayFilter, normalizeQaReplayManifest } from '../qaReplayRenderer.js';

describe('QA replay renderer', () => {
    it('uses listener windows as the timeline and keeps requested rate diagnostic-only', () => {
        const manifest = normalizeQaReplayManifest({ plays: [
            { chunkKey: 'a', playStartAt: 1000, playEndAt: 3000, effectivePlaybackRate: 1, requestedPlaybackRate: 1.2 },
            { chunkKey: 'b', playStartAt: 4000, playEndAt: 5000, effectivePlaybackRate: 1.2 },
        ] }, ['a', 'b']);
        expect(manifest.durationMs).toBe(4000);
        expect(manifest.plays[0].durationMs).toBe(2000);
        const built = buildQaReplayFilter(manifest, ['a.mp3', 'b.mp3']);
        expect(built.filter).toContain('atrim=duration=2.000');
        expect(built.filter).toContain('adelay=3000|3000');
        expect(built.filter).not.toContain('requestedPlaybackRate');
    });

    it('rejects missing audio and invalid windows', () => {
        expect(() => normalizeQaReplayManifest({ plays: [{ chunkKey: 'x', playStartAt: 1, playEndAt: 2 }] }, [])).toThrow('missing audio');
        expect(() => normalizeQaReplayManifest({ plays: [{ chunkKey: 'x', playStartAt: 2, playEndAt: 2 }] }, ['x'])).toThrow('playEndAt');
    });

    it('distinguishes pitch-changing Web Audio reconstruction', () => {
        const manifest = normalizeQaReplayManifest({ plays: [
            { chunkKey: 'x', playStartAt: 1, playEndAt: 501, effectivePlaybackRate: 1.2, playbackEngine: 'web_audio', preservesPitch: false },
        ] }, ['x']);
        expect(buildQaReplayFilter(manifest, ['x.mp3']).filter).toContain('asetrate=16000*1.200000');
    });
});
