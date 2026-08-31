import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Control Plane: required environment variables must fail the process at startup.
 *
 * Why a child process and not an import (26.08.2026)
 * --------------------------------------------------
 * `control-plane.js` resolves these vars while building its `config` literal and
 * calls `process.exit(1)` when one is missing. That path cannot be exercised by
 * importing the module: the exit would take the test runner down with it, and the
 * existing control-plane tests all read the file as TEXT via readFileSync, which
 * proves what the source says, not what the process does.
 *
 * The hardcoded fallbacks these assertions replace
 * ------------------------------------------------
 * `GATEWAY_URL` and `WHISPER_SERVICE_URL` used to default to deployment-specific
 * URLs. That did two bad things: it pinned one hosting setup into the source, and
 * it turned a missing variable into a silent misroute instead of a startup error.
 * Both are listed as required in infra/verify-env-parity.mjs, so the fallback was
 * never protecting a supported configuration.
 */

const CONTROL_PLANE = path.resolve(fileURLToPath(new URL('../control-plane.js', import.meta.url)));

// Enough to get past every other required check, so each case isolates one variable.
const COMPLETE_ENV = {
    BROADCASTER_PASSWORD: 'test-password',
    WHISPER_SERVICE_URL: 'http://whisper.test:8000',
    GATEWAY_URL: 'http://gateway.test:8080',
    CONTROL_PLANE_PORT: '0',
};

function startControlPlane(env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CONTROL_PLANE], {
            env: { ...process.env, ...COMPLETE_ENV, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.stdout.on('data', (d) => { stdout += d.toString(); });

        // A process that does not exit within the window tells us only that startup
        // did not fail fast. It is NOT evidence that the HTTP server is accepting
        // connections - readiness belongs to the live Azure smoke test, not here.
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ code: null, stderr, stdout, survived: true });
        }, 8000);

        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, stderr, stdout, survived: false });
        });
    });
}

describe('Control Plane required environment variables', () => {
    const cases = [
        ['BROADCASTER_PASSWORD', 'BROADCASTER_PASSWORD environment variable required'],
        ['WHISPER_SERVICE_URL', 'WHISPER_SERVICE_URL environment variable required'],
        ['GATEWAY_URL', 'GATEWAY_URL environment variable required'],
    ];

    for (const [name, message] of cases) {
        it(`exits 1 with a named error when ${name} is missing`, async () => {
            const { code, stderr, survived } = await startControlPlane({ [name]: undefined });

            expect(survived, `control-plane kept running without ${name}`).toBe(false);
            expect(code, `expected exit 1 without ${name}, stderr was: ${stderr}`).toBe(1);
            // The message must name the variable. "Configuration error" would send the
            // operator reading source instead of reading the log.
            expect(stderr).toContain(message);
        }, 15000);
    }

    it('does not exit when every required variable is present', async () => {
        const { survived, code, stderr } = await startControlPlane({});

        // Asserts only "did not fail fast". Readiness is a live Azure concern.
        expect(survived, `control-plane exited (code ${code}) with a complete env; stderr: ${stderr}`).toBe(true);
    }, 15000);

    it('reports only the first missing variable, so the log names one cause', async () => {
        const { code, stderr } = await startControlPlane({
            WHISPER_SERVICE_URL: undefined,
            GATEWAY_URL: undefined,
        });

        expect(code).toBe(1);
        expect(stderr).toContain('WHISPER_SERVICE_URL environment variable required');
        expect(stderr).not.toContain('GATEWAY_URL environment variable required');
    }, 15000);
});
