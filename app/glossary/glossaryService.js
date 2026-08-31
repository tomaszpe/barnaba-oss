/**
 * Glossary Service for Barnaba Church Translation System
 *
 * Provides theological term extraction, Swiss German normalization,
 * and dynamic glossary formatting for LLM prompts.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Load glossary data (JSON files)
const glossary = require('./theologicalGlossary.json');
const swissMapping = require('./swissGermanMapping.json');

// ---------------------------------------------------------------------------
// Church-scoped data (S2 + S7)
// ---------------------------------------------------------------------------
// Congregation-specific records used to live inside theologicalGlossary.json under
// a category named after one client, and the proper-noun list was a literal repeated
// in twelve prompt templates. Both are configuration, not code: they differ per
// congregation and they name real people.
//
// Every derived structure below is keyed by church id, NOT by language alone. The
// gateway serves several churches from one process (config/churches.json is a list),
// so a language-keyed cache would hand one congregation's terms to another
// congregation's listeners. That is the failure this keying exists to prevent.
const DEFAULT_CHURCH_ID = 'default';
const CHURCH_DATA_PATH = process.env.CHURCH_DATA_PATH
    || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'churchData.json');

/**
 * Validate the shape of a church data file.
 *
 * An ABSENT file is a supported state; a PRESENT but broken one is not. Those are
 * different situations and were being treated as the same: a JSON syntax error used to
 * be swallowed into an empty object, so a deployment with a corrupted configuration
 * started anyway and quietly served every congregation without its names or terms.
 * A configuration that exists is a statement of intent; failing to read it is an error.
 */
function validateChurchData(parsed, source) {
    const bad = (msg) => { throw new Error(`[GlossaryService] ${source}: ${msg}`); };
    // Type AND content. Checking only that a key exists is what let `{ de: "" }` through.
    const isFilled = (v) => typeof v === 'string' && v.trim().length > 0;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        bad('must be a JSON object keyed by church id');
    }
    for (const [churchId, entry] of Object.entries(parsed)) {
        if (churchId === '_comment') continue;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            bad(`entry "${churchId}" must be an object`);
        }
        const { properNouns, glossaryTerms, glossaryCategories } = entry;

        if (properNouns !== undefined) {
            if (!Array.isArray(properNouns) || properNouns.some((n) => !isFilled(n))) {
                bad(`"${churchId}".properNouns must be an array of non-empty strings`);
            }
        }
        if (glossaryCategories !== undefined) {
            if (glossaryCategories === null || typeof glossaryCategories !== 'object' || Array.isArray(glossaryCategories)) {
                bad(`"${churchId}".glossaryCategories must be an object`);
            }
            for (const [name, description] of Object.entries(glossaryCategories)) {
                if (!isFilled(name)) bad(`"${churchId}".glossaryCategories has a blank category name`);
                if (!isFilled(description)) {
                    bad(`"${churchId}".glossaryCategories["${name}"] must be a non-empty description`);
                }
            }
        }
        if (glossaryTerms !== undefined) {
            if (glossaryTerms === null || typeof glossaryTerms !== 'object' || Array.isArray(glossaryTerms)) {
                bad(`"${churchId}".glossaryTerms must be an object`);
            }
            for (const [term, record] of Object.entries(glossaryTerms)) {
                if (!isFilled(term)) bad(`"${churchId}".glossaryTerms has a blank term name`);
                if (record === null || typeof record !== 'object' || Array.isArray(record)) {
                    bad(`"${churchId}".glossaryTerms["${term}"] must be an object`);
                }
                if (!isFilled(record.category)) {
                    // getTermsByCategory and getGlossaryStats both index by category; a record
                    // without one lands under "undefined" and is invisible to both.
                    bad(`"${churchId}".glossaryTerms["${term}"].category must be a non-empty string`);
                }
                if (record.context !== undefined && record.context !== null && !isFilled(record.context)) {
                    bad(`"${churchId}".glossaryTerms["${term}"].context must be a non-empty string when present`);
                }
                const t = record.translations;
                if (t === null || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).length === 0) {
                    // A record without translations is inert: it would be merged, matched and
                    // then dropped by extractRelevantTerms. Silent no-ops are worse than errors.
                    bad(`"${churchId}".glossaryTerms["${term}"].translations must be a non-empty object`);
                }
                for (const [lang, value] of Object.entries(t)) {
                    // The whole point of the check. `{ de: "" }` and `{ de: 123 }` both used to
                    // pass, and the first one reproduces EXACTLY the silent missing translation
                    // this validation exists to prevent: the key is there, so the record looks
                    // complete, and extractRelevantTerms drops it at run time without a word.
                    if (!isFilled(lang)) bad(`"${churchId}".glossaryTerms["${term}"].translations has a blank language code`);
                    if (!isFilled(value)) {
                        bad(`"${churchId}".glossaryTerms["${term}"].translations["${lang}"] must be a non-empty string`);
                    }
                }
            }
        }
    }
    return parsed;
}

