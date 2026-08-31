/**
 * BARNABA Control Plane
 *
 * Lightweight server that manages Whisper and Gateway containers.
 * Always running, minimal resource usage.
 *
 * Features:
 * - Start/stop Whisper container
 * - Start/stop Gateway container
 * - Health status monitoring
 * - Serves admin.html
 * - Proxies auth requests to Gateway when running
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import {
    createCsrfToken,
    setCsrfCookie,
    clearCsrfCookie,
    requireCsrf,
} from './csrfService.js';
import { buildClientFeatureConfig } from './clientFeatureConfig.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Configuration
// ============================================================
const config = {
    port: process.env.CONTROL_PLANE_PORT || 8090,
    masterPassword: process.env.BROADCASTER_PASSWORD || (() => {
        console.error('ERROR: BROADCASTER_PASSWORD environment variable required');
        process.exit(1);
    })(),
    azure: {
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '',
        resourceGroup: process.env.AZURE_RESOURCE_GROUP || 'barnaba-rg',
        // Split resource-group support: the Whisper service and the Gateway/Control Plane can
        // live in different resource groups. Falls back to AZURE_RESOURCE_GROUP.
        whisperResourceGroup: process.env.WHISPER_RESOURCE_GROUP || process.env.AZURE_RESOURCE_GROUP || 'barnaba-rg',
        whisperContainer: process.env.WHISPER_CONTAINER_NAME || 'barnaba-whisper',
        gatewayContainer: process.env.GATEWAY_CONTAINER_NAME || 'barnaba-gateway',
        apiVersion: '2024-03-01',  // Azure Container Apps API version
    },
    // Both URLs are REQUIRED env vars (see infra/verify-env-parity.mjs). They used to
    // carry hardcoded deployment-specific fallbacks, which did two bad things: they
    // pinned one particular hosting setup into the source, and they turned a missing
    // env var into a silent misroute instead of a startup error. Fail loudly instead.
    urls: {
        whisper: process.env.WHISPER_SERVICE_URL || (() => {
            console.error('ERROR: WHISPER_SERVICE_URL environment variable required');
            process.exit(1);
        })(),
        gateway: process.env.GATEWAY_URL || (() => {
            console.error('ERROR: GATEWAY_URL environment variable required');
            process.exit(1);
        })(),
    },
    clientFeatures: buildClientFeatureConfig(process.env),
    timeouts: {
        containerStart: 120000,  // 120s for az rest (async operation)
        healthCheck: 10000,      // 10s for health pings
        // 12 min: cold GPU image pull + model warm-up, but above all WAITING FOR A NODE.
        // Observed on a loaded GPU pool: the platform rescheduled the replica about every 60 s
        // for 6 min 20 s before it allocated a node; the whole start took 7 min 28 s. A 5-minute
        // limit expired in the middle of that wait, `startSystem()` aborted at the
        // `waiting-for-whisper` step and DID NOT START THE GATEWAY - which looked like a deploy
        // failure but was only too short a limit. The image pull alone is 59 s, start plus model
        // load about 30 s; the rest is queueing for a GPU, which is outside our control.
        whisperReady: 720000,    // 12 min
        gatewayReady: 120000,    // 2 min for gateway startup
        healthPoll: 10000,
    }
};

const secureCookies = process.env.COOKIE_SECURE !== 'false';

console.log('[ControlPlane] Configuration:');
console.log(`  - Port: ${config.port}`);
console.log('  - Mode: AZURE (Container Apps)');
console.log(`  - Resource Group: ${config.azure.resourceGroup}`);
if (config.azure.whisperResourceGroup !== config.azure.resourceGroup) {
    console.log(`  - Whisper Resource Group: ${config.azure.whisperResourceGroup} (split-RG)`);
}
console.log(`  - Whisper Container: ${config.azure.whisperContainer}`);
console.log(`  - Gateway Container: ${config.azure.gatewayContainer}`);

// ============================================================
// State
// ============================================================
const state = {
    whisper: { status: 'unknown', lastCheck: null, error: null },
    gateway: { status: 'unknown', lastCheck: null, error: null },
    lastAction: null,
};

const CONTROL_COOKIE_NAME = 'barnaba_control_session';
const CONTROL_COOKIE_MAX_AGE_SECONDS = Math.max(
    300,
    Number.parseInt(process.env.CONTROL_COOKIE_MAX_AGE_SECONDS || String(12 * 60 * 60), 10) || (12 * 60 * 60)
);
const controlSessions = new Map();

function parseCookies(header = '') {
    return String(header || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const idx = part.indexOf('=');
            if (idx === -1) return cookies;
            cookies[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
            return cookies;
        }, {});
}

function cookieOptions({ maxAgeSeconds = null } = {}) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (secureCookies) parts.push('Secure');
    if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
    return parts.join('; ');
}

function createControlSession(res) {
    const token = crypto.randomBytes(32).toString('hex');
    controlSessions.set(token, Date.now() + CONTROL_COOKIE_MAX_AGE_SECONDS * 1000);
    res.append('Set-Cookie', `${CONTROL_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions({ maxAgeSeconds: CONTROL_COOKIE_MAX_AGE_SECONDS })}`);
    setCsrfCookie(res, createCsrfToken(), {
        secure: secureCookies,
        maxAgeSeconds: CONTROL_COOKIE_MAX_AGE_SECONDS,
    });
}

function clearControlSession(req, res) {
    const token = parseCookies(req.headers.cookie || '')[CONTROL_COOKIE_NAME];
    if (token) controlSessions.delete(token);
    res.append('Set-Cookie', `${CONTROL_COOKIE_NAME}=; ${cookieOptions({ maxAgeSeconds: 0 })}`);
    clearCsrfCookie(res, { secure: secureCookies });
}

function hasValidControlSession(req) {
    const token = parseCookies(req.headers.cookie || '')[CONTROL_COOKIE_NAME];
    const expiresAt = token ? controlSessions.get(token) : null;
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        controlSessions.delete(token);
        return false;
    }
    return true;
}

function requireControlAuth(req, res) {
    if (hasValidControlSession(req)) return true;
    return false;
}

function requireControlSession(req, res, next) {
    if (requireControlAuth(req, res)) {
        next();
        return;
    }
    res.status(401).json({ success: false, error: 'Unauthorized' });
}

function requireControlCsrf(req, res, next) {
    requireCsrf(req, res, next, parseCookies);
}

function forwardCsrfHeader(req) {
    const token = req.headers['x-barnaba-csrf'];
    return token ? { 'x-barnaba-csrf': token } : {};
}

function forwardSetCookies(response, res) {
    const getSetCookie = response.headers.getSetCookie?.();
    if (Array.isArray(getSetCookie) && getSetCookie.length > 0) {
        res.setHeader('Set-Cookie', getSetCookie);
        return;
    }
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
        res.setHeader('Set-Cookie', setCookie);
    }
}

// State lock to prevent race conditions
let stateLock = false;
async function acquireStateLock(timeoutMs = 5000) {
    const start = Date.now();
    while (stateLock) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('State lock timeout');
        }
        await new Promise(r => setTimeout(r, 50));
    }
    stateLock = true;
}
function releaseStateLock() {
    stateLock = false;
}

// Rate limiting for control endpoints
const rateLimitMap = new Map(); // IP -> { count, resetTime }
const RATE_LIMIT = { maxRequests: 10, windowMs: 60000 }; // 10 requests per minute

function checkRateLimit(ip) {
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + RATE_LIMIT.windowMs };
    }

    entry.count++;
    rateLimitMap.set(ip, entry);

    if (entry.count > RATE_LIMIT.maxRequests) {
        return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
    }
    return { allowed: true };
}

function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const check = checkRateLimit(ip);

    if (!check.allowed) {
        return res.status(429).json({
            success: false,
            error: 'Too many requests. Please try again later.',
            retryAfter: check.retryAfter
        });
    }
    next();
}

// ============================================================
// Express App
// ============================================================
const app = express();
app.use(express.json());

// No-cache for HTML files (prevent stale browser cache after deploys)
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/' || req.path === '/sw.js') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// Serve static files (admin.html)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Authentication
// ============================================================

/**
 * Verify password using timing-safe comparison
 */
