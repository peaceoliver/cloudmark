/* Csengő a fejlécben: értesítések listája, olvasottnak jelölés és értesítési beállítások. */
(function () {
    const notifyApi = window.CloudMark.api;
    const wrapper = document.getElementById('bellWrapper');
    if (!wrapper) return;
    const toggle = document.getElementById('bellToggle');
    const panel = document.getElementById('bellPanel');
    const list = document.getElementById('bellList');
    const badge = document.getElementById('bellBadge');
    const settingsBox = document.getElementById('bellSettings');
    const POLL_MS = 60000;

    const state = { signedIn: false, items: [], unread: 0, settings: null, timer: null, push: null };
    const relative = new Intl.RelativeTimeFormat('hu', { numeric: 'auto' });

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    function timeAgo(value) {
        const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
        const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [Infinity, 'week']];
        const divisors = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
        const [, unit] = steps.find(([limit]) => Math.abs(seconds) < limit);
        return relative.format(Math.round(seconds / divisors[unit]), unit);
    }

    function kindIcon(kind) {
        return { task_reminder: 'fa-regular fa-bell', daily_digest: 'fa-regular fa-sun', test: 'fa-solid fa-vial', share_invite: 'fa-solid fa-user-group', share_info: 'fa-solid fa-user-group' }[kind] || 'fa-regular fa-bell';
    }

    function renderBadge() {
        badge.textContent = state.unread > 99 ? '99+' : String(state.unread || '');
        badge.hidden = !state.unread;
        toggle.setAttribute('aria-label', state.unread ? `Értesítések, ${state.unread} olvasatlan` : 'Értesítések');
    }

    /** A share invitation that still waits for the user's answer. */
    function isOpenInvite(item) {
        return item.kind === 'share_invite' && item.share_incoming && item.share_status === 'pending';
    }

    function renderList() {
        list.innerHTML = state.items.length ? state.items.map(item => {
            const main = `
                <i class="${kindIcon(item.kind)}" aria-hidden="true"></i>
                <span class="bell-item-main">
                    <span class="bell-item-title">${esc(item.title)}</span>
                    ${item.body ? `<span class="bell-item-body">${esc(item.body)}</span>` : ''}
                    <span class="bell-item-time">${esc(timeAgo(item.created_at))}</span>
                </span>`;
            if (!isOpenInvite(item)) {
                return `<button type="button" class="bell-item ${item.read_at ? '' : 'is-unread'}" data-notification="${Number(item.id)}">${main}</button>`;
            }
            // Meghívó: gombok a sorban (gomb a gombban nem lehet, ezért itt div a sor).
            return `
                <div class="bell-item bell-invite ${item.read_at ? '' : 'is-unread'}">
                    ${main}
                    <span class="bell-invite-actions">
                        <button type="button" class="btn btn-primary" data-share-accept="${Number(item.share_id)}" data-notification-id="${Number(item.id)}"><i class="fa-solid fa-check"></i> Elfogadom</button>
                        <button type="button" class="btn btn-secondary" data-share-decline="${Number(item.share_id)}" data-notification-id="${Number(item.id)}">Elutasítom</button>
                    </span>
                </div>`;
        }).join('') : '<div class="bell-empty">Nincs értesítésed. Az emlékeztetők, a napi összefoglaló és a megosztások itt jelennek meg.</div>';
    }

    const SHARE_VIEWS = { note: 'notes', task: 'tasks', command: 'commands' };

    /** Shows a shared item in its own view (after accepting, or when its notification is clicked). */
    async function openSharedItem(type, id, item = null) {
        const view = SHARE_VIEWS[type];
        if (!view || !id) return;
        closePanel();
        const cloudMark = window.CloudMark;
        cloudMark.views?.showView(view);
        if (type === 'note') {
            if (item) cloudMark.notes?.remember?.(item);
            await cloudMark.notes?.openById?.(id);
        } else if (type === 'task') {
            await cloudMark.tasks?.reload?.();
            await cloudMark.tasks?.openById?.(id);
        } else {
            await cloudMark.commands?.openById?.(id);
        }
    }

    async function answerInvite(button, accept) {
        const shareId = accept ? button.dataset.shareAccept : button.dataset.shareDecline;
        const entry = state.items.find(candidate => String(candidate.id) === button.dataset.notificationId);
        button.closest('.bell-invite')?.querySelectorAll('button').forEach(other => { other.disabled = true; });
        try {
            if (accept) {
                const result = await notifyApi.acceptShare(shareId);
                if (entry) entry.share_status = 'accepted';
                notify('Elfogadva, megjelent a listádban.', 'success');
                await refresh();
                if (result.item) await openSharedItem(result.item.type, result.item.id, result.item);
            } else {
                await notifyApi.declineShare(shareId);
                if (entry) entry.share_status = 'declined';
                notify('Elutasítva.', 'success');
                await refresh();
            }
        } catch (err) {
            notify(err.message || 'Nem sikerült.', 'error');
            await refresh();
        }
    }

    /** What this browser can do with push: 'ok', 'unsupported', 'ios-install' (iPhone outside the installed app) or 'denied'. */
    function pushSupport() {
        const pwa = window.CloudMark.pwa;
        if (pwa?.isIos() && !pwa.isStandalone()) return 'ios-install';
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        return 'ok';
    }

    async function currentSubscription() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
        const registration = await navigator.serviceWorker.getRegistration();
        return registration ? registration.pushManager.getSubscription() : null;
    }

    /** Loads the server's push key, this user's devices and this browser's subscription. */
    async function loadPushState() {
        try {
            const [config, devices, subscription] = await Promise.all([
                notifyApi.getPushConfig(), notifyApi.getPushSubscriptions(), currentSubscription().catch(() => null)
            ]);
            const endpoint = subscription?.endpoint || null;
            state.push = { config, devices, endpoint, here: Boolean(endpoint && devices.some(device => device.endpoint === endpoint)) };
        } catch (err) {
            state.push = null;
        }
    }

    function base64UrlToBytes(value) {
        const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    }

    /** Turns notifications on for this device. Must start inside the click, so the permission prompt is allowed. */
    async function enablePushHere() {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error(permission === 'denied'
            ? 'Az értesítések le vannak tiltva ebben a böngészőben. A böngésző vagy a telefon beállításaiban engedélyezheted.'
            : 'Az értesítések engedélyezése elmaradt.');
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(state.push.config.publicKey)
            });
        }
        await notifyApi.savePushSubscription(subscription.toJSON());
    }

    async function disablePushHere() {
        const subscription = await currentSubscription();
        const device = state.push?.devices.find(entry => entry.endpoint === subscription?.endpoint);
        if (device) await notifyApi.deletePushSubscription(device.id);
        if (subscription) await subscription.unsubscribe().catch(() => {});
    }

    function renderPushSettings() {
        const push = state.push;
        if (!push) return '';
        if (!push.config.configured) {
            return '<div class="bell-settings-title">Telefonos értesítések</div><div class="bell-setting-note">A push értesítés még nincs beállítva a szerveren.</div>';
        }
        const support = pushSupport();
        const note = {
            'ios-install': 'iPhone-on előbb telepítsd a CloudMarkot (Safari → Megosztás → Hozzáadás a Főképernyőhöz), és onnan megnyitva kapcsold be.',
            unsupported: 'Ez a böngésző nem tud push értesítést fogadni.',
            denied: 'Az értesítések le vannak tiltva ebben a böngészőben. A böngésző vagy a telefon beállításaiban engedélyezheted.'
        }[support];
        const others = push.devices.filter(device => device.endpoint !== push.endpoint);
        return `
            <div class="bell-settings-title">Telefonos értesítések</div>
            <label class="bell-setting"><input type="checkbox" data-setting="pushHere" ${push.here ? 'checked' : ''} ${support === 'ok' ? '' : 'disabled'}> Értesítések ezen az eszközön</label>
            ${note ? `<div class="bell-setting-note">${esc(note)}</div>` : ''}
            ${others.length ? `<div class="bell-devices">${others.map(device => `
                <div class="bell-device">
                    <i class="fa-solid ${/iPhone|iPad|Android/.test(device.device_label || '') ? 'fa-mobile-screen' : 'fa-desktop'}" aria-hidden="true"></i>
                    <span>${esc(device.device_label || 'Eszköz')}${device.last_error ? ' <em>· hiba</em>' : ''}</span>
                    <button type="button" class="note-action" data-bell="remove-device" data-device="${Number(device.id)}" title="Eszköz eltávolítása" aria-label="Eszköz eltávolítása"><i class="fa-solid fa-xmark"></i></button>
                </div>`).join('')}</div>` : ''}`;
    }

    function renderSettings() {
        const settings = state.settings;
        if (!settings) { settingsBox.innerHTML = ''; return; }
        const [quietStart, quietEnd] = (settings.quietHours || '22:00-07:00').split('-');
        const emailNote = !settings.emailConfigured ? 'Az e-mail küldés még nincs beállítva (admin beállítások).'
            : !settings.email ? 'Nincs e-mail címed megadva, ezért csak itt kapsz értesítést.'
            : !settings.emailVerified ? `A(z) ${settings.email} cím nincs megerősítve, ezért oda nem küldünk.`
            : `E-mail cím: ${settings.email}`;
        settingsBox.innerHTML = `
            <label class="bell-setting"><input type="checkbox" data-setting="notifyEmail" ${settings.notifyEmail ? 'checked' : ''}> E-mail emlékeztetők</label>
            <label class="bell-setting"><input type="checkbox" data-setting="digestOn" ${settings.dailyDigestTime ? 'checked' : ''}> Napi összefoglaló e-mailben
                <input type="time" data-setting="dailyDigestTime" value="${esc(settings.dailyDigestTime || '07:30')}" ${settings.dailyDigestTime ? '' : 'disabled'} aria-label="Napi összefoglaló időpontja">
            </label>
            <div class="bell-setting-note">${esc(emailNote)}</div>
            ${renderPushSettings()}
            <label class="bell-setting"><input type="checkbox" data-setting="quietOn" ${settings.quietHours ? 'checked' : ''}> Csendes időszak
                <span class="bell-quiet-times">
                    <input type="time" data-setting="quietStart" value="${esc(quietStart)}" ${settings.quietHours ? '' : 'disabled'} aria-label="Csendes időszak kezdete">–<input type="time" data-setting="quietEnd" value="${esc(quietEnd)}" ${settings.quietHours ? '' : 'disabled'} aria-label="Csendes időszak vége">
                </span>
            </label>
            <div class="bell-setting-note">A csendes időszakban a telefon nem kap értesítést, csak a csengő és az e-mail.</div>
            <button type="button" class="btn btn-secondary bell-test" data-bell="test"><i class="fa-solid fa-paper-plane"></i> Teszt értesítés</button>`;
    }

    async function refresh() {
        if (!state.signedIn) return;
        try {
            const result = await notifyApi.getNotifications();
            state.items = result.items;
            state.unread = result.unread;
            renderBadge();
            if (!panel.hidden) renderList();
        } catch (err) { /* offline vagy kijelentkezett: a következő kör újrapróbálja */ }
    }

    function startPolling() {
        clearInterval(state.timer);
        state.timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    }

    async function openPanel() {
        panel.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        renderList();
        await refresh();
    }

    /** Loads the notification settings into the Settings window (Általános fül). */
    async function loadSettings() {
        try {
            const [settings] = await Promise.all([notifyApi.getNotificationSettings(), loadPushState()]);
            state.settings = settings;
            renderSettings();
        } catch (err) { settingsBox.innerHTML = ''; }
    }

    function closePanel() {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
    }

    async function markRead(ids) {
        const unread = ids.filter(id => state.items.some(item => String(item.id) === String(id) && !item.read_at));
        if (!unread.length) return;
        state.items.forEach(item => { if (unread.includes(String(item.id))) item.read_at = new Date().toISOString(); });
        state.unread = Math.max(0, state.unread - unread.length);
        renderBadge();
        renderList();
        try { await notifyApi.markNotificationsRead({ ids: unread.map(Number) }); } catch (err) { refresh(); }
    }

    toggle.addEventListener('click', event => {
        event.stopPropagation();
        if (panel.hidden) openPanel(); else closePanel();
    });

    document.addEventListener('click', event => {
        if (!panel.hidden && !wrapper.contains(event.target)) closePanel();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) { closePanel(); toggle.focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

    async function onBellClick(event) {
        const accept = event.target.closest('[data-share-accept]');
        if (accept) { answerInvite(accept, true); return; }
        const decline = event.target.closest('[data-share-decline]');
        if (decline) { answerInvite(decline, false); return; }
        const entry = event.target.closest('[data-notification]');
        if (entry) {
            const item = state.items.find(candidate => String(candidate.id) === entry.dataset.notification);
            await markRead([entry.dataset.notification]);
            if (item?.share_id) {
                if (item.share_status === 'accepted') await openSharedItem(item.share_item_type, item.share_item_id);
                return;
            }
            if (item?.item_id || item?.kind === 'daily_digest') {
                closePanel();
                window.CloudMark.views?.showView('tasks');
                if (item.item_id) window.CloudMark.tasks?.openById?.(item.item_id);
            }
            return;
        }
        const button = event.target.closest('[data-bell]');
        if (!button) return;
        if (button.dataset.bell === 'open-settings') {
            closePanel();
            if (typeof openUserSettings === 'function') openUserSettings('general');
            return;
        }
        if (button.dataset.bell === 'remove-device') {
            button.disabled = true;
            try {
                await notifyApi.deletePushSubscription(button.dataset.device);
                await loadPushState();
                renderSettings();
                notify('Az eszköz többé nem kap értesítést.', 'success');
            } catch (err) {
                button.disabled = false;
                notify(err.message || 'Az eltávolítás nem sikerült.', 'error');
            }
            return;
        }
        if (button.dataset.bell === 'read-all') {
            state.items.forEach(item => { item.read_at = item.read_at || new Date().toISOString(); });
            state.unread = 0;
            renderBadge();
            renderList();
            try { await notifyApi.markNotificationsRead({ all: true }); } catch (err) { refresh(); }
        }
        if (button.dataset.bell === 'test') {
            button.disabled = true;
            try {
                const result = await notifyApi.sendTestNotification();
                const emailText = {
                    sent: 'és e-mail is ment.',
                    not_configured: 'e-mail nélkül (a küldés nincs beállítva).',
                    no_address: 'e-mail nélkül (nincs e-mail címed).',
                    not_verified: 'e-mail nélkül (az e-mail címed nincs megerősítve).',
                    disabled: 'e-mail nélkül (az e-mail emlékeztetők ki vannak kapcsolva).',
                    error: `de az e-mail küldése nem sikerült: ${result.error || ''}`
                }[result.email] || '';
                const pushText = result.push === 'sent' ? ` A telefonos értesítés ${result.pushDevices} eszközre ment ki.`
                    : result.push === 'error' ? ' A telefonos értesítés küldése nem sikerült.' : '';
                notify(`Teszt értesítés elküldve, ${emailText}${pushText}`, result.email === 'error' || result.push === 'error' ? 'error' : 'success');
                await refresh();
                renderList();
            } catch (err) {
                notify(err.message || 'A teszt nem sikerült.', 'error');
            } finally {
                button.disabled = false;
            }
        }
    }
    panel.addEventListener('click', onBellClick);
    settingsBox.addEventListener('click', onBellClick);

    settingsBox.addEventListener('change', async event => {
        const input = event.target.closest('[data-setting]');
        if (!input) return;
        const timeInput = settingsBox.querySelector('[data-setting="dailyDigestTime"]');
        if (input.dataset.setting === 'pushHere') {
            input.disabled = true;
            try {
                if (input.checked) await enablePushHere(); else await disablePushHere();
                await loadPushState();
                renderSettings();
                notify(input.checked ? 'Ez az eszköz mostantól értesítést kap.' : 'Ez az eszköz nem kap több értesítést.', 'success');
            } catch (err) {
                input.checked = !input.checked;
                input.disabled = false;
                notify(err.message || 'Nem sikerült.', 'error');
            }
            return;
        }
        const quietInputs = ['quietOn', 'quietStart', 'quietEnd'].map(name => settingsBox.querySelector(`[data-setting="${name}"]`));
        try {
            if (['quietOn', 'quietStart', 'quietEnd'].includes(input.dataset.setting)) {
                const [toggleInput, startInput, endInput] = quietInputs;
                startInput.disabled = endInput.disabled = !toggleInput.checked;
                if (toggleInput.checked && (!startInput.value || !endInput.value)) return;
                await notifyApi.saveUserSetting('quietHours', toggleInput.checked ? `${startInput.value}-${endInput.value}` : 'off');
            } else if (input.dataset.setting === 'notifyEmail') {
                await notifyApi.saveUserSetting('notifyEmail', input.checked ? 'true' : 'false');
            } else if (input.dataset.setting === 'digestOn') {
                timeInput.disabled = !input.checked;
                await notifyApi.saveUserSetting('dailyDigestTime', input.checked ? (timeInput.value || '07:30') : 'off');
            } else if (input.dataset.setting === 'dailyDigestTime' && input.value) {
                await notifyApi.saveUserSetting('dailyDigestTime', input.value);
            }
            notify('Értesítési beállítás mentve.', 'success');
        } catch (err) {
            notify(err.message || 'A mentés nem sikerült.', 'error');
        }
    });

    /** Called from the view switcher on page load, login and logout. */
    function onAuthChange(user) {
        state.signedIn = Boolean(user);
        wrapper.hidden = !state.signedIn;
        closePanel();
        state.items = [];
        state.unread = 0;
        state.settings = null;
        renderBadge();
        if (state.signedIn) { refresh(); startPolling(); }
        else clearInterval(state.timer);
    }

    window.CloudMark.inbox = { onAuthChange, refresh, loadSettings, openPanel };
})();
