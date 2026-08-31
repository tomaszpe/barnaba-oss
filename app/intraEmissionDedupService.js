const DEFAULT_CONFIG = {
    enabled: false,
    minContentTokens: 5,
    containmentThreshold: 0.72,
    prefixTokenThreshold: 4,
    minNewContentTokens: 2,
    maxRemovalRatio: 0.5,
    maxLookahead: 2,
    // Phase 1 (25.06): repeated-phrase guard. A contiguous run of >= N raw tokens
    // shared between two units, covering >= coverage of the shorter unit, is a
    // streaming/ASR duplicate (id 8/25/81/82/88). Below N tokens it is treated as
    // rhetorical anaphora and kept ("Gott ist gut. Gott ist gut.", "warum, warum").
    repeatedRunMinTokens: 4,
    repeatedRunMinCoverage: 0.7,
    semanticEnabled: false,
    semanticDryRun: true,
    semanticSimilarityThreshold: 0.78,
    semanticContainmentThreshold: 0.25,
    semanticMinPreviousTokens: 2,
    semanticMinCurrentTokens: 3,
};

const STOPWORDS = new Set([
    'aber', 'alle', 'allem', 'allen', 'aller', 'alles', 'als', 'also', 'am',
    'an', 'auch', 'auf', 'aus', 'bei', 'bin', 'bis', 'bist', 'da', 'damit',
    'dann', 'das', 'dass', 'dein', 'dem', 'den', 'der', 'des', 'die', 'dies',
    'diese', 'dieser', 'dieses', 'doch', 'du', 'ein', 'eine', 'einem', 'einen',
    'einer', 'eines', 'er', 'es', 'für', 'ganz', 'hat', 'hast', 'hatte',
    'haben', 'ich', 'im', 'in', 'ist', 'ja', 'jetzt', 'man', 'mit', 'nicht',
    'fur', 'noch', 'nun', 'oder', 'sich', 'sie', 'sind', 'so', 'und', 'uns', 'von',
    'war', 'was', 'wenn', 'wer', 'wie', 'wir', 'wird', 'zu', 'zum', 'zur',
]);

function normalizeConfig(config = {}) {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        enabled: config.enabled === true,
        semanticEnabled: config.semanticEnabled === true,
        semanticDryRun: config.semanticDryRun !== false,
    };
}

