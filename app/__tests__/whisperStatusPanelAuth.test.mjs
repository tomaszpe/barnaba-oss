import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const controlPlaneSource = readFileSync(new URL('../control-plane.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../public-control/admin.html', import.meta.url), 'utf8');

/**
 * Regression guard for the operator panel's session-gated reads.
 *
 * 30.08.2026 put requireBroadcasterSession on GET /api/whisper/status and
 * GET /api/latency-stats. The panel that calls them is served by the Control Plane, sent no
 * credential the Gateway understands, and the CP proxy replied 200 with the Gateway's 401
 * body. The panel read the missing `initialized` field as an outage and displayed
 * "Whisper not available" - for four days, over a Whisper container that was answering
 * /health with model_loaded:true the whole time (02.09.2026).
 *
 * Three properties keep that from recurring: the panel sends a credential, the proxy
 * forwards it, and neither hop launders an auth failure into an availability verdict.
 */

function slice(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker);
    expect(start, `${label}: start marker not found - the guard below would test nothing`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `${label}: end marker not found`).toBeGreaterThan(start);
    return source.slice(start, end);
}

const whisperStatusProxy = slice(
    controlPlaneSource,
    "app.get('/api/whisper/status'",
    "app.get('/api/latency-stats'",
    'control-plane whisper status proxy'
);
const latencyProxy = slice(
    controlPlaneSource,
    "app.get('/api/latency-stats'",
    "app.post('/api/sermon-context'",
    'control-plane latency proxy'
);
const panelStatusCheck = slice(
    adminSource,
    'async function bcCheckWhisperStatus() {',
    '// WebSocket connection to Gateway',
    'admin.html status check'
);
const panelLatencyFetch = slice(
    adminSource,
    'async function bcFetchLatencyStats() {',
    'function bcUpdateLatencyStats(',
    'admin.html latency fetch'
);

describe('gateway session credential survives the control-plane hop', () => {
    it('gateway still accepts the X-Session-Token header', () => {
        // The whole fix rests on this reader. If the Gateway ever goes cookie-only, the
        // panel loses its only credential on the CP origin and every guard below is moot.
        expect(serverSource).toContain("req.headers['x-session-token']");
    });

    it.each([
        ['/api/whisper/status', whisperStatusProxy],
        ['/api/latency-stats', latencyProxy],
    ])('control-plane forwards the session header on %s', (_route, route) => {
        expect(route).toContain('forwardSessionHeader(req)');
    });

    it('forwardSessionHeader reads the header the gateway looks for', () => {
        expect(controlPlaneSource).toMatch(
            /function forwardSessionHeader\(req\)\s*\{[\s\S]*req\.headers\['x-session-token'\][\s\S]*?\}/
        );
    });

    it.each([
        ['/api/whisper/status', whisperStatusProxy],
        ['/api/latency-stats', latencyProxy],
    ])('control-plane passes the gateway status through on %s', (_route, route) => {
        // `res.json(data)` alone answers 200 whatever the Gateway said - the exact laundering
        // that turned a 401 into "Whisper not available".
        expect(route).toContain('res.status(response.status).json(data)');
        expect(route).not.toMatch(/^\s*res\.json\(data\);/m);
    });
});

describe('operator panel sends its session and reports the real failure', () => {
    it('bcSessionHeaders carries the token the gateway reads', () => {
        expect(adminSource).toMatch(
            /function bcSessionHeaders\(\)\s*\{\s*return sessionToken \? \{ 'X-Session-Token': sessionToken \} : \{\};\s*\}/
        );
    });

    it.each([
        ['whisper status', panelStatusCheck],
        ['latency stats', panelLatencyFetch],
    ])('%s fetch is authenticated', (_label, block) => {
        expect(block).toContain('headers: bcSessionHeaders()');
    });

    it('an expired session is reported as an expired session, not as a dead ASR', () => {
        const unauthorized = slice(
            panelStatusCheck,
            'if (res.status === 401) {',
            'const status = await res.json();',
            'admin.html 401 branch'
        );
        expect(unauthorized).toContain('Session expired');
        expect(unauthorized).not.toContain('Whisper not available');
        // The branch must stop there: falling through re-runs the availability verdict on an
        // error body and lands back on the wrong message.
        expect(unauthorized).toContain('return;');
    });

    it('surfaces an upstream reason when the proxy supplies one', () => {
        // getWhisperStatus() never sets `error`, so this reads "Whisper not available" for a
        // real outage and "Gateway not available" when the CP could not reach the Gateway.
        expect(panelStatusCheck).toContain("status.error ? ` ${status.error}` : ' Whisper not available'");
    });
});
