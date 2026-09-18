import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const adminSource = readFileSync(new URL('../public-control/admin.html', import.meta.url), 'utf8');

/**
 * Regression guard for a failed control-panel login (16.09.2026).
 *
 * START BARNABA with a wrong password showed nothing: `ensureControlSession` threw outside the
 * try/catch, so the rejection went unhandled (no toast), and `masterPassword` kept the rejected
 * value. Every prompt is guarded by `if (!masterPassword)`, so the next click skipped the
 * prompt and resent the same wrong password. Only a page reload let the operator retype it.
 * A 429 rate-limit answer failed the same silent way.
 *
 * The harness runs the real admin.html functions in a sandbox with a stubbed fetch and a
 * scripted password prompt, and clicks the buttons twice.
 */

function slice(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker);
    expect(start, `${label}: start marker not found - the guard below would test nothing`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `${label}: end marker not found`).toBeGreaterThan(start);
    return source.slice(start, end);
}

const loginHelpers = slice(
    adminSource,
    'async function ensureControlSession(password) {',
    'async function fetchControlJson(',
    'admin.html control login helpers'
);
const startBarnabaSource = slice(
    adminSource,
    'async function startBarnaba() {',
    'async function checkWhisperHealth() {',
    'admin.html startBarnaba'
);
const stopBarnabaSource = slice(
    adminSource,
    'async function stopBarnaba() {',
    'function resetControlPanel(',
    'admin.html stopBarnaba'
);
const quickStartSource = slice(
    adminSource,
    'async function quickStart() {',
    '</script>',
    'admin.html quickStart'
);

const INVALID_PASSWORD = { status: 401, body: { success: false, error: 'Invalid password' } };
const RATE_LIMITED = {
    status: 429,
    body: { success: false, error: 'Too many requests. Please try again later.', retryAfter: 42 },
};
const LOGIN_OK = { status: 200, body: { success: true } };

function makeElement(overrides = {}) {
    return {
        value: '',
        disabled: false,
        textContent: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        focus() {},
        ...overrides,
    };
}

