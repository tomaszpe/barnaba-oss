import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildQaReplayFilter, cleanupQaReplay, normalizeQaReplayManifest, renderQaReplay } from '../qaReplayRenderer.js';

describe('QA replay heterogeneous audio guards', () => {
    it('normalizes every branch and rejects overlapping listener windows', () => {
        const manifest = normalizeQaReplayManifest({ plays: [
            { chunkKey: 'a', playStartAt: 0, playEndAt: 1000, effectivePlaybackRate: 1.2, preservesPitch: true },
            { chunkKey: 'b', playStartAt: 1000, playEndAt: 2000, effectivePlaybackRate: 1.2, preservesPitch: false },
        ] }, ['a', 'b']);
        const filter = buildQaReplayFilter(manifest, ['a.mp3', 'b.mp3']).filter;
        expect(filter.match(/aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono/g)).toHaveLength(4);
        expect(() => normalizeQaReplayManifest({ plays: [
            { chunkKey: 'a', playStartAt: 0, playEndAt: 1001 },
            { chunkKey: 'b', playStartAt: 1000, playEndAt: 2000 },
        ] }, ['a', 'b'])).toThrow('must not overlap');
    });

    it('renders mixed 24k stereo and 16k mono pitch modes', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'barnaba-qa-mixed-'));
        try {
            const stereo = path.join(dir, 'stereo.mp3');
            const mono = path.join(dir, 'mono.mp3');
            execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '24000', '-ac', '2', stereo]);
            execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-ar', '16000', '-ac', '1', mono]);
            const result = await renderQaReplay({
                manifest: { plays: [
                    { chunkKey: 'a', playStartAt: 0, playEndAt: 800, effectivePlaybackRate: 1.2, preservesPitch: true },
                    { chunkKey: 'b', playStartAt: 1000, playEndAt: 1800, effectivePlaybackRate: 1.2, preservesPitch: false },
                ] },
                chunks: new Map([['a', readFileSync(stereo)], ['b', readFileSync(mono)]])
            });
            try {
                const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', result.outputPath], { encoding: 'utf8' }).trim());
                expect(Math.abs(duration - 1.8)).toBeLessThanOrEqual(0.1);
            } finally { await cleanupQaReplay(result.tempDir); }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30000);
});
