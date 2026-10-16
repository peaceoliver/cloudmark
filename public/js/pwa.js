/*
 * Telepíthető app (PWA): service worker regisztráció, „Telepítés” gomb, iPhone-os útmutató,
 * új verzió jelzése és offline sáv.
 */
(function () {
    const installButton = document.getElementById('installAppBtn');
    const installActions = document.getElementById('installAppActions');
    const installSection = document.getElementById('installAppSection');
    const installHint = document.getElementById('installAppHint');
    const offlineBar = document.getElementById('offlineBar');
    let deferredPrompt = null;

    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function notify(message, type = 'info', duration) {
        if (typeof showNotification === 'function') showNotification(message, type, duration);
    }

    /** Shows the menu's install entry only where installing is possible and not done yet. */
    function renderInstall() {
        if (!installSection) return;
        const canPrompt = Boolean(deferredPrompt);
        const iosManual = isIos() && !isStandalone();
        installSection.hidden = isStandalone() || (!canPrompt && !iosManual);
        if (installHint) installHint.hidden = !iosManual || canPrompt;
        if (installActions) installActions.hidden = !canPrompt;
    }

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPrompt = event;
        renderInstall();
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        renderInstall();
        notify('A CloudMark telepítve. Mostantól a kezdőképernyőről is megnyithatod.', 'success');
    });

    installButton?.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        const prompt = deferredPrompt;
        deferredPrompt = null;
        prompt.prompt();
        try { await prompt.userChoice; } catch (err) { /* dismissed */ }
        renderInstall();
    });

    function renderOnline() {
        if (offlineBar) offlineBar.hidden = navigator.onLine;
    }
    window.addEventListener('online', renderOnline);
    window.addEventListener('offline', renderOnline);

    /** Offers a reload when a new app version is installed and waiting. */
    function offerUpdate(worker) {
        const container = document.getElementById('notificationArea');
        if (!container || container.querySelector('.pwa-update')) return;
        const toast = document.createElement('div');
        toast.className = 'notification notification-info pwa-update';
        toast.setAttribute('role', 'status');
        toast.innerHTML = '<span>Új CloudMark verzió érhető el.</span>'
            + '<button type="button" class="btn btn-primary btn-sm" data-pwa-reload>Frissítés</button>'
            + '<button type="button" class="notification-close" aria-label="Később">&times;</button>';
        toast.querySelector('[data-pwa-reload]').addEventListener('click', () => worker.postMessage({ type: 'SKIP_WAITING' }));
        toast.querySelector('.notification-close').addEventListener('click', () => toast.remove());
        container.appendChild(toast);
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const hadController = Boolean(navigator.serviceWorker.controller);
            const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
            if (registration.waiting && hadController) offerUpdate(registration.waiting);
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
                });
            });
            let reloading = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (!hadController || reloading) return;
                reloading = true;
                window.location.reload();
            });
            // A sokáig nyitva hagyott app is észrevegye az új verziót.
            setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
        } catch (err) {
            console.warn('Service worker regisztráció sikertelen:', err);
        }
    }

    /** Keeps the phone's status bar colour in step with the light/dark theme. */
    function syncThemeColor() {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = document.documentElement.getAttribute('data-theme') === 'light' ? '#ffffff' : '#0b0f19';
    }
    new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    /** Shows a task that a notification pointed at, and marks that notification read. */
    async function openFromNotification(itemId, notificationId) {
        const cloudMark = window.CloudMark;
        if (notificationId) cloudMark.api?.markNotificationsRead({ ids: [Number(notificationId)] }).catch(() => {});
        cloudMark.views?.showView('tasks');
        if (itemId) await cloudMark.tasks?.openById?.(Number(itemId));
        cloudMark.inbox?.refresh();
    }

    // Üzenetek a service workertől: új értesítés jött, egy gomb megváltoztatott egy feladatot, vagy meg kell nyitni egyet.
    navigator.serviceWorker?.addEventListener('message', event => {
        const message = event.data || {};
        if (message.type === 'cloudmark:notification') window.CloudMark.inbox?.refresh();
        if (message.type === 'cloudmark:task-changed') {
            window.CloudMark.inbox?.refresh();
            window.CloudMark.tasks?.refreshBadge();
            if (window.CloudMark.views?.active === 'tasks') window.CloudMark.tasks?.show();
        }
        if (message.type === 'cloudmark:open') openFromNotification(message.itemId, message.notificationId);
    });

    /** A notification opened a new window as /?task=…&notification=…: open that task once signed in. */
    function handleLaunchParams() {
        const params = new URLSearchParams(window.location.search);
        const itemId = params.get('task');
        const notificationId = params.get('notification');
        if (!itemId && !notificationId) return;
        const clean = () => history.replaceState(null, '', window.location.pathname + window.location.hash);
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            const signedIn = !document.getElementById('bellWrapper')?.hidden;
            if (signedIn) {
                clearInterval(timer);
                clean();
                openFromNotification(itemId, notificationId);
            } else if (tries > 40) {
                clearInterval(timer);
                clean();
            }
        }, 250);
    }

    syncThemeColor();
    handleLaunchParams();
    renderInstall();
    renderOnline();
    if (document.readyState === 'complete') registerServiceWorker();
    else window.addEventListener('load', registerServiceWorker);

    window.CloudMark = window.CloudMark || {};
    window.CloudMark.pwa = { isStandalone, isIos };
})();
