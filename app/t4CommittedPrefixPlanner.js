import { isCompleteSourceMap, isCoordinateSpaceId } from './sourceMap.js';

const MAX_PROOFS = 4096;
const MAX_RANGES_PER_PROOF = 8192;

const validRange = (range) => (
    isCoordinateSpaceId(range?.coordinateSpaceId)
    && Number.isSafeInteger(range?.startSample)
    && Number.isSafeInteger(range?.endSample)
    && range.startSample >= 0
    && range.endSample > range.startSample
);

const rangeContainsWord = (range, word) => (
    range.coordinateSpaceId === word.coordinateSpaceId
    && range.startSample <= word.startSample
    && range.endSample >= word.endSample
);

const rangeOverlapsWord = (range, word) => (
    range.coordinateSpaceId === word.coordinateSpaceId
    && range.startSample < word.endSample
    && range.endSample > word.startSample
);

const proofCoverage = (proof, words) => words.map((word) => (
    proof.ranges.some((range) => rangeContainsWord(range, word))
));

const chronologicalPrefix = (proofs, coverageByProof, wordCount) => {
    let frontier = 0;
    const contributorReleaseSeqs = [];
    for (let proofIndex = 0; proofIndex < proofs.length && frontier < wordCount; proofIndex += 1) {
        const coverage = coverageByProof[proofIndex];
        const before = frontier;
        while (frontier < wordCount && coverage[frontier]) frontier += 1;
        if (frontier > before) contributorReleaseSeqs.push(proofs[proofIndex].releaseSeq);
    }
    return { frontier, contributorReleaseSeqs };
};

const topologyFor = ({ unionCoverage, chronologicalFrontier, hasBoundaryOverlap }) => {
    const wordCount = unionCoverage.length;
    const coveredCount = unionCoverage.filter(Boolean).length;
    if (coveredCount === 0) return hasBoundaryOverlap ? 'boundary_overlap_only' : 'none';
    const unionPrefix = unionCoverage.findIndex((covered) => !covered);
    const prefixLength = unionPrefix === -1 ? wordCount : unionPrefix;
    if (coveredCount === wordCount) {
        return chronologicalFrontier === wordCount ? 'full' : 'fragmented_non_actionable';
    }
    const coveredAfterGap = unionCoverage.slice(prefixLength + 1).some(Boolean);
    if (prefixLength > 0 && !coveredAfterGap && chronologicalFrontier === prefixLength) {
        return 'proved_prefix';
    }
    if (prefixLength === 0) {
        const firstCovered = unionCoverage.indexOf(true);
        const suffixOnly = firstCovered >= 0
            && unionCoverage.slice(firstCovered).every(Boolean);
        return suffixOnly ? 'suffix_non_actionable' : 'proved_committed_infix_non_actionable';
    }
    return 'fragmented_non_actionable';
};

const normalizedBoundaries = (value, wordCount) => {
    if (!Array.isArray(value) || value.length > wordCount) return [];
    return [...new Set(value.filter((boundary) => (
        Number.isSafeInteger(boundary) && boundary > 0 && boundary < wordCount
    )))].sort((left, right) => left - right);
};

export const planT4CommittedPrefix = ({
    sourceMap,
    proofs = [],
    safeBoundaryWordIndexes = [],
    ledgerVersion = 0,
    minRemovedWords = 3,
    maxBridgeWords = 2,
} = {}) => {
    if (!isCompleteSourceMap(sourceMap)) {
        return Object.freeze({
            eligible: false,
            action: 'unchanged',
            reason: 'source_not_provable',
            topology: 'ambiguous',
            provedPrefixWords: 0,
            safeBoundaryWord: 0,
            bridgeWords: 0,
            ledgerVersion,
        });
    }
    if (!Array.isArray(proofs) || proofs.length > MAX_PROOFS
        || proofs.some((proof) => (
            !Array.isArray(proof?.ranges)
            || proof.ranges.length > MAX_RANGES_PER_PROOF
            || proof.ranges.some((range) => !validRange(range))
            || !Number.isSafeInteger(proof.releaseSeq)
            || !Number.isSafeInteger(proof.committedAt)
        ))) {
        return Object.freeze({
            eligible: false,
            action: 'unchanged',
            reason: 'committed_source_not_provable',
            topology: 'ambiguous',
            provedPrefixWords: 0,
            safeBoundaryWord: 0,
            bridgeWords: 0,
            ledgerVersion,
        });
    }

    const orderedProofs = [...proofs].sort((left, right) => (
        left.committedAt - right.committedAt || left.releaseSeq - right.releaseSeq
    ));
    const words = sourceMap.provenWords;
    const coverageByProof = orderedProofs.map((proof) => proofCoverage(proof, words));
    const unionCoverage = words.map((_, wordIndex) => (
        coverageByProof.some((coverage) => coverage[wordIndex])
    ));
    const hasBoundaryOverlap = words.some((word, wordIndex) => (
        !unionCoverage[wordIndex]
        && orderedProofs.some((proof) => proof.ranges.some((range) => rangeOverlapsWord(range, word)))
    ));
    const chronological = chronologicalPrefix(
        orderedProofs, coverageByProof, sourceMap.wordCount,
    );
    const topology = topologyFor({
        unionCoverage,
        chronologicalFrontier: chronological.frontier,
        hasBoundaryOverlap,
    });
    const common = {
        topology,
        provedPrefixWords: chronological.frontier,
        committedWordCount: unionCoverage.filter(Boolean).length,
        contributorReleaseSeqs: Object.freeze(chronological.contributorReleaseSeqs),
        ledgerVersion,
    };

    if (topology === 'full') {
        return Object.freeze({
            eligible: true,
            action: 'suppress',
            reason: 'source_fully_committed',
            safeBoundaryWord: sourceMap.wordCount,
            bridgeWords: 0,
            ...common,
        });
    }
    if (topology !== 'proved_prefix') {
        return Object.freeze({
            eligible: false,
            action: 'unchanged',
            reason: topology,
            safeBoundaryWord: 0,
            bridgeWords: 0,
            ...common,
        });
    }

    const boundaries = normalizedBoundaries(safeBoundaryWordIndexes, sourceMap.wordCount);
    const safeBoundaryWord = boundaries.filter((boundary) => (
        boundary <= chronological.frontier
        && chronological.frontier - boundary <= maxBridgeWords
        && boundary >= minRemovedWords
    )).at(-1) || 0;
    if (!safeBoundaryWord) {
        const belowBenefit = chronological.frontier < minRemovedWords;
        return Object.freeze({
            eligible: false,
            action: 'unchanged',
            reason: belowBenefit ? 'proved_prefix_below_benefit' : 'no_safe_semantic_boundary',
            safeBoundaryWord: 0,
            bridgeWords: 0,
            ...common,
        });
    }
    return Object.freeze({
        eligible: true,
        action: 'resegment',
        reason: 'proved_prefix_safe_boundary',
        safeBoundaryWord,
        bridgeWords: chronological.frontier - safeBoundaryWord,
        ...common,
    });
};
