/* Főoldali nézetváltó: könyvjelzők és parancsok között, oldalbetöltés nélkül. */
(function () {
    const VIEW_STORAGE_KEY = 'cloudmark_active_view';
    const VIEWS = {
        bookmarks: { hash: '#/konyvjelzok', searchId: 'bookmarkSearch' },
        commands: { hash: '#/parancsok', searchId: 'commandSearch' }
    };
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
    }

    /** Called from updateUserUI on page load, login and logout. */
    function onAuthChange(user) {
        signedIn = Boolean(user);
        tabs.hidden = !signedIn;
        const userId = user ? String(user.id ?? user.username) : null;
        if (userId !== lastUserId) window.CloudMark.commands?.reset();
        lastUserId = userId;
        if (!signedIn) {
            if (viewFromHash()) history.replaceState(null, '', window.location.pathname + window.location.search);
            showView('bookmarks', { updateHash: false });
            return;
        }
        showView(viewFromHash() || readSavedView() || 'bookmarks');
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
        if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === '1' || event.key === '2')) {
            event.preventDefault();
            showView(event.key === '1' ? 'bookmarks' : 'commands');
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
        }
    });

    window.CloudMark.views = { showView, onAuthChange, get active() { return activeView; } };

    // Ha a bejelentkezési állapot már ismert (az initApp gyorsabban végzett), igazodunk hozzá.
    if (typeof currentUser !== 'undefined' && currentUser) onAuthChange(currentUser);
})();
