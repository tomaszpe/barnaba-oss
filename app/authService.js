/**
 * Authentication Service for Barnaba Church Translation System
 *
 * Stateless model (13.05.2026):
 * - Single shared ACCESS_PIN (env var) for all listeners
 * - Churches whitelisted in config/churches.json (PR per new church)
 * - No per-church PIN generation, no persistence file
 *
 * Stateless sessions (10.06.2026):
 * - Session tokens are HMAC-signed (payload.signature, base64url) and
 *   self-validating, so they survive gateway restarts, redeploys and
 *   scale-to-zero. Revocation is per-process only (logout denylist);
 *   global revocation = rotate SESSION_SECRET.
 *
 * Provides:
 * - Listener PIN verification against shared ACCESS_PIN
 * - QR code generation for a church join URL without embedding ACCESS_PIN
 * - Broadcaster session token management
 * - Master password protection for broadcaster registration
 */

import crypto from 'crypto';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const ACCESS_PIN = process.env.ACCESS_PIN || (() => {
    console.error('SECURITY ERROR: ACCESS_PIN environment variable is required');
    throw new Error('ACCESS_PIN environment variable must be set');
})();

if (!/^\d{6}$/.test(ACCESS_PIN)) {
    throw new Error('ACCESS_PIN must be exactly 6 digits');
}

const CONFIG = {
    sessionValidHours: 219000, // 25 years — broadcaster sessions permanent
    maxPinAttempts: 5,
    rateLimitWindowMs: 60 * 1000,
    masterPassword: process.env.BROADCASTER_PASSWORD || (() => {
        console.error('SECURITY ERROR: BROADCASTER_PASSWORD environment variable is required');
        throw new Error('BROADCASTER_PASSWORD environment variable must be set');
    })()
};

// ============================================================
// Church whitelist (loaded from config/churches.json)
// ============================================================

// Configurable, because the path was not: tests had to assert against the real
// deployment's whitelist, which put actual congregation ids into test data. The
// default is unchanged, so nothing about an existing deployment moves.
const CHURCHES_PATH = process.env.CHURCHES_CONFIG_PATH
    || path.resolve(__dirname, 'config', 'churches.json');
let CHURCHES = [];
let CHURCHES_BY_ID = new Map();

function loadChurches() {
    const raw = fs.readFileSync(CHURCHES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('config/churches.json must be a non-empty array');
    }
    for (const c of parsed) {
        if (!c.id || !c.name) {
            throw new Error(`Invalid church entry (missing id or name): ${JSON.stringify(c)}`);
        }
        if (!/^[a-z0-9-]+$/.test(c.id)) {
            throw new Error(`Invalid churchId "${c.id}" — must match [a-z0-9-]+`);
        }
    }
    CHURCHES = parsed;
    CHURCHES_BY_ID = new Map(parsed.map(c => [c.id, c]));
    console.log(`[AuthService] Loaded ${CHURCHES.length} churches from whitelist`);
}

loadChurches();

// ============================================================
// Session Secret (stateless HMAC tokens)
// ============================================================

// Must be identical across restarts and replicas — otherwise every restart
// invalidates all listener sessions (the bug behind GitHub #91). Prefer a
// dedicated SESSION_SECRET env var; the fallback is derived deterministically
// from secrets already required at boot. The PIN alone is NOT enough — it is
// shown to listeners on the QR screen, so it must not be the only key input.
const SESSION_SECRET = process.env.SESSION_SECRET
    || crypto.createHash('sha256')
        .update(`barnaba-session-v1:${ACCESS_PIN}:${CONFIG.masterPassword}`)
        .digest();

// ============================================================
// In-Memory State (rate limits + logout denylist only)
// ============================================================

const revokedSessions = new Map();   // token → expiresAt (per-process logout denylist)
const rateLimits = new Map();        // IP → { attempts, lastAttempt }
const masterPasswordRateLimits = new Map(); // IP → failed master-password attempts
let issuedSessions = 0;              // counter since process start (stats only)

// ============================================================
// Church whitelist accessors
// ============================================================

function listChurches() {
    return CHURCHES.map(c => ({ id: c.id, name: c.name }));
}