function splitUnits(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    const matches = trimmed.match(/[^.!?]+[.!?]+(?:["'»”])?|[^.!?]+$/g) || [];
    return matches.map((raw, index) => ({
        index,
        raw: raw.trim(),
    })).filter(unit => unit.raw.length > 0);
}

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss')
        .match(/[\p{L}\p{N}]+/gu) || [];
}

function contentTokens(text) {
    return tokenize(text).filter(token => token.length > 2 && !STOPWORDS.has(token));
}

function unique(tokens) {
    return [...new Set(tokens)];
}

function setIntersectionSize(a, b) {
    let count = 0;
    for (const item of a) {
        if (b.has(item)) count++;
    }
    return count;
}

function tokenStats(aText, bText) {
    const aTokens = contentTokens(aText);
    const bTokens = contentTokens(bText);
    const aSet = new Set(aTokens);
    const bSet = new Set(bTokens);
    const intersection = setIntersectionSize(aSet, bSet);
    const minSize = Math.min(aSet.size, bSet.size);
    const unionSize = aSet.size + bSet.size - intersection;
    return {
        aTokens,
        bTokens,
        aSet,
        bSet,
        intersection,
        containment: minSize > 0 ? intersection / minSize : 0,
        jaccard: unionSize > 0 ? intersection / unionSize : 0,
        newInB: unique(bTokens.filter(token => !aSet.has(token))).length,
        newInA: unique(aTokens.filter(token => !bSet.has(token))).length,
    };
}

function commonPrefixTokens(aText, bText) {
    const a = contentTokens(aText);
    const b = contentTokens(bText);
    let count = 0;
    while (count < a.length && count < b.length && a[count] === b[count]) {
        count++;
    }
    return count;
}

function commonPrefixAllTokens(aText, bText) {
    const a = tokenize(aText);
    const b = tokenize(bText);
    let count = 0;
    while (count < a.length && count < b.length && a[count] === b[count]) {
        count++;
    }
    return count;
}

function hasConflictingNumbers(aText, bText) {
    const a = new Set(String(aText || '').match(/\d+/g) || []);
    const b = new Set(String(bText || '').match(/\d+/g) || []);
    if (a.size === 0 && b.size === 0) return false;
    if (a.size === 0 || b.size === 0) return false;
    if (a.size !== b.size) return true;
    for (const value of a) {
        if (!b.has(value)) return true;
    }
    return false;
}

function hasNegationFlip(aText, bText) {
    const negations = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nie', 'niemals', 'without', 'not', 'no']);
    const a = tokenize(aText).some(token => negations.has(token));
    const b = tokenize(bText).some(token => negations.has(token));
    return a !== b;
}

// Guard #4 (Phase 1): a single stray leading »/«/„ is an ASR artifact, not a
// citation — strip it before any protection check. We only protect a unit that
// carries a BALANCED quote (opening AND closing mark) enclosing real content
// (e.g. a Scripture quote), or a numbered/decimal marker. id 25/73 carry stray
// guillemets around a plain duplicate and must NOT be protected.
function stripEdgeArtifacts(text) {
    return String(text || '')
        .replace(/^[\s"'«»„“”]+/, '')
        .replace(/[\s"'«»„“”]+$/, '')
        .trim();
}

function hasBalancedQuote(text) {
    const value = String(text || '');
    if (/«[^«»]*»/.test(value)) return true;
    if (/„[^„“”]*[“”]/.test(value)) return true;
    // a straight-quote pair enclosing at least a few characters
    if (/"[^"]{3,}"/.test(value)) return true;
    return false;
}

function looksLikeProtectedRepeat(text) {
    const value = String(text || '').trim();
    if (hasBalancedQuote(value)) return true;
    if (/^\d+[.)]/.test(value)) return true;
    if (/\b\d+\s*[,.:]\s*\d+\b/.test(value)) return true;
    return false;
}

// Longest run of identical consecutive raw tokens shared by two token arrays.
function longestCommonRun(aTokens, bTokens) {
    const m = aTokens.length;
    const n = bTokens.length;
    if (m === 0 || n === 0) return 0;
    let best = 0;
    let prev = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        const curr = new Array(n + 1).fill(0);
        for (let j = 1; j <= n; j++) {
            if (aTokens[i - 1] === bTokens[j - 1]) {
                curr[j] = prev[j - 1] + 1;
                if (curr[j] > best) best = curr[j];
            }
        }
        prev = curr;
    }
    return best;
}

// One pass: find the first immediately-repeated contiguous block of >= minRunTokens
// raw tokens and return the text with the FIRST copy removed plus the removed
// fragment. Returns null when there is nothing to collapse.
function findImmediateRepeat(text, minRunTokens) {
    const s = String(text || '');
    const spans = [];
    const re = /[\p{L}\p{N}]+/gu;
    let match;
    while ((match = re.exec(s)) !== null) {
        spans.push({
            norm: tokenize(match[0])[0] || match[0].toLowerCase(),
            start: match.index,
        });
    }
    const n = spans.length;
    for (let p = Math.floor(n / 2); p >= minRunTokens; p--) {
        for (let i = 0; i + 2 * p <= n; i++) {
            let equal = true;
            for (let k = 0; k < p; k++) {
                if (spans[i + k].norm !== spans[i + p + k].norm) { equal = false; break; }
            }
            if (equal) {
                const fragment = s.slice(spans[i].start, spans[i + p].start);
                const cut = s.slice(0, spans[i].start) + s.slice(spans[i + p].start);
                return {
                    text: cut.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim(),
                    fragment: fragment.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim(),
                };
            }
        }
    }
    return null;
}

// Guard #3 (Phase 1): collapse immediately-repeated contiguous blocks WITHIN one
// unit (id 81 unit[2]: "...beantwortet, ...beantwortet, sondern"). Returns the
// cleaned text AND the list of removed fragments so callers can log exactly what
// was consolidated (id 42/80 are collapse-only: no whole unit is dropped, so the
// scorecard would otherwise see a trim with empty decisions). Only blocks of
// >= minRunTokens collapse, so short rhetoric ("warum, warum, warum") is kept.
function collapseInternalRepeatDetailed(text, minRunTokens) {
    let current = String(text || '');
    const removed = [];
    for (let guard = 0; guard < 50; guard++) {
        const step = findImmediateRepeat(current, minRunTokens);
        if (!step) break;
        removed.push(step.fragment);
        current = step.text;
    }
    return { text: current.replace(/\s{2,}/g, ' ').trim(), removed };
}

function collapseInternalRepeat(text, minRunTokens) {
    return collapseInternalRepeatDetailed(text, minRunTokens).text;
}

// A non-adjacent repeat whose intervening unit shares a content token with the
// pair is intentional anaphora (id 73: "...warum." / "Warum, warum, warum?" /
// "...warum."), not an artifact — keep it. Disjoint intervening content (id 8:
// reordered ASR fragment) means the repeat is safe to drop.
function interveningSharesContent(units, i, j) {
    if (j - i <= 1) return false;
    const anchor = new Set([...contentTokens(units[i].raw), ...contentTokens(units[j].raw)]);
    for (let k = i + 1; k < j; k++) {
        if (contentTokens(units[k].raw).some(token => anchor.has(token))) return true;
    }
    return false;
}

function classifyPair(previous, current, config = {}, semantic = {}) {
    const cfg = normalizeConfig({ enabled: true, ...config });
    if (!previous || !current) return { action: 'keep', reason: 'missing_unit' };
    if (looksLikeProtectedRepeat(previous) || looksLikeProtectedRepeat(current)) {
        return { action: semantic.similarity >= cfg.semanticSimilarityThreshold ? 'blocked' : 'keep', reason: 'protected_repeat' };
    }
    if (hasConflictingNumbers(previous, current)) {
        return { action: semantic.similarity >= cfg.semanticSimilarityThreshold ? 'blocked' : 'keep', reason: 'conflicting_numbers' };
    }
    if (hasNegationFlip(previous, current)) {
        return { action: semantic.similarity >= cfg.semanticSimilarityThreshold ? 'blocked' : 'keep', reason: 'negation_flip' };
    }

    const stats = tokenStats(previous, current);
    const prefix = commonPrefixTokens(previous, current);
    const rawPrefix = commonPrefixAllTokens(previous, current);
    const isPrefixFragment =
        (stats.aSet.size >= Math.max(3, cfg.minContentTokens - 2) || rawPrefix >= 5) &&
        stats.containment >= 0.95 &&
        stats.newInB >= cfg.minNewContentTokens &&
        (prefix >= Math.max(2, cfg.prefixTokenThreshold - 1) || rawPrefix >= 5);

    if (isPrefixFragment) {
        return { action: 'drop_previous', reason: 'prefix_fragment_correction', prefix, rawPrefix, ...stats };
    }

    if (cfg.semanticEnabled && Number.isFinite(semantic.similarity)) {
        const semanticCorrection =
            semantic.similarity >= cfg.semanticSimilarityThreshold &&
            stats.containment >= cfg.semanticContainmentThreshold &&
            stats.aSet.size >= cfg.semanticMinPreviousTokens &&
            stats.bSet.size >= cfg.semanticMinCurrentTokens &&
            stats.newInB >= cfg.minNewContentTokens &&
            current.length >= previous.length;

        if (semanticCorrection) {
            return {
                action: 'drop_previous',
                reason: 'semantic_correction',
                prefix,
                semanticSimilarity: semantic.similarity,
                ...stats,
            };
        }
    }

    // Guard #1 + #2 (Phase 1): a long contiguous shared token run is a streaming
    // duplicate regardless of unit length — this fires BEFORE the too_short and
    // length>80 gates that previously let id 8/25/81/88 through. Conflicting
    // numbers / negation flips were already returned above (guard #5), so a run
    // that reaches here is safe. Below repeatedRunMinTokens we fall through and
    // short rhetorical anaphora is preserved.
    const rawA = tokenize(previous);
    const rawB = tokenize(current);
    const sharedRun = longestCommonRun(rawA, rawB);
    const minRawLen = Math.min(rawA.length, rawB.length);
    const runCoverage = minRawLen > 0 ? sharedRun / minRawLen : 0;
    if (sharedRun >= cfg.repeatedRunMinTokens && runCoverage >= cfg.repeatedRunMinCoverage) {
        const coverA = rawA.length > 0 ? sharedRun / rawA.length : 0;
        const coverB = rawB.length > 0 ? sharedRun / rawB.length : 0;
        return {
            action: coverA >= coverB ? 'drop_previous' : 'drop_current',
            reason: 'repeated_phrase',
            run: sharedRun,
            runCoverage: Number(runCoverage.toFixed(4)),
            prefix,
            ...stats,
        };
    }

    if (stats.aSet.size < cfg.minContentTokens || stats.bSet.size < cfg.minContentTokens) {
        return { action: 'keep', reason: 'too_short', ...stats };
    }

    const isExpandedCorrection =
        stats.containment >= cfg.containmentThreshold &&
        stats.newInB >= cfg.minNewContentTokens &&
        (prefix >= cfg.prefixTokenThreshold || stats.jaccard >= 0.58);

    if (isExpandedCorrection) {
        return { action: 'drop_previous', reason: 'expanded_correction', prefix, ...stats };
    }

    const isExactDuplicate =
        stats.containment === 1 &&
        stats.jaccard === 1 &&
        previous.trim().toLowerCase() === current.trim().toLowerCase();

    // Guard #2 (Phase 1): drop the arbitrary length>80 gate. An exact duplicate is
    // safe to collapse as long as it is not sub-rhetorical (>= repeatedRunMinTokens
    // raw tokens), which keeps "Gott ist gut. Gott ist gut." intact.
    if (isExactDuplicate && rawA.length >= cfg.repeatedRunMinTokens) {
        return { action: 'drop_current', reason: 'exact_duplicate', prefix, ...stats };
    }

    return { action: 'keep', reason: 'different_content', prefix, ...stats };
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return null;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function shouldScoreSemantic(previous, current, cfg) {
    if (!cfg.semanticEnabled) return false;
    if (looksLikeProtectedRepeat(previous) || looksLikeProtectedRepeat(current)) return false;

    const stats = tokenStats(previous, current);
    if (hasConflictingNumbers(previous, current) || hasNegationFlip(previous, current)) {
        return stats.aSet.size >= cfg.semanticMinPreviousTokens &&
            stats.bSet.size >= cfg.semanticMinCurrentTokens &&
            stats.containment >= cfg.semanticContainmentThreshold;
    }
    return (
        current.length >= previous.length &&
        stats.aSet.size >= cfg.semanticMinPreviousTokens &&
        stats.bSet.size >= cfg.semanticMinCurrentTokens &&
        stats.newInB >= cfg.minNewContentTokens &&
        stats.containment >= cfg.semanticContainmentThreshold
    );
}

async function pairSemanticSimilarity(previous, current, cfg, options) {
    if (!cfg.semanticEnabled) return null;
    if (typeof options.semanticSimilarityFn === 'function') {
        return options.semanticSimilarityFn(previous, current);
    }
    if (typeof options.embedFn !== 'function') return null;

    const cache = options.embeddingCache || new Map();
    const embed = async (text) => {
        if (!cache.has(text)) {
            cache.set(text, await options.embedFn(text));
        }
        return cache.get(text);
    };

    const [a, b] = await Promise.all([embed(previous), embed(current)]);
    return cosineSimilarity(a, b);
}

function cleanupIntraEmission(text, config = {}) {
    const cfg = normalizeConfig(config);
    const original = String(text || '');
    if (!cfg.enabled) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [] };
    }
    if (/(^|\s)\d+[.)]\s+\p{L}/u.test(original)) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [] };
    }

    const collapseFragments = [];
    const units = splitUnits(original).map(unit => {
        const { text: collapsed, removed } = collapseInternalRepeatDetailed(unit.raw, cfg.repeatedRunMinTokens);
        removed.forEach(fragment => collapseFragments.push({ unitIndex: unit.index, fragment }));
        return { index: unit.index, raw: collapsed, collapsedFrom: removed.length > 0 ? unit.raw : null };
    });
    const collapsedChanged = collapseFragments.length > 0;
    if (units.length < 2 && !collapsedChanged) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [] };
    }

    const keep = units.map(() => true);
    // Seed decisions with internal-collapse records so a collapse-only trim
    // (id 42/80: no whole unit dropped) is still auditable in the scorecard.
    const decisions = collapseFragments.map(frag => ({
        previousIndex: frag.unitIndex,
        currentIndex: frag.unitIndex,
        action: 'collapse_internal_repeat',
        reason: 'internal_repeat',
        removed_fragment: frag.fragment.slice(0, 160),
    }));

    for (let i = 0; i < units.length; i++) {
        if (!keep[i]) continue;
        const maxJ = Math.min(units.length - 1, i + cfg.maxLookahead);
        for (let j = i + 1; j <= maxJ; j++) {
            if (!keep[j]) continue;
            let decision = classifyPair(units[i].raw, units[j].raw, cfg);
            // Guard for gapped repeats: a duplicate split by thematically related
            // content is intentional anaphora (id 73), not an artifact (id 8).
            if ((decision.action === 'drop_previous' || decision.action === 'drop_current')
                && decision.reason === 'repeated_phrase'
                && interveningSharesContent(units, i, j)) {
                decision = { action: 'keep', reason: 'protected_anaphora_gap', containment: decision.containment, jaccard: decision.jaccard, prefix: decision.prefix };
            }
            decisions.push({
                previousIndex: units[i].index,
                currentIndex: units[j].index,
                action: decision.action,
                reason: decision.reason,
                containment: Number.isFinite(decision.containment) ? Number(decision.containment.toFixed(4)) : null,
                jaccard: Number.isFinite(decision.jaccard) ? Number(decision.jaccard.toFixed(4)) : null,
                prefix: decision.prefix ?? null,
            });
            if (decision.action === 'drop_previous') {
                keep[i] = false;
                break;
            }
            if (decision.action === 'drop_current') {
                keep[j] = false;
            }
        }
    }

    const removedUnits = units.filter((_, index) => !keep[index]);
    if (removedUnits.length === 0 && !collapsedChanged) {
        return { action: 'emit', text: original, decisions, removedUnits: [] };
    }

    const cleaned = units.filter((_, index) => keep[index]).map(unit => unit.raw).join(' ').trim();
    // Length-delta ratio so the safety cap also accounts for internal collapses,
    // not just whole-unit removals.
    const removalRatio = original.length > 0 ? Math.max(0, (original.length - cleaned.length) / original.length) : 0;

    if (!cleaned || removalRatio > cfg.maxRemovalRatio) {
        return {
            action: 'emit',
            text: original,
            decisions,
            removedUnits,
            blocked: true,
            reason: 'safety_removal_ratio',
            removalRatio,
        };
    }

    return {
        action: 'trim',
        text: cleaned,
        decisions,
        removedUnits,
        removalRatio,
        collapsedInternal: collapsedChanged,
        collapsedUnits: collapseFragments.length,
        removedFragments: collapseFragments.map(frag => frag.fragment),
    };
}

