import { describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_SHADOW_CONFIG,
    buildSourceUnits,
    createSourceSemanticRepeatShadow,
    decideVerdict,
    firedGuards,
    isClosedUnit,
    isFullUnit,
    normalizeShadowConfig,
    pairSignals,
} from '../sourceSemanticRepeatShadow.js';

// Deterministic fake embeddings: a text maps to a unit vector chosen by keyword, so
// cosine is fully controlled by the test instead of by a network call.
const AXES = {
    seneca: [1, 0, 0],
    knopf: [0, 1, 0],
    hiob: [0, 0, 1],
};
const axisFor = (text) => {
    const lower = text.toLowerCase();
    for (const [key, vector] of Object.entries(AXES)) {
        if (lower.includes(key)) return vector;
    }
    return [0.5, 0.5, 0.5];
};
const embedByKeyword = async (text) => axisFor(text);

const mix = (a, b, weight) => a.map((value, index) => value * (1 - weight) + b[index] * weight);

const makeShadow = (overrides = {}, embedFn = embedByKeyword) => {
    const logs = [];
    const shadow = createSourceSemanticRepeatShadow({
        embedFn,
        logFn: (entry) => logs.push(entry),
        now: overrides.now,
        config: { enabled: true, ...overrides.config },
    });
    return { shadow, logs };
};

describe('unit gating', () => {
    it('treats a punctuation shard as neither closed nor full', () => {
        // Offline these embedded to cosine 1.000 against each other and produced
        // 11 of 54 candidates with zero seconds of audio.
        expect(isFullUnit('.')).toBe(false);
        expect(isFullUnit('» !')).toBe(false);
        expect(isFullUnit('Seneca hat schon ein Buch geschrieben.')).toBe(true);
    });

    it('rejects a unit that ends on an open word even with a period', () => {
        expect(isClosedUnit('Das ist das ganze Setting, worum es geht.')).toBe(true);
        expect(isClosedUnit('Wir sprechen von einer Menge und.')).toBe(false);
    });

    it('marks only closed AND full units as scorable', () => {
        const units = buildSourceUnits({
            sessionEpoch: 'epoch-1',
            releaseSeq: 7,
            text: 'Seneca hat schon ein Buch geschrieben. » . Der rote Knopf wird gedrueckt heute.',
        });
        // splitUnits keeps "» ." as ONE shard, so three units, the middle one unscorable.
        expect(units.map((unit) => unit.scorable)).toEqual([true, false, true]);
        expect(units[0].source_unit_id).toBe('epoch-1:7:0');
    });
});