function verifyPassword(password) {
    if (!password) return false;

    const masterBuffer = Buffer.from(config.masterPassword);
    const inputBuffer = Buffer.from(password);

    if (masterBuffer.length !== inputBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(masterBuffer, inputBuffer);
}

// ============================================================
// Container Management Functions
// ============================================================

/**
 * Build the Azure REST API URL for container app operations
 */
function buildContainerAppUrl(containerName, operation) {
    const subId = config.azure.subscriptionId;
    // Split-RG: Whisper may be in a different RG than Gateway/ControlPlane
    const rg = containerName === config.azure.whisperContainer
        ? config.azure.whisperResourceGroup
        : config.azure.resourceGroup;
    const apiVersion = config.azure.apiVersion;
    return `/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${containerName}/${operation}?api-version=${apiVersion}`;
}

function buildContainerAppResourceUrl(containerName) {
    const subId = config.azure.subscriptionId;
    const rg = containerName === config.azure.whisperContainer
        ? config.azure.whisperResourceGroup
        : config.azure.resourceGroup;
    return `/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${containerName}?api-version=${config.azure.apiVersion}`;
}

function normalizeOrigin(url) {
    try {
        const parsed = new URL(url);
        return parsed.origin;
    } catch {
        return null;
    }
}

async function checkContainerAppReady(containerName) {
    try {
        const { stdout } = await execFileAsync('az', [
            'rest',
            '--method', 'GET',
            '--url', buildContainerAppResourceUrl(containerName)
        ], { timeout: config.timeouts.healthCheck });

        const data = JSON.parse(stdout || '{}');
        const props = data.properties || {};
        const runningStatus = props.runningStatus || null;
        const latestRevisionName = props.latestRevisionName || null;
        const latestReadyRevisionName = props.latestReadyRevisionName || null;
        const activeRevision = (props.latestRevisionName && props.latestRevisionName === props.latestReadyRevisionName)
            ? props.latestRevisionName
            : null;
        const ready = runningStatus === 'Running'
            && latestRevisionName
            && latestRevisionName === latestReadyRevisionName;

        return {
            ready,
            runningStatus,
            latestRevisionName,
            latestReadyRevisionName,
            activeRevision,
            error: ready ? null : `Azure status ${runningStatus || 'unknown'}, latest=${latestRevisionName || 'n/a'}, ready=${latestReadyRevisionName || 'n/a'}`
        };
    } catch (error) {
        return {
            ready: false,
            error: `Azure readiness check failed: ${error.message}`
        };
    }
}

/**
 * Start an Azure Container App.
 * Uses 'az rest' because 'az containerapp start' doesn't exist in Azure CLI
 */
async function startContainer(containerName) {
    console.log(`[ControlPlane] Starting container: ${containerName}`);

    try {
        // Use 'az rest' to call the REST API (az containerapp start doesn't exist!)
        const url = buildContainerAppUrl(containerName, 'start');
        console.log(`[ControlPlane] Calling: az rest --method POST --url ${url}`);

        const { stdout, stderr } = await execFileAsync('az', [
            'rest',
            '--method', 'POST',
            '--url', url
        ], { timeout: config.timeouts.containerStart });

        console.log(`[ControlPlane] Container ${containerName} start command completed`);
        return { success: true };
    } catch (error) {
        console.error(`[ControlPlane] Failed to start ${containerName}:`, error.message);
        return { success: false, error: 'Failed to start container' };
    }
}

/**
 * Stop an Azure Container App.
 * Uses 'az rest' because 'az containerapp stop' doesn't exist in Azure CLI
 */
async function stopContainer(containerName) {
    console.log(`[ControlPlane] Stopping container: ${containerName}`);

    try {
        // Use 'az rest' to call the REST API (az containerapp stop doesn't exist!)
        const url = buildContainerAppUrl(containerName, 'stop');
        console.log(`[ControlPlane] Calling: az rest --method POST --url ${url}`);

        const { stdout, stderr } = await execFileAsync('az', [
            'rest',
            '--method', 'POST',
            '--url', url
        ], { timeout: config.timeouts.containerStart });

        console.log(`[ControlPlane] Container ${containerName} stopped`);
        return { success: true };
    } catch (error) {
        console.error(`[ControlPlane] Failed to stop ${containerName}:`, error.message);
        return { success: false, error: 'Failed to stop container' };
    }
}

function isServiceReady(serviceName, data) {
    if (serviceName === 'whisper') {
        return data?.status === 'healthy' && data?.model_loaded === true;
    }
    return true;
}

/**
 * Check if a service is ready by pinging its health endpoint.
 * For Whisper, HTTP 200 is not enough: the model must be loaded and warmed.
 */
async function checkHealth(url, serviceName) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeouts.healthCheck);

        const response = await fetch(`${url}/health`, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok) {
            const data = await response.json();
            if (isServiceReady(serviceName, data)) {
                return { healthy: true, data };
            }
            return {
                healthy: false,
                error: serviceName === 'whisper' ? 'Model warming up' : 'Service not ready',
                data
            };
        } else {
            return { healthy: false, error: `HTTP ${response.status}` };
        }
    } catch (error) {
        return {
            healthy: false,
            error: error.name === 'AbortError' ? 'Timeout' : error.message
        };
    }
}

