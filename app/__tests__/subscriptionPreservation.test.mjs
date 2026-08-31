import { describe, it, expect, beforeEach } from 'vitest';

/**
 * HOTFIX 7.1: Subscription preservation on broadcaster re-auth.
 *
 * Contract tests verifying the fixed subscription management logic.
 * Reimplements the relevant state management from server.js to verify
 * the guard patterns work correctly.
 *
 * Bug: handleAuthenticateBroadcaster + handleNodeRegister unconditionally
 * created new empty Map(), wiping existing listener subscriptions.
 * handleDisconnect deleted the entire subscriptions map.
 * Result: 100% listeners silenced on broadcaster reconnect.
 */

// ============================================================
// Reimplemented state + logic from server.js (post-fix)
// ============================================================

let state;

function resetState() {
    state = {
        churches: new Map(),
        subscriptions: new Map(),
    };
}

// Reimplements fixed handleAuthenticateBroadcaster subscription logic
function authenticateBroadcaster(churchId, ws) {
    state.churches.set(churchId, { ws, name: 'TestChurch' });

    // HOTFIX 7.1: Guard against wiping existing subscriptions on re-auth
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
    }
    // (logging omitted from test — verified by log inspection)
}

// Reimplements fixed handleNodeRegister subscription logic
function registerNode(churchId, ws) {
    state.churches.set(churchId, { ws, name: 'TestChurch' });

    // HOTFIX 7.1: Guard against wiping existing subscriptions
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
    }
}

// Reimplements fixed handleDisconnect (broadcaster type) subscription logic
function disconnectBroadcaster(churchId) {
    state.churches.delete(churchId);
    // HOTFIX 7.1: Do NOT delete subscriptions map on broadcaster disconnect.
    // (state.subscriptions.delete(churchId) was REMOVED)
}

// Reimplements handleSubscribe (unchanged — already guarded)
function subscribeListener(churchId, language, listenerWs) {
    if (!state.subscriptions.has(churchId)) {
        state.subscriptions.set(churchId, new Map());
    }
    const churchSubs = state.subscriptions.get(churchId);
    if (!churchSubs.has(language)) {
        churchSubs.set(language, new Set());
    }
    churchSubs.get(language).add(listenerWs);
}

// Reimplements getActiveLanguages (unchanged)
function getActiveLanguages(churchId) {
    const subs = state.subscriptions.get(churchId);
    if (!subs) return [];
    return [...subs.entries()]
        .filter(([_, clients]) => clients.size > 0)
        .map(([lang]) => lang);
}

// Mock WebSocket
function mockWs(id) {
    return { _id: id, readyState: 1 };
}

// ============================================================
// Tests
// ============================================================