describe('guards', () => {
    const base = 'Er wurde als Koenig stilisiert, mit 7000 Schafen und 3000 Rindern.';

    it('fires on conflicting numbers', () => {
        const signals = pairSignals(base, 'Er wurde als Koenig stilisiert, mit 9000 Schafen und 5000 Rindern.');
        expect(signals.guard_numbers).toBe(true);
    });

    it('fires when one side has a number and the other does not — both directions', () => {
        // "viele Schafe" -> "7000 Schafe" replaces an unquantified claim with a quantified
        // one. Suppressing either unit deletes the only place the figure was ever said.
        const unquantified = 'Hiob hatte viele Schafe dabei.';
        const quantified = 'Hiob hatte 7000 Schafe dabei.';
        expect(pairSignals(unquantified, quantified).guard_numbers).toBe(true);
        expect(pairSignals(quantified, unquantified).guard_numbers).toBe(true);
        expect(pairSignals(quantified, quantified).guard_numbers).toBe(false);
        expect(pairSignals(unquantified, unquantified).guard_numbers).toBe(false);
    });

    it('fires on a negation flip', () => {
        const signals = pairSignals(
            'Wir sprechen von einer inflationaeren Menge von Buechern zum Thema Geduld.',
            'Wir sprechen nicht von einer inflationaeren Menge von Buechern zum Thema Geduld.',
        );
        expect(signals.guard_negation).toBe(true);
    });

    it('fires on a balanced quote', () => {
        const signals = pairSignals('Gelassenheit verlaengert das Leben heute.', '«Gelassenheit verlaengert das Leben».');
        expect(signals.guard_quote).toBe(true);
    });

    it('fires on an explicit rhetorical repeat cue', () => {
        const signals = pairSignals(
            'Das Buch Hiob zeigt einen Menschen, der gelernt hat zu leben.',
            'Ich sage es nochmals, das Buch Hiob zeigt einen Menschen, der gelernt hat.',
        );
        expect(signals.guard_rhetorical).toBe(true);
    });

    it('fires the expansion guard when the current unit contains the previous one verbatim', () => {
        // Offline this was 2 of 5 false positives: suppressing the current unit would delete
        // the head of a quote the listener never heard in full.
        const signals = pairSignals(
            'ist besser als beide Haende voll Muehe und Jagd nach Wind.',
            'Eine Handvoll Gelassenheit ist besser als beide Haende voll Muehe und Jagd nach Wind.',
        );
        expect(signals.guard_expansion).toBe(true);
    });

    it('does not fire the expansion guard when the current unit is merely similar', () => {
        const signals = pairSignals(
            'Die Mehrheit hat es nicht geschafft heute.',
            'Die meisten haben es fuer diesen nicht geschafft.',
        );
        expect(signals.guard_expansion).toBe(false);
    });

    it('counts new content-word types as new_lexical_token_count', () => {
        // "mit"/"und" are stopwords: only Reichtum and Gesundheit are new content types.
        const signals = pairSignals('Hiob hat lange gerungen heute.', 'Hiob hat lange gerungen heute mit Reichtum und Gesundheit.');
        expect(signals.new_lexical_token_count).toBe(2);
    });
});

describe('decideVerdict', () => {
    const match = (cosine, previousText, currentText) => ({
        entry: { text: previousText, releaseSeq: 1, unitIndex: 0, sourceUnitId: 'e:1:0', tsMs: 0 },
        cosine,
        signals: pairSignals(previousText, currentText),
    });

    it('returns keep with no history', () => {
        expect(decideVerdict([], DEFAULT_SHADOW_CONFIG).verdict).toBe('keep');
    });

    it('separates the high-precision band from the exploratory band', () => {
        const same = 'Seneca hat schon ein Buch geschrieben heute.';
        expect(decideVerdict([match(0.78, same, same)], DEFAULT_SHADOW_CONFIG).verdict).toBe('candidate_high_precision');
        expect(decideVerdict([match(0.72, same, same)], DEFAULT_SHADOW_CONFIG).verdict).toBe('candidate_exploratory');
        expect(decideVerdict([match(0.69, same, same)], DEFAULT_SHADOW_CONFIG).verdict).toBe('keep');
    });

    it('picks the BEST eligible match, not the first one above the threshold', () => {
        const current = 'Seneca hat schon ein Buch geschrieben heute.';
        const matches = [
            { ...match(0.76, 'Seneca hat schon ein Buch geschrieben heute.', current), entry: { text: current, releaseSeq: 1, unitIndex: 0, sourceUnitId: 'weak', tsMs: 0 } },
            { ...match(0.93, 'Seneca hat schon ein Buch geschrieben heute.', current), entry: { text: current, releaseSeq: 2, unitIndex: 0, sourceUnitId: 'strong', tsMs: 0 } },
        ];
        const decision = decideVerdict(matches, DEFAULT_SHADOW_CONFIG);
        expect(decision.bestEligible.entry.sourceUnitId).toBe('strong');
    });

    it('prefers a weaker guard-clear match over a stronger guarded one, and still logs the guarded one', () => {
        const current = 'Seneca hat schon ein Buch geschrieben heute.';
        const guarded = {
            ...match(0.99, '«Seneca hat schon ein Buch geschrieben heute».', current),
            entry: { text: '«Seneca hat schon ein Buch geschrieben heute».', releaseSeq: 1, unitIndex: 0, sourceUnitId: 'guarded', tsMs: 0 },
        };
        const clean = {
            ...match(0.80, 'Seneca hat schon ein Buch geschrieben heute.', current),
            entry: { text: 'Seneca hat schon ein Buch geschrieben heute.', releaseSeq: 2, unitIndex: 0, sourceUnitId: 'clean', tsMs: 0 },
        };
        const decision = decideVerdict([guarded, clean], DEFAULT_SHADOW_CONFIG);
        expect(decision.verdict).toBe('candidate_high_precision');
        expect(decision.bestEligible.entry.sourceUnitId).toBe('clean');
        expect(decision.bestRaw.entry.sourceUnitId).toBe('guarded');
        expect(firedGuards(decision.bestRaw.signals)).toContain('guard_quote');
    });

    it('reports guarded when the only strong match is blocked', () => {
        const decision = decideVerdict([
            match(0.95, 'Er hatte 7000 Schafe und 3000 Rinder dabei.', 'Er hatte 9000 Schafe und 5000 Rinder dabei.'),
        ], DEFAULT_SHADOW_CONFIG);
        expect(decision.verdict).toBe('guarded');
        expect(decision.reason).toContain('guard_numbers');
    });

    it('reports related_with_new_content when the repeat carries new lexical tokens', () => {
        const decision = decideVerdict([
            match(0.88, 'Hiob hat lange gerungen heute.', 'Hiob rang lange mit Gott, Reichtum, Gesundheit und Familie.'),
        ], DEFAULT_SHADOW_CONFIG);
        expect(decision.verdict).toBe('related_with_new_content');
    });
});

