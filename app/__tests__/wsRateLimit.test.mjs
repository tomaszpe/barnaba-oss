import { describe, expect, it } from 'vitest';
import {
    isConnectionScopedListenerTelemetry,
    takeRateLimitSlot,
    WS_IP_RATE_LIMIT,
    WS_LISTENER_TELEMETRY_RATE_LIMIT,
} from '../wsRateLimit.js';

describe('WebSocket rate limiting', () => {
    it('routes only valid telemetry from an authenticated listener to the connection limit', () => {
        const listener = { authenticated: true, type: 'client' };
        const ack = { type: 'latency_ack', txId: 'tx-1', receivedAt: 1234 };

        expect(isConnectionScopedListenerTelemetry(ack, listener)).toBe(true);
        expect(isConnectionScopedListenerTelemetry({ ...ack, receivedAt: '1234' }, listener)).toBe(false);
        expect(isConnectionScopedListenerTelemetry(ack, { authenticated: false, type: 'client' })).toBe(false);
        expect(isConnectionScopedListenerTelemetry({ type: 'subscribe' }, listener)).toBe(false);
        expect(isConnectionScopedListenerTelemetry({ type: 'clock_sync_ack' }, listener)).toBe(false);
    });

    it('allows the expected listener telemetry rate independently on every connection', () => {
        const now = 1000;
        for (let listener = 0; listener < 70; listener += 1) {
            let connectionState = null;
            for (let ack = 0; ack < 20; ack += 1) {
                const result = takeRateLimitSlot(connectionState, now, WS_LISTENER_TELEMETRY_RATE_LIMIT);
                connectionState = result.state;
                expect(result.allowed).toBe(true);
            }
        }
    });

    it('preserves the shared IP limit for all non-telemetry messages', () => {
        let state = null;
        for (let count = 1; count <= WS_IP_RATE_LIMIT.maxMessages; count += 1) {
            const result = takeRateLimitSlot(state, 1000, WS_IP_RATE_LIMIT);
            state = result.state;
            expect(result.allowed).toBe(true);
        }

        const rejected = takeRateLimitSlot(state, 1000, WS_IP_RATE_LIMIT);
        expect(rejected).toMatchObject({ allowed: false, shouldWarn: true, shouldClose: false });

        const repeated = takeRateLimitSlot(rejected.state, 1000, WS_IP_RATE_LIMIT);
        expect(repeated).toMatchObject({ allowed: false, shouldWarn: false, shouldClose: false });
    });

    it('closes a single abusive telemetry connection and resets after the window', () => {
        let state = {
            count: WS_LISTENER_TELEMETRY_RATE_LIMIT.maxMessages * 2,
            resetTime: 61000,
            warned: true,
        };
        const abusive = takeRateLimitSlot(state, 1000, WS_LISTENER_TELEMETRY_RATE_LIMIT);
        expect(abusive).toMatchObject({ allowed: false, shouldWarn: false, shouldClose: true });

        const reset = takeRateLimitSlot(abusive.state, 61001, WS_LISTENER_TELEMETRY_RATE_LIMIT);
        expect(reset).toMatchObject({ allowed: true, shouldWarn: false, shouldClose: false });
        expect(reset.state.count).toBe(1);
    });
});
