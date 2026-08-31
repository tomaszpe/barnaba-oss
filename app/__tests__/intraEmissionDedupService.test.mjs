import { describe, it, expect } from 'vitest';
import {
    cleanupIntraEmission,
    cleanupIntraEmissionAsync,
    classifyPair,
    collapseInternalRepeat,
    contentTokens,
    cosineSimilarity,
    longestCommonRun,
    splitUnits,
} from '../intraEmissionDedupService.js';

const enabledOnly = { enabled: true };
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const enabled = { enabled: true };
const semanticEnabled = {
    enabled: true,
    semanticEnabled: true,
    semanticDryRun: false,
    semanticSimilarityThreshold: 0.78,
};

describe('intraEmissionDedupService', () => {
    it('splits sentence-like SmoothMode batches into ordered units', () => {
        expect(splitUnits('Er sagt etwas. Dann sagt er mehr! Noch eine Frage? Ende')).toEqual([
            { index: 0, raw: 'Er sagt etwas.' },
            { index: 1, raw: 'Dann sagt er mehr!' },
            { index: 2, raw: 'Noch eine Frage?' },
            { index: 3, raw: 'Ende' },
        ]);
    });

    it('normalizes German content tokens for overlap checks', () => {
        expect(contentTokens('Die Größe der Prüfung ist für uns nicht alles.')).toEqual([
            'grosse',
            'prufung',
        ]);
    });

    it('detects an expanded local correction and drops the earlier unit', () => {
        const previous = 'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit.';
        const current = 'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit behalten in der Prüfung.';

        const result = classifyPair(previous, current, enabled);
        expect(result.action).toBe('drop_previous');
        expect(['expanded_correction', 'prefix_fragment_correction']).toContain(result.reason);
    });

    it('cleans P1-style corrections inside a single SmoothMode emission', () => {
        const input = [
            'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit.',
            'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit behalten in der Prüfung.',
            'Das ist die zweite Perspektive.',
        ].join(' ');

        const result = cleanupIntraEmission(input, enabled);

        expect(result.action).toBe('trim');
        expect(result.text).toBe('Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit behalten in der Prüfung. Das ist die zweite Perspektive.');
        expect(result.removedUnits).toHaveLength(1);
        expect(result.decisions.some(d => d.action === 'drop_previous')).toBe(true);
    });

    it('does not remove short rhetorical repetition', () => {
        const input = 'Gott ist gut. Gott ist gut. Und seine Treue bleibt.';

        const result = cleanupIntraEmission(input, enabled);

        expect(result.action).toBe('emit');
        expect(result.text).toBe(input);
    });

    it('does not remove protected numbered or quoted material', () => {
        const numbered = '1. Wir behalten die Ruhe in der Prüfung. 2. Wir behalten die Ruhe in der Prüfung und bleiben wach.';
        const quoted = '«Der Herr ist mein Hirte und mir wird nichts mangeln.» Der Herr ist mein Hirte und mir wird nichts mangeln in dieser Zeit.';

        expect(cleanupIntraEmission(numbered, enabled).action).toBe('emit');
        expect(cleanupIntraEmission(quoted, enabled).action).toBe('emit');
    });

    it('does not merge similar content with conflicting numbers', () => {
        const previous = 'Das Erdbeben hatte auf der Richterskala die Stärke 8 und traf die ganze Stadt.';
        const current = 'Das Erdbeben hatte auf der Richterskala die Stärke 7 und traf die ganze Stadt.';

        expect(classifyPair(previous, current, enabled)).toMatchObject({
            action: 'keep',
            reason: 'conflicting_numbers',
        });
    });

    it('blocks cleanup when too much of the emission would be removed', () => {
        const input = [
            'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit.',
            'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit behalten in der Prüfung.',
        ].join(' ');

        const result = cleanupIntraEmission(input, { ...enabled, maxRemovalRatio: 0.1 });

        expect(result.action).toBe('emit');
        expect(result.blocked).toBe(true);
        expect(result.text).toBe(input);
    });

    it('is a no-op when disabled', () => {
        const input = 'Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit. Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit behalten.';

        expect(cleanupIntraEmission(input, { enabled: false })).toMatchObject({
            action: 'emit',
            text: input,
            removedUnits: [],
        });
    });

    it('calculates cosine similarity for embedding vectors', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it('uses semantic similarity to trim a local correction that lexical checks miss', async () => {
        const input = 'Erdbeben auf Richterseiten. Erdbeben auf der Richterskala Stärke 8.';

        const result = await cleanupIntraEmissionAsync(input, semanticEnabled, {
            semanticSimilarityFn: async () => 0.86,
        });

        expect(result.action).toBe('trim');
        expect(result.text).toBe('Erdbeben auf der Richterskala Stärke 8.');
        expect(result.semanticSummary).toMatchObject({
            trimCandidates: 1,
            blocked: 0,
            dryRun: false,
        });
    });

    it('records semantic trim candidates without changing text in dry-run mode', async () => {
        const input = 'Erdbeben auf Richterseiten. Erdbeben auf der Richterskala Stärke 8.';

        const result = await cleanupIntraEmissionAsync(input, {
            ...semanticEnabled,
            semanticDryRun: true,
        }, {
            semanticSimilarityFn: async () => 0.86,
        });

        expect(result.action).toBe('emit');
        expect(result.text).toBe(input);
        expect(result.semanticSummary.trimCandidates).toBe(1);
        expect(result.decisions.some(d => d.reason === 'semantic_correction')).toBe(true);
    });

    it('blocks high-similarity semantic candidates with conflicting numbers', async () => {
        const input = 'Das Erdbeben hatte die Stärke 8 und traf die Stadt. Das Erdbeben hatte die Stärke 7 und traf die ganze Stadt.';

        const result = await cleanupIntraEmissionAsync(input, semanticEnabled, {
            semanticSimilarityFn: async () => 0.92,
        });

        expect(result.action).toBe('emit');
        expect(result.semanticSummary.blocked).toBeGreaterThan(0);
        expect(result.decisions.some(d => d.action === 'blocked' && d.reason === 'conflicting_numbers')).toBe(true);
    });

    it('does not semantically trim short rhetorical repetition', async () => {
        const input = 'Gott ist gut. Gott ist gut. Und seine Treue bleibt.';

        const result = await cleanupIntraEmissionAsync(input, semanticEnabled, {
            semanticSimilarityFn: async () => 1,
        });

        expect(result.action).toBe('emit');
        expect(result.text).toBe(input);
        expect(result.semanticSummary.trimCandidates).toBe(0);
    });
});

// Phase 1 (25.06) golden fixtures: real DE `src` from golden 2026-06-24
// (mirror/eval-2026-06-24.jsonl). Oracle = the DE-cleanup GPT output the same
// `src` produced for the DE target, which PL/EN/FR/IT did NOT inherit. The goal
// is to consolidate the shared DE source before fan-out so every language gets a
// clean input for free. Target: >= 6/7 corrected, ZERO false positives on rhetoric.
describe('intraEmissionDedupService — Phase 1 golden fixtures (24.06)', () => {
    it('id 8: drops a reordered exact repeat split by unrelated ASR content', () => {
        // intervening "essen, dann bekommt man ein Zweiziger." is content-disjoint
        const src = 'Mehrheit hat es nicht geschafft. essen, dann bekommt man ein Zweiziger. Die Mehrheit hat es nicht geschafft. Es gab drei Kategorien von';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(countOf(result.text, 'hat es nicht geschafft')).toBe(1);
        expect(result.text).toContain('Die Mehrheit hat es nicht geschafft.');
    });

    it('id 25: drops a near-dup behind a stray ASR guillemet (not a real quote)', () => {
        const src = 'lebe im Zeitalter des Imperialismus. » Wir leben im Zeitalter des Imperialismus, irgendetwas Kleines kommt in unser Leben und wir explodieren und das Verhältnis zwischen';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(countOf(result.text, 'Zeitalter des Imperialismus')).toBe(1);
        expect(result.text).toContain('Wir leben im Zeitalter des Imperialismus');
    });

    it('id 71: keeps trimming a plain expansion correction (no regression)', () => {
        const src = 'Hiob sagt, ich will reden über die Ruhe. Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit in der Prüfung.';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(result.text).toBe('Hiob sagt, ich will reden über die Ruhe und über die Besonnenheit in der Prüfung.');
    });

    it('id 73: KEEPS a rhetorical repeat interleaved with related anaphora (oracle keeps it)', () => {
        // DE oracle kept both "Er weiss nicht, warum." — "Warum, warum, warum?"
        // shares the "warum" theme, so this is intentional rhetoric, not an artifact.
        const src = '» Er weiss nicht, warum. «Warum, warum, warum ? » Er weiss nicht, warum. In Kapitel 4 «Er ist in Staub und';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('emit');
        expect(result.text).toBe(src);
        expect(result.decisions.some(d => d.reason === 'protected_anaphora_gap')).toBe(true);
        expect(result.text).toContain('Warum, warum, warum');
    });

    it('id 81: drops an exact sentence dup AND collapses a comma-joined clause dup', () => {
        const src = 'Gott selber ist die Antwort. Gott selber ist die Antwort. Das Spannende ist nämlich, dass Gott Hiob keine einzige Frage beantwortet, Das Spannende ist nämlich, dass Gott Hiob keine einzige Frage beantwortet, sondern';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(countOf(result.text, 'Gott selber ist die Antwort')).toBe(1);
        expect(countOf(result.text, 'Das Spannende ist nämlich')).toBe(1);
        expect(result.text).toContain('beantwortet, sondern');
    });

    it('id 82: drops a connector-swap near-dup (deshalb/Darum) via the shared run', () => {
        const src = 'im Gegenzug 70 Fragen stellt. Die Vollkommenheit der Fragen, deshalb haben wir das Buch der meisten Fragen in der Bibel. Darum haben wir das Buch der meisten Fragen in der Bibel. Gott stellt 70 Fragen und';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(countOf(result.text, 'das Buch der meisten Fragen in der Bibel')).toBe(1);
        expect(result.text).not.toContain('Darum haben wir');
    });

    it('id 88: drops a leading fragment fully contained in the next unit', () => {
        const src = 'als alles, was du hast. Gelassenheit ist besser als alles, was du hast. Du kannst dein Leben kosmetisch aufarbeiten, aber es heisst immer noch nicht, wie sieht es bei dir aus. Was';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(countOf(result.text, 'als alles, was du hast')).toBe(1);
        expect(result.text).toContain('Gelassenheit ist besser als alles, was du hast.');
    });

    it('safety cap still blocks when consolidation would remove too much', () => {
        const src = 'Gott selber ist die Antwort. Gott selber ist die Antwort.';
        const result = cleanupIntraEmission(src, { ...enabledOnly, maxRemovalRatio: 0.1 });
        expect(result.action).toBe('emit');
        expect(result.blocked).toBe(true);
    });
});

describe('intraEmissionDedupService — Phase 1 rhetoric guards (zero false positives)', () => {
    it('keeps short adjacent anaphora (run below threshold)', () => {
        const src = 'Gott ist gut. Gott ist gut. Und seine Treue bleibt.';
        expect(cleanupIntraEmission(src, enabledOnly).action).toBe('emit');
    });

    it('keeps comma-separated single-word rhetoric ("warum, warum, warum")', () => {
        expect(collapseInternalRepeat('Warum, warum, warum?', 4)).toBe('Warum, warum, warum?');
        expect(collapseInternalRepeat('Heilig, heilig, heilig ist der Herr.', 4)).toBe('Heilig, heilig, heilig ist der Herr.');
    });

    it('keeps a real balanced quote followed by an expanded restatement', () => {
        const quoted = '«Der Herr ist mein Hirte und mir wird nichts mangeln.» Der Herr ist mein Hirte und mir wird nichts mangeln in dieser Zeit.';
        expect(cleanupIntraEmission(quoted, enabledOnly).action).toBe('emit');
    });

    it('does not consolidate when numbers conflict even with a long shared run', () => {
        const src = 'Das Erdbeben hatte die Stärke 8 und traf die ganze Stadt. Das Erdbeben hatte die Stärke 7 und traf die ganze Stadt.';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('emit');
    });

    it('collapses an immediately repeated long clause inside one unit', () => {
        const src = 'Das Spannende ist nämlich, dass Gott Hiob keine Frage beantwortet, Das Spannende ist nämlich, dass Gott Hiob keine Frage beantwortet, sondern er fragt zurück.';
        const collapsed = collapseInternalRepeat(src, 4);
        expect(countOf(collapsed, 'Das Spannende ist nämlich')).toBe(1);
        expect(collapsed).toContain('sondern er fragt zurück.');
    });

    it('makes a collapse-only trim auditable (decisions + removedFragments, no unit dropped)', () => {
        // Single unit, internal comma-dup → text changes but no whole unit is
        // removed. Scorecard must still see what was consolidated (id 42/80).
        const src = 'Das Spannende ist nämlich, dass Gott Hiob keine Frage beantwortet, Das Spannende ist nämlich, dass Gott Hiob keine Frage beantwortet, sondern er fragt zurück.';
        const result = cleanupIntraEmission(src, enabledOnly);
        expect(result.action).toBe('trim');
        expect(result.removedUnits).toHaveLength(0);
        expect(result.collapsedInternal).toBe(true);
        expect(result.collapsedUnits).toBeGreaterThan(0);
        expect(result.removedFragments.length).toBeGreaterThan(0);
        expect(result.decisions.some(d => d.action === 'collapse_internal_repeat' && d.reason === 'internal_repeat')).toBe(true);
    });

    it('longestCommonRun finds the shared contiguous token block', () => {
        expect(longestCommonRun(['a', 'b', 'c', 'd'], ['x', 'b', 'c', 'd'])).toBe(3);
        expect(longestCommonRun(['a', 'b'], ['c', 'd'])).toBe(0);
    });
});
