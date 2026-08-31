const RHETORICAL_REPEAT_CUES = [
    /\bich\s+sage\s+es\s+(?:nochmals|noch\s+einmal|wieder)\b/iu,
    /\bich\s+wiederhole\s+(?:es|das|dies)\b/iu,
    /\bich\s+möchte\s+(?:es|das|dies)\s+wiederholen\b/iu,
];

export const hasRhetoricalRepeatIntent = (text) => (
    RHETORICAL_REPEAT_CUES.some((pattern) => pattern.test(String(text || '')))
);

const normalizeForExactRepeat = (text) => String(text || '')
    .toLocaleLowerCase('de-DE')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const protectRhetoricalRepeat = ({ text, proposedAction, previousText = '' }) => {
    const current = normalizeForExactRepeat(text);
    const previous = normalizeForExactRepeat(previousText);
    const immediateExactRepeat = current.length > 0 && current === previous;
    if (proposedAction !== 'skip' || immediateExactRepeat || !hasRhetoricalRepeatIntent(text)) {
        return { text, action: proposedAction, rhetoricalRepeat: false };
    }
    return {
        text,
        action: 'emit',
        rhetoricalRepeat: true,
        reason: 'explicit_rhetorical_repeat',
    };
};
