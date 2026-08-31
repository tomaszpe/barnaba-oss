import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildClientFeatureConfig } from '../clientFeatureConfig.js';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const controlPlaneSource = readFileSync(new URL('../control-plane.js', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('instant feedback runtime rollout', () => {
  it('defaults OFF in both PWA-serving processes and reaches the client config', () => {
    expect(buildClientFeatureConfig({}).instantFeedback).toBe(false);
    expect(buildClientFeatureConfig({ INSTANT_FEEDBACK_ENABLED: 'false' }).instantFeedback).toBe(false);
    expect(buildClientFeatureConfig({ INSTANT_FEEDBACK_ENABLED: 'true' }).instantFeedback).toBe(true);
    expect(controlPlaneSource).toContain("buildClientFeatureConfig(process.env)");
    expect(gatewaySource).toContain("buildClientFeatureConfig(process.env)");
    expect(indexSource).toContain('let instantFeedbackEnabled = false;');
    expect(indexSource).toContain('instantFeedbackEnabled = cfg.instantFeedback === true;');
    expect(controlPlaneSource).toMatch(/gatewayUrl: config\.urls\.gateway,[\s\S]*?instantFeedback: config\.clientFeatures\.instantFeedback,/);
    expect(gatewaySource).toMatch(/app\.get\('\/api\/control\/config',[\s\S]*?instantFeedback: config\.clientFeatures\.instantFeedback,/);
  });

  it('shows the trigger only during active LIVE listening', () => {
    expect(indexSource).toContain("instantFeedbackEnabled && currentScreen === 4 && !!language ? 'block' : 'none'");
    expect(indexSource).toContain('<button id="feedbackTrigger" class="feedback-trigger"');
  });

  it('offers the four allowlisted reasons and localized thanks copy', () => {
    for (const reason of ['wrong_word', 'long_pause', 'translation_lag', 'other']) {
      expect(indexSource).toContain(`data-reason="${reason}"`);
    }
    expect(indexSource).toContain("pl: ['Zgłoś problem', 'Złe słowo', 'Zbyt duża przerwa', 'Tłumaczenie nie nadąża', 'Inne', 'Dziękujemy']");
    expect(indexSource).toContain("body: JSON.stringify({ sessionId: telemetry.sessionId, churchId, lang: language, reason })");
  });
});
