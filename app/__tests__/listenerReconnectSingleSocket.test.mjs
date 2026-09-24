import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../public-control/index.html', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const slice = (from, to) => {
    const start = indexSource.indexOf(from);
    const end = indexSource.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`index.html slice not found: ${from}`);
    return indexSource.slice(start, end);
};

// Real source, executed — not a reimplementation. Reimplementing connect() in the test
// would copy the fixed code and stay green under mutation.
const connectSource = slice(
    '        // Exactly one live listener socket at a time.',
    '        function send(msg) {',
);

class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, registry) {
        this.url = url;
        this.readyState = FakeSocket.CONNECTING;
        this.closeCalls = 0;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        registry.push(this);
    }

    close() {
        this.closeCalls += 1;
        this.readyState = FakeSocket.CLOSED;
        // A real socket still emits close after close(); if the handler was not detached
        // first, this is exactly how a retired socket schedules another reconnect.
        if (this.onclose) this.onclose();
    }

    emitOpen() {
        this.readyState = FakeSocket.OPEN;
        if (this.onopen) this.onopen();
    }

    emitClose() {
        this.readyState = FakeSocket.CLOSED;
        if (this.onclose) this.onclose();
    }

    emitMessage(payload) {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    }
}

const buildHarness = ({ churchId = 'example-church', language = 'pt' } = {}) => {
    const sockets = [];
    const timers = [];
    const handled = [];
    const subscribes = [];

    const clock = {
        run(afterMs) {
            for (const timer of [...timers]) {
                if (timer.cancelled || timer.delay > afterMs) continue;
                timer.cancelled = true;
                timer.fn();
            }
        },
        pending: () => timers.filter(timer => !timer.cancelled).length,
    };

    const context = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn, delay) => {
            const timer = { fn, delay, cancelled: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
        WebSocket: class extends FakeSocket {
            constructor(url) { super(url, sockets); }
        },
        WS_URL: 'wss://gateway.test/ws',
        document: { body: { classList: { add() {}, remove() {} } } },
        statusDot: { className: '' },
        statusText: { textContent: '' },
        getUIStrings: () => ({ connecting: 'c', connected: 'k', disconnected: 'd' }),
        uiLang: 'pl',
        OFFLINE_THRESHOLD: 3,
        showOfflineOverlay() {},
        hideOfflineOverlay() {},
        progressiveQueue: { resetForNewEpoch() {} },
        telemetry: { packetEventOutbox: { flush() {} } },
        authenticateListenerSocket() {},
        subscribeCurrentLanguage: (lang) => subscribes.push(lang),
        handleMsg: (msg) => handled.push(msg),
        churchId,
        language,
    };

    const script = `
        let ws = null;
        let reconnectAttempts = 0;
        let wsListenerAuthenticated = false;
        let serverConfirmed = false;
        ${connectSource}
        ({
            connect,
            scheduleReconnect,
            currentSocket: () => ws,
            offlineFlag: () => !serverConfirmed,
        })
    `;
    const api = vm.runInNewContext(script, context);
    return { api, sockets, clock, handled, subscribes };
};

