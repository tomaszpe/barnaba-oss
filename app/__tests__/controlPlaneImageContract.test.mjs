import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 30.07.2026: the control-plane image crashed on boot with
// ERR_MODULE_NOT_FOUND /app/clientFeatureConfig.js — the Dockerfile copies files
// one by one and the new shared module was never added. The gateway image does
// `COPY . .`, so it never showed the problem. This test walks the real import
// graph from control-plane.js and fails when a reachable module is not copied.

const appDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dockerfile = readFileSync(path.join(appDir, 'Dockerfile.control-plane'), 'utf8');
const startup = readFileSync(path.join(appDir, 'startup.sh'), 'utf8');

// .mjs counts too: a check that followed only .js imports passed while the image
// was missing feedbackRoutes.mjs, which control-plane.js imports at boot.
const copiedFiles = new Set(
    [...dockerfile.matchAll(/^COPY\s+([^\s]+)\s/gm)]
        .map(match => match[1])
        .filter(entry => /\.m?js$/.test(entry)),
);

const localImportsOf = (file) => {
    const source = readFileSync(path.join(appDir, file), 'utf8');
    return [...source.matchAll(/from\s+'\.\/([a-zA-Z0-9_.-]+\.m?js)'/g)].map(match => match[1]);
};

const reachableModules = () => {
    const seen = new Set();
    const queue = ['control-plane.js'];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const dependency of localImportsOf(current)) {
            if (seen.has(dependency)) continue;
            seen.add(dependency);
            queue.push(dependency);
        }
    }
    return [...seen];
};

describe('control-plane image contract', () => {
    it('copies every local module reachable from control-plane.js', () => {
        const missing = reachableModules().filter(module => !copiedFiles.has(module));
        expect(missing).toEqual([]);
    });

    it('still ships the listener PWA and the entrypoint', () => {
        expect(dockerfile).toMatch(/^COPY\s+public\/\s/m);
        expect(dockerfile).toMatch(/^COPY\s+control-plane\.js\s/m);
        expect(dockerfile).toMatch(/^COPY\s+startup\.sh\s/m);
    });

    it('overlays the control-plane pages after the shared public files', () => {
        const shared = dockerfile.search(/^COPY\s+public\/\s+\.\/public\/$/m);
        const overlay = dockerfile.search(/^COPY\s+public-control\/\s+\.\/public\/$/m);
        expect(shared).toBeGreaterThanOrEqual(0);
        expect(overlay).toBeGreaterThan(shared);
    });

    it('normalizes a Windows checkout before executing the Linux entrypoint', () => {
        expect(dockerfile).toContain("sed -i 's/\\r$//' startup.sh");
        expect(dockerfile).toContain('chmod +x startup.sh');
    });

    it('runs the control plane as the unprivileged base-image user', () => {
        expect(dockerfile).toContain('chown -R node:node /app');
        expect(dockerfile).toMatch(/^USER node$/m);
    });

    it('fails closed unless Azure identity can read the managed app', () => {
        expect(startup).toContain('verify_azure_resource_access || exit 1');
        expect(startup).toContain('az account set --subscription "$AZURE_SUBSCRIPTION_ID"');
        expect(startup).toContain('az rest --method GET --url "$RESOURCE_URL" --output none');
        expect(startup).toContain('Azure identity cannot read the managed Container App');
    });
});
