import crypto from 'crypto';
import { classifyTranslationProviderError } from './translationProviderError.js';

const DEFAULT_MAX_AGE_MS = 10000;
const DEFAULT_BUDGET_COUNT = 3;
const DEFAULT_BUDGET_WINDOW_MS = 60000;
const DEFAULT_HALF_OPEN_AFTER_MS = 120000;
const DEFAULT_HALF_OPEN_MAX_MS = 900000;
const MIN_SOURCE_ONLY_SUCCESSES = 3;

const positiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const languageSet = (value) => new Set(
    String(value || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
);

const translationSourceHash = (sourceText) => crypto
    .createHash('sha256')
    .update(String(sourceText || ''))
    .digest('hex');

class TranslationContentFilterRecovery {
    constructor({
        enabled = false,
        languages = [],
        sourceOnlyForSession = true,
        retryMaxAgeMs = DEFAULT_MAX_AGE_MS,
        retryBudgetCount = DEFAULT_BUDGET_COUNT,
        retryBudgetWindowMs = DEFAULT_BUDGET_WINDOW_MS,
        halfOpenAfterMs = DEFAULT_HALF_OPEN_AFTER_MS,
        halfOpenMaxMs = DEFAULT_HALF_OPEN_MAX_MS,
        now = () => Date.now(),
    } = {}) {
        this.enabled = enabled === true;
        this.languages = languages instanceof Set
            ? new Set([...languages].map((lang) => String(lang).toLowerCase()))
            : languageSet(Array.isArray(languages) ? languages.join(',') : languages);
        this.sourceOnlyForSession = sourceOnlyForSession !== false;
        this.retryMaxAgeMs = positiveInt(retryMaxAgeMs, DEFAULT_MAX_AGE_MS);
        this.retryBudgetCount = positiveInt(retryBudgetCount, DEFAULT_BUDGET_COUNT);
        this.retryBudgetWindowMs = positiveInt(retryBudgetWindowMs, DEFAULT_BUDGET_WINDOW_MS);
        this.halfOpenAfterMs = positiveInt(halfOpenAfterMs, DEFAULT_HALF_OPEN_AFTER_MS);
        this.halfOpenMaxMs = Math.max(
            this.halfOpenAfterMs,
            positiveInt(halfOpenMaxMs, DEFAULT_HALF_OPEN_MAX_MS),
        );
        this.now = now;
        this.churches = new Map();
        this.retryLedgers = new Map();
        this.probeSequence = 0;
        this.stats = {
            sourceOnlyRetries: 0,
            recovered: 0,
            retryBudgetExhausted: 0,
            halfOpenProbes: 0,
        };
    }

    isEnabledFor(targetLang) {
        return this.enabled && this.languages.has(String(targetLang || '').toLowerCase());
    }

    getLanguageState(churchId, targetLang) {
        return this.churches.get(churchId)?.get(targetLang) || null;
    }

    setLanguageState(churchId, targetLang, state) {
        let languages = this.churches.get(churchId);
        if (!languages) {
            languages = new Map();
            this.churches.set(churchId, languages);
        }
        languages.set(targetLang, state);
    }

    deleteLanguageState(churchId, targetLang) {
        const languages = this.churches.get(churchId);
        if (!languages) return;
        languages.delete(targetLang);
        if (languages.size === 0) this.churches.delete(churchId);
    }

    getRetryLedger(churchId, targetLang) {
        let languages = this.retryLedgers.get(churchId);
        if (!languages) {
            languages = new Map();
            this.retryLedgers.set(churchId, languages);
        }
        let ledger = languages.get(targetLang);
        if (!ledger) {
            ledger = { timestamps: [], memo: new Set() };
            languages.set(targetLang, ledger);
        }
        return ledger;
    }

    beginAttempt(churchId, targetLang) {
        if (!this.isEnabledFor(targetLang)) return { contextMode: 'full', probe: false, probeToken: null };
        const state = this.getLanguageState(churchId, targetLang);
        if (!state) return { contextMode: 'full', probe: false, probeToken: null };

        const probeReady = !this.sourceOnlyForSession
            && state.sourceOnlySuccesses >= MIN_SOURCE_ONLY_SUCCESSES
            && this.now() >= state.nextProbeAt
            && state.probeInFlight !== true;
        if (probeReady) {
            state.mode = 'half_open';
            state.probeInFlight = true;
            state.probeToken = ++this.probeSequence;
            this.stats.halfOpenProbes++;
            return { contextMode: 'full', probe: true, probeToken: state.probeToken };
        }
        return { contextMode: 'source_only', probe: false, probeToken: null };
    }

    recordPolicyBlock({ churchId, targetLang, contextMode }) {
        if (!this.isEnabledFor(targetLang)) return false;
        const nowMs = this.now();
        const previous = this.getLanguageState(churchId, targetLang);
        const backoffMs = previous
            ? Math.min(this.halfOpenMaxMs, Math.max(this.halfOpenAfterMs, previous.backoffMs * 2))
            : this.halfOpenAfterMs;
        this.setLanguageState(churchId, targetLang, {
            mode: 'source_only',
            since: previous?.since ?? nowMs,
            nextProbeAt: nowMs + backoffMs,
            backoffMs,
            sourceOnlySuccesses: 0,
            probeInFlight: false,
            probeToken: null,
        });
        return !previous || contextMode === 'full';
    }

    recordSuccess({ churchId, targetLang, contextMode, probe = false, probeToken = null }) {
        if (!this.isEnabledFor(targetLang)) return;
        const state = this.getLanguageState(churchId, targetLang);
        if (!state) return;
        if (contextMode === 'full') {
            if (probe && state.mode === 'half_open' && state.probeToken === probeToken) {
                this.deleteLanguageState(churchId, targetLang);
            }
            return;
        }
        state.sourceOnlySuccesses++;
        if (state.mode !== 'half_open' || state.probeInFlight !== true) {
            state.mode = 'source_only';
            state.probeInFlight = false;
        }
    }

    recordNonPolicyFailure({ churchId, targetLang, probe = false, probeToken = null }) {
        if (!probe) return;
        const state = this.getLanguageState(churchId, targetLang);
        if (!state || state.probeToken !== probeToken) return;
        state.mode = 'source_only';
        state.probeInFlight = false;
        state.probeToken = null;
        state.sourceOnlySuccesses = 0;
        state.nextProbeAt = this.now() + state.backoffMs;
    }

    reserveRetry({ churchId, targetLang, sourceHash, filterSource, queuedAt }) {
        if (!this.isEnabledFor(targetLang) || filterSource !== 'prompt') return false;
        const nowMs = this.now();
        const queuedAtMs = Number(queuedAt);
        if (!Number.isFinite(queuedAtMs) || queuedAtMs <= 0) return false;
        const ageMs = nowMs - queuedAtMs;
        if (ageMs < 0 || ageMs >= this.retryMaxAgeMs) return false;

        if (!this.getLanguageState(churchId, targetLang)) return false;
        const ledger = this.getRetryLedger(churchId, targetLang);
        const memoKey = `${sourceHash}:${filterSource}`;
        if (ledger.memo.has(memoKey)) return false;

        const cutoff = nowMs - this.retryBudgetWindowMs;
        ledger.timestamps = ledger.timestamps.filter((timestamp) => timestamp >= cutoff);
        if (ledger.timestamps.length >= this.retryBudgetCount) {
            this.stats.retryBudgetExhausted++;
            return false;
        }

        ledger.timestamps.push(nowMs);
        ledger.memo.add(memoKey);
        this.stats.sourceOnlyRetries++;
        return true;
    }

    recordRecovered() {
        this.stats.recovered++;
    }

    isContextSuppressed(churchId, targetLang) {
        return this.isEnabledFor(targetLang)
            && this.getLanguageState(churchId, targetLang) !== null;
    }

    clearChurch(churchId) {
        this.churches.delete(churchId);
        this.retryLedgers.delete(churchId);
    }

    getStatus() {
        let activeSuppressions = 0;
        for (const languages of this.churches.values()) activeSuppressions += languages.size;
        return {
            enabled: this.enabled,
            languages: [...this.languages],
            sourceOnlyForSession: this.sourceOnlyForSession,
            activeSuppressions,
            ...this.stats,
        };
    }
}

const contextualizeError = (rawError, { attempts, contextMode }) => {
    const error = classifyTranslationProviderError(rawError);
    if (error.attempts > 0) error.attempts = attempts;
    error.contextMode = contextMode;
    error.recoveredFromContentFilter = false;
    return error;
};

const executeTranslationWithContentFilterRecovery = async ({
    recovery,
    churchId,
    targetLang,
    sourceHash,
    queuedAt,
    attempt,
    onSuppressed = () => {},
}) => {
    const first = recovery.beginAttempt(churchId, targetLang);
    try {
        const result = await attempt({ contextMode: first.contextMode, attempt: 1 });
        recovery.recordSuccess({
            churchId,
            targetLang,
            contextMode: first.contextMode,
            probe: first.probe,
            probeToken: first.probeToken,
        });
        return {
            ...result,
            providerMeta: {
                attempts: 1,
                contextMode: first.contextMode,
                recoveredFromContentFilter: false,
                filterSource: null,
            },
        };
    } catch (rawError) {
        const error = contextualizeError(rawError, { attempts: 1, contextMode: first.contextMode });
        if (error.kind !== 'content_filter') {
            recovery.recordNonPolicyFailure({
                churchId,
                targetLang,
                probe: first.probe,
                probeToken: first.probeToken,
            });
            throw error;
        }

        const suppressed = recovery.recordPolicyBlock({
            churchId,
            targetLang,
            contextMode: first.contextMode,
        });
        if (suppressed) onSuppressed({ churchId, targetLang });
        const retry = first.contextMode === 'full' && recovery.reserveRetry({
            churchId,
            targetLang,
            sourceHash,
            filterSource: error.filterSource,
            queuedAt,
        });
        if (!retry) throw error;

        try {
            const result = await attempt({ contextMode: 'source_only', attempt: 2 });
            recovery.recordSuccess({ churchId, targetLang, contextMode: 'source_only' });
            recovery.recordRecovered();
            return {
                ...result,
                providerMeta: {
                    attempts: 2,
                    contextMode: 'source_only',
                    recoveredFromContentFilter: true,
                    filterSource: error.filterSource,
                },
            };
        } catch (retryRawError) {
            const retryError = contextualizeError(retryRawError, {
                attempts: 2,
                contextMode: 'source_only',
            });
            if (retryError.kind === 'content_filter') {
                recovery.recordPolicyBlock({ churchId, targetLang, contextMode: 'source_only' });
            }
            throw retryError;
        }
    }
};

export {
    TranslationContentFilterRecovery,
    executeTranslationWithContentFilterRecovery,
    languageSet,
    translationSourceHash,
};