function loadChurchDataFile() {
    // An absent file is a supported state: the published repository ships only the
    // example, and the base glossary alone must still work.
    if (!existsSync(CHURCH_DATA_PATH)) return {};

    let parsed;
    try {
        parsed = JSON.parse(readFileSync(CHURCH_DATA_PATH, 'utf8'));
    } catch (err) {
        // Fail-fast, not fail-open. See validateChurchData.
        throw new Error(`[GlossaryService] ${CHURCH_DATA_PATH} exists but is not valid JSON: ${err.message}`);
    }
    // _comment is documentation for whoever edits the file, not a church entry.
    // Stripped BEFORE validation, or the validator rejects the example's own header.
    delete parsed._comment;
    validateChurchData(parsed, CHURCH_DATA_PATH);
    return parsed;
}

let churchData = loadChurchDataFile();

// NO mutable "active church" global. The gateway handles requests for several
// congregations concurrently, so a process-wide switch is not merely untidy - two
// interleaved translations would race for it and one congregation's listeners would
// get the other's terms. The church id is threaded explicitly instead, the same way
// translationService already keys contextBuffer and committedTranslations.

// churchId -> { termPatterns, terms, staticGlossary: Map<lang, string> }
const churchScopes = new Map();

function churchEntry(churchId) {
    return churchData[churchId] || churchData[DEFAULT_CHURCH_ID] || {};
}

/** Base glossary merged with this church's own records. */
function effectiveTerms(churchId) {
    return { ...glossary.terms, ...(churchEntry(churchId).glossaryTerms || {}) };
}

/**
 * Per-church lookup structures, built once and memoised under the church id.
 *
 * The memo is what makes A -> B -> A safe: switching back reuses A's own patterns
 * instead of rebuilding over whatever B left behind.
 */
function scopeFor(churchId) {
    const existing = churchScopes.get(churchId);
    if (existing) return existing;

    const terms = effectiveTerms(churchId);
    const termPatterns = Object.keys(terms)
        .sort((a, b) => b.length - a.length)   // longest first for greedy matching
        .map((term) => ({
            pattern: new RegExp('\\b' + escapeRegex(term) + '\\b', 'gi'),
            term,
            data: terms[term],
        }));

    // Categories move with the records: getCategories() is part of the compared
    // surface, so leaving the category description behind in the public file would
    // both leak the client name and break equivalence.
    const categories = { ...glossary.categories, ...(churchEntry(churchId).glossaryCategories || {}) };
    const scope = { terms, categories, termPatterns, staticGlossary: new Map() };
    churchScopes.set(churchId, scope);
    return scope;
}

/**
 * Proper nouns the translator must keep verbatim, for the active church.
 * Was a literal repeated across twelve prompt templates (S2).
 */
function getProperNouns(churchId = DEFAULT_CHURCH_ID) {
    return churchEntry(churchId).properNouns || [];
}

/** Test seam: replace the loaded configuration without touching the file. */
function __setChurchDataForTests(data) {
    churchData = data || {};
    churchScopes.clear();
}

