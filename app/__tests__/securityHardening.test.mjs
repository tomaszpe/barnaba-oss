import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateCsrfRequest } from '../csrfService.js';

const readSource = (url) => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');

const serverSource = readSource(new URL('../server.js', import.meta.url));
const authServiceSource = readSource(new URL('../authService.js', import.meta.url));
const controlPlaneSource = readSource(new URL('../control-plane.js', import.meta.url));
const gatewayDockerfile = readSource(new URL('../Dockerfile', import.meta.url));
const controlPlaneDockerfile = readSource(new URL('../Dockerfile.control-plane', import.meta.url));
const listenerSource = readSource(new URL('../public/index.html', import.meta.url));
const broadcasterSource = readSource(new URL('../public/node.html', import.meta.url));
const azureAppsTemplate = readSource(new URL('../../infra/azure/apps.bicep', import.meta.url));

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const idx = part.indexOf('=');
      if (idx !== -1) cookies[part.slice(0, idx)] = part.slice(idx + 1);
      return cookies;
    }, {});
}

describe('security hardening regressions', () => {
  it('validates CSRF by matching readable cookie and request header', () => {
    const req = {
      headers: {
        cookie: 'barnaba_csrf=abc123',
        'x-barnaba-csrf': 'abc123',
      },
    };

    expect(validateCsrfRequest(req, parseCookies)).toBe(true);
    expect(validateCsrfRequest({ headers: { cookie: 'barnaba_csrf=abc123' } }, parseCookies)).toBe(false);
    expect(validateCsrfRequest({ headers: { cookie: 'barnaba_csrf=abc123', 'x-barnaba-csrf': 'wrong' } }, parseCookies)).toBe(false);
  });

  it('keeps gateway admin authorization cookie-only', () => {
    expect(serverSource).toContain("const ADMIN_COOKIE_NAME = 'barnaba_admin_session'");
    expect(serverSource).toContain("function isAdminRequestAuthorized(req) {\n    return hasAdminSession(req);\n}");
    expect(serverSource).not.toContain('isAdminRequestAuthorized(req, password)');
    expect(serverSource).not.toContain('const { password } = req.query');
  });

  it('keeps control actions cookie-only after login', () => {
    expect(controlPlaneSource).toContain("const CONTROL_COOKIE_NAME = 'barnaba_control_session'");
    expect(controlPlaneSource).toContain('function requireControlAuth(req, res) {\n    if (hasValidControlSession(req)) return true;');
    expect(controlPlaneSource).not.toContain('verifyPassword(req.body?.password)) {\n        createControlSession');
  });

  it('requires sessions for operational status and telemetry endpoints', () => {
    expect(controlPlaneSource).toContain("app.get('/api/control/status', requireControlSession");
    expect(controlPlaneSource).toContain("app.get('/api/control/whisper-health', requireControlSession");
    expect(controlPlaneSource).toContain("app.get('/api/control/gateway-health', requireControlSession");
    expect(serverSource).toContain("app.get('/api/whisper/status', requireBroadcasterSession");
    expect(serverSource).toContain("app.get('/api/latency-stats', requireBroadcasterSession");
    expect(controlPlaneSource).toContain("headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {}");
    expect(broadcasterSource).toContain("fetch('/api/whisper/status'");
    expect(broadcasterSource).toContain("fetch('/api/latency-stats'");
    expect(broadcasterSource).not.toContain('fetch(`${API_BASE}/api/whisper/status`');
  });

  it('ships shared auth helpers in the control-plane image', () => {
    expect(controlPlaneSource).toContain("from './csrfService.js'");
    expect(controlPlaneDockerfile).toContain('COPY csrfService.js ./');
  });

  it('does not copy the control-plane dependency manifests into the gateway dependency stage', () => {
    expect(gatewayDockerfile).toContain('COPY package.json package-lock.json ./');
    expect(gatewayDockerfile).not.toContain('COPY package*.json ./');
    expect(gatewayDockerfile).toContain('npm ci --omit=dev');
  });

  it('keeps session tokens stateless so they survive gateway restarts', () => {
    // Regression for GitHub #91: a sessions Map dies with the process, so
    // every redeploy/scale-to-zero forced listeners back to the PIN screen.
    expect(authServiceSource).toContain('SESSION_SECRET');
    expect(authServiceSource).toContain("crypto.createHmac('sha256', SESSION_SECRET)");
    expect(authServiceSource).not.toContain('sessions.set(token');
    expect(authServiceSource).not.toContain('const sessions = new Map()');
  });

  it('persists listener session token for long-lived phone access', () => {
    expect(listenerSource).toContain("const SESSION_KEY = 'barnaba_listener_session'");
    expect(listenerSource).toContain('sessionToken,');
    expect(listenerSource).toContain('listenerSessionToken = savedSession.sessionToken;');
    expect(listenerSource).toContain('const SESSION_HOURS = 219000');
  });

  it('ships a tailored CSP instead of disabling the header', () => {
    expect(serverSource).not.toContain('contentSecurityPolicy: false');
    expect(serverSource).toContain('contentSecurityPolicy: {');
    expect(serverSource).toContain('objectSrc: ["\'none\'"]');
    expect(serverSource).toContain('frameAncestors: ["\'none\'"]');
    expect(serverSource).toContain("scriptSrc: [\"'self'\", \"'unsafe-inline'\", 'https://cdn.jsdelivr.net']");
    expect(listenerSource).toContain('integrity="sha384-');
  });

  it('does not write sermon or translation content to normal process logs', () => {
    const forbidden = [
      'Result: "${result.text',
      '${churchId}: "${result.text}',
      'Processing sentence: "${sentence.text}',
      'Partial preview: "${result.partial}',
      '[STT] ${churchId}: "${text}',
      'Final transcription for ${churchId}: "${result.text}',
      'CONFIRMED: "${result.confirmed}',
      'confirmed="${result.confirmed}',
      'Text: "${text.substring',
      '${result.text.substring(0, 50)}',
    ];
    for (const fragment of forbidden) expect(serverSource).not.toContain(fragment);
  });

  it('keeps internal exception details out of 5xx JSON responses', () => {
    expect(serverSource).not.toContain("res.status(500).json({ success: false, error: error.message })");
    expect(serverSource).not.toContain("error: state.whisperActivity.lastError || 'Failed to stop container'");
    expect(serverSource).not.toContain("type: 'transcription_error',\n            error: error.message");
    expect(controlPlaneSource).not.toContain("res.status(500).json({ success: false, error: error.message })");
  });

  it('keeps the unauthenticated Whisper API on internal Azure ingress', () => {
    const whisperResource = azureAppsTemplate.split("resource gateway '")[0];
    expect(whisperResource).toContain("resource whisper 'Microsoft.App/containerApps@");
    expect(whisperResource).toContain('external: false');
    expect(whisperResource).toContain('targetPort: 8000');
  });
});