function isValidChurchId(churchId) {
    return CHURCHES_BY_ID.has(churchId);
}

function getChurch(churchId) {
    return CHURCHES_BY_ID.get(churchId) || null;
}

// ============================================================
// PIN Verification
// ============================================================

function pinsMatch(input) {
    const expected = Buffer.from(ACCESS_PIN);
    const got = Buffer.from(String(input || ''));
    if (expected.length !== got.length) return false;
    return crypto.timingSafeEqual(expected, got);
}

/**
 * Verify a PIN for a specific church.
 *
 * @param {string} churchId - Church identifier (must be in whitelist)
 * @param {string} pin - PIN to verify
 * @param {string} clientIp - Client IP for rate limiting
 * @returns {{valid: boolean, error?: string, churchName?: string}}
 */
function verifyPIN(churchId, pin, clientIp = 'unknown') {
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
        return { valid: false, error: 'Too many attempts. Please wait a minute.' };
    }

    const church = getChurch(churchId);
    if (!church) {
        recordAttempt(clientIp);
        return { valid: false, error: 'Unknown church' };
    }

    if (!pinsMatch(pin)) {
        recordAttempt(clientIp);
        return { valid: false, error: 'Invalid PIN' };
    }

    rateLimits.delete(clientIp);
    return { valid: true, churchName: church.name };
}

// ============================================================
// QR Code Generation
// ============================================================

/**
 * Generate QR code containing church join URL. The listener enters the PIN
 * on the page; the PIN is not embedded in the URL.
 *
 * @param {string} churchId - Church identifier (must be in whitelist)
 * @param {string} baseUrl - Base URL of the application
 * @returns {Promise<{qrCode: string, pin: string, joinUrl: string}>}
 */
async function generateJoinQR(churchId, baseUrl) {
    const church = getChurch(churchId);
    if (!church) {
        throw new Error(`Unknown churchId: ${churchId}`);
    }

    const joinUrl = `${baseUrl}?church=${encodeURIComponent(churchId)}`;

    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
        width: 300,
        margin: 2,
        color: { dark: '#1a1a2e', light: '#ffffff' },
        errorCorrectionLevel: 'M'
    });

    return {
        qrCode: qrDataUrl,
        pin: ACCESS_PIN,
        joinUrl,
        churchName: church.name
    };
}

async function generateQRSvg(url) {
    return await QRCode.toString(url, {
        type: 'svg',
        margin: 2,
        color: { dark: '#1a1a2e', light: '#ffffff' }
    });
}

// ============================================================
// Session Management (stateless HMAC tokens)
// ============================================================

function signSessionPayload(payload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function decodeSessionClaims(payload) {
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!claims || typeof claims !== 'object') return null;
        if (!claims.c || !claims.r || !Number.isFinite(claims.exp)) return null;
        return claims;
    } catch {
        return null;
    }
}

function createSession(churchId, churchName, role) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
        c: churchId,
        n: churchName,
        r: role,
        iat: now,
        exp: now + (CONFIG.sessionValidHours * 60 * 60 * 1000)
    })).toString('base64url');

    issuedSessions++;
    console.log(`[AuthService] Created ${role} session for ${churchName}`);
    return `${payload}.${signSessionPayload(payload)}`;
}

function createBroadcasterSession(churchId, churchName) {
    return createSession(churchId, churchName, 'broadcaster');
}

function createListenerSession(churchId, churchName) {
    return createSession(churchId, churchName, 'listener');
}

function validateSession(token) {
    if (!token) return { valid: false, error: 'No token provided' };

    const [payload, signature, ...rest] = String(token).split('.');
    if (!payload || !signature || rest.length > 0) {
        return { valid: false, error: 'Invalid session' };
    }

    const expected = Buffer.from(signSessionPayload(payload));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
        return { valid: false, error: 'Invalid session' };
    }

    const claims = decodeSessionClaims(payload);
    if (!claims) return { valid: false, error: 'Invalid session' };
    if (revokedSessions.has(token)) return { valid: false, error: 'Session revoked' };
    if (Date.now() > claims.exp) return { valid: false, error: 'Session expired' };

    return {
        valid: true,
        session: {
            churchId: claims.c,
            churchName: claims.n,
            role: claims.r,
            createdAt: claims.iat,
            expiresAt: claims.exp
        }
    };
}