// Build efficient lookup structures (swiss/phrase patterns are church-independent)
let swissPatterns = [];
let phrasePatterns = [];
let initialized = false;

/**
 * Escape special regex characters in a string
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a phrase matcher that cannot start or end inside a word.
 *
 * JavaScript's `\b` is ASCII-oriented even with the Unicode flag, so it is not
 * reliable for Swiss German text containing characters such as ä, ö, ü, or é.
 * Combining marks are token characters too, so decomposed Unicode cannot create
 * a false boundary inside a word.
 */
function tokenBoundedPhrasePattern(phrase) {
    const tokenCharacter = '\\p{L}\\p{N}\\p{M}_';
    return new RegExp(
        `(?<![${tokenCharacter}])${escapeRegex(phrase)}(?![${tokenCharacter}])`,
        'giu',
    );
}

/**
 * Initialize the glossary service
 * Builds regex patterns for efficient term matching
 */
function initGlossary() {
    if (initialized) {
        return;
    }

    console.log('[GlossaryService] Initializing...');

    // Term patterns are built per church and memoised - see scopeFor().
    scopeFor(DEFAULT_CHURCH_ID);

    // Build patterns for Swiss German → Standard German mappings
    // Process all categories
    for (const category of Object.keys(swissMapping.mappings)) {
        const mappings = swissMapping.mappings[category];
        for (const [swiss, standard] of Object.entries(mappings)) {
            swissPatterns.push({
                pattern: new RegExp(`\\b${escapeRegex(swiss)}\\b`, 'gi'),
                swiss: swiss,
                standard: standard
            });
        }
    }
    // Sort by length (longest first)
    swissPatterns.sort((a, b) => b.swiss.length - a.swiss.length);

    // Build patterns for Swiss German phrases
    for (const [swiss, standard] of Object.entries(swissMapping.phrases || {})) {
        phrasePatterns.push({
            pattern: tokenBoundedPhrasePattern(swiss),
            swiss: swiss,
            standard: standard
        });
    }
    // Sort by length (longest first)
    phrasePatterns.sort((a, b) => b.swiss.length - a.swiss.length);

    initialized = true;
    console.log(`[GlossaryService] Initialized: ${scopeFor(DEFAULT_CHURCH_ID).termPatterns.length} terms, ${swissPatterns.length} Swiss German mappings, ${phrasePatterns.length} phrases`);
}

/**
 * Apply Swiss German → Standard German (Hochdeutsch) normalization
 *
 * @param {string} text - Input text in Swiss German
 * @returns {string} - Normalized text in Standard German
 */
function normalizeSwissGerman(text) {
    if (!initialized) {
        initGlossary();
    }

    let normalized = text;

    // First apply phrase-level replacements (longer phrases first)
    for (const { pattern, standard } of phrasePatterns) {
        normalized = normalized.replace(pattern, standard);
    }

    // Then apply word-level replacements
    for (const { pattern, standard } of swissPatterns) {
        normalized = normalized.replace(pattern, standard);
    }

    return normalized;
}

/**
 * Extract relevant glossary terms from source text
 * Returns only terms that appear in the text, limited to maxTerms
 *
 * @param {string} sourceText - German source text to scan
 * @param {string} targetLang - Target language code (pl, en, uk, it)
 * @param {number} maxTerms - Maximum number of terms to return (default: 25)
 * @returns {Array} - Array of {source, target, category, context} objects
 */
