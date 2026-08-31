import { describe, expect, it } from 'vitest';
import { buildQaReplayReport, normalizeQaReplayManifest } from '../qaReplayRenderer.js';

describe('QA replay diagnostic report', () => {
    it('reports received/played/drop/rate/silence metrics from the full trace', () => {
        const raw = {
            receivedAudioChunks: 3,
            partial: true,
            incompletePlayWindows: 1,
            drops: [{ reason: 'age_budget' }, { reason: 'age_budget' }],
            plays: [
                { chunkKey: 'a', playStartAt: 1000, playEndAt: 2000, requestedPlaybackRate: 1.2, effectivePlaybackRate: 1 },
                { chunkKey: 'b', playStartAt: 2500, playEndAt: 3500, requestedPlaybackRate: 1.3, effectivePlaybackRate: 1.2 },
            ],
        };
        const report = buildQaReplayReport(normalizeQaReplayManifest(raw, ['a', 'b']), raw);
        expect(report).toMatchObject({
            receivedAudioChunks: 3,
            playedWindows: 2,
            incompletePlayWindows: 1,
            droppedByReason: { age_budget: 2 },
            requestedRateMax: 1.3,
            effectiveRateAvg: 1.1,
            maxAudibleSilenceMs: 500,
            partial: true,
            incompletePlayWindows: 1,
        });
    });
});
