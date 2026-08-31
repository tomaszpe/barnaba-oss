import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
import {
    hasRhetoricalRepeatIntent,
    protectRhetoricalRepeat,
} from '../b4RhetoricalRepeatPolicy.js';

const stemStart = serverSource.indexOf('function stemWord(word)');
const p2Start = serverSource.indexOf('const P2_NGRAM_SIZE');
const p2End = serverSource.indexOf('/**\n * B4 (18.02.2026)', p2Start);
const p2RuntimeSource = `${serverSource.slice(stemStart, serverSource.indexOf('/**\n * B2 (17.02.2026): Remove inter-segment overlap', stemStart))}\n${serverSource.slice(p2Start, p2End)}\nthis.crossEmissionDedup = crossEmissionDedup;`;

const loadP2 = () => {
    const context = {
        console: { log() {} },
        state: { emissionNgramHistory: new Map() },
    };
    vm.runInNewContext(p2RuntimeSource, context);
    return context.crossEmissionDedup;
};

describe('B4 rhetorical-repeat exception', () => {
    it('passes rel 93 -> 94 when the speaker explicitly announces the repeat', () => {
        const rel94 = 'Ich sage es nochmals, das Buch Hiob zeigt uns einen Menschen, der gelernt hat, mit offenen Fragen zu leben.';
        const decision = protectRhetoricalRepeat({ text: rel94, proposedAction: 'skip' });

        expect(hasRhetoricalRepeatIntent(rel94)).toBe(true);
        expect(decision.action).toBe('emit');
        expect(decision.text).toContain('das Buch Hiob zeigt uns einen Menschen');
        expect(decision.rhetoricalRepeat).toBe(true);
    });

    it('does not preserve an identical immediate ASR loop merely because it contains a cue', () => {
        const repeated = 'Ich sage es nochmals, das Buch Hiob zeigt uns einen Menschen.';
        expect(protectRhetoricalRepeat({
            text: repeated,
            previousText: 'Ich sage es nochmals: das Buch Hiob zeigt uns einen Menschen.',
            proposedAction: 'skip',
        })).toMatchObject({ action: 'skip', rhetoricalRepeat: false });
    });
    it('keeps a 100% ASR repeat without a rhetorical cue blocked', () => {
        const duplicate = 'Das Buch Hiob zeigt uns einen Menschen, der gelernt hat, mit offenen Fragen zu leben.';
        expect(protectRhetoricalRepeat({ text: duplicate, proposedAction: 'skip' }))
            .toMatchObject({ action: 'skip', rhetoricalRepeat: false });
    });

    it('keeps the actual P2 early-return gate ahead of B4 for the Atkinson replay', () => {
        const atkinson = 'Und zwar, Atkinson, das ist nicht Mr. Bean, sondern es ist ein Exeget.';
        const crossEmissionDedup = loadP2();
        expect(crossEmissionDedup(atkinson, 'example-church')).toMatchObject({ action: 'emit' });
        expect(crossEmissionDedup(atkinson, 'example-church')).toMatchObject({ action: 'skip', text: '' });

        const p2Gate = serverSource.slice(
            serverSource.indexOf('const crossResult = crossEmissionDedup'),
            serverSource.indexOf('// Project B (B3.2): Path C semantic dedup'),
        );
        expect(p2Gate).toContain("qualityTracker.trackPipelineBlock(churchId, 'P2'");
        expect(p2Gate).toContain('return;');
        expect(p2Gate).not.toContain('jaccardOverlapGuard');
    });

    it('keeps the production behavior in shadow until the separate apply flag is enabled', () => {
        expect(serverSource).toContain(
            "process.env.B4_RHETORICAL_REPEAT_APPLY_ENABLED === 'true'",
        );
        const guard = serverSource.slice(
            serverSource.indexOf('function jaccardOverlapGuard'),
            serverSource.indexOf('function jaccardOverlapGuard') + 7000,
        );
        expect(guard).toContain("stage: 'b4_rhetorical_repeat_shadow'");
        expect(guard).toContain('if (rhetoricalDecision.rhetoricalRepeat && B4_RHETORICAL_REPEAT_APPLY_ENABLED)');
        expect(guard).toContain("return finalize({ text: '', action: 'skip'");
    });
});
