import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    allowedDropReasons,
    sanitizeDeliveryOutcomeBatch,
    sanitizeDeliveryOutcomeEvent,
    sanitizeListenerMeasurementAgeMs,
    sanitizePendingDropSample,
} from '../listenerTelemetryContract.js';

const listenerSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('listener measurement freshness contract', () => {
    it('reports the age of the latest real play separately from beacon freshness', () => {
        expect(listenerSource).toContain('listener_measurement_age_ms: Number.isFinite(telemetry.lastHeardSourcePlayStartAt)');
        expect(listenerSource).toContain('now - telemetry.lastHeardSourcePlayStartAt');
        expect(listenerSource).toContain('now - p.playStartAt <= 30000');
        expect(listenerSource).toContain('const drifts = freshRecent.map');
    });

    it('passes only a finite non-negative measurement age into live quality state', () => {
        expect(sanitizeListenerMeasurementAgeMs(-25)).toBe(0);
        expect(sanitizeListenerMeasurementAgeMs('1250')).toBe(1250);
        expect(sanitizeListenerMeasurementAgeMs(null)).toBeNull();
        expect(sanitizeListenerMeasurementAgeMs('')).toBeNull();
        expect(sanitizeListenerMeasurementAgeMs('not-a-number')).toBeNull();
        expect(sanitizeListenerMeasurementAgeMs(Number.POSITIVE_INFINITY)).toBeNull();
        expect(serverSource).toContain('sanitizeListenerMeasurementAgeMs(');
        expect(serverSource).toContain('listener_measurement_age_ms: listenerMeasurementAgeMs');
        expect(serverSource).toContain('listener_drift_ms: snapshot.source_coverage_lag_ms ?? null');
        expect(serverSource).not.toContain('listener_drift_ms: snapshot.audibleDrift_max_ms');
    });
});

