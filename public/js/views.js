/* Főoldali nézetváltó: jegyzetek, feladatok, könyvjelzők és parancsok között, oldalbetöltés nélkül. */
(function () {
    const VIEW_STORAGE_KEY = 'cloudmark_active_view';
    const VIEWS = {
        bookmarks: { hash: '#/konyvjelzok', searchId: 'bookmarkSearch' },
        commands: { hash: '#/parancsok', searchId: 'commandSearch' },
        notes: { hash: '#/jegyzetek', searchId: 'noteSearch' },
        tasks: { hash: '#/feladatok', searchId: 'taskSearch' }
    };
    // A gyorsbillentyűk a fülek sorrendjét követik.
    const SHORTCUTS = { 1: 'notes', 2: 'tasks', 3: 'bookmarks', 4: 'commands' };
    // Bejelentkezve ez nyílik meg, ha még nincs elmentett nézet (az első fül).
    const DEFAULT_VIEW = 'notes';
    const tabs = document.getElementById('appTabs');
    if (!tabs) return;

    let activeView = 'bookmarks';
    let signedIn = false;
    let lastUserId = null;

    function viewFromHash() {
        return Object.keys(VIEWS).find(name => VIEWS[name].hash === window.location.hash) || null;
    }

    function readSavedView() {
        try { return localStorage.getItem(VIEW_STORAGE_KEY); } catch (err) { return null; }
    }

    function showView(name, { updateHash = true } = {}) {
        if (!VIEWS[name] || (!signedIn && name !== 'bookmarks')) name = 'bookmarks';
        activeView = name;
        document.querySelectorAll('.app-view').forEach(view => { view.hidden = view.dataset.view !== name; });
        tabs.querySelectorAll('[data-view-tab]').forEach(tab => {
            const active = tab.dataset.viewTab === name;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
        });
        if (signedIn) {
            try { localStorage.setItem(VIEW_STORAGE_KEY, name); } catch (err) { /* private mode */ }
        }
        const keepCleanUrl = name === 'bookmarks' && !window.location.hash;
        if (updateHash && signedIn && !keepCleanUrl && window.location.hash !== VIEWS[name].hash) {
            history.replaceState(null, '', VIEWS[name].hash);
        }
        if (name === 'commands') window.CloudMark.commands?.show();
        if (name === 'notes') window.CloudMark.notes?.show();
        if (name === 'tasks') window.CloudMark.tasks?.show();
    }

    /** Called from updateUserUI on page load, login and logout. */
    function onAuthChange(user) {
        signedIn = Boolean(user);
        tabs.hidden = !signedIn;
        const userId = user ? String(user.id ?? user.username) : null;
        if (userId !== lastUserId) {
            window.CloudMark.commands?.reset();
            window.CloudMark.notes?.reset();
            window.CloudMark.tasks?.reset();
        }
        lastUserId = userId;
        window.CloudMark.inbox?.onAuthChange(user);
        if (signedIn) window.CloudMark.tasks?.refreshBadge();
        if (!signedIn) {
            if (viewFromHash()) history.replaceState(null, '', window.location.pathname + window.location.search);
            showView('bookmarks', { updateHash: false });
            return;
        }
        showView(viewFromHash() || readSavedView() || DEFAULT_VIEW);
    }

    tabs.addEventListener('click', event => {
        const tab = event.target.closest('[data-view-tab]');
        if (tab) showView(tab.dataset.viewTab);
    });

    window.addEventListener('hashchange', () => {
        const name = viewFromHash();
        if (name && name !== activeView) showView(name, { updateHash: false });
    });

    function isTyping(target) {
        return target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    }

    document.addEventListener('keydown', event => {
        if (!signedIn) return;
        if (event.altKey && !event.ctrlKey && !event.metaKey && SHORTCUTS[event.key]) {
            event.preventDefault();
            showView(SHORTCUTS[event.key]);
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
        if (document.querySelector('.modal-overlay.active')) return;
        if (event.key === '/') {
            event.preventDefault();
            document.getElementById(VIEWS[activeView].searchId)?.focus();
        } else if ((event.key === 'n' || event.key === 'N') && activeView === 'commands') {
            event.preventDefault();
            window.CloudMark.commands?.openEditor(null);
        } else if ((event.key === 'n' || event.key === 'N') && activeView === 'notes') {
            event.preventDefault();
            window.CloudMark.notes?.openComposer();
        } else if ((event.key === 'n' || event.key === 'N') && activeView === 'tasks') {
            event.preventDefault();
            window.CloudMark.tasks?.focusQuickAdd();
        }
    });

    window.CloudMark.views = { showView, onAuthChange, get active() { return activeView; } };

    // Ha a bejelentkezési állapot már ismert (az initApp gyorsabban végzett), igazodunk hozzá.
    if (typeof currentUser !== 'undefined' && currentUser) onAuthChange(currentUser);
})();
