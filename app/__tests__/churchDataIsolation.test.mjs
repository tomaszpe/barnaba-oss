import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Church data isolation (S2 + S7).
 *
 * Why equivalence testing is not enough
 * -------------------------------------
 * The before/after comparison proves the refactor changed nothing for the REFERENCE
 * configuration - one church. It is green by construction when there is exactly one
 * church, so it says nothing about the failure that per-church data makes possible for
 * the first time: one congregation's terms reaching another's listeners.
 *
 * Why there is no setActiveChurch() in this file
 * ----------------------------------------------
 * There used to be, and it hid two real defects that review caught:
 *
 *   1. translateText() never called it. The production path built prompts for the
 *      'default' configuration while the tests and the capture set the context by
 *      hand - a green measurement of wiring that was not connected.
 *   2. buildSystemPrompt() took an explicit churchId for the proper nouns and the
 *      cache key, but pulled the glossary from the process-wide "active church". Ask
 *      for A while B is active and you got A's names beside B's terms - and it was
 *      cached under A.
 *
 * A process-wide switch cannot be right here anyway: the gateway serves several
 * congregations concurrently, so two interleaved requests would race for it. The id
 * is threaded explicitly, and these tests exercise it the way production does.
 */

const ORIGINAL_ENV = { ...process.env };

const restoreEnvironment = () => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
};

const CHURCH_A = {
    properNouns: ['AlphaName'],
    glossaryCategories: { alpha_local: 'Alpha-only category' },
    glossaryTerms: {
        Alphaterm: {
            // in STATIC_GLOSSARY_CATEGORIES, so it reaches the static glossary too
            category: 'trinity',
            context: 'alpha context',
            translations: { de: 'Alphaterm', en: 'Alpha term', it: 'Termine alfa', pl: 'Termin alfa' },
        },
    },
};

const CHURCH_B = {
    properNouns: ['BetaName'],
    glossaryCategories: { beta_local: 'Beta-only category' },
    glossaryTerms: {
        Betaterm: {
            category: 'trinity',
            context: 'beta context',
            translations: { de: 'Betaterm', en: 'Beta term', it: 'Termine beta', pl: 'Termin beta' },
        },
    },
};

// Italian, not Polish: the proper-noun instruction lives in 10 of the 12 language
// rule blocks and Polish is one of the two without it. That is a property of the
// frozen prompt, not of this refactor.
const LANG = 'it';
const PROBE = 'Alphaterm und Betaterm im selben Satz.';

describe('church data isolation - direct API', () => {
    let glossary;

    beforeEach(async () => {
        vi.resetModules();
        glossary = await import('../glossary/glossaryService.js');
        glossary.__setChurchDataForTests({ 'church-a': CHURCH_A, 'church-b': CHURCH_B });
        glossary.initGlossary();
    });

    it('keeps each congregation to its own terms', () => {
        const a = glossary.extractRelevantTerms(PROBE, LANG, 25, 'church-a').map((t) => t.source);
        const b = glossary.extractRelevantTerms(PROBE, LANG, 25, 'church-b').map((t) => t.source);

        expect(a).toContain('Alphaterm');
        expect(a).not.toContain('Betaterm');
        expect(b).toContain('Betaterm');
        expect(b).not.toContain('Alphaterm');

        expect(glossary.lookupTerm('Alphaterm', LANG, 'church-a')).not.toBeNull();
        expect(glossary.lookupTerm('Betaterm', LANG, 'church-a')).toBeNull();
        expect(glossary.lookupTerm('Alphaterm', LANG, 'church-b')).toBeNull();
    });

    it('does not leak terms through the static glossary cache', () => {
        // This is the cache that used to be keyed by language alone.
        const staticA = glossary.getStaticGlossary(LANG, 'church-a');
        const staticB = glossary.getStaticGlossary(LANG, 'church-b');
        const staticAgain = glossary.getStaticGlossary(LANG, 'church-a');

        // Non-emptiness first. Without it this test passes when getStaticGlossary
        // returns '' for everything - which is exactly what happened once, after a
        // careless global rename made the builder iterate its own empty accumulator.
        // "A does not contain B's term" is trivially true of an empty string.
        expect(staticA.length).toBeGreaterThan(100);
        expect(staticB.length).toBeGreaterThan(100);

        expect(staticA).toContain('Alphaterm');
        expect(staticA).not.toContain('Betaterm');
        expect(staticB).toContain('Betaterm');
        expect(staticB).not.toContain('Alphaterm');
        expect(staticAgain).toBe(staticA);
    });

    it('keeps category descriptions per congregation', () => {
        expect(Object.keys(glossary.getCategories('church-a'))).toContain('alpha_local');
        expect(Object.keys(glossary.getCategories('church-a'))).not.toContain('beta_local');
        expect(Object.keys(glossary.getCategories('church-b'))).toContain('beta_local');
    });

    it('an unknown congregation falls back to default without inheriting', () => {
        glossary.getStaticGlossary(LANG, 'church-a'); // warm A first
        expect(glossary.getProperNouns('unknown-church')).toEqual([]);
        expect(glossary.lookupTerm('Alphaterm', LANG, 'unknown-church')).toBeNull();
    });
});

