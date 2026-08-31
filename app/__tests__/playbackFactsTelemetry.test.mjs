import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const slice = (from, to) => {
    const start = indexSource.indexOf(from);
    const end = indexSource.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`index.html slice not found: ${from}`);
    return indexSource.slice(start, end);
};

// Real source, executed — not a reimplementation. Reimplementing these functions in the test
        // would copy the fixed code and stay green under mutation.
const telemetrySource = slice('        function _telemetryRecordReceived(chunk) {', '        function buildTelemetrySnapshot(');
// End boundary includes the `/**` of the NEXT doc block on purpose — stopping after it
// would leave the slice with an unterminated comment.
const playbackSource = slice('        async function playServerAudio(', '        /**\n         * Play speech using Web Speech API');

const runTelemetry = () => {
    const outcomes = [];
    const context = { console: { log() {}, warn() {}, error() {} }, outcomes };
    const script = `
        (() => {
            const TELEMETRY_PLAYS_BUFFER = 50;
            const telemetry = {
                chunksReceived: 0, chunksPlayed: 0, chunksCompleted: 0, chunksSkipped: 0,
                chunksNullAudio: 0, chunksPlaybackErrors: 0, chunksExplicitDrops: 0,
                pendingDroppedTotal: 0, droppedByReason: {}, pendingDrops: [], plays: [],
                lastPlayEndAt: null, lastHeardSourceAudioCapturedLocal: null, lastHeardSourcePlayStartAt: null,
            };
            const clockState = { serverSkewMs: null, samples: 0 };
            const qaReplayCapture = null;
            const qaChunkKey = () => 'k';
            const language = 'pl';
            const serverTimeToLocal = () => null;
            const _telemetryRecordOutcome = (chunk, outcome, extra = {}) => { outcomes.push({ outcome, extra }); return null; };
            ${telemetrySource}
            return { _telemetryRecordPlayStart, _telemetryRecordCompleted };
        })()
    `;
    return { api: vm.runInNewContext(script, context), outcomes };
};

const runPlayback = ({ htmlAudio, preservePitch = false }) => {
    const context = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        Uint8Array,
        htmlAudio,
        preservePitch,
    };
    // Concatenated, not a template literal: playServerAudio contains its own
    // `data:audio/mp3;base64,${base64}` template, which an outer template would interpolate.
    const script = [`
        (() => {
            let listenerCatchupMaxRate = 1.3;
            let preserveTtsPitchEnabled = preservePitch;
            let ttsPlaybackActive = false;
            let keepAlivePausedForTts = false;
            let audioOn = false;
            let silentAudio = null;
            let gainNode = { gain: { value: 1 } };
            const VOLUME_LEVEL = 1;
            const navigator = {};
            const ttsAudio = htmlAudio;
            let audioContext = {
                state: 'running',
                decodeAudioData: () => Promise.resolve({ duration: 5.75 }),
                createBufferSource: () => ({
                    buffer: null,
                    playbackRate: { value: 1 },
                    connect() {},
                    onended: null,
                    start() { this.onended(); },
                }),
            };
            function initAudioContext() {}
    `, playbackSource, `
            return playServerAudio;
        })()
    `].join('\n');
    return vm.runInNewContext(script, context);
};

// Minimal HTMLAudioElement stand-in: 'ended' is registered before play() in the real code,
// so firing it from play() reproduces the real ordering. `rateCap` models an engine that
// clamps the assigned rate; `rateReadback` models an element whose rate cannot be read.
const fakeAudioElement = ({ duration = 5.75, preservesPitch = true, rateCap = Infinity, rateReadback, autoEnd = true } = {}) => {
    const listeners = {};
    let assignedRate = 1;
    let defaultRate = 1;
    let src = null;
    return {
        duration,
        preservesPitch,
        volume: 0,
        get src() { return src; },
        // Assigning `src` runs the media load algorithm, which per HTML spec resets
        // playbackRate to defaultPlaybackRate. Verified on the listener device 01.08.2026:
        // a rate set before `src` reads back as 1.0 after it. Modelling this is the whole
        // point of the fake — without it the test cannot tell the ordering apart.
        set src(value) { src = value; assignedRate = defaultRate; },
        get defaultPlaybackRate() { return defaultRate; },
        set defaultPlaybackRate(value) { defaultRate = Math.min(Number(value), rateCap); },
        get playbackRate() { return rateReadback === undefined ? assignedRate : rateReadback; },
        set playbackRate(value) { assignedRate = Math.min(Number(value), rateCap); },
        addEventListener(event, callback) { listeners[event] = callback; },
        play() { if (autoEnd) listeners.ended?.(); return Promise.resolve(); },
        fire(event) { listeners[event]?.(); },
    };
};

