import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('B4 cadence v2 server integration', () => {
    it('keeps both runtime flags default-off', () => {
        expect(server).toContain(
            "const B4_CADENCE_V2_SHADOW_ENABLED = process.env.B4_CADENCE_V2_SHADOW_ENABLED === 'true';",
        );
        expect(server).toContain(
            "const B4_CADENCE_V2_APPLY_ENABLED = process.env.B4_CADENCE_V2_APPLY_ENABLED === 'true';",
        );
    });

    it('selects cadence output only under the apply flag', () => {
        expect(server).toContain(
            'const jaccardResult = B4_CADENCE_V2_APPLY_ENABLED ? b4CadenceResult : legacyB4Result;',
        );
        expect(server).toContain("stage: 'b4_cadence_v2_shadow'");
        expect(server).toContain('policy_applied: B4_CADENCE_V2_APPLY_ENABLED');
    });

    it('commits only non-skipped cadence output after source acceptance', () => {
        const committer = server.slice(
            server.indexOf('function createDedupHistoryCommitter'),
            server.indexOf('function createDedupHistoryCommitter') + 2500,
        );
        expect(committer).toContain('if (candidate.b4CadenceText)');
        expect(committer).toContain('commitB4CadenceHistory(');
        expect(server).toContain("b4CadenceResult && b4CadenceResult.action !== 'skip'");
    });

    it('clears cadence history on both disconnect cleanup paths', () => {
        expect(server.match(/clearB4CadenceHistory\(churchId\);/g)).toHaveLength(2);
    });
});
