/* Consolidated 3-dot header menu: open/close behavior. */
(function () {
    const toggle = document.getElementById('mainMenuToggle');
    const panel = document.getElementById('mainMenuPanel');
    const backdrop = document.getElementById('mainMenuBackdrop');
    const closeBtn = document.getElementById('mainMenuClose');
    if (!toggle || !panel) return;

    function openMainMenu() {
        panel.classList.add('open');
        backdrop.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
    }

    function closeMainMenu() {
        panel.classList.remove('open');
        backdrop.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }

    function toggleMainMenu() {
        if (panel.classList.contains('open')) closeMainMenu();
        else openMainMenu();
    }

    toggle.addEventListener('click', toggleMainMenu);
    closeBtn?.addEventListener('click', closeMainMenu);
    backdrop.addEventListener('click', closeMainMenu);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMainMenu();
    });

    // A menüből nyíló ablakok előtt a menü bezárul.
    ['menuInfoBtn', 'menuUserSettingsBtn', 'menuTeamBtn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', closeMainMenu);
    });

    window.openMainMenu = openMainMenu;
    window.closeMainMenu = closeMainMenu;
})();