describe('config validation', () => {
    it('accepts the defaults', () => {
        const { config, errors } = normalizeShadowConfig({ enabled: true });
        expect(errors).toEqual([]);
        expect(config.enabled).toBe(true);
        expect(config.maxQueueDepth).toBe(DEFAULT_SHADOW_CONFIG.maxQueueDepth);
    });

    it.each([
        ['maxQueueDepth', NaN],       // P27_SHADOW_MAX_QUEUE=abc -> parseInt -> NaN
        ['maxQueueDepth', 0],
        ['maxHistoryUnits', -1],
        ['windowSec', 0],
        ['windowSec', Infinity],
        ['maxNewLexicalTokens', -1],
        ['maxNewLexicalTokens', 1.5],
        ['tauHighPrecision', 1.4],
        ['tauExploratory', -0.1],
        ['secPerSourceWord', 0],
        ['minUnitWords', 0],
    ])('rejects %s=%s and disables measurement', (key, value) => {
        const { config, errors } = normalizeShadowConfig({ enabled: true, [key]: value });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain(key);
        expect(config.enabled).toBe(false);
    });

    it('rejects an exploratory threshold above the high-precision one', () => {
        const { config, errors } = normalizeShadowConfig({ enabled: true, tauExploratory: 0.9, tauHighPrecision: 0.75 });
        expect(errors.join(' ')).toContain('tauExploratory');
        expect(config.enabled).toBe(false);
    });

    it('never half-configures: a NaN queue bound would silently become unbounded', async () => {
        const logs = [];
        const shadow = createSourceSemanticRepeatShadow({
            embedFn: embedByKeyword,
            logFn: (entry) => logs.push(entry),
            config: { enabled: true, maxQueueDepth: Number('abc') },
        });
        expect(shadow.config.enabled).toBe(false);
        expect(logs[0]).toMatchObject({ verdict: 'unscored', reason: 'invalid_config', config_state: 'INVALID/DISABLED' });

        const queued = shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(queued).toBe(0);
        expect(logs.filter((entry) => entry.reason !== 'invalid_config')).toHaveLength(0);
    });
});

