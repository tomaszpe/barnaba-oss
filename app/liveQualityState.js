const DEFAULT_LIVE_QUALITY_CONFIG = {
    windowMs: 60000,
    listenerMeasurementMaxAgeMs: 30000,
    degradedPauseP95Ms: 7000,
    criticalPauseP95Ms: 12000,
    degradedWhisperP95Ms: 3000,
    criticalWhisperP95Ms: 6000,
    degradedFirstTextP95Ms: 5000,
    criticalFirstTextP95Ms: 9000,
    degradedFirstAudioP95Ms: 6000,
    criticalFirstAudioP95Ms: 10000,
    degradedListenerBufferDepth: 2,
    criticalListenerBufferDepth: 5,
    degradedListenerDriftMs: 6000,
    criticalListenerDriftMs: 12000,
    degradedQueueDepth: 2,
    criticalQueueDepth: 5,
    degradedDuplicateRate: 0.08,
    criticalDuplicateRate: 0.18,
    degradedDropAudioSkipRate: 0.05,
    criticalDropAudioSkipRate: 0.15,
    degradedFallbackRate: 0.08,
    criticalFallbackRate: 0.2,
    minSamplesForConfidence: 5,
};

const MAIN_CAUSES = [
    'listener_drift',
    'tts_backlog',
    'gpt_latency',
    'whisper_delay',
    'duplicate_risk',
    'queue_pressure',
    'source_stall',
    'healthy',
];

function normalizeConfig(config = {}) {
    return {
        ...DEFAULT_LIVE_QUALITY_CONFIG,
        ...config,
    };
}

function createLiveQualityState(config = {}) {
    return new LiveQualityState(config);
}

class LiveQualityState {
    constructor(config = {}) {
        this.config = normalizeConfig(config);
        this.records = [];
        this.latestByStream = new Map();
    }

    record(metric = {}, nowMs = Date.now()) {
        const normalized = normalizeMetric(metric, nowMs);
        this.records.push(normalized);
        for (const stream of streamNamesForRecord(normalized)) {
            const latest = this.latestByStream.get(stream);
            if (!latest || normalized.tsMs >= latest.tsMs) this.latestByStream.set(stream, normalized);
        }
        this.prune(nowMs);
        return normalized;
    }

    recordMany(metrics = [], nowMs = Date.now()) {
        for (const metric of metrics) {
            this.record(metric, metric?.tsMs ?? nowMs);
        }
        this.prune(nowMs);
    }

    prune(nowMs = Date.now()) {
        const cutoff = nowMs - this.config.windowMs;
        this.records = this.records.filter(record => record.tsMs >= cutoff);
    }

    snapshot(nowMs = Date.now()) {
        this.prune(nowMs);
        return buildLiveQualitySnapshot(
            this.records,
            this.config,
            nowMs,
            Object.fromEntries(this.latestByStream),
        );
    }
}

function normalizeMetric(metric = {}, nowMs = Date.now()) {
    return {
        ...metric,
        tsMs: normalizeTimestamp(metric.tsMs ?? metric.timestamp_ms ?? metric.timeMs, nowMs),
        stage: metric.stage || 'unknown',
        churchId: metric.churchId ?? metric.church_id ?? null,
        lang: metric.lang ?? metric.language ?? null,
    };
}

function buildLiveQualitySnapshot(records = [], config = {}, nowMs = Date.now(), latestByStream = null) {
    const cfg = normalizeConfig(config);
    const normalizedRecords = records.map(record => normalizeMetric(record, nowMs));
    const freshness = summarizeStreamFreshness(normalizedRecords, cfg, nowMs, latestByStream);
    const metrics = collectLiveQualityMetrics(normalizedRecords, cfg, nowMs);
    const causeScores = scoreMainCauses(metrics, cfg, freshness);
    const state = classifyLiveQuality(causeScores, freshness);
    const mainCause = selectMainCause(causeScores);
    const confidence = calculateConfidence(metrics, cfg);

    return {
        state,
        mainCause,
        confidence,
        metrics,
        causeScores,
        freshness,
        sampleCount: metrics.totalSamples,
        windowMs: cfg.windowMs,
    };
}