describe('church data configuration - validation', () => {
    /**
     * An ABSENT file is supported; a PRESENT but broken one is not.
     *
     * They used to be the same thing: a JSON error was swallowed into an empty object,
     * so a deployment with a corrupted configuration started anyway and served every
     * congregation without its names or terms while looking healthy. A configuration
     * that exists is a statement of intent - failing to read it is an error, not a
     * reason to invent an empty one.
     */
    let validate;

    beforeEach(async () => {
        vi.resetModules();
        ({ validateChurchData: validate } = await import('../glossary/glossaryService.js'));
    });

    const bad = [
        ['top level is an array', []],
        ['top level is null', null],
        ['entry is not an object', { 'church-a': 'nope' }],
        ['properNouns is not an array', { 'church-a': { properNouns: 'AlphaName' } }],
        ['properNouns holds a blank', { 'church-a': { properNouns: ['ok', '  '] } }],
        ['glossaryTerms is an array', { 'church-a': { glossaryTerms: [] } }],
        ['glossaryCategories is an array', { 'church-a': { glossaryCategories: [] } }],
        ['record is not an object', { 'church-a': { glossaryTerms: { T: 'x' } } }],
        ['record has no translations', { 'church-a': { glossaryTerms: { T: { category: 'c' } } } }],
        ['record has empty translations', { 'church-a': { glossaryTerms: { T: { translations: {} } } } }],
        // The three below were ACCEPTED by the first version of the validator. The first
        // one is the whole point: a present key with an empty value reproduces exactly the
        // silent missing translation the check exists to prevent - the record looks
        // complete and extractRelevantTerms drops it at run time without a word.
        ['translation value is an empty string', { 'church-a': { glossaryTerms: { T: { category: 'c', translations: { de: '' } } } } }],
        ['translation value is not a string', { 'church-a': { glossaryTerms: { T: { category: 'c', translations: { de: 123 } } } } }],
        ['category description is an empty string', { 'church-a': { glossaryCategories: { x: '' } } }],
        ['record has no category', { 'church-a': { glossaryTerms: { T: { translations: { de: 'x' } } } } }],
        ['context is present but blank', { 'church-a': { glossaryTerms: { T: { category: 'c', context: '  ', translations: { de: 'x' } } } } }],
        ['language code is blank', { 'church-a': { glossaryTerms: { T: { category: 'c', translations: { '': 'x' } } } } }],
        ['term name is blank', { 'church-a': { glossaryTerms: { '  ': { category: 'c', translations: { de: 'x' } } } } }],
    ];

    for (const [name, payload] of bad) {
        it(`rejects: ${name}`, () => {
            expect(() => validate(payload, 'test.json')).toThrow();
        });
    }

    it('accepts a complete, well-formed configuration', () => {
        expect(() => validate({ 'church-a': CHURCH_A, 'church-b': CHURCH_B }, 'test.json')).not.toThrow();
    });

    it('accepts an entry that omits every optional section', () => {
        expect(() => validate({ 'church-a': {} }, 'test.json')).not.toThrow();
    });

    it('accepts a record without context, which is optional', () => {
        const payload = { 'church-a': { glossaryTerms: { T: { category: 'c', translations: { de: 'x' } } } } };
        expect(() => validate(payload, 'test.json')).not.toThrow();
    });
});

describe('glossary statistics', () => {
    let glossary;

    beforeEach(async () => {
        vi.resetModules();
        glossary = await import('../glossary/glossaryService.js');
        glossary.__setChurchDataForTests({ 'church-a': CHURCH_A });
        glossary.initGlossary();
    });

    it('counts terms instead of trusting the declared metadata', () => {
        // totalTerms used to be glossary.termCount - a number written in the JSON that
        // drifted from the file it described. A statistic nobody can trust is worse than
        // none, and this one is the obvious place to check "did the split lose records".
        const base = glossary.getGlossaryStats();
        const withChurch = glossary.getGlossaryStats('church-a');

        expect(withChurch.totalTerms).toBe(base.totalTerms + 1);
        expect(base.declaredTermCount).toBeTypeOf('number');
    });
});

