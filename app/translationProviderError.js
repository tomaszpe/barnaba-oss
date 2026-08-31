import crypto from 'crypto';

const CONTENT_FILTER_MESSAGE = /content[ _-]?filter|ResponsibleAIPolicyViolation|content management policy/i;
const CIRCUIT_NEUTRAL_KINDS = new Set(['content_filter', 'circuit_open', 'request_invalid']);
const PROVIDER_REACHABLE_KINDS = new Set(['content_filter', 'request_invalid']);
const SAFE_ID = /^[a-zA-Z0-9._:/-]+$/;
const CONTEXT_MODES = new Set(['full', 'source_only', 'input_rejected', 'liturgical_cache']);

const kindMessage = (kind) => ({
    content_filter: 'Translation blocked by provider content policy',
    circuit_open: 'Translation provider circuit is open',
    rate_limit: 'Translation provider rate limit',
    timeout: 'Translation provider timeout',
    provider_5xx: 'Translation provider unavailable',
    auth_or_deployment: 'Translation provider configuration failure',
    request_invalid: 'Translation provider rejected the request',
    network: 'Translation provider network failure',
    provider_invalid_response: 'Translation provider returned an invalid response',
    unknown: 'Translation provider request failed',
}[kind] || 'Translation provider request failed');

const safeToken = (value, maxLength = 160) => {
    if (value === null || value === undefined) return null;
    const text = String(value).slice(0, maxLength);
    return SAFE_ID.test(text) ? text : null;
};

const safeSeverity = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase();
    return ['safe', 'low', 'medium', 'high', 'very_high', 'unknown'].includes(normalized)
        ? normalized
        : null;
};

const safeHeader = (headers, name) => {
    if (!headers) return null;
    try {
        const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
        return safeToken(value, 200);
    } catch {
        return null;
    }
};

const extractCorrelationIds = (error) => {
    const headers = error?.headers;
    const apimRequestId = safeHeader(headers, 'apim-request-id');
    const xMsRequestId = safeHeader(headers, 'x-ms-request-id');
    const xRequestId = safeHeader(headers, 'x-request-id') || safeToken(error?.request_id, 200);
    return {
        ...(apimRequestId ? { apimRequestId } : {}),
        ...(xMsRequestId ? { xMsRequestId } : {}),
        ...(xRequestId ? { xRequestId } : {}),
    };
};

const bodyErrorFrom = (error) => {
    if (error?.error && typeof error.error === 'object') return error.error;
    if (error?.body?.error && typeof error.body.error === 'object') return error.body.error;
    if (error?.response?.data?.error && typeof error.response.data.error === 'object') {
        return error.response.data.error;
    }
    return {};
};