async function waitForHealth(url, serviceName, timeoutMs) {
    const startedAt = Date.now();
    let lastHealth = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastHealth = await checkHealth(url, serviceName);
        if (lastHealth.healthy) return lastHealth;
        await new Promise(resolve => setTimeout(resolve, config.timeouts.healthPoll));
    }

    return {
        healthy: false,
        error: `${serviceName} failed to become ready within ${Math.round(timeoutMs / 1000)}s`,
        lastHealth
    };
}

async function checkServiceReady(serviceName) {
    if (serviceName === 'whisper') {
        const [azure, health] = await Promise.all([
            checkContainerAppReady(config.azure.whisperContainer),
            checkHealth(config.urls.whisper, 'whisper')
        ]);
        return {
            healthy: azure.ready && health.healthy,
            error: !azure.ready ? azure.error : health.error,
            data: health.data || null,
            azure
        };
    }

    return checkHealth(config.urls.gateway, 'gateway');
}

async function waitForServiceReady(serviceName, timeoutMs) {
    const startedAt = Date.now();
    let lastStatus = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastStatus = await checkServiceReady(serviceName);
        if (lastStatus.healthy) return lastStatus;
        await new Promise(resolve => setTimeout(resolve, config.timeouts.healthPoll));
    }

    return {
        healthy: false,
        error: `${serviceName} failed to become ready within ${Math.round(timeoutMs / 1000)}s`,
        lastStatus
    };
}

