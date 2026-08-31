import { afterEach, describe, expect, it } from 'vitest';
import {
    DENOMINATIONAL_STYLE_LANGUAGES,
    OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV,
    parseOperatorDenominationalTranslationStyles,
} from '../denominationalStyleConfig.js';
import { buildSystemPrompt } from '../translationService.js';

const completeStyles = (prefix) => Object.fromEntries(
    DENOMINATIONAL_STYLE_LANGUAGES.map((language) => [language, `${prefix} ${language} style`]),
);

afterEach(() => {
    delete process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV];
});

describe('operator denominational translation style', () => {
    it('uses a neutral public default', () => {
        const prompt = buildSystemPrompt('en');

        expect(prompt).toContain('use the operator-configured denominational translation style');
    });

    it('uses the operator-configured style for the selected language', () => {
        process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV] = JSON.stringify(
            completeStyles("the operator's synthetic"),
        );

        const prompt = buildSystemPrompt('en');

        expect(prompt).toContain("use the operator's synthetic en style conventions");
        expect(prompt).not.toContain('use the operator-configured denominational translation style');
    });

    it('keeps cached prompts isolated across A -> B -> A configuration changes', () => {
        const firstNeutralPrompt = buildSystemPrompt('en');
        process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV] = JSON.stringify(
            completeStyles('private operator'),
        );

        const configuredPrompt = buildSystemPrompt('en');
        delete process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV];
        const secondNeutralPrompt = buildSystemPrompt('en');

        expect(firstNeutralPrompt).not.toBe(configuredPrompt);
        expect(configuredPrompt).toContain('use private operator en style conventions');
        expect(secondNeutralPrompt).toBe(firstNeutralPrompt);
    });

    it('keeps language-specific styles isolated in one configuration', () => {
        process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV] = JSON.stringify(
            completeStyles('isolated'),
        );

        const englishPrompt = buildSystemPrompt('en');
        const frenchPrompt = buildSystemPrompt('fr');

        expect(englishPrompt).toContain('use isolated en style conventions');
        expect(englishPrompt).not.toContain('isolated fr style');
        expect(frenchPrompt).toContain('use isolated fr style conventions');
        expect(frenchPrompt).not.toContain('isolated en style');
    });

    it('requires and preserves the German entry in the complete operator contract', () => {
        const styles = completeStyles('complete');

        const parsed = parseOperatorDenominationalTranslationStyles(JSON.stringify(styles));

        expect(parsed.de).toBe('complete de style');
    });

    it('rejects an unsupported target language before building a broken prompt', () => {
        expect(() => buildSystemPrompt('xx')).toThrow(/Unsupported translation target language: xx/);
    });

    it('rejects malformed JSON instead of silently using the neutral prompt', () => {
        process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV] = '{broken';

        expect(() => buildSystemPrompt('en')).toThrow(/must contain valid JSON/);
    });

    it.each([
        ['an array', '[]', /JSON object keyed by language code/],
        ['an empty value', '', /must be omitted or contain a non-empty JSON object/],
    ])('rejects %s', (_label, rawValue, expectedError) => {
        process.env[OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV] = rawValue;

        expect(() => buildSystemPrompt('en')).toThrow(expectedError);
    });

    it('rejects a configuration missing any supported language', () => {
        const styles = completeStyles('incomplete');
        delete styles.de;

        expect(() => parseOperatorDenominationalTranslationStyles(JSON.stringify(styles)))
            .toThrow(/missing: de/);
    });

    it('rejects unexpected language keys', () => {
        const styles = { ...completeStyles('complete'), xx: 'unexpected style' };

        expect(() => parseOperatorDenominationalTranslationStyles(JSON.stringify(styles)))
            .toThrow(/unexpected: xx/);
    });

    it.each([
        ['empty', '   '],
        ['multiline', 'first line\nsecond line'],
        ['too long', 'x'.repeat(161)],
    ])('rejects a %s style value', (_label, invalidStyle) => {
        const styles = completeStyles('valid');
        styles.en = invalidStyle;

        expect(() => parseOperatorDenominationalTranslationStyles(JSON.stringify(styles)))
            .toThrow(/en must be a non-empty single-line string/);
    });
});
