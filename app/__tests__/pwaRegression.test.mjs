import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const serviceWorkerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function loadServiceWorker({ fetchImpl, caches, Response = globalThis.Response }) {
  const listeners = new Map();
  const self = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };

  // `URL` is a real global in ServiceWorkerGlobalScope and sw.js uses it to match the config
  // route by pathname. Leaving it out of the sandbox made the fetch handler throw before
  // calling respondWith, which reads as "the caching regression came back" — a harness gap
  // reported as a product failure.
  vm.runInNewContext(serviceWorkerSource, { self, caches, fetch: fetchImpl, Response, URL });
  return listeners;
}

describe('PWA regressions', () => {
  it('keeps each inline script syntactically valid', () => {
    const scripts = [...indexSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    for (const [, source] of scripts) {
      expect(() => new vm.Script(source)).not.toThrow();
    }
  });

  it('clones a successful network response before returning it and caches the clone', async () => {
    const cachedCopy = { kind: 'cached-copy' };
    let returned = false;
    const response = {
      status: 200,
      clone: vi.fn(() => {
        if (returned) throw new Error('body already used');
        return cachedCopy;
      }),
    };
    const put = vi.fn(async () => undefined);
    const caches = {
      open: vi.fn(async () => ({ put })),
      match: vi.fn(),
      keys: vi.fn(),
      delete: vi.fn(),
    };
    const listeners = loadServiceWorker({ fetchImpl: vi.fn(async () => response), caches });
    const waitUntilPromises = [];
    const request = { url: 'https://example.test/icon.svg', mode: 'cors', destination: 'image' };
    let responsePromise;

    listeners.get('fetch')({
      request,
      respondWith: promise => { responsePromise = promise; },
      waitUntil: promise => waitUntilPromises.push(promise),
    });

    const networkResponse = await responsePromise;
    returned = true;
    await Promise.all(waitUntilPromises);

    expect(networkResponse).toBe(response);
    expect(response.clone).toHaveBeenCalledOnce();
    expect(caches.open).toHaveBeenCalledWith('barnabas-v9');
    expect(put).toHaveBeenCalledWith(request, cachedCopy);
  });

  it('returns an error response instead of undefined when both network and cache miss', async () => {
    const errorResponse = { type: 'error' };
    const caches = {
      open: vi.fn(),
      match: vi.fn(async () => undefined),
      keys: vi.fn(),
      delete: vi.fn(),
    };
    const Response = { error: vi.fn(() => errorResponse) };
    const listeners = loadServiceWorker({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }), caches, Response });
    const request = { url: 'https://example.test/icon.svg', mode: 'cors', destination: 'image' };
    let responsePromise;

    listeners.get('fetch')({
      request,
      respondWith: promise => { responsePromise = promise; },
      waitUntil: vi.fn(),
    });

    await expect(responsePromise).resolves.toBe(errorResponse);
    expect(Response.error).toHaveBeenCalledOnce();
  });

  it('looks up and guards the offline overlay lazily because markup follows the script', () => {
    expect(indexSource).toContain('<div class="offline-overlay" id="offlineOverlay">');
    expect(indexSource).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(indexSource).not.toContain("const offlineOverlay = $('offlineOverlay');\n\n        function showOfflineOverlay");
    expect(indexSource).toMatch(/function showOfflineOverlay\(\) \{\s+const offlineOverlay = \$\('offlineOverlay'\);\s+if \(!offlineOverlay\) return;\s+offlineOverlay\.classList\.add\('visible'\);/);
    expect(indexSource).toMatch(/function hideOfflineOverlay\(\) \{\s+const offlineOverlay = \$\('offlineOverlay'\);\s+if \(!offlineOverlay\) return;\s+offlineOverlay\.classList\.remove\('visible'\);/);
  });

  it('stops phone keep-alive audio when the active church goes offline', () => {
    expect(indexSource).toContain('function stopLocalTranslationPlayback()');
    expect(indexSource).toMatch(/function stopLocalTranslationPlayback\(\) \{\s+resetLanguagePlayback\(\);\s+stopSilentKeepAlive\(\);\s+releaseWakeLock\(\);\s+stopTelemetryBeacon\(\);\s+stopViz\(\);/);
    expect(indexSource).toMatch(/function removeChurch\(id\) \{[\s\S]*?if \(churchId === id\) \{[\s\S]*?stopLocalTranslationPlayback\(\);[\s\S]*?goToScreen\(3\);/);
  });
});