const redactOperatorDiagnostic = (message) => {
    if (typeof message !== 'string' || message.length === 0) return null;
    return message
        .replace(/<sermon_text>[\s\S]*?<\/sermon_text>/gi, '<sermon_text>[REDACTED]</sermon_text>')
        .replace(/("(?:content|prompt|input|messages)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/((?:api[-_ ]?key|authorization|token|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
        .replace(/\b(?:sk|key)-[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500) || null;
};

const appendFilterResults = (value, source, output, path = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => appendFilterResults(entry, source, output, `${path}_${index}`));
        return;
    }

    const valueIsLeaf = 'filtered' in value || 'severity' in value || 'detected' in value;
    const valueCategory = safeToken(path || 'unknown', 120);
    if (valueIsLeaf && valueCategory) {
        output.push({
            source,
            category: valueCategory,
            filtered: value.filtered === true,
            ...(typeof value.detected === 'boolean' ? { detected: value.detected } : {}),
            ...(safeSeverity(value.severity) ? { severity: safeSeverity(value.severity) } : {}),
        });
        return;
    }

    for (const [key, detail] of Object.entries(value)) {
        if (!detail || typeof detail !== 'object') continue;
        const category = safeToken(path ? `${path}.${key}` : key, 120);
        const isLeaf = 'filtered' in detail || 'severity' in detail || 'detected' in detail;
        if (isLeaf && category) {
            output.push({
                source,
                category,
                filtered: detail.filtered === true,
                ...(typeof detail.detected === 'boolean' ? { detected: detail.detected } : {}),
                ...(safeSeverity(detail.severity) ? { severity: safeSeverity(detail.severity) } : {}),
            });
            continue;
        }
        appendFilterResults(detail, source, output, category || path);
    }
};

const errorFilterResults = (bodyError, source) => {
    const inner = bodyError?.innererror || bodyError?.inner_error || {};
    const output = [];
    appendFilterResults(inner.content_filter_result, source, output);
    appendFilterResults(inner.content_filter_results, source, output);
    appendFilterResults(bodyError.content_filter_result, source, output);
    appendFilterResults(bodyError.content_filter_results, source, output);
    return output;
};

const sanitizeFilterEntries = (entries) => (
    Array.isArray(entries)
        ? entries.flatMap((entry) => {
            const category = safeToken(entry?.category, 120);
            if (!category) return [];
            return [{
                source: entry?.source === 'prompt' || entry?.source === 'completion'
                    ? entry.source
                    : null,
                category,
                filtered: entry?.filtered === true,
                ...(typeof entry?.detected === 'boolean' ? { detected: entry.detected } : {}),
                ...(safeSeverity(entry?.severity) ? { severity: safeSeverity(entry.severity) } : {}),
            }];
        })
        : []
);

const contentFilterSource = ({ param, bodyError = {}, message = '', fallback = null }) => {
    const normalized = String(param || '').toLowerCase();
    if (normalized.includes('prompt')) return 'prompt';
    if (normalized.includes('completion')) return 'completion';

    if (Array.isArray(bodyError?.prompt_filter_results) || bodyError?.prompt_filter_result) {
        return 'prompt';
    }
    const inner = bodyError?.innererror || bodyError?.inner_error || {};
    if (inner?.content_filter_result
        || inner?.content_filter_results
        || bodyError?.content_filter_result
        || bodyError?.content_filter_results) {
        return 'prompt';
    }
    if (Array.isArray(bodyError?.choices)
        && bodyError.choices.some((choice) => choice?.content_filter_results || choice?.finish_reason === 'content_filter')) {
        return 'completion';
    }

    const normalizedMessage = String(message || '').toLowerCase();
    if (/\bprompt\b|input was filtered|input.*content filter/.test(normalizedMessage)) return 'prompt';
    if (/\bcompletion\b|output was filtered|response was filtered/.test(normalizedMessage)) return 'completion';
    return fallback;
};

class TranslationProviderError extends Error {
    constructor({
        kind = 'unknown',
        status = null,
        code = null,
        param = null,
        filterSource = null,
        filterResults = [],
        correlationIds = {},
        providerMessageHash = null,
        attempts = 1,
        contextMode = 'full',
        recoveredFromContentFilter = false,
        cause = null,
        operatorDiagnostic = null,
    } = {}) {
        super(kindMessage(kind));
        this.name = 'TranslationProviderError';
        this.kind = kind;
        this.provider = 'azure_openai';
        this.status = status !== null && status !== undefined && Number.isFinite(Number(status))
            ? Number(status)
            : null;
        this.code = safeToken(code);
        this.param = safeToken(param);
        this.filterSource = filterSource === 'prompt' || filterSource === 'completion'
            ? filterSource
            : null;
        this.filterResults = sanitizeFilterEntries(filterResults);
        const apimRequestId = safeToken(correlationIds?.apimRequestId, 200);
        const xMsRequestId = safeToken(correlationIds?.xMsRequestId, 200);
        const xRequestId = safeToken(correlationIds?.xRequestId, 200);
        this.correlationIds = {
            ...(apimRequestId ? { apimRequestId } : {}),
            ...(xMsRequestId ? { xMsRequestId } : {}),
            ...(xRequestId ? { xRequestId } : {}),
        };
        this.providerMessageHash = safeToken(providerMessageHash, 64);
        this.attempts = Number.isInteger(attempts) && attempts >= 0 ? attempts : 1;
        this.contextMode = CONTEXT_MODES.has(contextMode) ? contextMode : 'full';
        this.recoveredFromContentFilter = recoveredFromContentFilter === true;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: true,
        });
        Object.defineProperty(this, 'operatorDiagnostic', {
            value: redactOperatorDiagnostic(operatorDiagnostic),
            enumerable: false,
            configurable: true,
        });
    }
}