describe('HOTFIX 7.1: Subscription preservation', () => {
    beforeEach(() => {
        resetState();
    });

    describe('Fix #1: handleDisconnect preserves subscriptions', () => {
        it('should NOT delete subscriptions map on broadcaster disconnect', () => {
            const bcWs = mockWs('broadcaster');
            const l1 = mockWs('listener1');
            const l2 = mockWs('listener2');

            // Setup: broadcaster auth + 2 listeners subscribe
            authenticateBroadcaster('church1', bcWs);
            subscribeListener('church1', 'pl', l1);
            subscribeListener('church1', 'en', l2);

            expect(getActiveLanguages('church1')).toEqual(['pl', 'en']);

            // Act: broadcaster disconnects
            disconnectBroadcaster('church1');

            // Assert: subscriptions preserved
            expect(state.subscriptions.has('church1')).toBe(true);
            expect(state.subscriptions.get('church1').get('pl').has(l1)).toBe(true);
            expect(state.subscriptions.get('church1').get('en').has(l2)).toBe(true);
            expect(getActiveLanguages('church1')).toEqual(['pl', 'en']);
        });

        it('should still delete church from churches map', () => {
            const bcWs = mockWs('broadcaster');
            authenticateBroadcaster('church1', bcWs);

            disconnectBroadcaster('church1');

            expect(state.churches.has('church1')).toBe(false);
        });
    });

    describe('Fix #2: handleAuthenticateBroadcaster guard', () => {
        it('should create new Map on first auth (no existing subscriptions)', () => {
            const bcWs = mockWs('broadcaster');

            authenticateBroadcaster('church1', bcWs);

            expect(state.subscriptions.has('church1')).toBe(true);
            expect(state.subscriptions.get('church1').size).toBe(0);
        });

        it('should preserve existing subscriptions on re-auth', () => {
            const bcWs1 = mockWs('broadcaster1');
            const bcWs2 = mockWs('broadcaster2');
            const l1 = mockWs('listener1');
            const l2 = mockWs('listener2');

            // First auth + listeners subscribe
            authenticateBroadcaster('church1', bcWs1);
            subscribeListener('church1', 'pl', l1);
            subscribeListener('church1', 'en', l2);

            const subsBeforeReauth = state.subscriptions.get('church1');

            // Re-auth (broadcaster reconnect)
            authenticateBroadcaster('church1', bcWs2);

            // Same Map object preserved
            expect(state.subscriptions.get('church1')).toBe(subsBeforeReauth);
            // Listeners still present
            expect(state.subscriptions.get('church1').get('pl').has(l1)).toBe(true);
            expect(state.subscriptions.get('church1').get('en').has(l2)).toBe(true);
            expect(getActiveLanguages('church1')).toEqual(['pl', 'en']);
        });
    });

    describe('Fix #3: handleNodeRegister guard', () => {
        it('should create new Map on first register', () => {
            const bcWs = mockWs('broadcaster');

            registerNode('church1', bcWs);

            expect(state.subscriptions.has('church1')).toBe(true);
            expect(state.subscriptions.get('church1').size).toBe(0);
        });

        it('should preserve existing subscriptions on re-register', () => {
            const bcWs = mockWs('broadcaster');
            const l1 = mockWs('listener1');

            registerNode('church1', bcWs);
            subscribeListener('church1', 'fr', l1);

            // Re-register
            registerNode('church1', bcWs);

            expect(state.subscriptions.get('church1').get('fr').has(l1)).toBe(true);
            expect(getActiveLanguages('church1')).toEqual(['fr']);
        });
    });

    describe('Integration: full reconnect scenario', () => {
        it('broadcaster disconnect + reconnect preserves all listener subscriptions', () => {
            const bcWs1 = mockWs('broadcaster-session1');
            const bcWs2 = mockWs('broadcaster-session2');
            const l1 = mockWs('listener-pl');
            const l2 = mockWs('listener-en');
            const l3 = mockWs('listener-ar');

            // Phase 1: Normal session
            authenticateBroadcaster('church1', bcWs1);
            subscribeListener('church1', 'pl', l1);
            subscribeListener('church1', 'en', l2);
            subscribeListener('church1', 'ar', l3);

            expect(getActiveLanguages('church1')).toEqual(['pl', 'en', 'ar']);

            // Phase 2: Broadcaster WiFi drop
            disconnectBroadcaster('church1');

            // Listeners still tracked (Fix #1)
            expect(getActiveLanguages('church1')).toEqual(['pl', 'en', 'ar']);

            // Phase 3: Broadcaster auto-reconnect (admin.html)
            authenticateBroadcaster('church1', bcWs2);

            // Listeners still tracked (Fix #2)
            expect(getActiveLanguages('church1')).toEqual(['pl', 'en', 'ar']);

            // Phase 4: Translation should find active languages
            const langs = getActiveLanguages('church1');
            expect(langs.length).toBe(3);
            expect(langs).toContain('pl');
            expect(langs).toContain('en');
            expect(langs).toContain('ar');
        });

        it('multiple disconnect-reconnect cycles preserve subscriptions', () => {
            const l1 = mockWs('listener-pl');

            authenticateBroadcaster('church1', mockWs('bc1'));
            subscribeListener('church1', 'pl', l1);

            // 3 disconnect-reconnect cycles (simulating flaky WiFi)
            for (let i = 2; i <= 4; i++) {
                disconnectBroadcaster('church1');
                authenticateBroadcaster('church1', mockWs(`bc${i}`));
            }

            // Listener still tracked after 3 cycles
            expect(state.subscriptions.get('church1').get('pl').has(l1)).toBe(true);
            expect(getActiveLanguages('church1')).toEqual(['pl']);
        });

        it('new listeners can subscribe after broadcaster reconnect', () => {
            const bcWs1 = mockWs('bc1');
            const bcWs2 = mockWs('bc2');
            const l1 = mockWs('listener-existing');
            const l2 = mockWs('listener-new');

            // Initial session
            authenticateBroadcaster('church1', bcWs1);
            subscribeListener('church1', 'pl', l1);

            // Broadcaster reconnect
            disconnectBroadcaster('church1');
            authenticateBroadcaster('church1', bcWs2);

            // New listener joins after reconnect
            subscribeListener('church1', 'en', l2);

            // Both listeners tracked
            expect(getActiveLanguages('church1')).toEqual(['pl', 'en']);
        });
    });
});
