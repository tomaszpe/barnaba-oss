import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupQaReplay, renderQaReplay } from '../qaReplayRenderer.js';

describe('QA replay ffmpeg integration', () => {
    it('renders listener windows and their audible gap within 100 ms', async () => {
        const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'barnaba-qa-fixture-'));
        const chunkPath = path.join(fixtureDir, 'tone.mp3');
        try {
            execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', '-b:a', '32k', chunkPath]);
            const result = await renderQaReplay({
                manifest: { plays: [
                    { chunkKey: 'a', playStartAt: 1000, playEndAt: 2000, effectivePlaybackRate: 1 },
                    { chunkKey: 'b', playStartAt: 2500, playEndAt: 3500, effectivePlaybackRate: 1 },
                ] },
                chunks: new Map([['a', readFileSync(chunkPath)], ['b', readFileSync(chunkPath)]])
            });
            try {
                const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', result.outputPath], { encoding: 'utf8' }).trim());
                expect(Math.abs(duration - 2.5)).toBeLessThanOrEqual(0.1);
            } finally {
                await cleanupQaReplay(result.tempDir);
            }
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    }, 30000);
});