const classifyTranslationProviderError = (rawError) => {
    if (rawError instanceof TranslationProviderError) return rawError;

    const bodyError = bodyErrorFrom(rawError);
    const status = Number(rawError?.status ?? rawError?.statusCode);
    const normalizedStatus = Number.isFinite(status) ? status : null;
    const code = rawError?.code ?? bodyError?.code ?? null;
    const param = rawError?.param ?? bodyError?.param ?? null;
    const inner = bodyError?.innererror || bodyError?.inner_error || {};
    const message = typeof rawError?.message === 'string' ? rawError.message : '';
    const normalizedCode = String(code || '').toLowerCase();
    const normalizedName = String(rawError?.name || '').toLowerCase();
    const normalizedClassName = String(rawError?.constructor?.name || '').toLowerCase();
    const innerCode = String(inner?.code || '').toLowerCase();
    const inferredFilterSource = contentFilterSource({
        param,
        bodyError,
        message,
        fallback: rawError?.filterSource || null,
    });
    const filterResults = errorFilterResults(bodyError, inferredFilterSource);
    const hasStructuredFilter = filterResults.length > 0
        || normalizedCode === 'content_filter'
        || innerCode === 'responsibleaipolicyviolation';
    const messageFallback = !hasStructuredFilter && CONTENT_FILTER_MESSAGE.test(message);

    let kind = 'unknown';
    if (rawError?.kind === 'circuit_open' || /provider circuit (?:is )?open/i.test(message)) {
        kind = 'circuit_open';
    } else if (hasStructuredFilter || messageFallback) {
        kind = 'content_filter';
    } else if (normalizedStatus === 429
        || normalizedName.includes('ratelimit')
        || normalizedClassName.includes('ratelimit')) {
        kind = 'rate_limit';
    } else if (
        normalizedName.includes('timeout')
        || normalizedClassName.includes('timeout')
        || normalizedClassName === 'apiuseraborterror'
        || normalizedName === 'aborterror'
        || /timed? ?out|timeout|request was aborted/i.test(message)
    ) {
        kind = 'timeout';
    } else if ([401, 403, 404].includes(normalizedStatus)
        || /auth|api.?key|deployment.*(?:not.?found|missing)/i.test(`${normalizedCode} ${message}`)) {
        kind = 'auth_or_deployment';
    } else if ([400, 409, 422].includes(normalizedStatus)) {
        kind = 'request_invalid';
    } else if (normalizedStatus !== null && normalizedStatus >= 500) {
        kind = 'provider_5xx';
    } else if (
        normalizedName.includes('connection')
        || normalizedClassName.includes('connection')
        || ['econnreset', 'econnrefused', 'enotfound', 'etimedout'].includes(normalizedCode)
        || (normalizedStatus === null && /connection|network|socket/i.test(message))
    ) {
        kind = 'network';
    }

    const filterSource = kind === 'content_filter'
        ? inferredFilterSource
        : null;
    return new TranslationProviderError({
        kind,
        status: normalizedStatus,
        code,
        param,
        filterSource,
        filterResults,
        correlationIds: extractCorrelationIds(rawError),
        providerMessageHash: messageFallback
            ? crypto.createHash('sha256').update(message).digest('hex')
            : null,
        attempts: rawError?.attempts ?? 1,
        contextMode: rawError?.contextMode || 'full',
        recoveredFromContentFilter: rawError?.recoveredFromContentFilter === true,
        cause: rawError,
        operatorDiagnostic: kind === 'content_filter' ? null : redactOperatorDiagnostic(message),
    });
};

const shouldAffectTranslationCircuit = (error) => !CIRCUIT_NEUTRAL_KINDS.has(error?.kind);