describe('playback facts reach the persistent ledger (Early Catch-up spec §4.2-4.3)', () => {
    it('writes engine, effective rate, pitch and decoder duration into play_completed', () => {
        const { api, outcomes } = runTelemetry();
        api._telemetryRecordCompleted({ release_seq: 7 }, { playbackRate: 1.25, durationMs: 4600 }, {
            playbackEngine: 'html_audio',
            effectivePlaybackRate: 1.25,
            preservesPitch: true,
            decoderDurationMs: 5750,
        });

        expect(outcomes.at(-1).outcome).toBe('play_completed');
        expect(outcomes.at(-1).extra).toMatchObject({
            playback_rate: 1.25,          // requested
            duration_ms: 4600,            // wall clock, already compressed by the rate
            playback_engine: 'html_audio',
            effective_playback_rate: 1.25,
            preserves_pitch: true,
            decoder_duration_ms: 5750,
        });
    });

    it('reports nulls, not defaults, when a playback ends without facts', () => {
        // A missing fact must stay visibly missing: defaulting to 1.0 / html_audio would
        // manufacture exactly the confirmation the gate is supposed to test for.
        const { api, outcomes } = runTelemetry();
        api._telemetryRecordCompleted({ release_seq: 7 }, { playbackRate: 1.0, durationMs: 3000 }, null);

        expect(outcomes.at(-1).extra).toMatchObject({
            playback_engine: null,
            effective_playback_rate: null,
            preserves_pitch: null,
            decoder_duration_ms: null,
        });
    });

    it('writes the queue depth and age the policy saw into play_started', () => {
        const { api, outcomes } = runTelemetry();
        api._telemetryRecordPlayStart(0, Date.now() - 2600, 1.25, null, 7, 'hash', { lang: 'pl' }, 4);

        expect(outcomes.at(-1).outcome).toBe('play_started');
        expect(outcomes.at(-1).extra.queue_depth_at_play_start).toBe(4);
        expect(outcomes.at(-1).extra.age_ms).toBeGreaterThanOrEqual(2600);
    });

    it('leaves the depth null when the caller does not report one', () => {
        const { api, outcomes } = runTelemetry();
        api._telemetryRecordPlayStart(0, Date.now(), 1.0, null, 7, 'hash', { lang: 'pl' });

        expect(outcomes.at(-1).extra.queue_depth_at_play_start).toBeNull();
    });
});

describe('playServerAudio reports what the engine actually did', () => {
    it('reports start only after HTMLAudio play() is confirmed', async () => {
        const element = fakeAudioElement({ autoEnd: false });
        let confirmPlay;
        element.play = () => new Promise(resolve => { confirmPlay = resolve; });
        const starts = [];
        const playback = runPlayback({ htmlAudio: element })('QUJD', 1.0, () => starts.push('started'));

        expect(starts).toEqual([]);
        confirmPlay();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(starts).toEqual(['started']);
        element.fire('ended');
        await playback;
    });

    it('reports the WebAudio start exactly once after source.start()', async () => {
        const starts = [];
        await runPlayback({ htmlAudio: null, preservePitch: true })(
            'QUJD', 1.25, () => starts.push('started'),
        );

        expect(starts).toEqual(['started']);
    });

    it('returns the decoder duration in ms alongside the html_audio facts', async () => {
        const facts = await runPlayback({ htmlAudio: fakeAudioElement({ duration: 5.75 }) })('QUJD', 1.25);

        expect(facts).toMatchObject({
            playbackEngine: 'html_audio',
            effectivePlaybackRate: 1.25,
            preservesPitch: true,
            decoderDurationMs: 5750,   // seconds -> ms
        });
    });

    it('survives the load algorithm: the rate is applied AFTER src, not before', async () => {
        // Two independent bugs stacked here. First the element was never bound, so nothing
        // played through it at all. Once bound, the rate was still assigned before `src`,
        // and the load algorithm reset it — the chunk played at 1.0 while the requested rate
        // read 1.15. Only reading the rate back off the element exposes this.
        const facts = await runPlayback({ htmlAudio: fakeAudioElement() })('QUJD', 1.25);

        expect(facts.playbackEngine).toBe('html_audio');
        expect(facts.effectivePlaybackRate).toBe(1.25);
    });

    it('keeps the rate across a LATER re-load, via defaultPlaybackRate', async () => {
        // Ordering alone only survives the first load. Anything that re-runs the load
        // algorithm afterwards (a new src, an explicit load()) resets playbackRate to
        // defaultPlaybackRate — so the intent has to live there too, otherwise the next
        // resource silently drops back to 1.0.
        const element = fakeAudioElement();
        const facts = await runPlayback({ htmlAudio: element })('QUJD', 1.25);
        expect(facts.effectivePlaybackRate).toBe(1.25);

        element.src = 'data:audio/mp3;base64,AAAA';   // a later resource load

        expect(element.playbackRate).toBe(1.25);
    });

    it('reports the rate the ELEMENT ended up at, not the one that was requested', async () => {
        // An engine that caps playbackRate at 1.0 (or a `src` load that resets it) makes the
        // requested value a lie. Returning the request would report catch-up that never
        // happened — the one failure this field exists to catch.
        const facts = await runPlayback({ htmlAudio: fakeAudioElement({ rateCap: 1.0 }) })('QUJD', 1.25);

        expect(facts.effectivePlaybackRate).toBe(1.0);
    });

    it('leaves the rate null when the element cannot be read, instead of echoing the request', async () => {
        const facts = await runPlayback({ htmlAudio: fakeAudioElement({ rateReadback: NaN }) })('QUJD', 1.25);

        expect(facts.effectivePlaybackRate).toBeNull();
    });

    it('keeps decoder duration null when the element reports no usable duration', async () => {
        const facts = await runPlayback({ htmlAudio: fakeAudioElement({ duration: NaN }) })('QUJD', 1.0);

        expect(facts.decoderDurationMs).toBeNull();
    });

    it('exposes the WebAudio fallback forcing 1.0x while pitch preservation is on', async () => {
        // This is the case the gate exists for: requested 1.25x, actually played at 1.0x.
        const facts = await runPlayback({ htmlAudio: null, preservePitch: true })('QUJD', 1.25);

        expect(facts).toMatchObject({
            playbackEngine: 'web_audio',
            effectivePlaybackRate: 1.0,
            preservesPitch: false,
            decoderDurationMs: 5750,
        });
    });
});