async function cleanupIntraEmissionAsync(text, config = {}, options = {}) {
    const cfg = normalizeConfig(config);
    const original = String(text || '');
    if (!cfg.enabled) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [], semanticSummary: null };
    }
    if (!cfg.semanticEnabled) {
        return cleanupIntraEmission(original, cfg);
    }
    if (/(^|\s)\d+[.)]\s+\p{L}/u.test(original)) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [], semanticSummary: { trimCandidates: 0, blocked: 0, dryRun: cfg.semanticDryRun } };
    }

    const collapseFragments = [];
    const units = splitUnits(original).map(unit => {
        const { text: collapsed, removed } = collapseInternalRepeatDetailed(unit.raw, cfg.repeatedRunMinTokens);
        removed.forEach(fragment => collapseFragments.push({ unitIndex: unit.index, fragment }));
        return { index: unit.index, raw: collapsed, collapsedFrom: removed.length > 0 ? unit.raw : null };
    });
    const collapsedChanged = collapseFragments.length > 0;
    if (units.length < 2 && !collapsedChanged) {
        return { action: 'emit', text: original, decisions: [], removedUnits: [], semanticSummary: { trimCandidates: 0, blocked: 0, dryRun: cfg.semanticDryRun } };
    }

    const keep = units.map(() => true);
    const decisions = collapseFragments.map(frag => ({
        previousIndex: frag.unitIndex,
        currentIndex: frag.unitIndex,
        action: 'collapse_internal_repeat',
        reason: 'internal_repeat',
        removed_fragment: frag.fragment.slice(0, 160),
    }));
    const embeddingCache = new Map();
    let semanticTrimCandidates = 0;
    let semanticBlocked = 0;

    for (let i = 0; i < units.length; i++) {
        if (!keep[i]) continue;
        const maxJ = Math.min(units.length - 1, i + cfg.maxLookahead);
        for (let j = i + 1; j <= maxJ; j++) {
            if (!keep[j]) continue;

            let decision = classifyPair(units[i].raw, units[j].raw, { ...cfg, semanticEnabled: false });
            let semanticSimilarity = null;

            if ((decision.action === 'keep' || decision.action === 'blocked') && shouldScoreSemantic(units[i].raw, units[j].raw, cfg)) {
                try {
                    semanticSimilarity = await pairSemanticSimilarity(units[i].raw, units[j].raw, cfg, {
                        ...options,
                        embeddingCache,
                    });
                    if (Number.isFinite(semanticSimilarity)) {
                        decision = classifyPair(units[i].raw, units[j].raw, cfg, { similarity: semanticSimilarity });
                    }
                } catch (error) {
                    decision = { ...decision, reason: 'semantic_error', error: error.message };
                }
            }

            if ((decision.action === 'drop_previous' || decision.action === 'drop_current')
                && decision.reason === 'repeated_phrase'
                && interveningSharesContent(units, i, j)) {
                decision = { action: 'keep', reason: 'protected_anaphora_gap', containment: decision.containment, jaccard: decision.jaccard, prefix: decision.prefix };
            }

            if (decision.action === 'drop_previous' && decision.reason === 'semantic_correction') {
                semanticTrimCandidates++;
            }
            if (decision.action === 'blocked') {
                semanticBlocked++;
            }

            decisions.push({
                previousIndex: units[i].index,
                currentIndex: units[j].index,
                action: decision.action,
                reason: decision.reason,
                containment: Number.isFinite(decision.containment) ? Number(decision.containment.toFixed(4)) : null,
                jaccard: Number.isFinite(decision.jaccard) ? Number(decision.jaccard.toFixed(4)) : null,
                semanticSimilarity: Number.isFinite(semanticSimilarity) ? Number(semanticSimilarity.toFixed(4)) : null,
                prefix: decision.prefix ?? null,
            });

            if (decision.action === 'drop_previous') {
                if (!cfg.semanticDryRun || decision.reason !== 'semantic_correction') {
                    keep[i] = false;
                }
                break;
            }
            if (decision.action === 'drop_current') {
                keep[j] = false;
            }
        }
    }

    const removedUnits = units.filter((_, index) => !keep[index]);
    const semanticSummary = {
        trimCandidates: semanticTrimCandidates,
        blocked: semanticBlocked,
        dryRun: cfg.semanticDryRun,
    };

    if (removedUnits.length === 0 && !collapsedChanged) {
        return { action: 'emit', text: original, decisions, removedUnits: [], semanticSummary };
    }

    const cleaned = units.filter((_, index) => keep[index]).map(unit => unit.raw).join(' ').trim();
    const removalRatio = original.length > 0 ? Math.max(0, (original.length - cleaned.length) / original.length) : 0;

    if (!cleaned || removalRatio > cfg.maxRemovalRatio) {
        return {
            action: 'emit',
            text: original,
            decisions,
            removedUnits,
            blocked: true,
            reason: 'safety_removal_ratio',
            removalRatio,
            semanticSummary,
        };
    }

    return {
        action: 'trim',
        text: cleaned,
        decisions,
        removedUnits,
        removalRatio,
        collapsedInternal: collapsedChanged,
        collapsedUnits: collapseFragments.length,
        removedFragments: collapseFragments.map(frag => frag.fragment),
        semanticSummary,
    };
}

export {
    DEFAULT_CONFIG,
    cleanupIntraEmission,
    cleanupIntraEmissionAsync,
    classifyPair,
    collapseInternalRepeat,
    contentTokens,
    cosineSimilarity,
    longestCommonRun,
    normalizeConfig,
    splitUnits,
    tokenStats,
};