describe('listener keeps exactly one gateway socket across a resume', () => {
    it('a resume during a pending retry does not open a second socket', () => {
        const { api, sockets, clock } = buildHarness();

        api.connect();
        sockets[0].emitOpen();

        // Phone goes to background, socket dies: the close handler schedules a retry.
        sockets[0].emitClose();
        expect(clock.pending()).toBe(1);

        // Phone wakes up before the retry fires and reconnects from visibilitychange.
        api.connect();
        expect(sockets).toHaveLength(2);

        // The scheduled retry must be gone, otherwise it opens socket number three.
        clock.run(3000);
        expect(sockets).toHaveLength(2);
        expect(api.currentSocket()).toBe(sockets[1]);
    });

    it('the previous socket is closed and detached before a new one opens', () => {
        const { api, sockets, clock } = buildHarness();

        api.connect();
        sockets[0].emitOpen();
        api.connect();

        expect(sockets[0].closeCalls).toBe(1);
        expect(sockets[0].readyState).toBe(FakeSocket.CLOSED);
        expect(sockets[0].onmessage).toBeNull();
        expect(sockets[0].onclose).toBeNull();
        // Detaching before close is what stops close() from queueing another reconnect.
        clock.run(3000);
        expect(sockets).toHaveLength(2);
    });

    it('a retired socket cannot deliver audio to the player', () => {
        const { api, sockets, handled } = buildHarness();

        api.connect();
        sockets[0].emitOpen();
        const retired = sockets[0];
        api.connect();
        sockets[1].emitOpen();

        // Reattach by hand to simulate a browser event that was already in flight when the
        // socket was retired. This is the observed failure: two sockets, both feeding handleMsg.
        retired.onmessage = null;
        sockets[1].emitMessage({ type: 'tts_chunk', release_seq: 7 });
        expect(handled).toHaveLength(1);
        expect(handled[0].release_seq).toBe(7);
    });

    it('a late close from a retired socket neither marks offline nor schedules a retry', () => {
        const { api, sockets, clock } = buildHarness();

        api.connect();
        const first = sockets[0];
        first.emitOpen();
        api.connect();
        sockets[1].emitOpen();

        // Force the stale handler back on, then fire close from the retired generation.
        first.onclose = null;
        clock.run(3000);
        expect(sockets).toHaveLength(2);
        expect(api.currentSocket()).toBe(sockets[1]);
    });

    it('closing the current socket schedules exactly one retry', () => {
        const { api, sockets, clock } = buildHarness();

        api.connect();
        sockets[0].emitOpen();
        sockets[0].emitClose();

        expect(clock.pending()).toBe(1);
        clock.run(3000);
        expect(sockets).toHaveLength(2);
        expect(clock.pending()).toBe(0);
    });

    it('reconnect re-subscribes once, from the new socket only', () => {
        const { api, sockets, subscribes } = buildHarness();

        api.connect();
        sockets[0].emitOpen();
        sockets[0].emitClose();
        api.connect();
        sockets[1].emitOpen();

        expect(subscribes).toEqual(['pt', 'pt']);
    });
});

describe('resume and background paths stay honest about measurement', () => {
    it('visibilitychange does not re-subscribe on top of a fresh reconnect', () => {
        expect(indexSource).toContain('const reconnected = !ws || ws.readyState !== WebSocket.OPEN;');
        expect(indexSource).toMatch(
            /if \(!reconnected && churchId && language && authenticated\)/,
        );
    });

    it('going to background flushes the last measurement before timers freeze', () => {
        const backgroundBranch = indexSource.match(
            /console\.log\('\[App\] Going to background'\);[\s\S]{0,600}?\n\s*\}\);/,
        );
        expect(backgroundBranch).not.toBeNull();
        expect(backgroundBranch[0]).toContain('sendTelemetryBeacon();');
    });
});

describe('gateway does not invent measurements it never received', () => {
    it('absent listener counters stay null instead of becoming a measured zero', () => {
        expect(gatewaySource).toContain('const reportedCount = (value) => {');
        for (const field of [
            'chunksCompleted', 'chunksSkipped', 'chunksPlaybackErrors', 'chunksNullAudio',
            'chunksExplicitDrops', 'chunksUnexplained', 'currentlyPlaying',
        ]) {
            expect(gatewaySource).toContain(`${field}: reportedCount(snapshot.${field})`);
            expect(gatewaySource).not.toContain(`${field}: Number(snapshot.${field}) || 0`);
        }
    });

    it('a drop reason outside the contract takes an explicit path, not silence', () => {
        expect(gatewaySource).toContain("refused_by: 'allowedDropReasons'");
        expect(gatewaySource).toContain('dropped_by_reason_rejected: rejectedDropReasons');
    });
});
