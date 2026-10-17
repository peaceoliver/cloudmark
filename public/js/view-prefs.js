/*
 * Nézetenkénti megjelenítési beállítások (rendezés, nézet) a Kódtár, Jegyzetek, Feladatok és Fiókok nézethez,
 * valamint a fiókok széfjének automatikus zárolása (vaultAutoLock, percben).
 * Azonnal a böngészőben tárolódnak, bejelentkezve a fiókhoz is mentődnek, így minden eszközön ugyanazok.
 */
(function () {
    const OPTIONS = {
        commandSort: ['newest', 'abc', 'used'],
        commandView: ['grid', 'compact', 'list'],
        noteSort: ['updated', 'newest', 'abc'],
        noteView: ['grid', 'compact', 'list', 'kanban'],
        taskSort: ['due', 'priority', 'newest', 'abc'],
        taskView: ['list', 'compact'],
        accountSort: ['abc', 'newest', 'used'],
        accountView: ['list', 'compact', 'grid'],
        vaultAutoLock: ['15', '5', '60', 'never']
    };
    // A parancsok rendezése korábban ezen a kulcson volt.
    const LEGACY_KEYS = { commandSort: 'cloudmark_command_sort' };
    const storageKey = key => `cloudmark_pref_${key}`;

    function read(key) {
        try {
            return localStorage.getItem(storageKey(key)) ?? (LEGACY_KEYS[key] ? localStorage.getItem(LEGACY_KEYS[key]) : null);
        } catch (err) {
            return null;
        }
    }

    /** The saved value of `key`, or its first allowed value. */
    function get(key) {
        const value = read(key);
        return OPTIONS[key].includes(value) ? value : OPTIONS[key][0];
    }

    /** Saves a value locally and, when signed in, to the account. */
    function set(key, value) {
        if (!OPTIONS[key]?.includes(value)) return;
        try { localStorage.setItem(storageKey(key), value); } catch (err) { /* private mode */ }
        window.CloudMark?.api?.saveUserSetting(key, value).catch(() => {});
    }

    /** Takes the account's saved values (after sign-in) and tells the views to redraw. */
    function apply(settings = {}) {
        let changed = false;
        Object.keys(OPTIONS).forEach(key => {
            const value = settings[key];
            if (OPTIONS[key].includes(value) && value !== read(key)) {
                try { localStorage.setItem(storageKey(key), value); } catch (err) { /* private mode */ }
                changed = true;
            }
        });
        if (changed) document.dispatchEvent(new CustomEvent('cloudmark:prefs'));
    }

    /** Marks the active button of a view switcher. */
    function markSwitcher(switcher, value) {
        switcher?.querySelectorAll('[data-view-mode]').forEach(button => {
            const active = button.dataset.viewMode === value;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    window.CloudMark = window.CloudMark || {};
    window.CloudMark.prefs = { OPTIONS, get, set, apply, markSwitcher };
})();
