import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

/**
 * `/api/control/config` decides which arm of an A/B the listener is in.
 *
 * The service worker's strategy is network-first with a cache fallback, so before this
 * bypass a single failed fetch handed the PWA the PREVIOUS arm's flags — silently, and
 * indistinguishable from a successful read. On 31.07.2026 a phone did run on a stale
 * config; it was caught only because the flag was read back off the device afterwards.
 *
 * The real `fetch` handler is executed here rather than grepped: the assertion is that the
 * handler RETURNS without calling respondWith for this URL, which a string match cannot
 * establish.
 */
const runFetchHandler = (url, { mode = 'cors', destination = '' } = {}) => {
    let handler = null;
    const respondedWith = [];
    const context = {
        self: {
            addEventListener: (type, fn) => { if (type === 'fetch') handler = fn; },
            clients: { claim() {} },
            skipWaiting() {},
        },
        caches: {
            open: () => Promise.resolve({ put() {}, addAll: () => Promise.resolve() }),
            keys: () => Promise.resolve([]),
            match: () => Promise.resolve(undefined),
            delete: () => Promise.resolve(true),
        },
        fetch: () => Promise.resolve({ status: 200, clone: () => ({}) }),
        Response: { error: () => ({ error: true }) },
        URL,
        console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(context);
    vm.runInContext(swSource, context);
    expect(handler, 'sw.js registered no fetch handler').toBeTypeOf('function');

    handler({
        request: { url, mode, destination },
        respondWith: value => respondedWith.push(value),
        waitUntil: () => {},
    });
    return respondedWith;
};

describe('service worker never serves the listener config from cache', () => {
    it('bypasses /api/control/config entirely', () => {
        expect(runFetchHandler('https://gw.example/api/control/config')).toHaveLength(0);
    });

    it('bypasses it regardless of query string', () => {
        expect(runFetchHandler('https://gw.example/api/control/config?cachebust=1')).toHaveLength(0);
    });

    it('still handles ordinary assets, so the bypass is not a blanket opt-out', () => {
        // Guards the other direction: a bypass written as `url.includes('/api/')` would take
        // the whole API out of the cache, and a bypass of everything would disable offline
        // support that the PWA legitimately relies on.
        expect(runFetchHandler('https://gw.example/icon-192.png')).toHaveLength(1);
    });

    it('does not confuse a path that merely contains the config path', () => {
        // Matching on pathname equality, not substring: a route like /api/control/configs
        // would otherwise be silently uncached too.
        expect(runFetchHandler('https://gw.example/api/control/configs')).toHaveLength(1);
    });
});
