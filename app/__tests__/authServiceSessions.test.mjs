import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACCESS_PIN = process.env.ACCESS_PIN || '123456';
process.env.BROADCASTER_PASSWORD = process.env.BROADCASTER_PASSWORD || 'test-master-password';

// A synthetic whitelist, written before authService is imported (it resolves the path
// once at module load). This test used to assert against the real deployment's
// churches.json, which is how an actual congregation id ended up in test data.
const churchesDir = mkdtempSync(join(tmpdir(), 'barnaba-churches-'));
const churchesFile = join(churchesDir, 'churches.json');
writeFileSync(churchesFile, JSON.stringify([
    { id: 'example-church', name: 'Example Church' },
]), 'utf8');
process.env.CHURCHES_CONFIG_PATH = churchesFile;

const {
    createBroadcasterSession,
    createListenerSession,
    generateJoinQR,
    invalidateSession,
    validateSession,
    verifyMasterPassword,
} = await import('../authService.js');

describe('master-password rate limiting', () => {
    it('locks repeated failures per IP without blocking a different IP', () => {
        const blockedIp = '198.51.100.20';
        for (let i = 0; i < 5; i++) {
            expect(verifyMasterPassword('wrong-password', blockedIp)).toBe(false);
        }
        expect(verifyMasterPassword('test-master-password', blockedIp)).toBe(false);
        expect(verifyMasterPassword('test-master-password', '198.51.100.21')).toBe(true);
    });
});

describe('authService session roles', () => {
    it('creates broadcaster sessions with broadcaster role', () => {
        const token = createBroadcasterSession('test-church', 'Test Church');
        const result = validateSession(token);

        expect(result.valid).toBe(true);
        expect(result.session).toMatchObject({
            churchId: 'test-church',
            churchName: 'Test Church',
            role: 'broadcaster'
        });
    });

    it('creates listener sessions with listener role', () => {
        const token = createListenerSession('test-church', 'Test Church');
        const result = validateSession(token);

        expect(result.valid).toBe(true);
        expect(result.session).toMatchObject({
            churchId: 'test-church',
            churchName: 'Test Church',
            role: 'listener'
        });
    });

    it('generates join URLs without embedding the listener PIN', async () => {
        const qr = await generateJoinQR('example-church', 'https://barnaba.example');

        expect(qr.pin).toBe('123456');
        expect(qr.joinUrl).toContain('church=example-church');
        expect(qr.joinUrl).not.toContain('pin=');
        expect(qr.joinUrl).not.toContain('123456');
    });
});

describe('stateless HMAC sessions (survive gateway restarts)', () => {
    it('validates tokens in a fresh process instance (restart simulation)', async () => {
        const token = createListenerSession('test-church', 'Test Church');

        // Fresh module = empty in-memory state, same env-derived secret.
        // This is exactly what a redeploy / scale-to-zero restart looks like.
        vi.resetModules();
        const freshAuthService = await import('../authService.js');

        const result = freshAuthService.validateSession(token);
        expect(result.valid).toBe(true);
        expect(result.session).toMatchObject({
            churchId: 'test-church',
            churchName: 'Test Church',
            role: 'listener'
        });
    });

    it('rejects tokens with a tampered payload', () => {
        const token = createListenerSession('test-church', 'Test Church');
        const [payload, signature] = token.split('.');

        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        claims.r = 'broadcaster';
        const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');

        const result = validateSession(`${forgedPayload}.${signature}`);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Invalid session');
    });

    it('rejects malformed tokens', () => {
        expect(validateSession('not-a-token').valid).toBe(false);
        expect(validateSession('a.b.c').valid).toBe(false);
        expect(validateSession('').valid).toBe(false);
        expect(validateSession(null).valid).toBe(false);
    });

    it('rejects expired tokens', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const service = await import('../authService.js');
            const token = service.createListenerSession('test-church', 'Test Church');

            vi.setSystemTime(Date.now() + 219001 * 60 * 60 * 1000);

            const result = service.validateSession(token);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('Session expired');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects revoked tokens within the same process', () => {
        const token = createListenerSession('test-church', 'Test Church');
        expect(validateSession(token).valid).toBe(true);

        invalidateSession(token);

        const result = validateSession(token);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Session revoked');
    });
});