function collectLiveQualityMetrics(records = [], config = {}, nowMs = Date.now()) {
    const cfg = normalizeConfig(config);
    const values = {
        firstTextMs: [],
        firstAudioMs: [],
        segmentAgeMs: [],
        pauseMs: [],
        queueDepth: [],
        listenerBufferDepth: [],
        listenerDriftMs: [],
        whisperMs: [],
        gptMs: [],
        ttsMs: [],
        localAgreementConfirmationMs: [],
        fallbackStallMs: [],
    };
    const counters = {
        emissions: 0,
        translations: 0,
        tts: 0,
        drops: 0,
        audioSkips: 0,
        duplicates: 0,
        fallbacks: 0,
        sourceStalls: 0,
    };

    for (const record of records) {
        collectRecordValues(record, values, counters, cfg, nowMs);
    }

    const totalSamples = Object.values(values).reduce((sum, list) => sum + list.length, 0)
        + Object.values(counters).reduce((sum, count) => sum + count, 0);

    return {
        firstTextMs: summarizeNumbers(values.firstTextMs),
        firstAudioMs: summarizeNumbers(values.firstAudioMs),
        segmentAgeMs: summarizeNumbers(values.segmentAgeMs),
        pauseMs: summarizeNumbers(values.pauseMs),
        queueDepth: summarizeNumbers(values.queueDepth),
        listenerBufferDepth: summarizeNumbers(values.listenerBufferDepth),
        listenerDriftMs: summarizeNumbers(values.listenerDriftMs),
        whisperMs: summarizeNumbers(values.whisperMs),
        gptMs: summarizeNumbers(values.gptMs),
        ttsMs: summarizeNumbers(values.ttsMs),
        localAgreementConfirmationMs: summarizeNumbers(values.localAgreementConfirmationMs),
        fallbackStallMs: summarizeNumbers(values.fallbackStallMs),
        counters,
        rates: {
            dropAudioSkip: ratio(counters.drops + counters.audioSkips, Math.max(1, counters.emissions)),
            duplicates: ratio(counters.duplicates, Math.max(1, counters.emissions)),
            fallbacks: ratio(counters.fallbacks, Math.max(1, counters.emissions)),
        },
        totalSamples,
    };
}

function collectRecordValues(record, values, counters, config, nowMs) {
    if (!record || typeof record !== 'object') return;

    collectNumber(values.firstTextMs, record.first_text_ms ?? record.firstTextMs);
    collectNumber(values.firstAudioMs, record.first_audio_ms ?? record.firstAudioMs);
    collectNumber(values.segmentAgeMs, record.segment_age_ms ?? record.age_ms ?? record.segmentAgeMs);
    collectNumber(values.pauseMs, record.pause_ms ?? record.pauseMs ?? record.gap_ms ?? record.gapMs);
    if (!isListenerRecord(record) || listenerMeasurementStatus(record, config, nowMs).status === 'live') {
        collectNumber(values.queueDepth, record.queue_depth ?? record.queueDepth);
        collectNumber(values.listenerBufferDepth, record.listener_buffer_depth ?? record.listenerBufferDepth ?? record.bufferDepth);
        collectNumber(values.listenerDriftMs, record.listener_drift_ms ?? record.listenerDriftMs ?? record.audibleDriftMs);
    }
    collectNumber(values.whisperMs, record.whisper_ms ?? (record.stage === 'whisper' ? record.latency_ms : null));
    collectNumber(values.gptMs, record.gpt_ms ?? record.translation_ms ?? (record.stage === 'translation' ? record.latency_ms : null));
    collectNumber(values.ttsMs, record.tts_ms ?? (record.stage === 'tts' ? record.latency_ms : null));
    collectNumber(values.localAgreementConfirmationMs, record.confirmation_latency_ms ?? record.localAgreementConfirmationMs);
    collectNumber(values.fallbackStallMs, record.stall_ms ?? record.fallback_stall_ms ?? record.fallbackStallMs);

    if (isEmissionRecord(record)) counters.emissions += 1;
    if (record.stage === 'translation') counters.translations += 1;
    if (record.stage === 'tts') counters.tts += 1;
    if (record.stage === 'fallback' || record.action === 'fallback' || record.reason === 'partial_fallback') counters.fallbacks += 1;
    if (record.stage === 'source_stall' || record.reason === 'hasNew_false' || record.source_stall === true) counters.sourceStalls += 1;

    const decision = record.decision ?? record.action ?? record.runtime_action ?? record.controller_action;
    if (decision === 'drop' || decision === 'drop_stale') counters.drops += 1;
    if (decision === 'audio_skip' || decision === 'text_only' || decision === 'text_only_stale') counters.audioSkips += 1;

    const dupCount = Number(
        record.adjacentWordDups
        ?? record.adjacent_word_dups
        ?? record.duplicate_count
        ?? record.duplicates
        ?? 0
    );
    if (Number.isFinite(dupCount) && dupCount > 0) counters.duplicates += dupCount;
}

