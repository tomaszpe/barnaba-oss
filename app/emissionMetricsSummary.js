const TRACKED_STAGES = new Set([
    'emission_decision',
    'emission_controller_shadow',
    'emission_controller_runtime',
]);

function parseJsonlRecords(text) {
    const records = [];
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            records.push(JSON.parse(trimmed));
        } catch (error) {
            errors.push({
                line: index + 1,
                message: error.message,
            });
        }
    });

    return { records, errors };
}

function summarizeEmissionRecords(records = []) {
    const summary = createEmptySummary();

    for (const record of records) {
        if (!record || !TRACKED_STAGES.has(record.stage)) continue;

        summary.total += 1;
        increment(summary.byStage, record.stage);
        increment(summary.byChurch, record.churchId || 'unknown');
        increment(summary.byLanguage, record.lang || record.language || 'unknown');
        collectNumber(summary.ageMs, record.age_ms);
        collectNumber(summary.queueDepth, record.queue_depth);

        if (record.stage === 'emission_decision') {
            increment(summary.emissionDecision.byDecision, record.decision || 'unknown');
            increment(summary.emissionDecision.byMode, record.mode || 'unknown');
            increment(summary.emissionDecision.bySource, record.source || 'unknown');
            collectNumber(summary.firstAudioMs, record.first_audio_ms);
            continue;
        }

        if (record.stage === 'emission_controller_shadow') {
            increment(summary.controllerShadow.byAction, record.controller_action || 'unknown');
            increment(summary.controllerShadow.byMode, record.controller_mode || 'unknown');
            increment(summary.controllerShadow.byReason, record.controller_reason || 'unknown');
            increment(summary.controllerShadow.byRuntimeDecision, record.runtime_decision || 'unknown');
            if (record.runtime_decision && record.controller_action && record.runtime_decision !== record.controller_action) {
                summary.controllerShadow.runtimeMismatch += 1;
            }
            continue;
        }

        if (record.stage === 'emission_controller_runtime') {
            increment(summary.controllerRuntime.byAction, record.runtime_action || 'unknown');
            increment(summary.controllerRuntime.byMode, record.runtime_mode || 'unknown');
            increment(summary.controllerRuntime.byReason, record.runtime_reason || 'unknown');
        }
    }

    return finalizeSummary(summary);
}

function summarizeEmissionJsonl(text) {
    const parsed = parseJsonlRecords(text);
    return {
        ...summarizeEmissionRecords(parsed.records),
        parseErrors: parsed.errors,
    };
}

function createEmptySummary() {
    return {
        total: 0,
        byStage: {},
        byChurch: {},
        byLanguage: {},
        ageMs: [],
        queueDepth: [],
        firstAudioMs: [],
        emissionDecision: {
            byDecision: {},
            byMode: {},
            bySource: {},
        },
        controllerShadow: {
            byAction: {},
            byMode: {},
            byReason: {},
            byRuntimeDecision: {},
            runtimeMismatch: 0,
        },
        controllerRuntime: {
            byAction: {},
            byMode: {},
            byReason: {},
        },
    };
}

function finalizeSummary(summary) {
    return {
        total: summary.total,
        byStage: summary.byStage,
        byChurch: summary.byChurch,
        byLanguage: summary.byLanguage,
        ageMs: summarizeNumbers(summary.ageMs),
        queueDepth: summarizeNumbers(summary.queueDepth),
        firstAudioMs: summarizeNumbers(summary.firstAudioMs),
        emissionDecision: summary.emissionDecision,
        controllerShadow: summary.controllerShadow,
        controllerRuntime: summary.controllerRuntime,
    };
}

function summarizeNumbers(values) {
    const numeric = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
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
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values.push(numeric);
}

function increment(map, key) {
    map[key] = (map[key] || 0) + 1;
}

function round(value) {
    return Math.round(value * 100) / 100;
}

export {
    parseJsonlRecords,
    summarizeEmissionJsonl,
    summarizeEmissionRecords,
    summarizeNumbers,
};
