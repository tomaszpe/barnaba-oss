/**
 * Cache Service for Barnaba Church Translation System
 *
 * Provides liturgical phrase caching to bypass translation API
 * for common fixed expressions (e.g., "Im Namen des Vaters...").
 *
 * Phase 4: Public-domain phrases loaded from cache/liturgicalPhrases.json.
 * Languages or phrases without verified source wording fall through to translation.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache data structures
let phraseCache = new Map();        // Exact match: lowercase German → phrase object
let normalizedCache = new Map();    // Fuzzy match: normalized German → phrase object
let categoryIndex = new Map();      // Category → Set of phrase IDs
let initialized = false;
let phraseCount = 0;

/**
 * Normalize text for fuzzy matching
 * Removes punctuation and extra whitespace
 *
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[.,!?;:'"]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Initialize the liturgical cache
 * Loads pre-translated phrases from cache/liturgicalPhrases.json
 *
 * @returns {Promise<void>}
 */
async function initLiturgicalCache() {
    if (initialized) {
        return;
    }

    console.log('[CacheService] Initializing liturgical phrase cache...');

    try {
        // Load phrases from JSON file
        const require = createRequire(import.meta.url);
        const cachePath = path.join(__dirname, 'cache', 'liturgicalPhrases.json');
        const cacheData = require(cachePath);

        const phrases = cacheData.phrases || [];

        // Build lookup caches
        for (const phrase of phrases) {
            if (!phrase.de) continue;

            // Exact match (lowercase)
            phraseCache.set(phrase.de.toLowerCase(), phrase);

            // Normalized match (no punctuation, extra spaces removed)
            const normalized = normalizeText(phrase.de);
            normalizedCache.set(normalized, phrase);

            // Category index for stats/debugging
            if (phrase.category) {
                if (!categoryIndex.has(phrase.category)) {
                    categoryIndex.set(phrase.category, new Set());
                }
                categoryIndex.get(phrase.category).add(phrase.id);
            }
        }

        phraseCount = phrases.length;
        initialized = true;

        // Log statistics
        const categories = [...categoryIndex.keys()];
        console.log(`[CacheService] Loaded ${phraseCount} liturgical phrases from ${categories.length} categories`);
        console.log(`[CacheService] Categories: ${categories.join(', ')}`);

    } catch (error) {
        console.error('[CacheService] Failed to load liturgicalPhrases.json:', error.message);
        console.log('[CacheService] Falling back to minimal hardcoded cache...');

        // Fallback to essential phrases if JSON fails to load
        const essentialPhrases = [
            { id: 'amen', de: 'Amen', pl: 'Amen', en: 'Amen', uk: 'Амінь', it: 'Amen' },
            { id: 'hallelujah', de: 'Halleluja', pl: 'Alleluja', en: 'Hallelujah', uk: 'Алілуя', it: 'Alleluia' },
            { id: 'trinity', de: 'Im Namen des Vaters und des Sohnes und des Heiligen Geistes', pl: 'W imię Ojca i Syna i Ducha Świętego', en: 'In the name of the Father, and of the Son, and of the Holy Spirit', uk: 'В ім\'я Отця, і Сина, і Святого Духа', it: 'Nel nome del Padre, del Figlio e dello Spirito Santo' }
        ];

        for (const phrase of essentialPhrases) {
            phraseCache.set(phrase.de.toLowerCase(), phrase);
            normalizedCache.set(normalizeText(phrase.de), phrase);
        }

        phraseCount = essentialPhrases.length;
        initialized = true;
        console.log(`[CacheService] Fallback initialized with ${phraseCount} essential phrases`);
    }
}

/**
 * Check if text matches a cached liturgical phrase
 *
 * Matching strategy (in order of priority):
 * 1. Exact match (case-insensitive)
 * 2. Normalized match (no punctuation)
 * 3. Contained match (cached phrase is contained in input)
 * 4. Contains match (input is contained in cached phrase)
 *
 * @param {string} sourceText - German source text to check
 * @param {string} targetLang - Target language code (pl, en, uk, de, it)
 * @returns {{text: string, phraseId: string, matchType: string}|null} - Cached translation or null
 */
