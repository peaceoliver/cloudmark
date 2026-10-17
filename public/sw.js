/*
 * CloudMark service worker: telepíthetővé teszi az appot, hálózat nélkül egy „Nincs kapcsolat” oldalt mutat,
 * és megjeleníti a push értesítéseket „Kész” és „Szundi” gombokkal.
 * Adatot nem tárol offline: az /api hívások mindig a szerverre mennek.
 * A saját fájlokat hálózatról tölti (így mindig a legfrissebb verzió fut), és csak hálózati hiba esetén
 * adja a gyorsítótárból. Más címekre (CDN betűkészletek, ikonok) menő kéréseket nem érinti: azokat a böngésző
 * maga tölti, mert a service worker saját CSP-je (connect-src 'self') nem engedné őket.
 */
const VERSION = '2026-10-17-clipper';
const APP_CACHE = `cloudmark-app-${VERSION}`;
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

// Az új verzió azonnal átveszi az irányítást; az oldal egy „Frissítés” gombot mutat az újratöltéshez.
self.addEventListener('install', event => {
    event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('cloudmark-') && name !== APP_CACHE).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
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

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
        event.respondWith(networkFirst(request));
    }
});

/** Tells open CloudMark windows that something changed (they refresh the bell and the task list). */
async function broadcast(message) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(client => client.postMessage(message));
}

self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (err) {
        data = { body: event.data ? event.data.text() : '' };
    }
    const options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        lang: 'hu',
        timestamp: Date.now(),
        data: { type: data.type, itemId: data.itemId || null, notificationId: data.notificationId || null, actionToken: data.actionToken || null }
    };
    if (data.tag) {
        options.tag = data.tag;
        options.renotify = true;
    }
    if (data.type === 'task_reminder' && data.actionToken) {
        options.actions = [{ action: 'done', title: '✓ Kész' }, { action: 'snooze', title: 'Szundi 10 perc' }];
        options.requireInteraction = true;
    }
    // Minden push-nál meg kell jelennie egy értesítésnek (az iPhone ezt meg is követeli).
    event.waitUntil(Promise.all([
        self.registration.showNotification(data.title || 'CloudMark', options),
        broadcast({ type: 'cloudmark:notification' })
    ]));
});

/** Focuses an open CloudMark window and shows the task there, or opens a new window. */
async function openApp(data) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'cloudmark:open', itemId: data.itemId, notificationId: data.notificationId, view: 'tasks' });
        return;
    }
    const params = new URLSearchParams({ source: 'notification' });
    if (data.itemId) params.set('task', data.itemId);
    if (data.notificationId) params.set('notification', data.notificationId);
    await self.clients.openWindow(`/?${params}#/feladatok`);
}

self.addEventListener('notificationclick', event => {
    const data = event.notification.data || {};
    event.notification.close();
    if ((event.action === 'done' || event.action === 'snooze') && data.actionToken) {
        event.waitUntil((async () => {
            try {
                const response = await fetch('/api/notifications/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ token: data.actionToken, action: event.action })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await broadcast({ type: 'cloudmark:task-changed', itemId: data.itemId, action: event.action });
            } catch (err) {
                // Ha a gomb nem működött (pl. nincs hálózat vagy lejárt), megnyitjuk az appot a feladattal.
                await openApp(data);
            }
        })());
        return;
    }
    event.waitUntil(openApp(data));
});
