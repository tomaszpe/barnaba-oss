import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildClientFeatureConfig } from '../clientFeatureConfig.js';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const controlIndexSource = readFileSync(new URL('../public-control/index.html', import.meta.url), 'utf8');
const controlPlaneSource = readFileSync(new URL('../control-plane.js', import.meta.url), 'utf8');
const gatewaySource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('instant feedback runtime rollout', () => {
  it('defaults OFF in both PWA-serving processes and reaches the client config', () => {
    expect(buildClientFeatureConfig({}).instantFeedback).toBe(false);
    expect(buildClientFeatureConfig({ INSTANT_FEEDBACK_ENABLED: 'false' }).instantFeedback).toBe(false);
    expect(buildClientFeatureConfig({ INSTANT_FEEDBACK_ENABLED: 'true' }).instantFeedback).toBe(true);
    // Control Plane reads its three listener flags directly; the same strict 'true' test.
    expect(controlPlaneSource).toContain("instantFeedback: process.env.INSTANT_FEEDBACK_ENABLED === 'true',");
    expect(gatewaySource).toContain("buildClientFeatureConfig(process.env)");
    expect(indexSource).toContain('let instantFeedbackEnabled = false;');
    expect(indexSource).toContain('instantFeedbackEnabled = cfg.instantFeedback === true;');
    expect(controlPlaneSource).toMatch(/gatewayUrl: config\.urls\.gateway,[\s\S]*?instantFeedback: config\.clientFeatures\.instantFeedback,/);
    expect(gatewaySource).toMatch(/app\.get\('\/api\/control\/config',[\s\S]*?instantFeedback: config\.clientFeatures\.instantFeedback,/);
  });

  it('shows the trigger only during active LIVE listening', () => {
    expect(indexSource).toContain("instantFeedbackEnabled && currentScreen === 4 && !!language ? 'flex' : 'none'");
    expect(indexSource).toContain('<button id="feedbackTrigger" class="feedback-trigger"');
  });

  it('offers the four allowlisted reasons and localized thanks copy', () => {
    for (const reason of ['wrong_word', 'long_pause', 'translation_lag', 'other']) {
      expect(indexSource).toContain(`data-reason="${reason}"`);
    }
    expect(indexSource).toContain("pl: ['Zgłoś problem', 'Złe słowo', 'Zbyt duża przerwa', 'Tłumaczenie nie nadąża', 'Inne', 'Dziękujemy']");
  });

  it('delegates submission to feedback.js, which posts directly to control-plane', () => {
    expect(indexSource).toContain('<script src="/feedback.js?v=3"></script>');
    expect(indexSource).toContain('<link rel="stylesheet" href="/feedback.css?v=3">');
    expect(indexSource).toContain('function submitFeedback(reason) { getFeedbackUI().choose(reason); }');
    expect(indexSource).toContain('feedbackConfig = cfg.feedback || { url: null };');
    expect(gatewaySource).toMatch(/feedback: \{\s*url: process\.env\.APP_URL \? new URL\('\/api\/feedback', process\.env\.APP_URL\)\.href : null,/);
    // A listener cached before this change still posts to the gateway; it must reload.
    expect(gatewaySource).toMatch(/app\.post\('\/api\/feedback', \(req, res\) => \{\s*res\.status\(410\)/);
    // The listener served by Control Plane uses the same client and posts to its own origin.
    expect(controlIndexSource).toContain('<script src="/feedback.js?v=3"></script>');
    expect(controlIndexSource).toContain('function submitFeedback(reason) { getFeedbackUI().choose(reason); }');
    expect(controlPlaneSource).toContain("feedback: feedbackPublicConfig('/api/feedback'),");
    expect(controlPlaneSource).toContain('registerFeedbackRoutes(app, {');
  });
});