function invalidateSession(token) {
    const result = validateSession(token);
    if (result.valid) {
        revokedSessions.set(token, result.session.expiresAt);
        console.log(`[AuthService] Invalidated session for ${result.session.churchName}`);
    }
}

// ============================================================
// Master Password Verification
// ============================================================

function verifyMasterPassword(password, clientIp = 'unknown') {
    const rateCheck = checkRateLimitFor(masterPasswordRateLimits, clientIp);
    if (!rateCheck.allowed) return false;

    const masterBuffer = Buffer.from(CONFIG.masterPassword);
    const inputBuffer = Buffer.from(password || '');
    const valid = masterBuffer.length === inputBuffer.length
        && crypto.timingSafeEqual(masterBuffer, inputBuffer);
    if (valid) {
        masterPasswordRateLimits.delete(clientIp);
    } else {
        recordAttemptFor(masterPasswordRateLimits, clientIp);
    }
    return valid;
}

// ============================================================
// Rate Limiting
// ============================================================

function checkRateLimit(clientIp) {
    return checkRateLimitFor(rateLimits, clientIp);
}

function checkRateLimitFor(store, clientIp) {
    const limit = store.get(clientIp);
    if (!limit) return { allowed: true, remainingAttempts: CONFIG.maxPinAttempts };
    if (Date.now() - limit.lastAttempt > CONFIG.rateLimitWindowMs) {
        store.delete(clientIp);
        return { allowed: true, remainingAttempts: CONFIG.maxPinAttempts };
    }
    if (limit.attempts >= CONFIG.maxPinAttempts) {
        return { allowed: false, remainingAttempts: 0 };
    }
    return { allowed: true, remainingAttempts: CONFIG.maxPinAttempts - limit.attempts };
}

function recordAttempt(clientIp) {
    recordAttemptFor(rateLimits, clientIp);
}

function recordAttemptFor(store, clientIp) {
    const limit = store.get(clientIp) || { attempts: 0, lastAttempt: 0 };
    if (Date.now() - limit.lastAttempt > CONFIG.rateLimitWindowMs) limit.attempts = 0;
    limit.attempts++;
    limit.lastAttempt = Date.now();
    store.set(clientIp, limit);
}

// ============================================================
// Cleanup
// ============================================================

function cleanupMap(map, isExpired) {
    const now = Date.now();
    let removed = 0;
    for (const [key, value] of map) {
        if (isExpired(value, now)) {
            map.delete(key);
            removed++;
        }
    }
    return removed;
}

function cleanupExpired() {
    const cleanedRevoked = cleanupMap(revokedSessions, (expiresAt, now) => now > expiresAt);
    cleanupMap(rateLimits, (r, now) => now - r.lastAttempt > CONFIG.rateLimitWindowMs * 5);
    cleanupMap(masterPasswordRateLimits, (r, now) => now - r.lastAttempt > CONFIG.rateLimitWindowMs * 5);
    if (cleanedRevoked > 0) {
        console.log(`[AuthService] Cleanup: ${cleanedRevoked} revoked sessions removed`);
    }
}

setInterval(cleanupExpired, 15 * 60 * 1000);

// ============================================================
// Statistics
// ============================================================

function getAuthStats() {
    return {
        sessionModel: 'stateless-hmac',
        issuedSessions,
        revokedSessions: revokedSessions.size,
        churches: CHURCHES.length,
        rateLimitedIps: rateLimits.size,
        masterPasswordRateLimitedIps: masterPasswordRateLimits.size
    };
}

// ============================================================
// Exports
// ============================================================

export {
    // Whitelist
    listChurches,
    isValidChurchId,
    getChurch,

    // PIN verification
    verifyPIN,

    // QR Code
    generateJoinQR,
    generateQRSvg,

    // Session Management
    createBroadcasterSession,
    createListenerSession,
    validateSession,
    invalidateSession,

    // Password
    verifyMasterPassword,

    // Utilities
    cleanupExpired,
    getAuthStats
};
