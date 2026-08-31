import crypto from 'crypto';

const CSRF_TOKEN_BYTES = 32;
const CSRF_COOKIE_NAME = 'barnaba_csrf';
const CSRF_HEADER_NAME = 'x-barnaba-csrf';

function createCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_BYTES).toString('hex');
}

function safeEquals(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function csrfCookieOptions({ secure = false, maxAgeSeconds = null } = {}) {
    const parts = [
        'Path=/',
        'SameSite=Lax',
    ];
    if (secure) parts.push('Secure');
    if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
    return parts.join('; ');
}

function setCsrfCookie(res, token, options = {}) {
    res.append('Set-Cookie', `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; ${csrfCookieOptions(options)}`);
}

function clearCsrfCookie(res, options = {}) {
    res.append('Set-Cookie', `${CSRF_COOKIE_NAME}=; ${csrfCookieOptions({ ...options, maxAgeSeconds: 0 })}`);
}

function getCsrfCookie(req, parseCookies) {
    return parseCookies(req.headers.cookie || '')[CSRF_COOKIE_NAME] || null;
}

function validateCsrfRequest(req, parseCookies) {
    const cookieToken = getCsrfCookie(req, parseCookies);
    const headerToken = req.headers[CSRF_HEADER_NAME];
    return Boolean(cookieToken && headerToken && safeEquals(cookieToken, headerToken));
}

function requireCsrf(req, res, next, parseCookies) {
    if (validateCsrfRequest(req, parseCookies)) {
        next();
        return;
    }
    res.status(403).json({ success: false, error: 'CSRF token required' });
}

export {
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    createCsrfToken,
    setCsrfCookie,
    clearCsrfCookie,
    validateCsrfRequest,
    requireCsrf,
};
