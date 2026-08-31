export const OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV =
    'OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES';

export const DENOMINATIONAL_STYLE_LANGUAGES = Object.freeze([
    'ar', 'de', 'en', 'es', 'fr', 'it', 'pl', 'pt', 'ru', 'sw', 'tr', 'uk',
]);

export const DEFAULT_DENOMINATIONAL_TRANSLATION_STYLE =
    'use the operator-configured denominational translation style';

const MAX_STYLE_LENGTH = 160;

const configurationError = (message) => new Error(
    `Configuration error: ${OPERATOR_DENOMINATIONAL_TRANSLATION_STYLES_ENV} ${message}`,
);

export const parseOperatorDenominationalTranslationStyles = (rawValue) => {
    if (rawValue === undefined) return null;
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
        throw configurationError('must be omitted or contain a non-empty JSON object');
    }

    let parsed;
    try {
        parsed = JSON.parse(rawValue);
    } catch {
        throw configurationError('must contain valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw configurationError('must contain a JSON object keyed by language code');
    }

    const receivedLanguages = Object.keys(parsed);
    const missingLanguages = DENOMINATIONAL_STYLE_LANGUAGES.filter(
        (language) => !Object.hasOwn(parsed, language),
    );
    const unexpectedLanguages = receivedLanguages.filter(
        (language) => !DENOMINATIONAL_STYLE_LANGUAGES.includes(language),
    );
    if (missingLanguages.length || unexpectedLanguages.length) {
        const details = [
            missingLanguages.length ? `missing: ${missingLanguages.join(', ')}` : '',
            unexpectedLanguages.length ? `unexpected: ${unexpectedLanguages.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        throw configurationError(`must define exactly the supported languages (${details})`);
    }

    const normalized = {};
    for (const language of DENOMINATIONAL_STYLE_LANGUAGES) {
        const style = parsed[language];
        if (
            typeof style !== 'string'
            || !style.trim()
            || style.length > MAX_STYLE_LENGTH
            || /[\r\n]/.test(style)
        ) {
            throw configurationError(
                `${language} must be a non-empty single-line string of at most ${MAX_STYLE_LENGTH} characters`,
            );
        }
        normalized[language] = style.trim();
    }

    return Object.freeze(normalized);
};