function isEmissionRecord(record) {
    return record.stage === 'emission_decision'
        || record.stage === 'emission_controller_runtime'
        || record.stage === 'emission_controller_shadow'
        || record.stage === 'translation'
        || record.emissionId != null;
}

function scoreMainCauses(metrics, config, freshness = {}) {
    const cfg = normalizeConfig(config);
    return {
        listener_drift: freshness.listener?.status === 'live'
            ? maxSeverity(
                thresholdSeverity(metrics.listenerBufferDepth.p95, cfg.degradedListenerBufferDepth, cfg.criticalListenerBufferDepth),
                thresholdSeverity(metrics.listenerDriftMs.p95, cfg.degradedListenerDriftMs, cfg.criticalListenerDriftMs),
            )
            : 'unknown',
        tts_backlog: maxSeverity(
            thresholdSeverity(metrics.firstAudioMs.p95, cfg.degradedFirstAudioP95Ms, cfg.criticalFirstAudioP95Ms),
            thresholdSeverity(metrics.ttsMs.p95, cfg.degradedFirstAudioP95Ms, cfg.criticalFirstAudioP95Ms),
            rateSeverity(metrics.rates.dropAudioSkip, cfg.degradedDropAudioSkipRate, cfg.criticalDropAudioSkipRate),
        ),
        gpt_latency: thresholdSeverity(metrics.gptMs.p95, 1500, 3500),
        whisper_delay: maxSeverity(
            thresholdSeverity(metrics.whisperMs.p95, cfg.degradedWhisperP95Ms, cfg.criticalWhisperP95Ms),
            thresholdSeverity(metrics.firstTextMs.p95, cfg.degradedFirstTextP95Ms, cfg.criticalFirstTextP95Ms),
            thresholdSeverity(metrics.localAgreementConfirmationMs.p95, cfg.degradedFirstTextP95Ms, cfg.criticalFirstTextP95Ms),
            thresholdSeverity(metrics.pauseMs.p95, cfg.degradedPauseP95Ms, cfg.criticalPauseP95Ms),
        ),
        duplicate_risk: rateSeverity(metrics.rates.duplicates, cfg.degradedDuplicateRate, cfg.criticalDuplicateRate),
        queue_pressure: thresholdSeverity(metrics.queueDepth.p95, cfg.degradedQueueDepth, cfg.criticalQueueDepth),
        source_stall: maxSeverity(
            thresholdSeverity(metrics.fallbackStallMs.p95, cfg.degradedPauseP95Ms, cfg.criticalPauseP95Ms),
            rateSeverity(metrics.rates.fallbacks, cfg.degradedFallbackRate, cfg.criticalFallbackRate),
            metrics.counters.sourceStalls > 0 ? 'degraded' : 'good',
        ),
        healthy: 'good',
    };
}

function classifyLiveQuality(causeScores = {}, freshness = {}) {
    if (Object.values(causeScores).includes('critical')) return 'critical';
    if (Object.values(causeScores).includes('degraded')) return 'degraded';
    if (Object.values(freshness).some(stream => stream?.status !== 'live')) return 'unknown';
    return 'good';
}

function selectMainCause(causeScores = {}) {
    for (const severity of ['critical', 'degraded']) {
        const cause = MAIN_CAUSES.find(item => causeScores[item] === severity && item !== 'healthy');
        if (cause) return cause;
    }
    return 'healthy';
}

function calculateConfidence(metrics, config = {}) {
    const cfg = normalizeConfig(config);
    if (!metrics.totalSamples) return 0;
    return round(Math.min(1, metrics.totalSamples / cfg.minSamplesForConfidence));
}

function thresholdSeverity(value, degradedThreshold, criticalThreshold) {
    if (!Number.isFinite(value)) return 'good';
    if (value >= criticalThreshold) return 'critical';
    if (value >= degradedThreshold) return 'degraded';
    return 'good';
}

