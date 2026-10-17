// Élő frissítés: nyitott kapcsolat a szerverrel (GET /api/events, routes/live.js). Ha egy elem máshol változik
// (másik eszközön vagy annál, akivel megosztottad), a szerver szól, és ez a modul újratölti azt az egy elemet
// a megfelelő nézetben. Megszakadás után újracsatlakozik, és egyszer mindent frissít.
(function () {
    window.CloudMark = window.CloudMark || {};

    const DEBOUNCE_MS = 250;
    const RETRY_MS = 15000;

    let source = null;
    let signedIn = false;
    let userKey = null;
    let connectedOnce = false;
    let retryTimer = null;
    let flushTimer = null;
    const pendingItems = new Set();
    let pendingBookmarks = false;

    const app = () => window.CloudMark;

    function start() {
        stop();
        if (!signedIn || typeof window.EventSource !== 'function') return;
        source = new EventSource(`/api/events?client=${encodeURIComponent(app().clientId || '')}`);
        source.addEventListener('hello', () => {
            // Újracsatlakozáskor (alvó szerver, rossz térerő) a kimaradt változások miatt egyszer mindent frissítünk.
            if (connectedOnce) refreshAll();
            connectedOnce = true;
        });
        source.addEventListener('item', event => queue(() => pendingItems.add(String(readData(event).id))));
        source.addEventListener('bookmark', () => queue(() => { pendingBookmarks = true; }));
        source.addEventListener('notifications', () => app().inbox?.refresh());
        source.addEventListener('refresh', event => {
            const scope = readData(event).scope;
            if (scope === 'bookmarks') queue(() => { pendingBookmarks = true; });
            else refreshAll({ bookmarks: false });
        });
        source.onerror = () => {
            // Hibás válasznál (pl. 401, 502) a böngésző nem próbálkozik tovább magától.
            if (source && source.readyState === EventSource.CLOSED) scheduleRetry();
        };
    }

    function stop() {
        clearTimeout(retryTimer);
        retryTimer = null;
        if (source) { source.close(); source = null; }
    }

    function scheduleRetry() {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (signedIn && document.visibilityState === 'visible') start(); }, RETRY_MS);
    }

    function readData(event) {
        try { return JSON.parse(event.data || '{}'); } catch (err) { return {}; }
    }

    function queue(add) {
        add();
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, DEBOUNCE_MS);
    }

    async function flush() {
        const ids = [...pendingItems];
        pendingItems.clear();
        const bookmarksChanged = pendingBookmarks;
        pendingBookmarks = false;
        await Promise.all(ids.map(refreshItem));
        if (bookmarksChanged) await refreshBookmarks();
    }

    /** Loads one item again and hands it to every view (null: deleted or no longer visible to us). */
    async function refreshItem(id) {
        let item = null;
        try {
            item = await app().api.getItem(id);
        } catch (err) {
            if (err.status !== 404 && err.status !== 403) return;
        }
        app().notes?.applyRemote?.(id, item);
        app().tasks?.applyRemote?.(id, item);
        app().commands?.applyRemote?.(id, item);
    }

    async function refreshBookmarks() {
        if (typeof loadBookmarksFromServer !== 'function') return;
        try {
            await loadBookmarksFromServer();
            if (typeof renderBookmarks === 'function') renderBookmarks();
        } catch (err) { /* a következő változás vagy újracsatlakozás újrapróbálja */ }
    }

    function refreshAll({ bookmarks = true } = {}) {
        app().notes?.refreshAll?.();
        app().tasks?.refreshAll?.();
        app().commands?.refreshAll?.();
        app().inbox?.refresh();
        if (bookmarks) refreshBookmarks();
    }

    function onAuthChange(user) {
        const key = user ? String(user.id ?? user.username) : null;
        signedIn = Boolean(user);
        if (key === userKey && source) return;
        userKey = key;
        connectedOnce = false;
        if (signedIn) start(); else stop();
    }

    // Telefonon a háttérbe tett lap kapcsolata megszakadhat: előtérbe hozva újra felépül.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && signedIn && (!source || source.readyState === EventSource.CLOSED)) start();
    });

    /**
     * Re-renders `root` with `render()` while keeping the focused field and its cursor
     * (fields are matched by their position among the inputs of `root`).
     */
    function keepFocus(root, render) {
        const fieldsOf = () => [...root.querySelectorAll('input, textarea, select')];
        const active = document.activeElement;
        const index = active && root.contains(active) ? fieldsOf().indexOf(active) : -1;
        const start = index >= 0 ? active.selectionStart : null;
        const end = index >= 0 ? active.selectionEnd : null;
        render();
        if (index < 0) return;
        const field = fieldsOf()[index];
        if (!field) return;
        field.focus({ preventScroll: true });
        try {
            if (start !== null && start !== undefined) field.setSelectionRange(Math.min(start, field.value.length), Math.min(end, field.value.length));
        } catch (err) { /* select / checkbox: nincs kurzor */ }
    }

    /**
     * The „közben máshol módosult” bar at the top of an open editor. Nothing is overwritten until the user picks:
     * Frissítés (`onReload`, the saved copy replaces their typing) or Saját változat megtartása (`onKeep`).
     */
    function conflictBar(container, { text, onReload, onKeep }) {
        container.querySelector(':scope > .live-conflict')?.remove();
        const bar = document.createElement('div');
        bar.className = 'live-conflict';
        bar.setAttribute('role', 'alert');
        bar.innerHTML = `<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span class="live-conflict-text"></span>
            <span class="live-conflict-actions">
                <button type="button" class="btn btn-primary" data-live-choice="reload">Frissítés</button>
                <button type="button" class="btn btn-secondary" data-live-choice="keep">Saját változat megtartása</button>
            </span>`;
        bar.querySelector('.live-conflict-text').textContent = text;
        bar.addEventListener('click', event => {
            const button = event.target.closest('[data-live-choice]');
            if (!button) return;
            bar.remove();
            if (button.dataset.liveChoice === 'reload') onReload();
            else onKeep();
        });
        container.prepend(bar);
        return bar;
    }

    function clearConflictBar(container) {
        container?.querySelectorAll('.live-conflict').forEach(bar => bar.remove());
    }

    /** Whether `item` is a newer saved copy than `known` (an echo of our own save has the same updated_at). */
    function isNewer(item, known) {
        if (!known?.updated_at || !item?.updated_at) return true;
        return new Date(item.updated_at).getTime() > new Date(known.updated_at).getTime();
    }

    window.CloudMark.live = { onAuthChange, refreshAll, keepFocus, conflictBar, clearConflictBar, isNewer, get connected() { return Boolean(source && source.readyState === EventSource.OPEN); } };
})();