function extractRelevantTerms(sourceText, targetLang, maxTerms = 25, churchId = DEFAULT_CHURCH_ID) {
    if (!initialized) {
        initGlossary();
    }

    const foundTerms = [];
    const seenTerms = new Set(); // Avoid duplicates

    // Normalize Swiss German first
    const normalizedText = normalizeSwissGerman(sourceText);

    for (const { pattern, term, data } of scopeFor(churchId).termPatterns) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;

        if (pattern.test(normalizedText)) {
            // Check if we haven't already found this term
            const termLower = term.toLowerCase();
            if (!seenTerms.has(termLower)) {
                const translation = data.translations[targetLang];
                const fallback = !translation ? (data.translations['en'] || data.translations['de']) : null;
                const effective = translation || fallback;
                if (effective) {
                    foundTerms.push({
                        source: term,
                        target: effective,
                        category: data.category,
                        context: fallback
                            ? `${data.context ? data.context + '; ' : ''}EN fallback — adapt to ${targetLang}`
                            : (data.context || null)
                    });
                    seenTerms.add(termLower);
                }
            }

            if (foundTerms.length >= maxTerms) {
                break;
            }
        }
    }

    return foundTerms;
}

/**
 * Format extracted glossary terms for injection into LLM prompt
 *
 * @param {Array} terms - Array of term objects from extractRelevantTerms
 * @param {string} sourceLang - Source language code (default: 'de')
 * @returns {string} - Formatted glossary section for prompt
 */
function formatGlossaryForPrompt(terms, sourceLang = 'de') {
    if (!terms || terms.length === 0) {
        return '';
    }

    const formatted = terms.map(t => {
        if (t.context) {
            return `- "${t.source}" → "${t.target}" (${t.context})`;
        }
        return `- "${t.source}" → "${t.target}"`;
    }).join('\n');

    return `### REQUIRED TERMINOLOGY (use exactly as shown):\n${formatted}`;
}

/**
 * Get all terms for a specific category
 *
 * @param {string} category - Category name (e.g., 'christology', 'liturgy')
 * @param {string} targetLang - Target language code
 * @returns {Array} - Array of {source, target} objects
 */
function getTermsByCategory(category, targetLang, churchId = DEFAULT_CHURCH_ID) {
    if (!initialized) {
        initGlossary();
    }

    return Object.entries(scopeFor(churchId).terms)
        .filter(([_, data]) => data.category === category)
        .map(([term, data]) => ({
            source: term,
            target: data.translations[targetLang],
            category: data.category
        }))
        .filter(t => t.target); // Only include if translation exists
}

/**
 * Get all available categories
 *
 * @returns {Object} - Category names and descriptions
 */
function getCategories(churchId = DEFAULT_CHURCH_ID) {
    return scopeFor(churchId).categories;
}

/**
 * Get glossary statistics
 *
 * @returns {Object} - Statistics about the glossary
 */
