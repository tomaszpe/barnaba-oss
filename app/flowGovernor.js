const DEFAULT_FLOW_GOVERNOR_CONFIG = {
    enabled: true,
    minStableWords: 5,
    minStableChars: 28,
    minMicroEmitWords: 4,
    minMicroEmitChars: 24,
    normalSoftCommitAgeMs: 9000,
    fastSoftCommitAgeMs: 5000,
    catchupSoftCommitAgeMs: 3500,
    criticalSoftCommitAgeMs: 2500,
    forceFallbackAgeMs: 7000,
    criticalForceFallbackAgeMs: 4500,
    maxHoldAgeMs: 12000,
    minCompletenessScore: 0.45,
    strongCompletenessScore: 0.75,
    stablePrefixRatioForCommit: 0.55,
    riskyShortWords: ['amen', 'ja', 'nein', 'und', 'oder', 'aber', 'also'],
};

const TERMINAL_PUNCTUATION = /[.!?]$/;
const SOFT_BOUNDARY = /[,;:]$/;
const CLAUSE_STARTERS = new Set([
    'aber', 'denn', 'deshalb', 'darum', 'also', 'nun', 'jetzt', 'jedoch',
    'trotzdem', 'doch', 'weil', 'obwohl', 'wenn', 'falls', 'damit',
]);

function normalizeFlowGovernorConfig(config = {}) {
    return {
        ...DEFAULT_FLOW_GOVERNOR_CONFIG,
        ...config,
        enabled: config.enabled !== false,
        riskyShortWords: config.riskyShortWords || DEFAULT_FLOW_GOVERNOR_CONFIG.riskyShortWords,
    };
}

function decideFlowGovernor(input = {}, config = {}) {
    const cfg = normalizeFlowGovernorConfig(config);
    const signals = normalizeFlowSignals(input, cfg);

    if (!cfg.enabled) {
        return buildDecision('would_hold', 'flow_governor_disabled', signals);
    }

    if (!signals.text) {
        return buildDecision('would_hold', 'empty_text', signals);
    }

    if (signals.isFinal && signals.wordCount >= cfg.minMicroEmitWords) {
        return buildDecision('would_micro_emit', 'final_flush', signals);
    }

    if (signals.riskyShortFragment) {
        return signals.ageMs >= cfg.maxHoldAgeMs
            ? buildDecision('would_merge_to_next', 'risky_short_fragment_too_old', signals)
            : buildDecision('would_hold', 'risky_short_fragment', signals);
    }

    if (shouldForceFallback(signals, cfg)) {
        return buildDecision('would_force_fallback', 'age_budget_forces_partial_fallback', signals);
    }

    if (canSoftCommit(signals, cfg)) {
        return buildDecision('would_soft_commit_prefix', 'stable_prefix_age_budget', signals);
    }

    if (canMicroEmit(signals, cfg)) {
        return buildDecision('would_micro_emit', signals.terminalBoundary ? 'complete_micro_phrase' : 'strong_clause_boundary', signals);
    }

    if (signals.ageMs >= cfg.maxHoldAgeMs) {
        return buildDecision('would_merge_to_next', 'max_hold_without_safe_release', signals);
    }

    return buildDecision('would_hold', signals.stablePrefixWordCount > 0 ? 'waiting_for_safe_boundary' : 'waiting_for_stability', signals);
}

function buildFlowGovernorShadowMetric(decision, payload = {}) {
    const d = decision || decideFlowGovernor(payload.signals, payload.config);
    return {
        stage: 'flow_governor_shadow',
        churchId: payload.churchId ?? null,
        sessionId: payload.sessionId ?? null,
        emissionId: payload.emissionId ?? null,
        profile: d.profile,
        decision: d.decision,
        reason: d.reason,
        age_ms: d.ageMs,
        word_count: d.wordCount,
        char_count: d.charCount,
        stable_prefix_word_count: d.stablePrefixWordCount,
        stable_prefix_char_count: d.stablePrefixCharCount,
        stable_prefix_ratio: d.stablePrefixRatio,
        semantic_complete: d.semanticComplete,
        completeness_score: d.completenessScore,
        terminal_boundary: d.terminalBoundary,
        soft_boundary: d.softBoundary,
        risky_short_fragment: d.riskyShortFragment,
        source: payload.source ?? null,
    };
}

function logFlowGovernorShadowDecision(logFn, payload = {}) {
    const decision = decideFlowGovernor(payload.signals, payload.config);
    logFn(buildFlowGovernorShadowMetric(decision, payload));
    return decision;
}

function shouldForceFallback(signals, config) {
    if (signals.profile === 'normal') return false;
    const threshold = signals.profile === 'critical'
        ? config.criticalForceFallbackAgeMs
        : config.forceFallbackAgeMs;

    return signals.ageMs >= threshold
        && signals.wordCount >= config.minMicroEmitWords
        && signals.completenessScore >= config.minCompletenessScore;
}

function canSoftCommit(signals, config) {
    if (!['fast', 'catchup', 'critical'].includes(signals.profile)) return false;
    const threshold = profileSoftCommitThreshold(signals.profile, config);

    return signals.ageMs >= threshold
        && signals.stablePrefixWordCount >= config.minStableWords
        && signals.stablePrefixCharCount >= config.minStableChars
        && signals.stablePrefixRatio >= config.stablePrefixRatioForCommit
        && signals.completenessScore >= config.minCompletenessScore;
}