function rateSeverity(value, degradedThreshold, criticalThreshold) {
    return thresholdSeverity(value, degradedThreshold, criticalThreshold);
}

function maxSeverity(...severities) {
    if (severities.includes('critical')) return 'critical';
    if (severities.includes('degraded')) return 'degraded';
    return 'good';
}

function isListenerRecord(record) {
    return record?.stage === 'listener_telemetry';
}

function listenerMeasurementStatus(record, config = {}, nowMs = Date.now()) {
    const cfg = normalizeConfig(config);
    if (!record) return { status: 'missing', ageMs: null, lastSampleTsMs: null };
    const reportedAge = Number(
        record.listener_measurement_age_ms
        ?? record.listenerMeasurementAgeMs
        ?? record.latest_play_age_ms,
    );
    if (!Number.isFinite(reportedAge)) {
        return { status: 'unknown', ageMs: null, lastSampleTsMs: record.tsMs ?? null };
    }
    const recordTsMs = Number(record.tsMs);
    const receiptAge = Number.isFinite(recordTsMs) ? Math.max(0, nowMs - recordTsMs) : 0;
    const ageMs = Math.max(0, reportedAge) + receiptAge;
    return {
        status: ageMs <= cfg.listenerMeasurementMaxAgeMs ? 'live' : 'stale',
        ageMs: Math.round(ageMs),
        lastSampleTsMs: record.tsMs ?? null,
    };
}

function streamNamesForRecord(record) {
    const streams = [];
    if (isListenerRecord(record)) streams.push('listener');
    if (record?.stage === 'whisper' || record?.whisper_ms != null) streams.push('whisper');
    if (record?.stage === 'translation' || record?.gpt_ms != null || record?.translation_ms != null) streams.push('translation');
    if (record?.stage === 'tts' || record?.tts_ms != null) streams.push('tts');
    if (record?.stage === 'emission_decision'
        || record?.stage === 'emission_controller_runtime'
        || record?.stage === 'emission_controller_shadow') streams.push('emission');
    return streams;
}

function summarizeStreamFreshness(records = [], config = {}, nowMs = Date.now(), latestByStream = null) {
    const cfg = normalizeConfig(config);
    const streamNames = ['listener', 'whisper', 'translation', 'tts', 'emission'];
    const result = {};
    for (const stream of streamNames) {
        const latest = latestByStream?.[stream]
            || records.filter(record => streamNamesForRecord(record).includes(stream))
                .sort((a, b) => b.tsMs - a.tsMs)[0];
        if (!latest) {
            result[stream] = { status: 'missing', ageMs: null, lastSampleTsMs: null };
            continue;
        }
        if (stream === 'listener') {
            result[stream] = listenerMeasurementStatus(latest, cfg, nowMs);
            continue;
        }
        const ageMs = Math.max(0, nowMs - latest.tsMs);
        result[stream] = {
            status: ageMs <= cfg.windowMs ? 'live' : 'stale',
            ageMs: Math.round(ageMs),
            lastSampleTsMs: latest.tsMs,
        };
    }
    return result;
}

function summarizeNumbers(values = []) {
    const numeric = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!numeric.length) {
        return {
            count: 0,
            min: null,
            max: null,
            avg: null,
            p50: null,
            p95: null,
            p99: null,
        };
    }

    return {
        count: numeric.length,
        min: numeric[0],
        max: numeric[numeric.length - 1],
        avg: round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length),
        p50: percentileSorted(numeric, 50),
        p95: percentileSorted(numeric, 95),
        p99: percentileSorted(numeric, 99),
    };
}

function percentileSorted(sorted, percentile) {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
    return sorted[index];
}

function collectNumber(values, value) {
    if (value == null || value === '') return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values.push(Math.max(0, numeric));
}

function normalizeTimestamp(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function ratio(numerator, denominator) {
    if (!denominator) return 0;
    return round(numerator / denominator);
}

function round(value) {
    return Math.round(value * 10000) / 10000;
}

export {
    DEFAULT_LIVE_QUALITY_CONFIG,
    LiveQualityState,
    buildLiveQualitySnapshot,
    collectLiveQualityMetrics,
    createLiveQualityState,
    normalizeConfig,
    normalizeMetric,
    scoreMainCauses,
    summarizeStreamFreshness,
    summarizeNumbers,
};
