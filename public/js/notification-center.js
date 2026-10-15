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

    const state = { signedIn: false, items: [], unread: 0, settings: null, timer: null };
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
        return { task_reminder: 'fa-regular fa-bell', daily_digest: 'fa-regular fa-sun', test: 'fa-solid fa-vial' }[kind] || 'fa-regular fa-bell';
    }

    function renderBadge() {
        badge.textContent = state.unread > 99 ? '99+' : String(state.unread || '');
        badge.hidden = !state.unread;
        toggle.setAttribute('aria-label', state.unread ? `Értesítések, ${state.unread} olvasatlan` : 'Értesítések');
    }

    function renderList() {
        list.innerHTML = state.items.length ? state.items.map(item => `
            <button type="button" class="bell-item ${item.read_at ? '' : 'is-unread'}" data-notification="${Number(item.id)}">
                <i class="${kindIcon(item.kind)}" aria-hidden="true"></i>
                <span class="bell-item-main">
                    <span class="bell-item-title">${esc(item.title)}</span>
                    ${item.body ? `<span class="bell-item-body">${esc(item.body)}</span>` : ''}
                    <span class="bell-item-time">${esc(timeAgo(item.created_at))}</span>
                </span>
            </button>`).join('') : '<div class="bell-empty">Nincs értesítésed. Az emlékeztetők és a napi összefoglaló itt jelennek meg.</div>';
    }

    function renderSettings() {
        const settings = state.settings;
        if (!settings) { settingsBox.innerHTML = ''; return; }
        const emailNote = !settings.emailConfigured ? 'Az e-mail küldés még nincs beállítva (admin beállítások).'
            : !settings.email ? 'Nincs e-mail címed megadva, ezért csak itt kapsz értesítést.'
            : !settings.emailVerified ? `A(z) ${settings.email} cím nincs megerősítve, ezért oda nem küldünk.`
            : `E-mail cím: ${settings.email}`;
        settingsBox.innerHTML = `
            <div class="bell-settings-title">Értesítési beállítások</div>
            <label class="bell-setting"><input type="checkbox" data-setting="notifyEmail" ${settings.notifyEmail ? 'checked' : ''}> E-mail emlékeztetők</label>
            <label class="bell-setting"><input type="checkbox" data-setting="digestOn" ${settings.dailyDigestTime ? 'checked' : ''}> Napi összefoglaló e-mailben
                <input type="time" data-setting="dailyDigestTime" value="${esc(settings.dailyDigestTime || '07:30')}" ${settings.dailyDigestTime ? '' : 'disabled'} aria-label="Napi összefoglaló időpontja">
            </label>
            <div class="bell-setting-note">${esc(emailNote)}</div>
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
        renderList();
        try {
            state.settings = await notifyApi.getNotificationSettings();
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

    panel.addEventListener('click', async event => {
        const entry = event.target.closest('[data-notification]');
        if (entry) {
            const item = state.items.find(candidate => String(candidate.id) === entry.dataset.notification);
            await markRead([entry.dataset.notification]);
            if (item?.item_id || item?.kind === 'daily_digest') {
                closePanel();
                window.CloudMark.views?.showView('tasks');
                if (item.item_id) window.CloudMark.tasks?.openById?.(item.item_id);
            }
            return;
        }
        const button = event.target.closest('[data-bell]');
        if (!button) return;
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
                notify(`Teszt értesítés elküldve, ${emailText}`, result.email === 'error' ? 'error' : 'success');
                await refresh();
                renderList();
            } catch (err) {
                notify(err.message || 'A teszt nem sikerült.', 'error');
            } finally {
                button.disabled = false;
            }
        }
    });

    settingsBox.addEventListener('change', async event => {
        const input = event.target.closest('[data-setting]');
        if (!input) return;
        const timeInput = settingsBox.querySelector('[data-setting="dailyDigestTime"]');
        try {
            if (input.dataset.setting === 'notifyEmail') {
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

    window.CloudMark.inbox = { onAuthChange, refresh };
})();