function checkLiturgicalCache(sourceText, targetLang) {
    if (!initialized) {
        return null;
    }

    const lowerText = sourceText.toLowerCase().trim();
    const normalizedText = normalizeText(sourceText);

    // Strategy 1: Exact match (case-insensitive)
    let phrase = phraseCache.get(lowerText);
    if (phrase && phrase[targetLang]) {
        return {
            text: phrase[targetLang],
            phraseId: phrase.id,
            matchType: 'exact'
        };
    }

    // Strategy 2: Normalized match (no punctuation)
    phrase = normalizedCache.get(normalizedText);
    if (phrase && phrase[targetLang]) {
        return {
            text: phrase[targetLang],
            phraseId: phrase.id,
            matchType: 'normalized'
        };
    }

    // Strategy 3: Contained match - cached phrase is contained in input
    // Only for substantial phrases (>15 chars) to avoid false positives
    for (const [key, value] of phraseCache) {
        if (key.length > 15 && lowerText.includes(key) && value[targetLang]) {
            return {
                text: value[targetLang],
                phraseId: value.id,
                matchType: 'contained'
            };
        }
    }

    // Strategy 4: Contains match - input is contained in cached phrase
    // For short inputs that might be part of longer cached phrases
    if (normalizedText.length >= 5) {
        for (const [key, value] of normalizedCache) {
            if (key.includes(normalizedText) && value[targetLang]) {
                // Only match if input is at least 60% of cached phrase length
                if (normalizedText.length / key.length >= 0.6) {
                    return {
                        text: value[targetLang],
                        phraseId: value.id,
                        matchType: 'contains'
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Simple cache check that returns just the translation text
 * (backwards compatible with translationService.js)
 *
 * @param {string} sourceText - German source text to check
 * @param {string} targetLang - Target language code
 * @returns {string|null} - Cached translation text or null
 */
function checkCache(sourceText, targetLang) {
    const result = checkLiturgicalCache(sourceText, targetLang);
    return result ? result.text : null;
}

/**
 * Add a phrase to the runtime cache (does not persist)
 *
 * @param {string} germanPhrase - German phrase
 * @param {Object} translations - Translations keyed by language code
 */
function addToCache(germanPhrase, translations) {
    const id = `runtime_${Date.now()}`;
    const phrase = {
        id,
        de: germanPhrase,
        ...translations
    };

    phraseCache.set(germanPhrase.toLowerCase(), phrase);
    normalizedCache.set(normalizeText(germanPhrase), phrase);
}

/**
 * Get cache statistics
 *
 * @returns {Object} - Cache statistics
 */
function getCacheStats() {
    const categoryStats = {};
    for (const [category, ids] of categoryIndex) {
        categoryStats[category] = ids.size;
    }

    return {
        initialized,
        totalPhrases: phraseCount,
        exactMatchEntries: phraseCache.size,
        normalizedEntries: normalizedCache.size,
        categories: categoryStats,
        mode: 'full' // Phase 4 complete
    };
}

/**
 * Get all phrases in a specific category
 *
 * @param {string} category - Category name
 * @returns {Array} - Array of phrase objects in that category
 */
function getPhrasesByCategory(category) {
    if (!initialized || !categoryIndex.has(category)) {
        return [];
    }

    const phraseIds = categoryIndex.get(category);
    const phrases = [];

    for (const [_, phrase] of phraseCache) {
        if (phraseIds.has(phrase.id)) {
            phrases.push(phrase);
        }
    }

    return phrases;
}

/**
 * Get available categories
 *
 * @returns {string[]} - Array of category names
 */
function getCategories() {
    return [...categoryIndex.keys()];
}

/**
 * Clear the cache (for testing or reset)
 */
function clearCache() {
    phraseCache.clear();
    normalizedCache.clear();
    categoryIndex.clear();
    initialized = false;
    phraseCount = 0;
}

// ============================================================
// Exports
// ============================================================

export {
    initLiturgicalCache,
    checkLiturgicalCache,
    checkCache,            // Simple text-only version for backwards compatibility
    addToCache,
    getCacheStats,
    getPhrasesByCategory,
    getCategories,
    clearCache
};
