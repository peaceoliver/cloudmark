/*
 * Közös Beállítások ablak fülekkel (Általános, Jegyzetek, Feladatok, Könyvjelzők, Parancsok, AI),
 * és a nézetek ⋮ menüinek „Beállítások…” pontja, amely az adott nézet fülén nyitja meg.
 */
(function () {
    const modal = document.getElementById('userSettingsModal');
    if (!modal) return;
    const TABS = ['general', 'notes', 'tasks', 'bookmarks', 'commands', 'ai'];

    function showTab(name) {
        const tab = TABS.includes(name) ? name : 'general';
        modal.querySelectorAll('[data-settings-tab]').forEach(button => {
            const active = button.dataset.settingsTab === tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        modal.querySelectorAll('[data-settings-pane]').forEach(pane => { pane.hidden = pane.dataset.settingsPane !== tab; });
    }

    modal.querySelector('.settings-tabs').addEventListener('click', event => {
        const button = event.target.closest('[data-settings-tab]');
        if (button) showTab(button.dataset.settingsTab);
    });

    function closeMenus() {
        document.querySelectorAll('.cmd-dropdown.show').forEach(menu => menu.classList.remove('show'));
        document.querySelectorAll('.item-more-btn[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    }

    // A Könyvjelzők és a Jegyzetek ⋮ menüje (a Parancsok és a Feladatok a sajátját kezeli).
    document.querySelectorAll('.item-more-btn[data-more-menu]').forEach(button => {
        const menu = document.getElementById(button.dataset.moreMenu);
        button.addEventListener('click', event => {
            event.stopPropagation();
            const open = !menu.classList.contains('show');
            closeMenus();
            menu.classList.toggle('show', open);
            button.setAttribute('aria-expanded', String(open));
        });
        // Egy pont kiválasztása után a menü bezárul (a fájlválasztó címke is).
        menu.addEventListener('click', event => {
            if (event.target.closest('.cmd-dropdown-item')) setTimeout(closeMenus, 0);
        });
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('.cmd-dropdown') && !event.target.closest('.item-more-btn')) {
            document.querySelectorAll('.item-more-btn[data-more-menu]').forEach(button => {
                document.getElementById(button.dataset.moreMenu)?.classList.remove('show');
                button.setAttribute('aria-expanded', 'false');
            });
        }
        const opener = event.target.closest('[data-open-settings]');
        if (!opener) return;
        closeMenus();
        openUserSettings(opener.dataset.openSettings);
    });

    window.CloudMark = window.CloudMark || {};
    window.CloudMark.settings = { showTab };
})();