async function startSystem() {
    state.lastAction = { action: 'start-system', time: Date.now(), status: 'in_progress', step: 'checking' };

    const initialWhisperHealth = await checkServiceReady('whisper');
    const initialGatewayHealth = await checkServiceReady('gateway');
    const whisperWasReady = initialWhisperHealth.healthy;
    const gatewayWasRunning = initialGatewayHealth.healthy;

    state.lastAction.step = 'starting-whisper';
    const whisperStart = await startContainer(config.azure.whisperContainer);
    if (!whisperStart.success) {
        state.lastAction.status = 'failed';
        state.lastAction.error = `Whisper start failed: ${whisperStart.error}`;
        return { success: false, error: state.lastAction.error, whisper: whisperStart };
    }

    state.lastAction.step = 'waiting-for-whisper';
    const whisperHealth = await waitForServiceReady('whisper', config.timeouts.whisperReady);
    if (!whisperHealth.healthy) {
        state.lastAction.status = 'failed';
        state.lastAction.error = whisperHealth.error;
        return { success: false, error: whisperHealth.error, whisper: whisperHealth };
    }

    const needsGatewayRestart = gatewayWasRunning && !whisperWasReady;
    let gatewayStop = null;
    if (needsGatewayRestart) {
        state.lastAction.step = 'restarting-gateway';
        gatewayStop = await stopContainer(config.azure.gatewayContainer);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    state.lastAction.step = 'starting-gateway';
    const gatewayStart = await startContainer(config.azure.gatewayContainer);
    if (!gatewayStart.success) {
        state.lastAction.status = 'failed';
        state.lastAction.error = `Gateway start failed: ${gatewayStart.error}`;
        return { success: false, error: state.lastAction.error, whisper: whisperHealth, gateway: gatewayStart };
    }

    state.lastAction.step = 'waiting-for-gateway';
    const gatewayHealth = await waitForServiceReady('gateway', config.timeouts.gatewayReady);
    if (!gatewayHealth.healthy) {
        state.lastAction.status = 'failed';
        state.lastAction.error = gatewayHealth.error;
        return { success: false, error: gatewayHealth.error, whisper: whisperHealth, gateway: gatewayHealth };
    }

    state.whisper = {
        status: 'running',
        lastCheck: Date.now(),
        error: null,
        health: whisperHealth.data
    };
    state.gateway = {
        status: 'running',
        lastCheck: Date.now(),
        error: null,
        health: gatewayHealth.data
    };
    state.lastAction.status = 'completed';
    state.lastAction.step = 'ready';

    return {
        success: true,
        systemReady: true,
        whisper: whisperHealth,
        gateway: gatewayHealth,
        gatewayRestarted: Boolean(gatewayStop),
    };
}

// ============================================================
// API Endpoints
// ============================================================

app.post('/api/control/login', rateLimitMiddleware, (req, res) => {
    if (!verifyPassword(req.body?.password)) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    createControlSession(res);
    res.json({ success: true });
});

app.post('/api/control/logout', requireControlCsrf, (req, res) => {
    clearControlSession(req, res);
    res.json({ success: true });
});

/**
 * GET /api/control/status - Get current system status
 * Uses state lock to prevent race conditions
 */
app.get('/api/control/status', requireControlSession, async (req, res) => {
    try {
        await acquireStateLock();

        // Check health of both services
        const [whisperHealth, gatewayHealth] = await Promise.all([
            checkServiceReady('whisper'),
            checkServiceReady('gateway')
        ]);

        state.whisper = {
            status: whisperHealth.healthy ? 'running' : 'stopped',
            lastCheck: Date.now(),
            error: whisperHealth.error || null,
            health: whisperHealth.data || null,
            azure: whisperHealth.azure || null
        };

        state.gateway = {
            status: gatewayHealth.healthy ? 'running' : 'stopped',
            lastCheck: Date.now(),
            error: gatewayHealth.error || null,
            health: gatewayHealth.data || null
        };

        const systemReady = whisperHealth.healthy && gatewayHealth.healthy;

        res.json({
            systemReady,
            whisper: state.whisper,
            gateway: state.gateway,
            lastAction: state.lastAction
        });
    } catch (error) {
        console.error('[ControlPlane] Status check failed:', error.message);
        res.status(500).json({ success: false, error: 'Unable to read system status' });
    } finally {
        releaseStateLock();
    }
});

/**
 * POST /api/control/start-whisper - Start Whisper container
 */
app.post('/api/control/start-whisper', rateLimitMiddleware, requireControlCsrf, async (req, res) => {
    if (!requireControlAuth(req, res)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    state.lastAction = { action: 'start-whisper', time: Date.now(), status: 'in_progress' };

    const result = await startContainer(config.azure.whisperContainer);

    state.lastAction.status = result.success ? 'completed' : 'failed';
    state.lastAction.error = result.error;

    res.json(result);
});

/**
 * POST /api/control/start-gateway - Start Gateway container
 */
app.post('/api/control/start-gateway', rateLimitMiddleware, requireControlCsrf, async (req, res) => {
    if (!requireControlAuth(req, res)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    state.lastAction = { action: 'start-gateway', time: Date.now(), status: 'in_progress' };

    const result = await startContainer(config.azure.gatewayContainer);

    state.lastAction.status = result.success ? 'completed' : 'failed';
    state.lastAction.error = result.error;

    res.json(result);
});

/**
 * POST /api/control/start-system - Start Whisper, wait for model warm-up,
 * then start/restart Gateway. This is the safe path for minReplicas=0.
 */
app.post('/api/control/start-system', rateLimitMiddleware, requireControlCsrf, async (req, res) => {
    if (!requireControlAuth(req, res)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const result = await startSystem();
        res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
        state.lastAction = {
            action: 'start-system',
            time: Date.now(),
            status: 'failed',
            error: 'Failed to start system'
        };
        console.error('[ControlPlane] Start-system failed:', error.message);
        res.status(500).json({ success: false, error: 'Failed to start system' });
    }
});

/**
 * POST /api/control/stop-whisper - Stop Whisper container only
 * Called by Gateway auto-stop (Phase 7.5b) - the Gateway container has no az CLI.
 *
 * Auth is verifyPassword(body), NOT requireControlAuth/requireControlCsrf like the
 * sibling routes: the caller is server.js (no browser, no cookie jar), and a route
 * carrying an explicit body password sends no ambient credentials, so CSRF does not
 * apply. Gateway and Control Plane both read BROADCASTER_PASSWORD, so the secret is
 * already shared. Do not "align" this with the cookie-authed routes without also
 * changing the caller (server.js:1630).
 */
app.post('/api/control/stop-whisper', rateLimitMiddleware, async (req, res) => {
    // req.body?. - do not rely on express.json() having normalized a missing body to {}.
    // Without the guard, a bodyless POST would throw instead of answering 401.
    if (!verifyPassword(req.body?.password)) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    console.log('[ControlPlane] Stop-whisper request (auto-stop or manual)');
    state.lastAction = { action: 'stop-whisper', time: Date.now(), status: 'in_progress' };

    const result = await stopContainer(config.azure.whisperContainer);

    state.lastAction.status = result.success ? 'completed' : 'failed';
    state.lastAction.error = result.error;

    res.json(result);
});

/**
 * POST /api/control/stop-gateway - Stop Gateway container only (for restart)
 */
app.post('/api/control/stop-gateway', rateLimitMiddleware, requireControlCsrf, async (req, res) => {
    if (!requireControlAuth(req, res)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    state.lastAction = { action: 'stop-gateway', time: Date.now(), status: 'in_progress' };

    const result = await stopContainer(config.azure.gatewayContainer);

    state.lastAction.status = result.success ? 'completed' : 'failed';
    state.lastAction.error = result.error;

    res.json(result);
});

/**
 * POST /api/control/stop-all - Stop both containers
 */
app.post('/api/control/stop-all', rateLimitMiddleware, requireControlCsrf, async (req, res) => {
    if (!requireControlAuth(req, res)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    state.lastAction = { action: 'stop-all', time: Date.now(), status: 'in_progress' };

    // Stop both containers in parallel
    const [whisperResult, gatewayResult] = await Promise.all([
        stopContainer(config.azure.whisperContainer),
        stopContainer(config.azure.gatewayContainer)
    ]);

    const success = whisperResult.success && gatewayResult.success;
    state.lastAction.status = success ? 'completed' : 'failed';

    res.json({
        success,
        whisper: whisperResult,
        gateway: gatewayResult
    });
});

/**
 * GET /api/control/whisper-health - Check Whisper health
 */
app.get('/api/control/whisper-health', requireControlSession, async (req, res) => {
    const health = await checkServiceReady('whisper');
    res.json(health);
});

/**
 * GET /api/control/gateway-health - Check Gateway health
 */
app.get('/api/control/gateway-health', requireControlSession, async (req, res) => {
    const health = await checkHealth(config.urls.gateway, 'gateway');
    res.json(health);
});

/**
 * Church whitelist (served locally so dropdown works even when gateway is stopped).
 * Source of truth: config/churches.json (same file used by gateway).
 * GET /api/churches
 */
import fs from 'fs';

let CHURCHES = [];
try {
    // Same override as authService: see CHURCHES_CONFIG_PATH there.
    const churchesPath = process.env.CHURCHES_CONFIG_PATH
        || path.resolve(__dirname, 'config', 'churches.json');
    CHURCHES = JSON.parse(fs.readFileSync(churchesPath, 'utf8'))
        .map(c => ({ id: c.id, name: c.name }));
    console.log(`[ControlPlane] Loaded ${CHURCHES.length} churches from whitelist`);
} catch (e) {
    console.error('[ControlPlane] Failed to load config/churches.json:', e.message);
}

app.get('/api/churches', (req, res) => {
    res.json({ success: true, churches: CHURCHES });
});

/**
 * Proxy auth requests to Gateway
 * POST /api/auth/* -> Gateway /api/auth/*
 */
app.post('/api/auth/:endpoint', async (req, res) => {
    const endpoint = req.params.endpoint;
    const gatewayUrl = `${config.urls.gateway}/api/auth/${endpoint}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(gatewayUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Barnaba-Public-Origin': normalizeOrigin(config.urls.gateway) || config.urls.gateway,
                ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
                ...forwardCsrfHeader(req),
            },
            body: JSON.stringify(req.body),
            signal: controller.signal
        });

        clearTimeout(timeout);

        const data = await response.json();
        forwardSetCookies(response, res);
        res.status(response.status).json(data);
    } catch (error) {
        console.error(`[ControlPlane] Auth proxy error:`, error.message);
        res.status(503).json({
            success: false,
            error: 'Gateway is not available. Please start Barnaba first.'
        });
    }
});

/**
 * GET /api/control/config - Expose gateway URL for broadcaster
 */
app.get('/api/control/config', (req, res) => {
    // No-store, not merely no-cache: the value decides which arm the listener is in, so a
    // revalidated 304 from any intermediary would be indistinguishable from a fresh read.
    res.set('Cache-Control', 'no-store');
    res.json({
        gatewayUrl: config.urls.gateway,
        preserveTtsPitch: config.clientFeatures.preserveTtsPitch,
        instantFeedback: config.clientFeatures.instantFeedback,
        listenerPlaybackPolicyV2: config.clientFeatures.listenerPlaybackPolicyV2,
        listenerBoundedScheduler: config.clientFeatures.listenerBoundedScheduler,
        listenerCatchupMaxRate: config.clientFeatures.listenerCatchupMaxRate,
        listenerCatchupChunkAgeMs: config.clientFeatures.listenerCatchupChunkAgeMs,
        listenerBacklogBudgetMs: config.clientFeatures.listenerBacklogBudgetMs,
        listenerEarlyCatchup: config.clientFeatures.listenerEarlyCatchup,
        listenerEarlyCatchupEnterMs: config.clientFeatures.listenerEarlyCatchupEnterMs,
        listenerEarlyCatchupExitMs: config.clientFeatures.listenerEarlyCatchupExitMs,
        listenerEarlyCatchupDwellMs: config.clientFeatures.listenerEarlyCatchupDwellMs,
        listenerEarlyCatchupRate: config.clientFeatures.listenerEarlyCatchupRate,
        fqfT2SupersessionShadow: config.clientFeatures.fqfT2SupersessionShadow,
        fqfT2SupersessionApply: config.clientFeatures.fqfT2SupersessionApply,
    });
});

/**
 * Proxy: GET /api/whisper/status -> Gateway
 */
app.get('/api/whisper/status', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(`${config.urls.gateway}/api/whisper/status`, {
            signal: controller.signal,
            headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {},
        });
        clearTimeout(timeout);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(503).json({ initialized: false, error: 'Gateway not available' });
    }
});

/**
 * Proxy: GET /api/latency-stats -> Gateway
 */
app.get('/api/latency-stats', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${config.urls.gateway}/api/latency-stats`, {
            signal: controller.signal,
            headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {},
        });
        clearTimeout(timeout);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(503).json({ error: 'Gateway not available' });
    }
});

/**
 * Proxy: POST /api/sermon-context -> Gateway (multipart/form-data passthrough)
 * Collects raw body and forwards to gateway with original content-type (incl. boundary)
 */
app.post('/api/sermon-context', async (req, res) => {
    try {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(`${config.urls.gateway}/api/sermon-context`, {
            method: 'POST',
            headers: {
                'content-type': req.headers['content-type'],
                ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
                ...forwardCsrfHeader(req),
            },
            body: rawBody,
            signal: controller.signal
        });

        clearTimeout(timeout);
        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            const text = await response.text();
            console.error(`[ControlPlane] POST sermon-context: gateway returned non-JSON (${response.status}, ${text.length} characters)`);
            return res.status(502).json({ success: false, error: 'Gateway returned unexpected response' });
        }
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('[ControlPlane] Sermon context proxy error:', error.message);
        res.status(503).json({ success: false, error: 'Gateway is not available.' });
    }
});

/**
 * Proxy: GET /api/sermon-context -> Gateway
 */
app.get('/api/sermon-context', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(`${config.urls.gateway}/api/sermon-context`, {
            signal: controller.signal,
            headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {},
        });
        clearTimeout(timeout);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(503).json({ success: false, error: 'Gateway not available' });
    }
});

