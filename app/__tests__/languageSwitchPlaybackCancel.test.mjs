import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import vm from 'node:vm';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(testDirectory, '..', 'public', 'index.html');
const html = readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const deliverySource = readFileSync(resolve(dirname(htmlPath), 'listenerDelivery.js'), 'utf8');

function extract(start, end) {
    const startAt = html.indexOf(start);
    const endAt = html.indexOf(end, startAt + start.length);
    assert.ok(startAt >= 0 && endAt > startAt, `Source section missing: ${start}`);
    return html.slice(startAt, endAt);
}

const realSource = [
    extract('        function resetLanguagePlayback()', '        function stopLocalTranslationPlayback()'),
    extract('        function selectLang(lang)', '        function showTranslation(langName)'),
    extract('        const progressiveQueue = {', '        /**\n         * Initialize AudioContext'),
    extract('        function stopTtsAudioElement()', '        /**\n         * Play base64-encoded MP3 audio.'),
    extract('        async function playServerAudio(', '        /**\n         * Play speech using Web Speech API'),
].join('\n');

function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settle() {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
}

function createClock() {
    let now = 1000;
    let nextId = 0;
    const timers = new Map();
    return {
        timers,
        Date: class extends Date { static now() { return now; } },
        setTimeout(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        async advance(milliseconds) {
            const target = now + milliseconds;
            while (true) {
                const next = [...timers.entries()]
                    .filter(([, timer]) => timer.due <= target)
                    .sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
                await settle();
            }
            now = target;
            await settle();
        },
    };
}

function createAudio() {
    const listeners = new Map();
    return {
        src: '', paused: true, duration: 5, playbackRate: 1, preservesPitch: true,
        requests: [], responses: [], listeners,
        play() {
            this.paused = false;
            this.requests.push(this.src);
            return this.responses.shift() || Promise.resolve();
        },
        pause() { this.paused = true; },
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        load() {},
        addEventListener(name, callback, options) {
            if (!listeners.has(name)) listeners.set(name, new Map());
            listeners.get(name).set(callback, options);
        },
        removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
        emit(name) {
            for (const [callback, options] of [...(listeners.get(name) || [])]) {
                if (options?.once) listeners.get(name).delete(callback);
                callback();
            }
        },
    };
}

function createWebAudio() {
    return {
        state: 'running', sources: [], decodeResponses: [], decodeCalls: 0,
        resume() { this.state = 'running'; return Promise.resolve(); },
        decodeAudioData() {
            this.decodeCalls++;
            return this.decodeResponses.shift() || Promise.resolve({ duration: 5 });
        },
        createBufferSource() {
            const source = {
                playbackRate: { value: 1 }, starts: 0, stops: 0, onended: null,
                connect() {},
                start() { this.starts++; },
                stop() { this.stops++; this.onended?.(); },
            };
            this.sources.push(source);
            return source;
        },
    };
}

function loadListener({ bounded = false, htmlAudio = true } = {}) {
    const clock = createClock();
    const audio = createAudio();
    const webAudio = createWebAudio();
    const silentAudio = createAudio();
    const starts = [];
    const completed = [];
    const errors = [];
    const dropped = [];
    const subscriptions = [];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        navigator: { mediaSession: {} },
        document: { querySelectorAll: () => [] },
        speechSynthesis: { cancel() {} },
        ttsAudio: htmlAudio ? audio : null, silentAudio, audioContext: webAudio,
        gainNode: {}, VOLUME_LEVEL: 0.7, audioOn: true,
        ttsPlaybackActive: false, keepAlivePausedForTts: false,
        listenerCatchupMaxRate: 1.2, preserveTtsPitchEnabled: true,
        churchId: 'offline-church', serverConfirmed: true,
        LANG_NAMES: { pl: 'Polski', en: 'English', de: 'Deutsch' },
        speechQueue: [], speaking: false,
        listenerPlaybackPolicyV2Enabled: false,
        listenerBoundedSchedulerEnabled: bounded,
        listenerCatchupChunkAgeMs: 60000, listenerBacklogBudgetMs: 60000,
        LISTENER_DROP_AGE_BUDGET_MS: 60000,
        listenerEarlyCatchupEnabled: false,
        fqfT2SupersessionShadowEnabled: false, fqfT2SupersessionApplyEnabled: false,
        qaReplayCapture: null,
        telemetry: { plays: [] },
        earlyCatchup: { reset() {} }, playbackPolicy: { choose: () => 1 },
        localizeUI() {}, showTranslation() {}, initAudioContext() {},
        subscribeCurrentLanguage: lang => subscriptions.push(lang),
        _telemetryRecordReceived() {}, _telemetryRecordSkipped() {},
        _telemetryRecordSupersessionShadow() {}, _telemetryRecordSuperseded() {},
        _telemetryRecordPendingDrop: (chunk, reason) => dropped.push({ chunk, reason }),
        _telemetryRecordPlayStart: (_index, _received, rate, _captured, _seq, _hash, chunk) => {
            starts.push(chunk.lang);
            return { playStartAt: clock.Date.now(), playbackRate: rate };
        },
        _telemetryRecordCompleted: (chunk, record, facts) => completed.push({ chunk, record, facts }),
        _telemetryRecordPlaybackError: (chunk, error) => errors.push({ chunk, error }),
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(deliverySource, context);
    vm.runInContext(`
        let language = 'pl';
        const listenerDelivery = window.BarnabaListenerDelivery;
        ${realSource}
        globalThis.listenerTestApi = { queue: progressiveQueue, selectLang };
    `, context);
    let sequence = 0;
    return {
        ...context.listenerTestApi,
        clock, audio, webAudio, silentAudio, starts, completed, errors, dropped, subscriptions,
        context,
        add(lang = 'pl') {
            sequence++;
            context.listenerTestApi.queue.addChunk({
                type: 'tts_chunk', language: lang, session_epoch: 'offline-epoch',
                release_seq: sequence, emissionId: sequence,
                sentence_index: 0, total_sentences: 1, is_last: true,
                audioBase64: Buffer.from(lang).toString('base64'), chunk_word_count: 5,
            });
        },
    };
}

for (const bounded of [false, true]) {
    test(`language switch releases active HTMLAudio immediately (bounded=${bounded})`, async () => {
        const listener = loadListener({ bounded });
        listener.add();
        await settle();
        const oldTimers = [...listener.clock.timers.keys()];
        const oldEnded = [...listener.audio.listeners.get('ended').keys()];
        const oldErrors = [...listener.audio.listeners.get('error').keys()];

        listener.selectLang('en');
        listener.add('en');
        await settle();

        assert.deepEqual(listener.starts, ['pl', 'en']);
        assert.deepEqual(listener.subscriptions, ['en']);
        assert.equal(listener.queue.playing, true);
        for (const id of oldTimers) assert.equal(listener.clock.timers.has(id), false);
        for (const callback of oldEnded) assert.equal(listener.audio.listeners.get('ended').has(callback), false);
        for (const callback of oldErrors) assert.equal(listener.audio.listeners.get('error').has(callback), false);
        assert.equal(listener.completed.length, 0, 'cancelled audio is not completed telemetry');
        assert.equal(listener.errors.length, 0, 'intentional cancellation is not a playback failure');

        listener.audio.emit('ended');
        await settle();
        assert.deepEqual(listener.completed.map(item => item.chunk.lang), ['en']);
        assert.equal(listener.queue.playing, false);
    });
}

test('rapid PL to EN to DE switches do not let old callbacks unlock new audio', async () => {
    const listener = loadListener();
    listener.add();
    await settle();
    listener.selectLang('en');
    listener.add('en');
    listener.selectLang('de');
    listener.add('de');
    await settle();
    assert.equal(listener.starts.at(-1), 'de');
    assert.equal(listener.queue.playing, true);
    assert.equal(listener.context.ttsPlaybackActive, true);
    assert.equal(listener.completed.length, 0);
    assert.equal(listener.clock.timers.size, 1);
    listener.audio.emit('ended');
    await settle();
    assert.deepEqual(listener.completed.map(item => item.chunk.lang), ['de']);
});

test('old 30-second deadline cannot finish or deactivate new-language playback', async () => {
    const listener = loadListener();
    listener.add();
    await settle();
    await listener.clock.advance(2000);
    listener.selectLang('en');
    listener.add('en');
    await settle();
    await listener.clock.advance(28000);
    assert.deepEqual(listener.starts, ['pl', 'en']);
    assert.equal(listener.completed.length, 0);
    assert.equal(listener.queue.playing, true);
    assert.equal(listener.context.ttsPlaybackActive, true);
    await listener.clock.advance(2000);
    assert.deepEqual(listener.completed.map(item => item.chunk.lang), ['en']);
});

for (const outcome of ['resolve', 'reject']) {
    test(`switch while HTML play() is pending survives late ${outcome}`, async () => {
        const listener = loadListener();
        const oldPlay = deferred();
        listener.audio.responses.push(oldPlay.promise);
        listener.add();
        listener.selectLang('en');
        listener.add('en');
        await settle();
        assert.deepEqual(listener.starts, ['en']);
        assert.equal(listener.queue.playing, true);
        const keepAlivePlays = listener.silentAudio.requests.length;

        if (outcome === 'resolve') oldPlay.resolve();
        else oldPlay.reject(new Error('late old-language play failure'));
        await settle();

        assert.deepEqual(listener.starts, ['en']);
        assert.equal(listener.queue.playing, true);
        assert.equal(listener.context.ttsPlaybackActive, true);
        assert.equal(listener.webAudio.decodeCalls, 0, 'cancelled HTML task must not enter fallback');
        assert.equal(listener.silentAudio.requests.length, keepAlivePlays);
        assert.equal(listener.completed.length, 0);
        assert.equal(listener.errors.length, 0);
    });
}

test('switch during WebAudio decoding starts only the new-language source', async () => {
    const listener = loadListener({ htmlAudio: false });
    const oldDecode = deferred();
    listener.webAudio.decodeResponses.push(oldDecode.promise);
    listener.add();
    await settle();
    listener.selectLang('en');
    listener.add('en');
    await settle();
    assert.deepEqual(listener.starts, ['en']);
    assert.equal(listener.webAudio.sources.length, 1);
    oldDecode.resolve({ duration: 5 });
    await settle();
    assert.equal(listener.webAudio.sources.length, 1, 'late old decode must never start');
    assert.equal(listener.queue.playing, true);
    assert.equal(listener.completed.length, 0);
});

test('switch during suspended AudioContext resume prevents old task from decoding', async () => {
    const listener = loadListener({ htmlAudio: false });
    const oldResume = deferred();
    listener.webAudio.state = 'suspended';
    listener.webAudio.resume = () => {
        listener.webAudio.state = 'running';
        return oldResume.promise;
    };
    listener.add();
    listener.selectLang('en');
    listener.add('en');
    await settle();
    assert.deepEqual(listener.starts, ['en']);
    oldResume.resolve();
    await settle();
    assert.equal(listener.webAudio.decodeCalls, 1);
    assert.equal(listener.webAudio.sources.length, 1);
    assert.equal(listener.queue.playing, true);
});

test('switch stops active WebAudio and old ended callback cannot finish new playback', async () => {
    const listener = loadListener({ htmlAudio: false });
    listener.add();
    await settle();
    const oldSource = listener.webAudio.sources[0];
    const oldEnded = oldSource.onended;
    listener.selectLang('en');
    listener.add('en');
    await settle();
    assert.equal(oldSource.stops, 1);
    assert.equal(oldSource.onended, null);
    assert.deepEqual(listener.starts, ['pl', 'en']);
    oldEnded();
    await settle();
    assert.equal(listener.queue.playing, true);
    assert.equal(listener.completed.length, 0);
    listener.webAudio.sources[1].onended();
    await settle();
    assert.deepEqual(listener.completed.map(item => item.chunk.lang), ['en']);
});

test('HTML failure still falls back normally and language switch stops that fallback', async () => {
    const listener = loadListener();
    listener.audio.responses.push(Promise.reject(new Error('autoplay blocked')));
    listener.add();
    await settle();
    assert.equal(listener.webAudio.sources[0].starts, 1);
    assert.deepEqual(listener.starts, ['pl']);
    listener.selectLang('en');
    listener.add('en');
    await settle();
    assert.equal(listener.webAudio.sources[0].stops, 1);
    assert.deepEqual(listener.starts, ['pl', 'en']);
    assert.equal(listener.queue.playing, true);
});

test('ordinary queue reset continues active audio and retains single playback lane', async () => {
    const listener = loadListener();
    listener.add();
    await settle();
    const oldTimers = [...listener.clock.timers.keys()];
    listener.queue._reset();
    listener.add();
    await settle();
    assert.equal(listener.audio.requests.length, 1);
    assert.equal(listener.audio.paused, false);
    assert.equal(listener.queue.playing, true);
    assert.deepEqual([...listener.clock.timers.keys()], oldTimers);
    listener.audio.emit('ended');
    await settle();
    assert.equal(listener.audio.requests.length, 2);
    assert.equal(listener.completed.length, 1);
});

test('ordinary reset during decode does not open a second playback lane', async () => {
    const listener = loadListener({ htmlAudio: false });
    const oldDecode = deferred();
    listener.webAudio.decodeResponses.push(oldDecode.promise);
    listener.add();
    listener.queue._reset();
    listener.add();
    await settle();
    assert.equal(listener.webAudio.decodeCalls, 1);
    assert.equal(listener.queue.playing, true);
    oldDecode.resolve({ duration: 5 });
    await settle();
    assert.equal(listener.webAudio.decodeCalls, 2);
    assert.equal(listener.webAudio.sources.length, 1);
    assert.equal(listener.starts.length, 1);
});

test('same-language selection keeps existing reset behavior unchanged', async () => {
    const listener = loadListener();
    listener.add();
    await settle();
    const oldTimers = [...listener.clock.timers.keys()];
    listener.selectLang('pl');
    assert.deepEqual([...listener.clock.timers.keys()], oldTimers);
    assert.equal(listener.queue.playing, true);
    assert.equal(listener.audio.paused, true);
    assert.equal(listener.completed.length, 0);
});

test('normal HTML ended event finishes one task and starts the next', async () => {
    const listener = loadListener({ bounded: true });
    listener.add();
    listener.add();
    await settle();
    assert.equal(listener.starts.length, 1);
    listener.audio.emit('ended');
    await settle();
    assert.equal(listener.completed.length, 1);
    assert.equal(listener.starts.length, 2);
    assert.equal(listener.queue.playing, true);
    listener.audio.emit('ended');
    await settle();
    assert.equal(listener.completed.length, 2);
    assert.equal(listener.queue.playing, false);
    assert.equal(listener.errors.length, 0);
});

test('normal playback retains the existing 30-second safety timeout', async () => {
    const listener = loadListener();
    listener.add();
    await settle();
    await listener.clock.advance(29999);
    assert.equal(listener.completed.length, 0);
    await listener.clock.advance(1);
    assert.equal(listener.completed.length, 1);
    assert.equal(listener.queue.playing, false);
});
