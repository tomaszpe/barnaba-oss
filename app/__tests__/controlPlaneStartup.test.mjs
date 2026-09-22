import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const controlPlaneSource = readFileSync(new URL('../control-plane.js', import.meta.url), 'utf8');
const adminHtml = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');

describe('control-plane startup sequencing', () => {
  it('requires Whisper model warm-up before treating Whisper as ready', () => {
    expect(controlPlaneSource).toContain("if (serviceName === 'whisper')");
    expect(controlPlaneSource).toContain("checkContainerAppReady(config.azure.whisperContainer)");
    expect(controlPlaneSource).toContain("data?.status === 'healthy' && data?.model_loaded === true");
    expect(controlPlaneSource).toContain("error: serviceName === 'whisper' ? 'Model warming up' : 'Service not ready'");
  });

  it('exposes an atomic start-system endpoint that starts Whisper before Gateway', () => {
    expect(controlPlaneSource).toContain("app.post('/api/control/start-system'");
    expect(controlPlaneSource.indexOf("state.lastAction.step = 'starting-whisper'"))
      .toBeLessThan(controlPlaneSource.indexOf("state.lastAction.step = 'starting-gateway'"));
    expect(controlPlaneSource.indexOf("waitForServiceReady('whisper'"))
      .toBeLessThan(controlPlaneSource.indexOf("startContainer(config.azure.gatewayContainer)"));
  });

  it('uses short control requests and status polling from the admin Quick Start flow', () => {
    // 12 min. Raised because on a loaded GPU pool the wait for a node alone took 6 min 20 s of a
    // 7 min 28 s start, and a 5-minute limit aborted Quick start BEFORE the gateway step. This is
    // the limit that governs the panel - the server-side `whisperReady` applies to the
    // /api/control/start-system endpoint, which the panel does NOT use.
    expect(adminHtml).toContain('const WHISPER_STARTUP_WAIT_MS = 720000');
    expect(adminHtml).not.toContain('START_SYSTEM_TIMEOUT_MS');
    expect(adminHtml).not.toContain("fetchWithTimeout('/api/control/start-system'");
    expect(adminHtml).toContain("fetchControlJson('/api/control/start-whisper'");
    expect(adminHtml).toContain("fetchControlJson('/api/control/start-gateway'");
    expect(adminHtml).toContain("fetchControlJson('/api/control/status'");
    expect(adminHtml).toContain('startSystemFromControlPlane((message, percent) => qsSetProgress(percent ?? 20, message))');
    expect(adminHtml).toContain("updateProgress('BARNABA is ready!', 100)");
  });

  /**
   * The QR code must point at the origin the admin's browser is actually on, which is the
   * Control Plane. Forwarding the gateway origin sent every listener to the gateway page
   * instead, where inline handlers are blocked by CSP and no button works.
   */
  it('forwards the browser-facing origin to the gateway when building the join QR', () => {
    expect(controlPlaneSource).toContain("'X-Barnaba-Public-Origin': `${proto}://${host}`");
    expect(controlPlaneSource).toContain("req.get('x-forwarded-host')");
    expect(controlPlaneSource).not.toContain("'X-Barnaba-Public-Origin': normalizeOrigin(config.urls.gateway)");
  });
});
