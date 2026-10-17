/*
 * Telefonos elrendezés (640px alatt): alsó fülsor, „Szűrők” panel, aktív szűrők chipként, lebegő „+” gomb.
 * Gépen semmit nem változtat. A nézetek meglévő vezérlőit (kategóriák, rendezés, állapotok, nézetváltó, ⋮ menü)
 * telefonon áthelyezi egy alulról felcsúszó lapra, gépen visszateszi a helyükre, így a nézetek logikája változatlan.
 */
(function () {
    const MOBILE_QUERY = window.matchMedia('(max-width: 640px)');

    // Nézetenként: mi kerül a Szűrők lapra, mi marad kint a kereső alatt, és mely csoportokból lesz chip.
    // A chip csoportok `toggle` jelölése: nincs „Összes” gomb, az aktív gombra újra kattintva törlődik a szűrő.
    const VIEWS = {
        notes: {
            sheet: ['#notesView > .category-section', '#notesView > .item-list-toolbar'],
            groups: [
                { bar: '#noteCategoriesBar', label: 'Kategória' },
                { bar: '#noteLabelsBar', label: 'Címke' },
                { bar: '#notesView [aria-label="Jegyzet nézetek"]', label: 'Nézet' }
            ]
        },
        tasks: {
            sheet: ['#tasksView > .category-section', '#tasksView > .item-list-toolbar'],
            outside: ['#taskViewGroup'],
            groups: [{ bar: '#taskProjectsBar', label: 'Projekt', toggle: true }]
        },
        bookmarks: {
            sheet: ['#bookmarksView > .category-section', '#bookmarksView > .bookmark-list-toolbar'],
            groups: [
                { bar: '#categoriesBar', label: 'Kategória' },
                { bar: '#bookmarksView .bookmark-state-group', label: 'Állapot' }
            ]
        },
        commands: {
            sheet: ['#commandsView > .category-section', '#commandsView > .item-list-toolbar'],
            groups: [
                { bar: '#commandCategoriesBar', label: 'Kategória' },
                { bar: '#commandsView .commands-state-group', label: 'Nézet' }
            ]
        }
    };

    const ui = {};
    let mobile = false;
    let fab = null;
    let backdrop = null;

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function activeView() {
        return window.CloudMark?.views?.active || 'bookmarks';
    }

    // ---------- Szűrők lap ----------

    function buildView(name) {
        const view = document.querySelector(`.app-view[data-view="${name}"]`);
        const search = view?.querySelector(':scope > .enterprise-toolbar');
        if (!view || !search) return null;
        const config = VIEWS[name];

        const filterButton = document.createElement('button');
        filterButton.type = 'button';
        filterButton.className = 'm-filter-btn mobile-only';
        filterButton.setAttribute('aria-haspopup', 'dialog');
        filterButton.innerHTML = '<i class="fa-solid fa-sliders" aria-hidden="true"></i><span>Szűrők</span><span class="m-filter-count" hidden></span>';
        search.querySelector('.toolbar-group')?.appendChild(filterButton);

        const chips = document.createElement('div');
        chips.className = 'm-active-filters mobile-only';
        chips.hidden = true;
        search.after(chips);

        const outsideRow = document.createElement('div');
        outsideRow.className = 'm-outside-row mobile-only';
        chips.after(outsideRow);

        const sheet = document.createElement('div');
        sheet.className = 'm-sheet';
        sheet.hidden = true;
        sheet.innerHTML = `
            <div class="m-sheet-panel" role="dialog" aria-modal="true" aria-label="Szűrők és nézet">
                <div class="m-sheet-grab" aria-hidden="true"></div>
                <div class="m-sheet-head">
                    <strong>Szűrők és nézet</strong>
                    <button type="button" class="m-sheet-reset">Alaphelyzet</button>
                </div>
                <div class="m-sheet-body"></div>
                <div class="m-sheet-foot"><button type="button" class="btn btn-primary m-sheet-done">Kész</button></div>
            </div>`;
        view.appendChild(sheet);

        const state = { name, view, config, filterButton, chips, outsideRow, sheet, body: sheet.querySelector('.m-sheet-body'), moved: [] };
        filterButton.addEventListener('click', () => openSheet(state));
        sheet.querySelector('.m-sheet-done').addEventListener('click', () => closeSheet(state));
        sheet.querySelector('.m-sheet-reset').addEventListener('click', () => resetFilters(state));
        // A ⋮ menü pontjai (kezelés, import/export, beállítások) ablakot nyitnak: a lap ilyenkor bezárul.
        sheet.addEventListener('click', event => {
            if (event.target.closest('.cmd-dropdown-item:not(label)')) setTimeout(() => closeSheet(state), 0);
        });
        chips.addEventListener('click', event => {
            const chip = event.target.closest('[data-m-clear]');
            if (chip) clearGroup(state, Number(chip.dataset.mClear));
        });
        enableSwipeToClose(state);
        new MutationObserver(() => refreshChips(state)).observe(view, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        return state;
    }

    /** Moves the view's controls into the sheet (phone) or back to their place (desktop). */
    function placeControls(state) {
        if (mobile && !state.moved.length) {
            const move = (selector, target) => {
                const element = document.querySelector(selector);
                if (!element) return;
                const marker = document.createComment('m-place');
                element.before(marker);
                target.appendChild(element);
                state.moved.push({ element, marker });
            };
            state.config.sheet.forEach(selector => move(selector, state.body));
            (state.config.outside || []).forEach(selector => move(selector, state.outsideRow));
        } else if (!mobile && state.moved.length) {
            state.moved.forEach(({ element, marker }) => { marker.replaceWith(element); });
            state.moved = [];
            closeSheet(state);
        }
        state.outsideRow.hidden = !state.outsideRow.children.length;
        refreshChips(state);
    }

    function openSheet(state) {
        state.sheet.hidden = false;
        document.body.classList.add('m-sheet-open');
        state.filterButton.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => state.sheet.classList.add('is-open'));
        state.sheet.querySelector('.m-sheet-done').focus({ preventScroll: true });
    }

    function closeSheet(state) {
        if (state.sheet.hidden) return;
        state.sheet.classList.remove('is-open');
        state.filterButton.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('m-sheet-open');
        state.sheet.querySelector('.m-sheet-panel').style.transform = '';
        setTimeout(() => { if (!state.sheet.classList.contains('is-open')) state.sheet.hidden = true; }, 220);
    }

    function enableSwipeToClose(state) {
        const panel = state.sheet.querySelector('.m-sheet-panel');
        const handles = [panel.querySelector('.m-sheet-grab'), panel.querySelector('.m-sheet-head')];
        let startY = null;
        handles.forEach(handle => {
            handle.addEventListener('touchstart', event => { startY = event.touches[0].clientY; }, { passive: true });
            handle.addEventListener('touchmove', event => {
                if (startY === null) return;
                const delta = Math.max(0, event.touches[0].clientY - startY);
                panel.style.transform = `translateY(${delta}px)`;
            }, { passive: true });
            handle.addEventListener('touchend', event => {
                if (startY === null) return;
                const delta = event.changedTouches[0].clientY - startY;
                startY = null;
                if (delta > 80) closeSheet(state);
                else panel.style.transform = '';
            });
        });
        state.sheet.addEventListener('click', event => { if (event.target === state.sheet) closeSheet(state); });
    }

    // ---------- aktív szűrők chipként ----------

    function groupButtons(bar) {
        return Array.from(bar?.querySelectorAll('.category-chip, .state-filter, .cmd-state') || []).filter(button => !button.matches('[data-note-category-add], [data-project-new]'));
    }

    function buttonLabel(button) {
        const clone = button.cloneNode(true);
        clone.querySelectorAll('[class*="count"], .fa-tag, .fa-folder, .fa-regular, .fa-solid').forEach(node => node.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    /** The non-default choice of a filter group, or null. */
    function activeChoice(group) {
        const buttons = groupButtons(document.querySelector(group.bar));
        const active = buttons.find(button => button.classList.contains('active'));
        if (!active) return null;
        if (!group.toggle && active === buttons[0]) return null;
        return active;
    }

    function refreshChips(state) {
        if (!mobile) return;
        const parts = state.config.groups.map((group, index) => {
            const choice = activeChoice(group);
            return choice ? `<button type="button" class="m-chip" data-m-clear="${index}" aria-label="${esc(group.label)} szűrő törlése: ${esc(buttonLabel(choice))}">${esc(buttonLabel(choice))}<i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : '';
        }).filter(Boolean);
        const html = parts.join('');
        if (state.chips.innerHTML !== html) state.chips.innerHTML = html;
        state.chips.hidden = !parts.length;
        const count = state.filterButton.querySelector('.m-filter-count');
        const countText = parts.length ? String(parts.length) : '';
        if (count.textContent !== countText) count.textContent = countText;
        count.hidden = !parts.length;
        state.filterButton.classList.toggle('has-filters', parts.length > 0);
    }

    function clearGroup(state, index) {
        const group = state.config.groups[index];
        const choice = activeChoice(group);
        if (!choice) return;
        if (group.toggle) choice.click();
        else groupButtons(document.querySelector(group.bar))[0]?.click();
    }

    function resetFilters(state) {
        state.config.groups.forEach((group, index) => clearGroup(state, index));
    }

    // ---------- lebegő „+” gomb ----------

    function newItemIsOpen(name) {
        if (name === 'tasks') return document.body.classList.contains('m-quickadd-open');
        if (name === 'bookmarks') return document.querySelector('#bookmarksView .add-bookmark-toggle')?.getAttribute('aria-expanded') === 'true';
        if (name === 'commands') return document.getElementById('commandNewBtn')?.getAttribute('aria-expanded') === 'true';
        return false;
    }

    function scrollToSection(selector) {
        const section = document.querySelector(selector);
        if (!section) return;
        const header = document.querySelector('header');
        const top = section.getBoundingClientRect().top + window.scrollY - (header?.offsetHeight || 0) - 8;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    function onFabClick() {
        const name = activeView();
        if (name === 'tasks') { toggleQuickAdd(!newItemIsOpen('tasks')); return; }
        if (name === 'notes') {
            window.CloudMark.notes?.openComposer();
            scrollToSection('#noteNewSection');
            return;
        }
        if (name === 'commands') {
            const button = document.getElementById('commandNewBtn');
            button?.click();
            if (newItemIsOpen('commands')) scrollToSection('#commandsView > .add-item-section');
        }
        if (name === 'bookmarks') {
            const button = document.querySelector('#bookmarksView .add-bookmark-toggle');
            button?.click();
            if (newItemIsOpen('bookmarks')) scrollToSection('#bookmarksView > .add-bookmark-section');
        }
        refreshFab();
    }

    function refreshFab() {
        if (!fab) return;
        const name = activeView();
        const signedIn = typeof currentUser !== 'undefined' && Boolean(currentUser);
        fab.hidden = !signedIn;
        const open = newItemIsOpen(name);
        fab.classList.toggle('is-open', open);
        const labels = { notes: 'Új jegyzet', tasks: 'Új feladat', bookmarks: 'Új könyvjelző', commands: 'Új kódrészlet' };
        fab.setAttribute('aria-label', open ? 'Bezárás' : labels[name] || 'Új');
        fab.title = fab.getAttribute('aria-label');
    }

    // ---------- feladatok: gyors beírás alulról felcsúszó lapon ----------

    function toggleQuickAdd(open) {
        document.body.classList.toggle('m-quickadd-open', open);
        backdrop.hidden = !open;
        if (open) {
            positionQuickAdd();
            document.getElementById('taskQuickAdd')?.focus();
        } else {
            document.getElementById('taskQuickAdd')?.blur();
        }
        refreshFab();
    }

    // iOS-en a billentyűzet nem csökkenti az ablak magasságát: a lapot a látható terület aljához igazítjuk.
    function positionQuickAdd() {
        const section = document.querySelector('#tasksView > .tasks-toolbar');
        if (!section) return;
        const viewport = window.visualViewport;
        const offset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
        section.style.setProperty('--m-keyboard', `${offset}px`);
    }

    // ---------- fejléc: téma és kilépés a ⋮ menüben ----------

    function addMenuItems() {
        const actions = document.querySelector('#mainMenuPanel .menu-section.auth-only .enterprise-actions');
        if (!actions || actions.querySelector('.m-menu-theme')) return;
        actions.insertAdjacentHTML('beforeend', `
            <button type="button" class="btn btn-secondary mobile-only m-menu-theme"><i class="fa-solid fa-circle-half-stroke"></i> Téma váltása</button>
            <button type="button" class="btn btn-secondary mobile-only m-menu-logout"><i class="fa-solid fa-right-from-bracket"></i> Kilépés</button>`);
        actions.querySelector('.m-menu-theme').addEventListener('click', () => document.getElementById('themeToggle')?.click());
        actions.querySelector('.m-menu-logout').addEventListener('click', () => {
            document.getElementById('mainMenuClose')?.click();
            if (typeof logoutUser === 'function') logoutUser();
        });
    }

    // ---------- indítás ----------

    function applyLayout() {
        mobile = MOBILE_QUERY.matches;
        document.documentElement.classList.toggle('is-mobile', mobile);
        Object.values(ui).forEach(placeControls);
        if (!mobile) toggleQuickAdd(false);
        refreshFab();
    }

    function init() {
        Object.keys(VIEWS).forEach(name => { const state = buildView(name); if (state) ui[name] = state; });

        fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'm-fab mobile-only';
        fab.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
        fab.addEventListener('click', onFabClick);
        document.body.appendChild(fab);

        backdrop = document.createElement('div');
        backdrop.className = 'm-backdrop';
        backdrop.hidden = true;
        backdrop.addEventListener('click', () => toggleQuickAdd(false));
        document.body.appendChild(backdrop);

        addMenuItems();
        window.visualViewport?.addEventListener('resize', () => { if (document.body.classList.contains('m-quickadd-open')) positionQuickAdd(); });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            Object.values(ui).forEach(closeSheet);
            if (document.body.classList.contains('m-quickadd-open')) toggleQuickAdd(false);
        });
        // Nézetváltáskor (fül, gyorsbillentyű, hash) a lapok bezárulnak, és a „+” gomb az új nézethez igazodik.
        document.getElementById('appTabs')?.addEventListener('click', () => setTimeout(() => {
            Object.values(ui).forEach(closeSheet);
            toggleQuickAdd(false);
        }, 0));
        window.addEventListener('hashchange', () => setTimeout(refreshFab, 0));
        // A „+” gomb ×-re vált, amíg az új elem űrlapja nyitva van (a sávok aria-expanded értéke változik).
        document.querySelectorAll('#commandNewBtn, #bookmarksView .add-bookmark-toggle').forEach(button => {
            new MutationObserver(refreshFab).observe(button, { attributes: true, attributeFilter: ['aria-expanded'] });
        });
        new MutationObserver(refreshFab).observe(document.getElementById('appTabs'), { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });

        MOBILE_QUERY.addEventListener('change', applyLayout);
        applyLayout();
    }

    window.CloudMark = window.CloudMark || {};
    window.CloudMark.mobile = { refresh: () => { Object.values(ui).forEach(refreshChips); refreshFab(); }, toggleQuickAdd };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
