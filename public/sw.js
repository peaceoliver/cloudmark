/*
 * CloudMark service worker: telepíthetővé teszi az appot, és hálózat nélkül egy „Nincs kapcsolat” oldalt mutat.
 * Adatot nem tárol offline: az /api hívások mindig a szerverre mennek.
 * A saját fájlokat hálózatról tölti (így mindig a legfrissebb verzió fut), és csak hálózati hiba esetén
 * adja a gyorsítótárból. A CDN-es betűkészletek verziózott címűek, ezeket a gyorsítótárból adja.
 */
const VERSION = '2026-10-16-pwa';
const APP_CACHE = `cloudmark-app-${VERSION}`;
const CDN_CACHE = 'cloudmark-cdn-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
    OFFLINE_URL,
    '/js/offline.js',
    '/manifest.webmanifest',
    '/icons/icon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/badge-96.png'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = new Set([APP_CACHE, CDN_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('cloudmark-') && !keep.has(name)).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

/** The page asks a waiting new version to take over when the user taps „Frissítés”. */
self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function stripSearch(href) {
    const url = new URL(href);
    return url.origin + url.pathname;
}

async function networkFirst(request) {
    const cache = await caches.open(APP_CACHE);
    try {
        const response = await fetch(request);
        // Egy fájlból egy példányt tárol: a ?v=… verziójelölő nélküli címen.
        if (response.ok && response.type === 'basic') cache.put(stripSearch(request.url), response.clone());
        return response;
    } catch (err) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return cache.match(OFFLINE_URL);
        throw err;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CDN_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
        event.respondWith(networkFirst(request));
    } else if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request));
    }
});
