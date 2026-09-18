// Executes unchanged sections of server.js in a vm sandbox; downstream providers are stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SentenceAccumulator, SentenceBuffer } from '../../sentenceService.js';
import { buildDeadlinePayload, normWords, supersedeDecisionFor } from '../../deadlineProvisional.js';
import { clearHeldTail, decideNoOpenCutAction } from '../../noOpenCut.js';
import { endsWithTerminal, endsOnOpenWord, splitAtSafeBoundary } from '../../boundaryConfirmation.js';
export { normWords };

const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

function section(start, end) {
    const first = server.indexOf(start), last = server.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing server section: ${start}`);
    return server.slice(first, last);
}

export function gatewayHarness(overrides = {}) {
    const config = {
        deadlineFallback: { provisionalEnabled: true, reviewFixesEnabled: false,
            minDeltaWords: 3, timeoutMs: 6500, supersedeTtlMs: 25000, ...overrides.deadlineFallback },
        partialFallback: { enabled: true, minPartialLength: 20, timeoutMs: 999999,
            similarityThreshold: 0.85, ...overrides.partialFallback },
        smoothMode: { enabled: true, warmupMinSentences: 1, warmupMinChars: 30, ...overrides.smoothMode },
        flowGovernor: {}, boundaryConfirmation: {}, noOpenCut: {},
    };
    const clock = { now: 0 }, deliveries = [], events = [], previews = [];
    const accumulator = new SentenceAccumulator({ minSentences: 99, minChars: 99999,
        maxHoldMs: 999999, earlyReleaseMs: 999999, ...overrides.accumulator });
    const state = {
        stats: { whisperTranscriptions: 0 }, fallbackState: new Map(),
        smoothPhases: new Map([['test', { phase: 'streaming', warmupDone: true }]]),
        smoothAccumulators: new Map([['test', accumulator]]),
        silenceChunks: new Map(), sentenceBuffers: new Map(), emissionFullHistory: new Map(),
    };
    let nextDispatch;
    const context = vm.createContext({
        config, state, Date: { now: () => clock.now }, console: { log() {}, warn() {} },
        SentenceBuffer, buildDeadlinePayload, dpNormWords: normWords, supersedeDecisionFor,
        clearHeldTail, decideNoOpenCutAction, endsWithTerminal, endsOnOpenWord, splitAtSafeBoundary,
        buildSourceLineage: () => null, buildProjectedSourceLineage: () => null,
        updateWhisperActivity() {}, recordLiveQualityMetric() {}, logAutopilotShadow() {},
        logFlowGovernorShadow: () => null, evalLog: event => events.push(event),
        whisperRequestEvidence: () => ({}), completeWhisperOnlyTracking() {},
        broadcastToChurch: (_, event) => previews.push(event), activeListenerRoutes: () => [],
        qualityTracker: { trackFallback() {} }, FQF_HISTORY_COMMIT_ON_ACCEPT_ENABLED: true,
        DE_STOPWORDS: new Set(),
        processCompleteSentence: async (_, text, latency, options = {}) => {
            const wait = nextDispatch;
            nextDispatch = undefined;
            const output = context.applyRelease(text, options);
            if (wait) await wait;
            if (output !== undefined) deliveries.push({ text: output, origin: options.origin });
            return output === undefined ? undefined : { acceptedForTranslation: true };
        },
    });
    vm.runInContext(section('function ensureFallbackState(', '\nfunction markListenerBoundEmission('), context);
    vm.runInContext(section('function jaccardSimilarity(', '\nconst B4_HISTORY_SIZE'), context);
    vm.runInContext(section('function stemWord(', '\nfunction '), context);
    const resetBlock = section("    if (config.deadlineFallback.provisionalEnabled && options.origin !== 'deadline_fallback') {",
        '\n    qualityTracker.resetPendingFilters(churchId);');
    context.applyRelease = vm.runInContext(`(text, options = {}) => {
        const churchId = 'test', latencyTxId = null, releaseMeta = null;
        const logSourceReleaseOutcome = () => {};
        ${resetBlock}
        return text;
    }`, context);
    const receive = vm.runInContext(`async (result, isFinal = false) => {
        const churchId = 'test', latencyTxId = 'offline', _evalWhisperMs = 1;
        const ws = { send: raw => broadcastToChurch(churchId, JSON.parse(raw)) };
        ${section('            // Process CONFIRMED text through translation pipeline',
            '            // Boundary confirmation SHADOW')}
    }`, context);
    const emit = vm.runInContext(`(${section('async function emitDeadlineFallback(',
        '\nasync function checkDeadlineFallbacks(')})`, context);
    const fb = context.ensureFallbackState('test');
    return {
        fb, config, state, accumulator, deliveries, events, previews, clock,
        async receive(result, at = clock.now, isFinal = false) {
            clock.now = at;
            return receive({ partial: '', confirmed: '', hasNew: false, isSpeech: true, ...result }, isFinal);
        },
        fire(at) {
            clock.now = at;
            return emit('test', fb, [{ routeKey: 'pl:male', ageMs: 7000 }], at);
        },
        release(text, origin = 'smooth_release') {
            return context.processCompleteSentence('test', text, null, { origin });
        },
        flush(origin = 'smooth_timeout') {
            const release = accumulator.flush();
            return release ? this.release(release.text, origin) : undefined;
        },
        holdDispatch() {
            let resolve, reject;
            nextDispatch = new Promise((done, fail) => { resolve = done; reject = fail; });
            return { resolve, reject };
        },
    };
}