/**
 * Proxy: DELETE /api/sermon-context -> Gateway
 */
app.delete('/api/sermon-context', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(`${config.urls.gateway}/api/sermon-context`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
                ...forwardCsrfHeader(req),
            },
            body: JSON.stringify(req.body),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(503).json({ success: false, error: 'Gateway not available' });
    }
});

/**
 * Proxy: POST /api/listener-telemetry -> Gateway
 *
 * Listener PWA is served by Control Plane (static from public/), but the
 * telemetry endpoint lives on Gateway (server.js:1477). PWA beacon uses
 * relative URL '/api/listener-telemetry' which resolves to CP origin —
 * forward it to Gateway so records land in eval-*.jsonl with
 * stage='listener_telemetry'. Consumed by the offline evaluation report generator
 * (Drift Analysis section).
 *
 * Beacon is fire-and-forget on the client (navigator.sendBeacon ignores
 * response), so on failure we log + return 503 without retry.
 */
app.post('/api/listener-telemetry', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${config.urls.gateway}/api/listener-telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body || {}),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await response.json().catch(() => ({}));
        res.status(response.status).json(data);
    } catch (error) {
        console.warn('[listener-telemetry] proxy failed:', error && error.message);
        res.status(503).json({ success: false, error: 'Gateway not available' });
    }
});