function getGlossaryStats(churchId = DEFAULT_CHURCH_ID) {
    if (!initialized) {
        initGlossary();
    }

    const terms = scopeFor(churchId).terms;

    const categoryCounts = {};
    for (const [term, data] of Object.entries(terms)) {
        const cat = data.category;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
    return {
        version: glossary.version,
        lastUpdated: glossary.lastUpdated,
        // COUNTED, not declared. This used to report glossary.termCount - a metadata
        // field in the JSON that drifted from reality: it said 352 while the file held
        // 354 records, and after the church split it matched neither the public glossary
        // (340) nor the effective one. A statistic nobody can trust is worse than none.
        totalTerms: Object.keys(terms).length,
        declaredTermCount: glossary.termCount,
        languages: glossary.languages,
        categoryCounts: categoryCounts,
        swissMappings: swissPatterns.length,
        swissPhrases: phrasePatterns.length
    };
}

/**
 * Look up a single term in the glossary
 *
 * @param {string} term - German term to look up
 * @param {string} targetLang - Target language code
 * @returns {Object|null} - Translation data or null if not found
 */
function lookupTerm(term, targetLang, churchId = DEFAULT_CHURCH_ID) {
    if (!initialized) {
        initGlossary();
    }

    // Try exact match first
    const exactMatch = scopeFor(churchId).terms[term];
    if (exactMatch && exactMatch.translations[targetLang]) {
        return {
            source: term,
            target: exactMatch.translations[targetLang],
            category: exactMatch.category,
            context: exactMatch.context || null
        };
    }

    // Try case-insensitive match
    const termLower = term.toLowerCase();
    for (const [key, data] of Object.entries(scopeFor(churchId).terms)) {
        if (key.toLowerCase() === termLower && data.translations[targetLang]) {
            return {
                source: key,
                target: data.translations[targetLang],
                category: data.category,
                context: data.context || null
            };
        }
    }

    return null;
}

/**
 * Check if a term exists in the glossary
 *
 * @param {string} term - Term to check
 * @returns {boolean} - True if term exists
 */
function hasTerm(term, churchId = DEFAULT_CHURCH_ID) {
    if (!initialized) {
        initGlossary();
    }

    const termLower = term.toLowerCase();
    return Object.keys(scopeFor(churchId).terms).some(key =>
        key.toLowerCase() === termLower
    );
}

/**
 * Get Swiss German to Standard German mapping for a word
 *
 * @param {string} swissWord - Swiss German word
 * @returns {string|null} - Standard German equivalent or null
 */
function getSwissMapping(swissWord) {
    if (!initialized) {
        initGlossary();
    }

    for (const { swiss, standard } of swissPatterns) {
        if (swiss.toLowerCase() === swissWord.toLowerCase()) {
            return standard;
        }
    }

    return null;
}

// ============================================================
// Static Glossary for Prompt Caching (Phase 2a.2)
// ============================================================

// Categories included in static glossary (100 terms total)
// Priority: core theological terms most likely to appear in sermons
const STATIC_GLOSSARY_CATEGORIES = [
    'trinity',        // 13 terms
    'christology',    // 24 terms
    'pneumatology',   // 6 terms
    'soteriology',    // 25 terms
    'sacraments',     // 12 terms
    'protestant',     // 10 terms
    'ecclesiology',   // 10 terms (partial)
];

const STATIC_GLOSSARY_LIMIT = 100;

// Cache: per-lang formatted static glossary (computed once at init)
// Static glossary cache lives INSIDE the church scope (see scopeFor). A module
// level Map keyed by language alone was the concrete leak this refactor removes.

/**
 * Get pre-formatted static glossary for a target language.
 * Returns the same string every call for the same lang — designed for prompt caching.
 * Includes top 100 theological terms from priority categories.
 *
 * @param {string} targetLang - Target language code
 * @returns {string} - Formatted glossary section (or empty string if no terms)
 */
function getStaticGlossary(targetLang, churchId = DEFAULT_CHURCH_ID) {
    // NOTE: the accumulator is deliberately NOT called `terms`. It used to be, and a
    // global search-and-replace over `Object.entries(...terms)` silently rewired this
    // loop to iterate its own empty accumulator - every static glossary came out blank.
    const cache = scopeFor(churchId).staticGlossary;
    if (cache.has(targetLang)) {
        return cache.get(targetLang);
    }

    if (!initialized) {
        initGlossary();
    }

    const picked = [];
    for (const cat of STATIC_GLOSSARY_CATEGORIES) {
        for (const [term, data] of Object.entries(scopeFor(churchId).terms)) {
            if (data.category !== cat) continue;
            const translation = data.translations[targetLang];
            if (!translation) continue;
            picked.push({
                source: term,
                target: translation,
                context: data.context || null,
            });
            if (picked.length >= STATIC_GLOSSARY_LIMIT) break;
        }
        if (picked.length >= STATIC_GLOSSARY_LIMIT) break;
    }

    const formatted = formatGlossaryForPrompt(picked);
    const section = formatted
        ? `<glossary>\n${formatted}\n</glossary>\n\n`
        : '';

    cache.set(targetLang, section);
    return section;
}

// Auto-initialize on first import
initGlossary();

// ============================================================
// ES Module Exports
// ============================================================

export {
    initGlossary,
    getProperNouns,
    __setChurchDataForTests,
    validateChurchData,
    normalizeSwissGerman,
    extractRelevantTerms,
    formatGlossaryForPrompt,
    getStaticGlossary,
    getTermsByCategory,
    getCategories,
    getGlossaryStats,
    lookupTerm,
    hasTerm,
    getSwissMapping
};
