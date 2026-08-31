import { describe, expect, it } from 'vitest';
import {
    parseJsonlRecords,
    summarizeEmissionJsonl,
    summarizeEmissionRecords,
    summarizeNumbers,
} from '../emissionMetricsSummary.js';

describe('emission metrics summary', () => {
    it('parses JSONL records and reports invalid lines', () => {
        const parsed = parseJsonlRecords([
            '{"stage":"emission_decision","decision":"emit"}',
            '',
            '{bad json',
        ].join('\n'));

        expect(parsed.records).toHaveLength(1);
        expect(parsed.errors).toHaveLength(1);
        expect(parsed.errors[0].line).toBe(3);
    });

    it('summarizes emission decisions and controller actions', () => {
        const summary = summarizeEmissionRecords([
            {
                stage: 'emission_decision',
                churchId: 'example-church',
                lang: 'pl',
                decision: 'emit',
                mode: 'quality',
                source: 'dispatch',
                age_ms: 500,
                queue_depth: 1,
                first_audio_ms: 350,
            },
            {
                stage: 'emission_decision',
                churchId: 'example-church',
                lang: 'pl',
                decision: 'audio_skip',
                mode: 'audio_skip',
                source: 'runtime',
                age_ms: 13000,
                queue_depth: 5,
            },
            {
                stage: 'emission_controller_shadow',
                churchId: 'example-church',
                lang: 'en',
                runtime_decision: 'emit',
                controller_action: 'merge',
                controller_mode: 'catchup',
                controller_reason: 'catchup_age_budget',
                age_ms: 9000,
                queue_depth: 6,
            },
            {
                stage: 'emission_controller_runtime',
                churchId: 'example-church',
                lang: 'en',
                runtime_action: 'drop',
                runtime_mode: 'drop',
                runtime_reason: 'age_over_drop_threshold',
                age_ms: 21000,
                queue_depth: 8,
            },
            {
                stage: 'translation',
                latency_ms: 1000,
            },
        ]);

        expect(summary.total).toBe(4);
        expect(summary.byStage).toEqual({
            emission_decision: 2,
            emission_controller_shadow: 1,
            emission_controller_runtime: 1,
        });
        expect(summary.emissionDecision.byDecision).toEqual({
            emit: 1,
            audio_skip: 1,
        });
        expect(summary.emissionDecision.byMode).toEqual({
            quality: 1,
            audio_skip: 1,
        });
        expect(summary.controllerShadow.byAction).toEqual({ merge: 1 });
        expect(summary.controllerShadow.runtimeMismatch).toBe(1);
        expect(summary.controllerRuntime.byAction).toEqual({ drop: 1 });
        expect(summary.byLanguage).toEqual({ pl: 2, en: 2 });
        expect(summary.ageMs.max).toBe(21000);
        expect(summary.queueDepth.p95).toBe(8);
        expect(summary.firstAudioMs).toEqual({
            count: 1,
            min: 350,
            max: 350,
            avg: 350,
            p50: 350,
            p95: 350,
            p99: 350,
        });
    });

    it('summarizes JSONL with parse errors without dropping valid records', () => {
        const summary = summarizeEmissionJsonl([
            '{"stage":"emission_decision","decision":"drop","mode":"drop","age_ms":20000,"queue_depth":9}',
            'not-json',
            '{"stage":"emission_controller_runtime","runtime_action":"audio_skip","runtime_mode":"audio_skip"}',
        ].join('\n'));

        expect(summary.total).toBe(2);
        expect(summary.parseErrors).toHaveLength(1);
        expect(summary.emissionDecision.byDecision).toEqual({ drop: 1 });
        expect(summary.controllerRuntime.byMode).toEqual({ audio_skip: 1 });
    });

    it('returns empty numeric summary for missing values', () => {
        expect(summarizeNumbers([])).toEqual({
            count: 0,
            min: null,
            max: null,
            avg: null,
            p50: null,
            p95: null,
            p99: null,
        });
    });
});