/** Proxy listener instant-feedback reports to Gateway for persistent JSONL storage. */
app.post('/api/feedback', async (req, res) => {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${config.urls.gateway}/api/feedback`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body || {}), signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await response.json().catch(() => ({}));
        res.status(response.status).json(data);
    } catch (error) {
        console.warn('[feedback] proxy failed:', error && error.message);
        res.status(503).json({ success: false, error: 'Gateway not available' });
    }
});

/**
 * Health endpoint for the control plane itself
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'control-plane',
        uptime: process.uptime()
    });
});

// ============================================================
// Start Server
// ============================================================
const server = app.listen(config.port, () => {
    console.log('');
    console.log('============================================================');
    console.log('  BARNABA Control Plane');
    console.log('============================================================');
    console.log(`  HTTP:    http://localhost:${config.port}`);
    console.log(`  Admin:   http://localhost:${config.port}/admin.html`);
    console.log(`  Health:  http://localhost:${config.port}/health`);
    console.log('------------------------------------------------------------');
    console.log('  Managed Containers:');
    console.log(`    - Whisper: ${config.azure.whisperContainer}`);
    console.log(`    - Gateway: ${config.azure.gatewayContainer}`);
    console.log('============================================================');
    console.log('');
});

// ============================================================
// Graceful Shutdown Handlers
// ============================================================
function gracefulShutdown(signal) {
    console.log(`[ControlPlane] ${signal} received, shutting down gracefully...`);

    server.close(() => {
        console.log('[ControlPlane] HTTP server closed');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[ControlPlane] Forced shutdown after 10s timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
