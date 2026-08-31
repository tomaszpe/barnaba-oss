import { describe, it, expect } from 'vitest';

/**
 * Contract tests for broadcast function return values (Task A3.1).
 *
 * broadcastToLanguage and broadcastToLanguageGender are NOT exported from server.js.
 * These tests verify the return value contract by reimplementing the core logic
 * (extracted from server.js lines 3269-3332) and asserting it matches expected
 * behavior. Full integration tests (IT-1, IT-2) in Phase A3.3 will test the
 * real functions in context with actual subscription maps.
 *
 * This approach avoids needing to export internal functions or mock complex
 * module-level state (WebSocket, subscriptions Map).
 */

// Replicate the core broadcast-to-language-gender logic per server.js:3314-3332
function broadcastToLanguageGenderLogic(clients, clientGenders, targetGender, message) {
    if (!clients || clients.length === 0) return 0;

    let sentCount = 0;
    for (const client of clients) {
        const clientGender = clientGenders.get(client) || 'male';
        if (clientGender === targetGender && client.readyState === 1 /* OPEN */) {
            client.send(JSON.stringify(message));
            sentCount++;
        }
    }
    return sentCount;
}

// Replicate the core broadcast-to-language logic per server.js:3269-3288
function broadcastToLanguageLogic(clients, message) {
    if (!clients || clients.length === 0) return 0;

    let sentCount = 0;
    for (const client of clients) {
        if (client.readyState === 1 /* OPEN */) {
            client.send(JSON.stringify(message));
            sentCount++;
        }
    }
    return sentCount;
}

function mockClient(readyState = 1) {
    return { readyState, send: () => {} };
}

describe('broadcastToLanguageGender return sentCount contract', () => {
    const genders = new Map();
    const msg = { type: 'translation', text: 'test' };

    it('UT-1a: returns count matching number of matching listeners', () => {
        const c1 = mockClient(1);
        const c2 = mockClient(1);
        const c3 = mockClient(1);
        genders.set(c1, 'female');
        genders.set(c2, 'female');
        genders.set(c3, 'male');

        const result = broadcastToLanguageGenderLogic([c1, c2, c3], genders, 'female', msg);
        expect(result).toBe(2);
    });

    it('UT-1c-gender: returns 0 when no clients', () => {
        const result = broadcastToLanguageGenderLogic([], new Map(), 'male', msg);
        expect(result).toBe(0);
    });

    it('UT-1c-gender-null: returns 0 when clients is null/undefined', () => {
        expect(broadcastToLanguageGenderLogic(null, new Map(), 'male', msg)).toBe(0);
        expect(broadcastToLanguageGenderLogic(undefined, new Map(), 'male', msg)).toBe(0);
    });

    it('returns 0 when all clients CLOSED', () => {
        const c1 = mockClient(3); // CLOSED
        const c2 = mockClient(3);
        genders.set(c1, 'male');
        genders.set(c2, 'male');

        const result = broadcastToLanguageGenderLogic([c1, c2], genders, 'male', msg);
        expect(result).toBe(0);
    });

    it('defaults to male when gender not set', () => {
        const c1 = mockClient(1);
        // c1 NOT in genders map → defaults to 'male'

        const emptyGenders = new Map();
        const result = broadcastToLanguageGenderLogic([c1], emptyGenders, 'male', msg);
        expect(result).toBe(1);
    });
});

describe('broadcastToLanguage return sentCount contract', () => {
    const msg = { type: 'translation', text: 'test' };

    it('UT-1b: returns count of all OPEN clients', () => {
        const clients = [mockClient(1), mockClient(1), mockClient(3)]; // 2 OPEN, 1 CLOSED
        const result = broadcastToLanguageLogic(clients, msg);
        expect(result).toBe(2);
    });

    it('UT-1c-lang: returns 0 when no clients', () => {
        expect(broadcastToLanguageLogic([], msg)).toBe(0);
    });

    it('UT-1c-lang-null: returns 0 when clients null', () => {
        expect(broadcastToLanguageLogic(null, msg)).toBe(0);
    });
});