const sanitizeProviderOutcome = (rawError) => {
    const error = classifyTranslationProviderError(rawError);
    return {
        outcome: error.kind === 'content_filter' ? 'policy_block' : 'provider_failure',
        failure_kind: error.kind,
        http_status: error.status,
        provider_code: error.code,
        filter_source: error.filterSource,
        filter_results: error.filterResults,
        apim_request_id: error.correlationIds.apimRequestId || null,
        x_ms_request_id: error.correlationIds.xMsRequestId || null,
        x_request_id: error.correlationIds.xRequestId || null,
        provider_message_hash: error.providerMessageHash,
        attempt: error.attempts,
    };
};

const responseFilterAnnotations = (response) => {
    const output = [];
    for (const promptResult of response?.prompt_filter_results || []) {
        appendFilterResults(promptResult?.content_filter_results, 'prompt', output);
    }
    for (const choice of response?.choices || []) {
        appendFilterResults(choice?.content_filter_results, 'completion', output);
    }
    return output;
};

const assertNoFilteredCompletion = (response) => {
    if (!Array.isArray(response?.choices) || response.choices.length === 0) {
        throw new TranslationProviderError({
            kind: 'provider_invalid_response',
            status: 200,
            code: 'empty_choices',
        });
    }

    const annotations = responseFilterAnnotations(response);
    const completionBlocked = response.choices.some((choice) => choice?.finish_reason === 'content_filter')
        || annotations.some((entry) => entry.source === 'completion' && entry.filtered);
    const promptBlocked = annotations.some((entry) => entry.source === 'prompt' && entry.filtered);
    if (completionBlocked || promptBlocked) {
        const filterSource = completionBlocked ? 'completion' : 'prompt';
        throw new TranslationProviderError({
            kind: 'content_filter',
            status: 200,
            code: 'content_filter',
            param: filterSource,
            filterSource,
            filterResults: annotations.filter((entry) => entry.source === filterSource),
        });
    }

    const content = response.choices[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
        throw new TranslationProviderError({
            kind: 'provider_invalid_response',
            status: 200,
            code: 'empty_completion',
        });
    }
    return annotations;
};

const unwrapProviderResponse = (providerResult) => {
    if (providerResult?.data && providerResult?.response?.headers) {
        return {
            response: providerResult.data,
            correlationIds: extractCorrelationIds({
                headers: providerResult.response.headers,
                request_id: providerResult.request_id,
            }),
        };
    }
    return {
        response: providerResult,
        correlationIds: extractCorrelationIds(providerResult),
    };
};

const executeTranslationProviderRequestPolicy = async ({ request, circuitBreaker }) => {
    if (!circuitBreaker.canRequest()) {
        throw new TranslationProviderError({ kind: 'circuit_open', attempts: 0 });
    }

    try {
        const providerResult = await request();
        const { response, correlationIds } = unwrapProviderResponse(providerResult);
        const annotations = assertNoFilteredCompletion(response);
        circuitBreaker.recordSuccess();
        return { response, annotations, correlationIds };
    } catch (rawError) {
        const error = classifyTranslationProviderError(rawError);
        if (shouldAffectTranslationCircuit(error)) {
            circuitBreaker.recordFailure(error);
        } else if (PROVIDER_REACHABLE_KINDS.has(error.kind)) {
            circuitBreaker.recordProviderReachable();
        }
        throw error;
    }
};

const translationFailureFields = (rawError) => {
    const error = classifyTranslationProviderError(rawError);
    return {
        error: error.message,
        failureKind: error.kind,
        attempts: error.attempts,
        contextMode: error.contextMode,
        recoveredFromContentFilter: error.recoveredFromContentFilter,
        filterSource: error.filterSource,
    };
};

export {
    TranslationProviderError,
    assertNoFilteredCompletion,
    classifyTranslationProviderError,
    extractCorrelationIds,
    executeTranslationProviderRequestPolicy,
    redactOperatorDiagnostic,
    responseFilterAnnotations,
    sanitizeProviderOutcome,
    shouldAffectTranslationCircuit,
    translationFailureFields,
};