function canMicroEmit(signals, config) {
    if (signals.wordCount < config.minMicroEmitWords || signals.charCount < config.minMicroEmitChars) {
        return false;
    }

    if (signals.terminalBoundary && signals.completenessScore >= config.minCompletenessScore) {
        return true;
    }

    if (signals.profile === 'normal') return false;

    return signals.softBoundary
        && signals.ageMs >= profileSoftCommitThreshold(signals.profile, config)
        && signals.completenessScore >= config.strongCompletenessScore;
}

function profileSoftCommitThreshold(profile, config) {
    if (profile === 'critical') return config.criticalSoftCommitAgeMs;
    if (profile === 'catchup') return config.catchupSoftCommitAgeMs;
    if (profile === 'fast') return config.fastSoftCommitAgeMs;
    return config.normalSoftCommitAgeMs;
}

function normalizeFlowSignals(input = {}, config = DEFAULT_FLOW_GOVERNOR_CONFIG) {
    const text = normalizeWhitespace(input.text ?? input.partialText ?? input.fullText ?? '');
    const stablePrefix = deriveStablePrefix(input, text);
    const profile = normalizeProfile(input.flowGovernorProfile ?? input.profile ?? input.autopilotProfile);
    const wordCount = countWords(text);
    const stablePrefixWordCount = countWords(stablePrefix);
    const semanticComplete = input.semanticComplete === true;
    const completenessScore = normalizeCompletenessScore(
        input.completenessScore,
        estimateCompletenessScore(text, {
            semanticComplete,
            terminalBoundary: TERMINAL_PUNCTUATION.test(text),
            softBoundary: SOFT_BOUNDARY.test(text),
            wordCount,
        }),
    );

    return {
        text,
        stablePrefix,
        profile,
        ageMs: Math.max(0, Number(input.ageMs ?? input.segmentAgeMs) || 0),
        isFinal: input.isFinal === true,
        semanticComplete,
        completenessScore,
        wordCount,
        charCount: text.length,
        stablePrefixWordCount,
        stablePrefixCharCount: stablePrefix.length,
        stablePrefixRatio: text.length ? round(stablePrefix.length / text.length) : 0,
        terminalBoundary: TERMINAL_PUNCTUATION.test(text),
        softBoundary: SOFT_BOUNDARY.test(text),
        riskyShortFragment: isRiskyShortFragment(text, wordCount, config),
    };
}

function deriveStablePrefix(input, text) {
    const explicit = normalizeWhitespace(input.stablePrefix ?? input.confirmedPrefix ?? '');
    if (explicit) return explicit;

    const stableWords = Math.max(0, Number(input.stablePrefixWords) || 0);
    if (!stableWords) return '';
    return text.split(/\s+/).slice(0, stableWords).join(' ');
}

function estimateCompletenessScore(text, context) {
    if (!text) return 0;
    if (context.semanticComplete) return 1;
    if (context.terminalBoundary) return 0.85;
    if (context.softBoundary && context.wordCount >= 6) return 0.65;
    if (context.wordCount >= 10) return 0.55;
    if (context.wordCount >= 4 && hasClauseStarter(text)) return 0.45;
    return 0.25;
}

function normalizeCompletenessScore(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return clamp01(fallback);
    return clamp01(numeric);
}

function isRiskyShortFragment(text, wordCount, config) {
    if (!text || wordCount > 3) return false;
    const normalizedWords = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter(Boolean);
    if (!normalizedWords.length) return true;
    return normalizedWords.every(word => config.riskyShortWords.includes(word));
}

function hasClauseStarter(text) {
    const firstWord = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .find(Boolean);
    return CLAUSE_STARTERS.has(firstWord);
}

function normalizeProfile(profile) {
    if (profile === 'critical') return 'critical';
    if (profile === 'catchup') return 'catchup';
    if (profile === 'fast') return 'fast';
    return 'normal';
}

function buildDecision(decision, reason, signals) {
    return {
        decision,
        reason,
        profile: signals.profile,
        ageMs: signals.ageMs,
        text: signals.text,
        stablePrefix: signals.stablePrefix,
        wordCount: signals.wordCount,
        charCount: signals.charCount,
        stablePrefixWordCount: signals.stablePrefixWordCount,
        stablePrefixCharCount: signals.stablePrefixCharCount,
        stablePrefixRatio: signals.stablePrefixRatio,
        semanticComplete: signals.semanticComplete,
        completenessScore: signals.completenessScore,
        terminalBoundary: signals.terminalBoundary,
        softBoundary: signals.softBoundary,
        riskyShortFragment: signals.riskyShortFragment,
    };
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function countWords(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

function round(value) {
    return Math.round(value * 10000) / 10000;
}

export {
    DEFAULT_FLOW_GOVERNOR_CONFIG,
    buildFlowGovernorShadowMetric,
    decideFlowGovernor,
    logFlowGovernorShadowDecision,
    normalizeFlowGovernorConfig,
    normalizeFlowSignals,
};
