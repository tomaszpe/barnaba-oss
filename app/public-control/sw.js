// Barnabas Service Worker — network-first for all assets, HTML bypassed entirely
const CACHE_NAME = 'barnabas-v9';

// Install — precache static assets only (not HTML)
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // Two tiers on purpose. cache.addAll() is ATOMIC: one 404 rejects the whole
            // promise and the service worker never installs. The DEV badge icons are not
            // present in every build, so precaching them atomically made a missing optional
            // asset break the entire PWA install.
            const required = ['/manifest.json', '/icon.svg', '/icon-maskable.svg'];
            const optional = ['/icon-dev.svg', '/icon-maskable-dev.svg'];
            return cache.addAll(required).then(() => Promise.all(
                optional.map(url => cache.add(url).catch(() => { /* not in this build */ }))
            ));
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
        })
    );
    self.clients.claim();
});

// Fetch — HTML bypassed (server no-cache headers handle freshness), assets network-first
self.addEventListener('fetch', event => {
    if (event.request.url.includes('/ws')) return;
    if (event.request.mode === 'navigate' || event.request.destination === 'document') return;

    event.respondWith(
        fetch(event.request).then(response => {
            if (response.status === 200) {
                const copy = response.clone();
                event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
            }
            return response;
        }).catch(() => caches.match(event.request).then(cached => cached || Response.error()))
    );
});