describe('shadow runtime', () => {
    const emitTwice = async (shadow, epoch = 'epoch-1') => {
        shadow.observe({ churchId: 'church-a', sessionEpoch: epoch, releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        shadow.observe({ churchId: 'church-a', sessionEpoch: epoch, releaseSeq: 2, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
    };

    it('flags a verbatim cross-emission repeat and estimates the audio with a named basis', async () => {
        const { shadow, logs } = makeShadow();
        await emitTwice(shadow);
        expect(logs).toHaveLength(2);
        expect(logs[0].verdict).toBe('keep');
        expect(logs[1].verdict).toBe('candidate_high_precision');
        expect(logs[1].best_eligible_release_seq).toBe(1);
        expect(logs[1].audio_estimate_basis).toBe('sec_per_source_word_constant');
        expect(logs[1].estimated_redundant_audio_sec).toBeCloseTo(6 * DEFAULT_SHADOW_CONFIG.secPerSourceWord, 2);
    });

    it('never compares units inside the same emission (that is INTRA territory)', async () => {
        const { shadow, logs } = makeShadow();
        shadow.observe({
            churchId: 'church-a',
            sessionEpoch: 'epoch-1',
            releaseSeq: 1,
            text: 'Seneca hat schon ein Buch geschrieben. Seneca hat schon ein Buch geschrieben.',
        });
        await shadow.idle();
        expect(logs).toHaveLength(2);
        expect(logs.every((entry) => entry.verdict === 'keep')).toBe(true);
    });

    it('isolates history per church', async () => {
        const { shadow, logs } = makeShadow();
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        shadow.observe({ churchId: 'church-b', sessionEpoch: 'epoch-9', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(logs.map((entry) => entry.verdict)).toEqual(['keep', 'keep']);
    });

    it('drops history when the session epoch changes', async () => {
        const { shadow, logs } = makeShadow();
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-2', releaseSeq: 2, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(logs[1].verdict).toBe('keep');
        expect(logs[1].history_units).toBe(0);
    });

    it('forgets units older than the time window', async () => {
        let clock = 1_000_000;
        const { shadow, logs } = makeShadow({ now: () => clock });
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        clock += (DEFAULT_SHADOW_CONFIG.windowSec + 5) * 1000;
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 2, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(logs[1].verdict).toBe('keep');
        expect(logs[1].reason).toBe('no_history');
    });

    it('keeps a repeat that returns after 88 s — the roter-Knopf case a 12-unit cap missed', async () => {
        let clock = 1_000_000;
        const { shadow, logs } = makeShadow({ now: () => clock });
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        clock += 88_000;
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 2, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(logs[1].verdict).toBe('candidate_high_precision');
        expect(logs[1].best_eligible_delta_sec).toBeCloseTo(88, 1);
    });

    it('caps history at maxHistoryUnits even inside the time window', async () => {
        const { shadow, logs } = makeShadow({ config: { maxHistoryUnits: 3 } });
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        for (let seq = 2; seq <= 6; seq++) {
            shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: seq, text: `Der rote Knopf wird heute gedrueckt Nummer ${seq}.` });
        }
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 7, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        const last = logs[logs.length - 1];
        expect(last.history_units).toBeLessThanOrEqual(3);
        expect(last.verdict).toBe('keep');
    });

    it('is fail-open when the embedding call throws', async () => {
        const { shadow, logs } = makeShadow({}, async () => { throw new Error('azure down'); });
        expect(() => shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' })).not.toThrow();
        await shadow.idle();
        expect(logs[0].verdict).toBe('unscored');
        expect(logs[0].reason).toBe('embed_error');
        expect(shadow.stats().unscored).toBe(1);
    });

    it('marks overflow as unscored instead of growing the queue without bound', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const { shadow, logs } = makeShadow({ config: { maxQueueDepth: 2 } }, async (text) => {
            await gate;
            return axisFor(text);
        });
        for (let seq = 1; seq <= 6; seq++) {
            shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: seq, text: `Seneca hat schon ein Buch geschrieben Nummer ${seq}.` });
        }
        release();
        await shadow.idle();
        const overflow = logs.filter((entry) => entry.reason === 'queue_overflow');
        expect(overflow.length).toBeGreaterThan(0);
        expect(overflow.every((entry) => entry.verdict === 'unscored')).toBe(true);
        expect(shadow.stats().dropped).toBe(overflow.length);
    });

    it('does nothing at all when the flag is off', async () => {
        const { shadow, logs } = makeShadow({ config: { enabled: false } });
        const queued = shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await shadow.idle();
        expect(queued).toBe(0);
        expect(logs).toHaveLength(0);
    });

    it('returns synchronously without awaiting the embedding (hot path stays untouched)', async () => {
        let resolveEmbed;
        const { shadow } = makeShadow({}, () => new Promise((resolve) => { resolveEmbed = () => resolve([1, 0, 0]); }));
        const before = Date.now();
        const queued = shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        expect(queued).toBe(1);
        expect(Date.now() - before).toBeLessThan(50);
        resolveEmbed();
        await shadow.idle();
    });

    it('never mutates the text it observes', async () => {
        const { shadow } = makeShadow();
        const text = 'Seneca hat schon ein Buch geschrieben.';
        const units = buildSourceUnits({ sessionEpoch: 'epoch-1', releaseSeq: 1, text });
        const snapshot = JSON.stringify(units);
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, units });
        await shadow.idle();
        expect(JSON.stringify(units)).toBe(snapshot);
        expect(text).toBe('Seneca hat schon ein Buch geschrieben.');
    });

    it('contains an unexpected throw from scoring instead of leaking a rejected promise', async () => {
        const rejections = [];
        const onRejection = (reason) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
            const { shadow, logs } = makeShadow();
            // A non-array embedding is handled; this makes the cosine step itself blow up.
            shadow._historyFor = () => { throw new Error('history exploded'); };
            expect(() => shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' })).not.toThrow();
            await shadow.idle();
            await new Promise((resolve) => setImmediate(resolve));

            expect(logs.at(-1)).toMatchObject({ verdict: 'unscored', reason: 'score_error' });
            expect(shadow.stats().unscored).toBe(1);
            expect(rejections).toHaveLength(0);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });

    it('survives a throwing logger', async () => {
        const shadow = createSourceSemanticRepeatShadow({
            embedFn: embedByKeyword,
            logFn: () => { throw new Error('log sink down'); },
            config: { enabled: true },
        });
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        await expect(shadow.idle()).resolves.toBeUndefined();
    });

    it('scores both thresholds in one pass over one embedding call', async () => {
        const embedFn = vi.fn(async (text) => (
            // weight 0.49 puts cosine at ~0.72: inside the exploratory band, below high precision.
            text.includes('zweite') ? mix(AXES.seneca, AXES.knopf, 0.49) : axisFor(text)
        ));
        const { shadow, logs } = makeShadow({}, embedFn);
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 1, text: 'Seneca hat schon ein Buch geschrieben.' });
        shadow.observe({ churchId: 'church-a', sessionEpoch: 'epoch-1', releaseSeq: 2, text: 'Seneca hat zweite schon ein Buch geschrieben.' });
        await shadow.idle();
        const second = logs[1];
        expect(embedFn).toHaveBeenCalledTimes(2);
        expect(second.best_raw_cosine).toBeGreaterThan(DEFAULT_SHADOW_CONFIG.tauExploratory);
        expect(second.best_raw_cosine).toBeLessThan(DEFAULT_SHADOW_CONFIG.tauHighPrecision);
        expect(second.verdict).toBe('candidate_exploratory');
        expect(second.candidate_exploratory).toBe(true);
        expect(second.candidate_high_precision).toBe(false);
    });
});