describe('listener delivery telemetry contract', () => {
    it('accepts the complete delivery funnel and keeps canonical word identity', () => {
        const outcomes = [
            'chunk_received',
            'play_started',
            'play_completed',
            'explicit_drop',
            'superseded',
            'null_audio',
            'playback_error',
            'supersession_shadow',
        ];
        const events = sanitizeDeliveryOutcomeBatch(outcomes.map((outcome, index) => ({
            outcome_id: `s:${index}`,
            chunk_key: `epoch:9:pl:${index}`,
            outcome,
            session_epoch: 'epoch',
            release_seq: 9,
            language: 'pl',
            sentence_index: index,
            emitted_source_hash: 'a'.repeat(64),
            chunk_word_count: 7,
            source_lineage_status: 'complete',
            playback_rate: 1.15,
            duration_ms: 1200,
            age_ms: 300,
            reason: 'age_budget',
        })));

        expect(events.map(event => event.outcome)).toEqual(outcomes);
        expect(events[2]).toMatchObject({
            stage: 'listener_delivery_outcome',
            chunk_word_count: 7,
            playback_rate: 1.15,
            duration_ms: 1200,
            source_lineage_status: 'complete',
        });
    });

    it('sanitizes bounded T2 shadow identity without accepting text', () => {
        const event = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:shadow',
            chunk_key: 'e:9:pl:0',
            outcome: 'supersession_shadow',
            revision_family_id: 'family-a',
            revision_generation: 2,
            revision_ticket_id: 'ticket-a',
            revision_evidence: 'span_overlap',
            revision_apply_eligible: false,
            superseded_by_chunk_key: 'e:10:pl:0',
            superseded_by_release_seq: 10,
            superseded_by_revision_generation: 3,
            superseded_by_revision_apply_eligible: true,
            source_map_v2_status: 'complete',
            t2_supersede_pending_v2_eligible: false,
            source_map_v2_shadow_eligible: true,
            superseded_by_t2_v2_eligible: true,
            candidate_age_ms: 1200,
            queue_depth_at_observation: 4,
            text: 'sermon must not pass',
            translatedText: 'nor translation',
        });

        expect(event).toMatchObject({
            outcome: 'supersession_shadow',
            policy_applied: false,
            reason: 'superseded_candidate',
            revision_family_id: 'family-a',
            revision_generation: 2,
            revision_apply_eligible: false,
            superseded_by_revision_generation: 3,
            superseded_by_revision_apply_eligible: true,
            source_map_v2_status: 'complete',
            t2_supersede_pending_v2_eligible: false,
            source_map_v2_shadow_eligible: true,
            superseded_by_t2_v2_eligible: true,
            candidate_age_ms: 1200,
            queue_depth_at_observation: 4,
        });
        expect(event).not.toHaveProperty('text');
        expect(event).not.toHaveProperty('translatedText');
    });

    it('keeps bounded T2 apply evidence without accepting text', () => {
        const event = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:apply',
            chunk_key: 'e:9:pl:0',
            outcome: 'superseded',
            reason: 'superseded_candidate',
            policy_applied: true,
            revision_apply_eligible: true,
            superseded_by_chunk_key: 'e:10:pl:0',
            superseded_by_release_seq: 10,
            superseded_by_revision_generation: 3,
            superseded_by_revision_apply_eligible: true,
            candidate_age_ms: 1200,
            queue_depth_at_observation: 4,
            text: 'sermon must not pass',
        });

        expect(event).toMatchObject({
            outcome: 'superseded',
            reason: 'superseded_candidate',
            policy_applied: true,
            revision_apply_eligible: true,
            superseded_by_chunk_key: 'e:10:pl:0',
            superseded_by_revision_generation: 3,
            superseded_by_revision_apply_eligible: true,
            candidate_age_ms: 1200,
            queue_depth_at_observation: 4,
        });
        expect(event).not.toHaveProperty('text');
    });

    it('preserves explicit false eligibility and rejects coercion', () => {
        const base = {
            outcome_id: 's:eligibility',
            chunk_key: 'e:9:pl:0',
            outcome: 'superseded',
            reason: 'superseded_candidate',
        };
        expect(sanitizeDeliveryOutcomeEvent({
            ...base,
            revision_apply_eligible: false,
            superseded_by_revision_apply_eligible: false,
        })).toMatchObject({
            revision_apply_eligible: false,
            superseded_by_revision_apply_eligible: false,
        });
        for (const value of ['true', 1, 0, {}]) {
            expect(sanitizeDeliveryOutcomeEvent({
                ...base,
                revision_apply_eligible: value,
                superseded_by_revision_apply_eligible: value,
            })).toMatchObject({
                revision_apply_eligible: null,
                superseded_by_revision_apply_eligible: null,
            });
        }
    });

    it('keeps only an explicit fail-closed source lineage status', () => {
        const complete = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_started',
            source_lineage_status: 'complete',
        });
        const invented = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:2', chunk_key: 'e:9:pl:1', outcome: 'play_started',
            source_lineage_status: 'probably_complete',
        });
        expect(complete.source_lineage_status).toBe('complete');
        expect(invented.source_lineage_status).toBeNull();
    });

    it('carries the playback facts and the queue depth the policy saw', () => {
        // Without this whitelist the client can send the fields and the server drops them —
        // the exact "flag with no effect" shape this project has hit three times.
        const [started, completed] = sanitizeDeliveryOutcomeBatch([
            {
                outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_started',
                playback_rate: 1.25, age_ms: 2600, queue_depth_at_play_start: 4,
            },
            {
                outcome_id: 's:2', chunk_key: 'e:9:pl:1', outcome: 'play_completed',
                playback_rate: 1.25, duration_ms: 4600, decoder_duration_ms: 5750,
                playback_engine: 'html_audio', effective_playback_rate: 1.25, preserves_pitch: true,
            },
        ]);
        expect(started).toMatchObject({ age_ms: 2600, queue_depth_at_play_start: 4 });
        expect(completed).toMatchObject({
            playback_engine: 'html_audio',
            effective_playback_rate: 1.25,
            preserves_pitch: true,
            decoder_duration_ms: 5750,
        });
    });

    it('keeps an explicit null a null instead of turning it into a zero', () => {
        // `Number(null) === 0`: with the shared numeric helpers, "no rate reported" arrives as
        // "played at 0x", "no decoder duration" as "0 ms" and "depth unknown" as "queue empty".
        // All three would be indistinguishable from real measurements in the report.
        const completed = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_completed',
            effective_playback_rate: null, decoder_duration_ms: null,
        });
        expect(completed.effective_playback_rate).toBeNull();
        expect(completed.decoder_duration_ms).toBeNull();

        const started = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:2', chunk_key: 'e:9:pl:1', outcome: 'play_started',
            queue_depth_at_play_start: null,
        });
        expect(started.queue_depth_at_play_start).toBeNull();
    });

    it('carries early_catchup_active as a tri-state through the sanitizer', () => {
        // The PWA sends it, and until 04.08 the sanitizer's allowlist silently dropped it —
        // the same "client sends, server discards" shape as the playback facts above. It is
        // the ONLY source of `early_catchup_active_pct`, so losing it makes the candidate arm
        // of the A/B unscoreable in exactly the dimension the experiment is about.
        const active = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_started',
            early_catchup_active: true,
        });
        expect(active.early_catchup_active).toBe(true);

        const inactive = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:2', chunk_key: 'e:9:pl:1', outcome: 'play_started',
            early_catchup_active: false,
        });
        // Must be exactly `false`, never null: "the automaton was asked and said no" is a
        // measurement, and it is what the OFF arm consists of.
        expect(inactive.early_catchup_active).toBe(false);

        const unreported = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:3', chunk_key: 'e:9:pl:2', outcome: 'play_started',
        });
        expect(unreported.early_catchup_active).toBeNull();
    });

    it('refuses a non-boolean early_catchup_active instead of coercing it', () => {
        // A stringy "false" coerced with Boolean() is `true` — it would invert the reading.
        for (const value of ['true', 'false', 1, 0, {}]) {
            const started = sanitizeDeliveryOutcomeEvent({
                outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_started',
                early_catchup_active: value,
            });
            expect(started.early_catchup_active).toBeNull();
        }
    });

    it('does not attach early_catchup_active to play_completed', () => {
        // It is a property of the decision at play START. Carrying it on completion too would
        // create a second, silently divergent source for the same percentage.
        const completed = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_completed',
            early_catchup_active: true,
        });
        expect(completed).not.toHaveProperty('early_catchup_active');
    });

    it('keeps a reported zero depth distinct from an unreported one', () => {
        const started = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_started',
            queue_depth_at_play_start: 0,
        });
        expect(started.queue_depth_at_play_start).toBe(0);
    });

    it('leaves absent fields null rather than inventing values', () => {
        const completed = sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_completed',
        });
        expect(completed.effective_playback_rate).toBeNull();
        expect(completed.decoder_duration_ms).toBeNull();
        expect(sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:2', chunk_key: 'e:9:pl:1', outcome: 'play_started',
        }).queue_depth_at_play_start).toBeNull();
    });

    it('rejects a rate outside the reachable 1.0-1.5 band instead of clamping it', () => {
        // Clamping would turn junk into a plausible 1.5x and average it into effective_rate.
        const rate = value => sanitizeDeliveryOutcomeEvent({
            outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_completed',
            effective_playback_rate: value,
        }).effective_playback_rate;

        expect(rate(99)).toBeNull();
        expect(rate(0)).toBeNull();
        expect(rate(0.5)).toBeNull();
        expect(rate('nonsense')).toBeNull();
        expect(rate(1.0)).toBe(1.0);
        expect(rate(1.25)).toBe(1.25);
        expect(rate(1.5)).toBe(1.5);
    });

    it('separates "engine not reported" from an engine it does not know', () => {
        // null = an older client that never sent the field; 'unknown' = a value we cannot
        // trust. GO condition 6 asks for html_audio, so both must stay distinguishable.
        const base = { outcome_id: 's:1', chunk_key: 'e:9:pl:0', outcome: 'play_completed' };
        expect(sanitizeDeliveryOutcomeEvent(base).playback_engine).toBeNull();
        expect(sanitizeDeliveryOutcomeEvent({ ...base, playback_engine: 'web_audio' }).playback_engine).toBe('web_audio');
        expect(sanitizeDeliveryOutcomeEvent({ ...base, playback_engine: 'made_up' }).playback_engine).toBe('unknown');
        expect(sanitizeDeliveryOutcomeEvent({ ...base, preserves_pitch: 'true' }).preserves_pitch).toBeNull();
    });

    it('rejects malformed and unknown events instead of acknowledging them', () => {
        expect(sanitizeDeliveryOutcomeEvent({ outcome: 'play_completed' })).toBeNull();
        expect(sanitizeDeliveryOutcomeEvent({
            outcome_id: '1',
            chunk_key: 'e:1:pl:0',
            outcome: 'invented',
        })).toBeNull();
    });

    it('allows only bounded scheduler reasons in pending-drop samples', () => {
        expect(allowedDropReasons).toContain('server_epoch_changed');
        expect(allowedDropReasons).toContain('duplicate_chunk');
        const sample = sanitizePendingDropSample([
            {
                reason: 'server_epoch_changed',
                session_epoch: 'e',
                language: 'pl',
                emitted_source_hash: 'hash',
                chunk_word_count: 4,
            },
            { reason: 'untrusted_reason' },
        ]);
        expect(sample).toHaveLength(1);
        expect(sample[0]).toMatchObject({
            reason: 'server_epoch_changed',
            session_epoch: 'e',
            language: 'pl',
            emitted_source_hash: 'hash',
            chunk_word_count: 4,
        });
    });
});

describe('listener telemetry transport', () => {
    it('uses a byte-bounded unload beacon and a normal acknowledged fetch while the page is alive', () => {
        expect(listenerSource).toContain('const TELEMETRY_UNLOAD_MAX_BYTES = 48 * 1024;');
        expect(listenerSource).toContain('deliveryEventLimit: unload ? 50 : 100');
        expect(listenerSource).toContain('telemetryPayloadBytes(payload) > TELEMETRY_UNLOAD_MAX_BYTES');
        expect(listenerSource).toContain("if (!navigator.sendBeacon('/api/listener-telemetry', blob))");
        expect(listenerSource).not.toContain('keepalive: true');
    });

    it('authenticates normal telemetry fetches with the restored listener token', () => {
        expect(listenerSource).toContain("if (listenerSessionToken) headers.Authorization = `Bearer ${listenerSessionToken}`;");
        expect(serverSource).toContain('getListenerTelemetrySessionToken(req)');
        expect(serverSource).toContain("return bearerSessionToken(req.headers.authorization)\n        || getSessionTokenFromRequest(req);");
    });
});
