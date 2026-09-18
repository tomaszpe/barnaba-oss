import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildClientFeatureConfig } from '../clientFeatureConfig.js';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const controlIndexSource = readFileSync(new URL('../public-control/index.html', import.meta.url), 'utf8');
const controlPlaneSource = readFileSync(new URL('../control-plane.js', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('TTS pitch-preservation rollout', () => {
  it('keeps the runtime flag default-off in both PWA-serving processes', () => {
    expect(buildClientFeatureConfig({}).preserveTtsPitch).toBe(false);
    expect(buildClientFeatureConfig({ PWA_PRESERVE_PITCH_ENABLED: 'false' }).preserveTtsPitch).toBe(false);
    expect(buildClientFeatureConfig({ PWA_PRESERVE_PITCH_ENABLED: 'true' }).preserveTtsPitch).toBe(true);
    // Control Plane reads its three listener flags directly; the same strict 'true' test.
    expect(controlPlaneSource).toContain("preserveTtsPitch: process.env.PWA_PRESERVE_PITCH_ENABLED === 'true',");
    expect(gatewaySource).toContain("buildClientFeatureConfig(process.env)");
  });

  it('passes the runtime flag through both client-config endpoints', () => {
    expect(controlPlaneSource).toMatch(/gatewayUrl: config\.urls\.gateway,[\s\S]*?preserveTtsPitch: config\.clientFeatures\.preserveTtsPitch,/);
    expect(gatewaySource).toMatch(/app\.get\('\/api\/control\/config',[\s\S]*?preserveTtsPitch: config\.clientFeatures\.preserveTtsPitch/);
    expect(indexSource).toContain('preserveTtsPitchEnabled = cfg.preserveTtsPitch === true;');
    expect(controlIndexSource).toContain('preserveTtsPitchEnabled = cfg.preserveTtsPitch === true;');
  });

  it('enables native HTMLAudio pitch preservation only after runtime opt-in', () => {
    expect(indexSource).toMatch(/function applyTtsPitchPolicy\(\) \{\s+if \(!preserveTtsPitchEnabled \|\| !ttsAudio\) return;/);
    expect(indexSource).toContain('ttsAudio.preservesPitch = true;');
    expect(indexSource).toContain('ttsAudio.webkitPreservesPitch = true;');
    expect(indexSource).toContain('ttsAudio.mozPreservesPitch = true;');
  });

  it('disables resampling catch-up in Web Audio fallback only after runtime opt-in', () => {
    expect(indexSource).toContain('source.playbackRate.value = preserveTtsPitchEnabled ? 1.0 : safePlaybackRate;');
  });
});