function loadPanel({ typedPasswords, loginResponses, systemState = 'stopped' }) {
    const prompts = [];
    const toasts = [];
    const loginBodies = [];
    const elements = {
        qsChurchSelect: makeElement({ value: 'church-1' }),
        churchSelect: makeElement(),
        qsStartBtn: makeElement({ textContent: '▶️ START BARNABA' }),
        qsStopBtn: makeElement({ textContent: '⏹️ STOP BARNABA' }),
        passwordRow: makeElement({ style: { display: 'none' } }),
    };
    const pendingPasswords = [...typedPasswords];
    const pendingResponses = [...loginResponses];

    const context = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: { setItem() {}, getItem: () => null },
        $: id => (elements[id] ??= makeElement()),
        showPasswordModal: async title => {
            prompts.push(title);
            return pendingPasswords.shift() ?? null;
        },
        showToast: (message, type) => toasts.push({ message, type }),
        fetchWithTimeout: async (url, options = {}) => {
            if (url !== '/api/control/login') {
                // A test that reaches past the login must not look like a passing login check.
                throw new Error(`unexpected request after login: ${url}`);
            }
            loginBodies.push(JSON.parse(options.body));
            const next = pendingResponses.shift();
            if (!next) throw new Error('no scripted /api/control/login response left');
            return new Response(JSON.stringify(next.body), {
                status: next.status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        closeStopDialog() {},
        resetControlPanel() {},
        setStatus() {},
        updateProgress() {},
        qsSetProgress() {},
        startSystemFromControlPlane: async () => {
            throw new Error('stopped after login');
        },
        CHURCHES_CACHE: [],
    };
    vm.createContext(context);
    vm.runInContext(
        `
        let masterPassword = null;
        let systemState = ${JSON.stringify(systemState)};
        ${loginHelpers}
        ${startBarnabaSource}
        ${stopBarnabaSource}
        ${quickStartSource}
        globalThis.panel = {
            quickStart,
            startBarnaba,
            stopBarnaba,
            masterPassword: () => masterPassword,
            systemState: () => systemState,
        };
        `,
        context
    );

    return { panel: context.panel, prompts, toasts, loginBodies, elements };
}

describe('control login failure on START / STOP', () => {
    it.each([
        ['wrong password', INVALID_PASSWORD, 'Invalid password'],
        ['rate limit', RATE_LIMITED, 'Too many requests. Please try again later.'],
    ])('quickStart: %s shows the server reason, keeps START usable and prompts again', async (_label, failure, reason) => {
        const { panel, prompts, toasts, loginBodies, elements } = loadPanel({
            typedPasswords: ['wrong', 'second-try'],
            loginResponses: [failure, failure],
        });

        // First click: must settle, not reject - a rejection here is the unhandled one the
        // browser logged while the operator saw nothing.
        await expect(panel.quickStart()).resolves.toBeUndefined();
        expect(toasts).toEqual([{ message: expect.stringContaining(reason), type: 'error' }]);
        expect(panel.masterPassword()).toBeNull();
        expect(elements.qsStartBtn.disabled).toBe(false);
        expect(elements.qsStartBtn.textContent).toBe('▶️ START BARNABA');

        // Second click: the operator is asked again and the new password is what gets sent.
        await expect(panel.quickStart()).resolves.toBeUndefined();
        expect(prompts).toHaveLength(2);
        expect(loginBodies.map(body => body.password)).toEqual(['wrong', 'second-try']);
        expect(toasts).toHaveLength(2);
    });

    it('quickStart: a correct password after a wrong one is kept and the start proceeds', async () => {
        const { panel, prompts, toasts, loginBodies } = loadPanel({
            typedPasswords: ['wrong', 'right'],
            loginResponses: [INVALID_PASSWORD, LOGIN_OK],
        });

        await panel.quickStart();
        await panel.quickStart();

        expect(prompts).toHaveLength(2);
        expect(loginBodies.map(body => body.password)).toEqual(['wrong', 'right']);
        expect(panel.masterPassword()).toBe('right');
        // The stubbed start throws right after the login, so reaching its catch proves the flow
        // got past the control session.
        expect(toasts.at(-1).message).toContain('stopped after login');
    });

    it('quickStart: cancelling the prompt sends nothing', async () => {
        const { panel, loginBodies, toasts } = loadPanel({ typedPasswords: [], loginResponses: [] });

        await expect(panel.quickStart()).resolves.toBeUndefined();
        expect(loginBodies).toHaveLength(0);
        expect(toasts).toHaveLength(0);
    });

    it.each([
        ['startBarnaba', 'stopped'],
        ['stopBarnaba', 'running'],
    ])('%s: a rejected login is reported and the next click prompts again', async (fn, systemState) => {
        const { panel, prompts, toasts, loginBodies } = loadPanel({
            typedPasswords: ['wrong', 'second-try'],
            loginResponses: [INVALID_PASSWORD, INVALID_PASSWORD],
            systemState,
        });

        await expect(panel[fn]()).resolves.toBeUndefined();
        await expect(panel[fn]()).resolves.toBeUndefined();

        expect(prompts).toHaveLength(2);
        expect(loginBodies.map(body => body.password)).toEqual(['wrong', 'second-try']);
        expect(toasts.map(toast => toast.message)).toEqual([
            expect.stringContaining('Invalid password'),
            expect.stringContaining('Invalid password'),
        ]);
        expect(panel.masterPassword()).toBeNull();
        // The button that was clicked is not left in a STARTING/STOPPING state.
        expect(panel.systemState()).toBe(systemState);
    });

    it('a previously accepted password that is now refused is forgotten', async () => {
        const { panel, prompts, loginBodies } = loadPanel({
            typedPasswords: ['right', 'rotated'],
            loginResponses: [LOGIN_OK, RATE_LIMITED, LOGIN_OK],
            systemState: 'running',
        });

        // quickStart with the system already running: login, then registration (stubbed away).
        await panel.quickStart();
        expect(panel.masterPassword()).toBe('right');

        await panel.stopBarnaba();
        expect(panel.masterPassword()).toBeNull();

        await panel.stopBarnaba();
        expect(prompts).toHaveLength(2);
        expect(loginBodies.map(body => body.password)).toEqual(['right', 'right', 'rotated']);
    });
});

describe('session-expired re-authentication does not keep a refused password', () => {
    it('bcReauthenticate forgets the password when the gateway refuses it', () => {
        const reauth = slice(
            adminSource,
            'async function bcReauthenticate() {',
            '// Recording (AudioWorklet PCM)',
            'admin.html bcReauthenticate'
        );
        const refused = slice(reauth, '} else {', '} catch (e) {', 'admin.html bcReauthenticate failure branch');
        // Without this the auth_error handler takes its `if (masterPassword)` branch forever and
        // never shows the "Session expired" prompt again.
        expect(refused).toContain('forgetMasterPassword()');
    });
});
