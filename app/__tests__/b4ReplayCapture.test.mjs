import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const server = readFileSync(resolve(import.meta.dirname, '..', 'server.js'), 'utf8');

describe('B4 sealed replay capture', () => {
  it('is opt-in and captures the exact P2/B4 seam needed for deterministic offline replay', () => {
    expect(server).toContain("process.env.B4_REPLAY_CAPTURE_ENABLED === 'true'");
    const start = server.indexOf("stage: 'b4_replay_capture'");
    expect(start).toBeGreaterThan(0);
    const seam = server.slice(start - 900, start + 2200);
    expect(seam).toContain("if (typeof B4_REPLAY_CAPTURE_ENABLED !== 'undefined' && B4_REPLAY_CAPTURE_ENABLED)");
    expect(seam).toContain('source_text: sourceReleaseText');
    expect(seam).toContain('p2_input_text: p2HistoryCandidate');
    expect(seam).toContain('b4_input_text: preB4Text');
    expect(seam).toContain('b4_output_text: jaccardResult.text');
    expect(seam).toContain('wordSpans: Array.isArray(projectedB4Lineage.wordSpans)');
  });
});
