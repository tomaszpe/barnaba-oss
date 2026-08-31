import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('Live Quality Autopilot gateway integration', () => {
    it('imports the 3A/3B/4A policy modules into the gateway', () => {
        expect(serverSource).toContain("from './liveQualityState.js'");
        expect(serverSource).toContain("from './autopilotPolicy.js'");
        expect(serverSource).toContain("from './flowGovernor.js'");
    });

    it('keeps runtime apply flags explicitly opt-in', () => {
        expect(serverSource).toContain("applyEnabled: process.env.LIVE_QUALITY_AUTOPILOT_APPLY === 'true'");
        expect(serverSource).toContain("applyEnabled: process.env.FLOW_GOVERNOR_APPLY === 'true'");
        expect(serverSource).not.toContain("process.env.LIVE_QUALITY_AUTOPILOT_APPLY !== 'false'");
        expect(serverSource).not.toContain("process.env.FLOW_GOVERNOR_APPLY !== 'false'");
    });

    it('logs Autopilot and FlowGovernor shadow stages', () => {
        expect(serverSource).toContain('logAutopilotShadowDecision(evalLog');
        expect(serverSource).toContain('logFlowGovernorShadowDecision(evalLog');
        expect(serverSource).toContain('logAutopilotShadow(churchId');
        expect(serverSource).toContain('logFlowGovernorShadow(churchId');
    });

    it('allows FlowGovernor to accelerate only the existing partial fallback path', () => {
        expect(serverSource).toContain('flowGovernorWantsFallback');
        expect(serverSource).toContain("flowDecision?.decision === 'would_force_fallback'");
        expect(serverSource).toContain("flowDecision?.decision === 'would_micro_emit'");
        expect(serverSource).toContain('result.partial.length >= config.partialFallback.minPartialLength');
        expect(serverSource).toContain('similarity < config.partialFallback.similarityThreshold');
    });

    it('cleans per-church live quality state on broadcaster cleanup', () => {
        expect(serverSource).toContain('state.liveQualityStates.delete(churchId)');
    });
});