describe('church data isolation - through translateText', () => {
    afterEach(() => {
        restoreEnvironment();
        vi.doUnmock('openai');
        vi.resetModules();
        vi.restoreAllMocks();
    });

    /** Boots the service with a stub provider that records the system prompt it is sent. */
    async function bootWithStub() {
        process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
        process.env.AZURE_OPENAI_KEY = 'test-key';
        process.env.TRANSLATION_VARIANT = 'A';

        const systemPrompts = [];
        const create = vi.fn((payload) => {
            const system = (payload.messages || []).find((m) => m.role === 'system');
            systemPrompts.push(system ? system.content : '');
            return {
                withResponse: async () => ({
                    data: {
                        choices: [{ message: { content: 'tradotto' }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 10, completion_tokens: 5 },
                    },
                    response: { headers: { 'apim-request-id': 'stub' } },
                    request_id: null,
                }),
            };
        });
        vi.doMock('openai', () => ({
            default: class OpenAIMock {
                constructor() {
                    this.chat = { completions: { create } };
                }
            },
        }));

        vi.resetModules();
        const glossary = await import('../glossary/glossaryService.js');
        glossary.__setChurchDataForTests({ 'church-a': CHURCH_A, 'church-b': CHURCH_B });
        glossary.initGlossary();

        const service = await import('../translationService.js');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        service.initTranslationService();

        return { service, systemPrompts };
    }

    // Each of these calls bootWithStub(), which does vi.resetModules() and then re-imports
    // translationService.js and the whole glossary graph (340 terms x 12 languages) from
    // scratch. That setup, not the assertion, is what takes the time - on a cold filesystem
    // it can exceed vitest's 5 s default and fail a test that is checking isolation, not
    // speed. The budget is stated here rather than raised globally, so a genuine hang
    // anywhere else in the suite still fails fast.
    const BOOT_TIMEOUT_MS = 30_000;

    it('sends each congregation its own prompt, A then B then A', async () => {
        const { service, systemPrompts } = await bootWithStub();

        await service.translateText('Gott ist gut.', LANG, 'church-a');
        await service.translateText('Gott ist gut.', LANG, 'church-b');
        await service.translateText('Gott ist gut.', LANG, 'church-a');

        expect(systemPrompts).toHaveLength(3);
        const [first, second, third] = systemPrompts;

        expect(first).toContain('AlphaName');
        expect(first).not.toContain('BetaName');
        expect(first).not.toContain('Betaterm');

        expect(second).toContain('BetaName');
        expect(second).not.toContain('AlphaName');
        expect(second).not.toContain('Alphaterm');

        // The return trip is the part a merely-overwritten cache fails.
        expect(third).toBe(first);
    }, BOOT_TIMEOUT_MS);

    it('keeps interleaved concurrent requests apart', async () => {
        const { service, systemPrompts } = await bootWithStub();

        await Promise.all([
            service.translateText('Gott ist gut.', LANG, 'church-a'),
            service.translateText('Gott ist gut.', LANG, 'church-b'),
            service.translateText('Gott ist gut.', LANG, 'church-a'),
            service.translateText('Gott ist gut.', LANG, 'church-b'),
        ]);

        expect(systemPrompts).toHaveLength(4);
        for (const prompt of systemPrompts) {
            // Whichever order they resolved in, no prompt may mix the two.
            const hasAlpha = prompt.includes('AlphaName') || prompt.includes('Alphaterm');
            const hasBeta = prompt.includes('BetaName') || prompt.includes('Betaterm');
            expect(hasAlpha && hasBeta).toBe(false);
        }
        expect(systemPrompts.some((p) => p.includes('AlphaName'))).toBe(true);
        expect(systemPrompts.some((p) => p.includes('BetaName'))).toBe(true);
    }, BOOT_TIMEOUT_MS);

    it('does not fall back to the default configuration for a known church', async () => {
        const { service, systemPrompts } = await bootWithStub();

        await service.translateText('Gott ist gut.', LANG, 'church-a');

        // The defect this catches: translateText ignoring its churchId and building the
        // 'default' prompt, which carries no proper nouns at all.
        expect(systemPrompts[0]).toContain('AlphaName');
    }, BOOT_TIMEOUT_MS);
});
