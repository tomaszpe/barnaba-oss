const positiveWordCount = (value) => (
    Number.isSafeInteger(value) && value > 0 ? value : null
);

export const safeSourceBoundaryWordIndexes = (sourceUnits, expectedWordCount) => {
    if (!Array.isArray(sourceUnits) || sourceUnits.length === 0
        || !Number.isSafeInteger(expectedWordCount) || expectedWordCount <= 0) return [];
    const boundaries = [];
    let consumedWords = 0;
    for (const [index, unit] of sourceUnits.entries()) {
        const words = positiveWordCount(unit?.words);
        if (words === null) return [];
        consumedWords += words;
        if (unit.closed === true && index < sourceUnits.length - 1) {
            boundaries.push(consumedWords);
        }
    }
    return consumedWords === expectedWordCount ? boundaries : [];
};
