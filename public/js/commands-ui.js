/* Kódtár (régen Parancsok): kódrészlet-kártyák, másológombok, szerkesztő és kategóriák. Az adat a /api/items végpontokról jön (type = command). */
(function () {
    const commandApi = window.CloudMark.api;
    const searchQuery = window.CloudMark.searchQuery;
    const highlight = window.CloudMark.codeHighlight;
    const share = window.CloudMark.share;
    // Az élő frissítés (live.js) később töltődik be, ezért mindig a hívás pillanatában kérjük le.
    const live = () => window.CloudMark.live;
    /** Whether the user owns the command (not shared with them). */
    const isOwn = item => !share || share.isOwn(item);
    const COPY_FEEDBACK_MS = 1500;

    /*
     * Másolási szabályok, pontosan a parancstar.html minta szerint:
     * - egy sor: ha van benne '#', az utána lévő részt levágja, és a végéről a szóközöket;
     * - kommentek nélkül: ugyanez minden sorra, az üres sorok kimaradnak;
     * - Markdown: ### Cím + kódblokk a fül nyelvével (alapértelmezés bash).
     */
    const copyRules = {
        line(text) {
            return text.includes('#') ? text.split('#')[0].trim() : text;
        },
        clean(code) {
            return code.split('\n').map(line => line.split('#')[0].trim()).filter(line => line.length > 0).join('\n');
        },
        markdown(title, code, language) {
            return `### ${title}\n\`\`\`${language || 'bash'}\n${code}\n\`\`\``;
        }
    };

    const prefs = window.CloudMark.prefs;
    const state = {
        items: [],
        categories: [],
        loaded: false,
        loading: null,
        query: '',
        category: 'all',
        filter: 'active',
        sort: prefs.get('commandSort'),
        view: prefs.get('commandView'),
        activeFragment: new Map(),
        // Lista nézetben kinyitott parancsok (a kód csak ezeknél látszik).
        openIds: new Set(),
        // Kijelölő mód: több kódrészlet áthelyezése egy kategóriába.
        selecting: false,
        selected: new Set()
    };

    const grid = document.getElementById('commandGrid');
    const viewSwitcher = document.getElementById('commandViewSwitcher');
    const categoriesBar = document.getElementById('commandCategoriesBar');
    const searchInput = document.getElementById('commandSearch');
    const searchClear = document.getElementById('commandSearchClear');
    const sortSelect = document.getElementById('commandSortSelect');
    const moreButton = document.getElementById('commandMoreBtn');
    const moreMenu = document.getElementById('commandMoreMenu');
    if (!grid) return;

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    async function writeClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) throw new Error('copy failed');
    }

    /** Swaps a button's icon to a green check for a moment, like the sample page. */
    function flashCopied(button) {
        if (!button) return;
        const icon = button.querySelector('i');
        if (!icon) return;
        clearTimeout(button._copyTimer);
        if (!button.dataset.iconClass) button.dataset.iconClass = icon.className;
        icon.className = 'fa-solid fa-check copy-ok';
        button._copyTimer = setTimeout(() => { icon.className = button.dataset.iconClass; }, COPY_FEEDBACK_MS);
    }

    // ---------- adatok ----------

    async function load(force = false) {
        if (state.loaded && !force) return;
        if (state.loading && !force) return state.loading;
        grid.innerHTML = '<div class="empty-state">Kódtár betöltése…</div>';
        state.loading = Promise.all([
            commandApi.getItems('command', { all: 'true' }),
            commandApi.getCategoriesOfKind('command')
        ]).then(([items, categories]) => {
            state.items = items;
            state.categories = categories;
            state.loaded = true;
            render();
        }).catch(err => {
            grid.innerHTML = `<div class="empty-state">A kódtár betöltése nem sikerült: ${esc(err.message)}</div>`;
        }).finally(() => { state.loading = null; });
        return state.loading;
    }

    function reset() {
        state.items = [];
        state.categories = [];
        state.loaded = false;
        state.category = 'all';
        state.query = '';
        state.selecting = false;
        state.selected.clear();
        state.activeFragment.clear();
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        grid.innerHTML = '';
        categoriesBar.innerHTML = '';
    }

    function upsertItem(item) {
        const index = state.items.findIndex(existing => existing.id === item.id);
        if (index === -1) state.items.unshift(item);
        else state.items[index] = item;
    }

    function findItem(id) {
        return state.items.find(item => String(item.id) === String(id));
    }

    // ---------- kategóriák ----------

    /** Categories in tree order with a "Szülő / Gyerek" label, so nested folders read clearly. */
    function categoryTree() {
        const byParent = new Map();
        state.categories.forEach(category => {
            const key = category.parent_id ?? 'root';
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key).push(category);
        });
        const ids = new Set(state.categories.map(category => category.id));
        const result = [];
        const walk = (parentKey, prefix) => {
            (byParent.get(parentKey) || []).sort((a, b) => a.name.localeCompare(b.name, 'hu')).forEach(category => {
                const label = prefix ? `${prefix} / ${category.name}` : category.name;
                result.push({ ...category, label });
                walk(category.id, label);
            });
        };
        walk('root', '');
        // Orphans whose parent is missing still appear at the end.
        state.categories.filter(category => category.parent_id && !ids.has(category.parent_id))
            .forEach(category => { if (!result.some(entry => entry.id === category.id)) result.push({ ...category, label: category.name }); });
        return result;
    }

    function descendantIds(categoryId) {
        const ids = new Set([Number(categoryId)]);
        let grew = true;
        while (grew) {
            grew = false;
            state.categories.forEach(category => {
                if (category.parent_id && ids.has(Number(category.parent_id)) && !ids.has(Number(category.id))) {
                    ids.add(Number(category.id));
                    grew = true;
                }
            });
        }
        return ids;
    }

    function renderCategories() {
        const pool = state.items.filter(item => !item.trashed);
        const countIn = ids => pool.filter(item => item.category_id !== null && ids.has(Number(item.category_id))).length;
        const chips = [{ key: 'all', label: 'Összes', count: pool.length }];
        const inboxCount = pool.filter(item => item.category_id === null).length;
        if (inboxCount) chips.push({ key: 'inbox', label: 'Inbox', count: inboxCount });
        categoryTree().forEach(category => chips.push({ key: String(category.id), label: category.label, count: countIn(descendantIds(category.id)) }));
        if (!chips.some(chip => chip.key === state.category)) state.category = 'all';
        categoriesBar.innerHTML = chips.map(chip => `
            <button type="button" class="category-chip ${chip.key === state.category ? 'active' : ''}" data-category="${esc(chip.key)}">
                ${esc(chip.label)} <span class="command-chip-count">${chip.count}</span>
            </button>`).join('');
    }

    // ---------- kártyák ----------

    /** The names of a category and all its parents, so `/shell` also finds items in `shell / git`. */
    function categoryPath(categoryId) {
        const names = [];
        const seen = new Set();
        let category = state.categories.find(entry => String(entry.id) === String(categoryId));
        while (category && !seen.has(category.id)) {
            seen.add(category.id);
            names.push(category.name);
            category = category.parent_id ? state.categories.find(entry => String(entry.id) === String(category.parent_id)) : null;
        }
        return names;
    }

    function visibleItems() {
        // Ékezetfüggetlen, több szónál mindegyik kell; #címke és /kategória szűkít (search-query.js).
        const query = searchQuery.parse(state.query);
        const categoryIds = /^\d+$/.test(state.category) ? descendantIds(state.category) : null;
        const list = state.items.filter(item => {
            if (state.filter === 'trash') { if (!item.trashed) return false; }
            else if (item.trashed || item.archived) return false;
            if (state.filter === 'starred' && !item.starred) return false;
            if (state.filter === 'shared' && isOwn(item)) return false;
            if (state.category === 'inbox' && item.category_id !== null) return false;
            if (categoryIds && !(item.category_id !== null && categoryIds.has(Number(item.category_id)))) return false;
            return searchQuery.matches(query, {
                texts: [item.title, item.description, item.category_name, ...item.fragments.map(fragment => `${fragment.label || ''} ${fragment.language || ''}\n${fragment.content}`), ...item.tags.map(tag => `#${tag}`)],
                tags: item.tags,
                categories: item.category_id === null ? ['inbox'] : (categoryPath(item.category_id).length ? categoryPath(item.category_id) : [item.category_name || ''])
            });
        });
        const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'hu');
        if (state.sort === 'abc') list.sort(byTitle);
        else if (state.sort === 'used') list.sort((a, b) => (b.use_count - a.use_count) || byTitle(a, b));
        else list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return list;
    }

    function activeFragmentIndex(item) {
        const index = state.activeFragment.get(item.id) || 0;
        return index < item.fragments.length ? index : 0;
    }

    function cardHtml(item) {
        const fragments = item.fragments.length ? item.fragments : [{ content: '', language: null, label: null }];
        const fragmentIndex = activeFragmentIndex(item);
        const fragment = fragments[fragmentIndex];
        const lines = fragment.content.split('\n');
        const isMultiLine = lines.length > 1;
        // Több fülnél a fülek mutatják a nyelvet, ezért a nyelv címke csak egy fülnél látszik.
        const tabs = fragments.length > 1 ? `
            <div class="command-tabs" role="tablist">
                ${fragments.map((entry, index) => `<button type="button" class="command-tab ${index === fragmentIndex ? 'active' : ''}" role="tab" aria-selected="${index === fragmentIndex}" data-action="tab" data-index="${index}">${esc(entry.label || entry.language || `${index + 1}. fül`)}</button>`).join('')}
            </div>` : '';
        // VS Code-szerű színezés (code-highlight.js escape-eli a szöveget), több sornál sorszámokkal.
        const highlighted = highlight ? highlight.highlightLines(fragment.content, fragment.language) : lines.map(esc);
        const lineHtml = lines.map((line, index) => `
            <div class="code-line">
                <button type="button" class="line-copy-btn" data-action="copy-line" data-line="${index}" title="Csak ezen sor másolása (kommentek nélkül)" aria-label="Sor másolása"><i class="fa-regular fa-copy"></i></button>
                ${isMultiLine ? `<span class="code-line-no" aria-hidden="true">${index + 1}</span>` : ''}
                <pre><code class="hljs">${highlighted[index] || ' '}</code></pre>
            </div>`).join('');
        const actions = isMultiLine ? `
            <div class="code-actions">
                <button type="button" class="code-action-btn" data-action="copy-all" title="Összes másolása" aria-label="Összes másolása"><i class="fa-regular fa-copy"></i></button>
                <button type="button" class="code-action-btn" data-action="menu" title="Opciók" aria-label="Másolási opciók" aria-haspopup="true"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                <div class="cmd-dropdown" role="menu">
                    <button type="button" class="cmd-dropdown-item" data-action="copy-all">Összes másolása</button>
                    <button type="button" class="cmd-dropdown-item" data-action="copy-md">Másolás Markdownként</button>
                    <button type="button" class="cmd-dropdown-item" data-action="copy-clean">Kommentek nélkül</button>
                </div>
            </div>` : '';
        const stateButtons = item.trashed ? `
            <button type="button" class="action-btn" data-action="restore" title="Visszaállítás"><i class="fa-solid fa-rotate-left"></i></button>
            <button type="button" class="action-btn" data-action="delete" title="Végleges törlés"><i class="fa-solid fa-trash-can"></i></button>` : `
            <button type="button" class="action-btn ${item.starred ? 'is-starred' : ''}" data-action="star" title="${item.starred ? 'Kedvenc eltávolítása' : 'Kedvencnek jelölés'}"><i class="${item.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
            <button type="button" class="action-btn" data-action="edit" title="${item.access === 'view' ? 'Részletek' : 'Szerkesztés'}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="action-btn" data-action="share" title="${isOwn(item) ? 'Megosztás' : 'Megosztás részletei'}"><i class="fa-solid fa-share-nodes"></i></button>
            ${isOwn(item)
                ? '<button type="button" class="action-btn" data-action="trash" title="Kukába"><i class="fa-solid fa-trash"></i></button>'
                : (item.share_direct ? '<button type="button" class="action-btn" data-action="leave" title="Eltávolítás a listámból"><i class="fa-solid fa-right-from-bracket"></i></button>' : '')}`;
        return `
            <article class="card command-card ${state.openIds.has(item.id) ? 'is-open' : ''} ${state.selected.has(Number(item.id)) ? 'is-selected' : ''}" data-item-id="${Number(item.id)}">
                <div>
                    <div class="command-card-head">
                        ${state.selecting ? `<span class="command-select-box" aria-hidden="true"><i class="${state.selected.has(Number(item.id)) ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}"></i></span>` : ''}
                        <h3 class="card-title">${esc(item.title)}</h3>
                        <div class="command-card-actions">
                            ${item.trashed ? '' : '<button type="button" class="action-btn command-quick-copy" data-action="copy-all" title="Másolás" aria-label="Másolás"><i class="fa-regular fa-copy"></i></button>'}
                            ${stateButtons}
                        </div>
                    </div>
                    <div class="card-meta command-card-meta">
                        <span class="card-category">${esc(item.category_name || 'Inbox')}</span>
                        ${fragment.language && fragments.length === 1 ? `<span class="command-lang">${esc(fragment.language)}</span>` : ''}
                        ${share?.badgeHtml(item) || ''}
                    </div>
                    ${item.description ? `<p class="command-desc">${esc(item.description)}</p>` : ''}
                </div>
                <div>
                    ${tabs}
                    <div class="code-wrapper ${isMultiLine ? 'has-multiple' : ''}">
                        <div class="code-lines">${lineHtml}</div>
                        ${actions}
                    </div>
                    ${item.tags.length ? `<div class="card-tags command-tags">${item.tags.map(tag => `#${esc(tag)}`).join(' ')}</div>` : ''}
                </div>
            </article>`;
    }

    function renderGrid() {
        grid.classList.remove('view-grid', 'view-compact', 'view-list');
        grid.classList.add(`view-${state.view}`);
        grid.classList.toggle('is-selecting', state.selecting);
        renderSelectBar();
        prefs.markSwitcher(viewSwitcher, state.view);
        const list = visibleItems();
        if (state.filter === 'shared' && !list.length) {
            grid.innerHTML = '<div class="empty-state">Még senki nem osztott meg veled kódrészletet. Ha valaki megoszt, a csengőnél fogadhatod el.</div>';
            return;
        }
        if (!state.items.length) {
            grid.innerHTML = '<div class="empty-state">Még nincs kódrészleted. Hozz létre egyet az „Új kódrészlet” gombbal, vagy importáld a meglévő listádat (⋮ → Import).</div>';
            return;
        }
        if (!list.length) {
            grid.innerHTML = `<div class="empty-state">${state.filter === 'trash' ? 'A kuka üres.' : 'Nincs a keresésnek megfelelő kódrészlet.'}</div>`;
            return;
        }
        grid.innerHTML = list.map(cardHtml).join('');
    }

    function rerenderCard(item) {
        const card = grid.querySelector(`[data-item-id="${Number(item.id)}"]`);
        if (card) card.outerHTML = cardHtml(item);
    }

    function render() {
        renderCategories();
        renderGrid();
    }

    function closeDropdowns(except) {
        document.querySelectorAll('.cmd-dropdown.show').forEach(menu => { if (menu !== except) menu.classList.remove('show'); });
        if (moreButton && except !== moreMenu) moreButton.setAttribute('aria-expanded', 'false');
    }

    // ---------- kártya műveletek ----------

    async function copyFromCard(action, item, card, button) {
        const fragment = item.fragments[activeFragmentIndex(item)] || { content: '', language: null };
        let text;
        let feedbackButton = button;
        if (action === 'copy-line') {
            text = copyRules.line(fragment.content.split('\n')[Number(button.dataset.line)] ?? '');
        } else {
            if (action === 'copy-all') text = fragment.content;
            if (action === 'copy-md') text = copyRules.markdown(item.title, fragment.content, fragment.language);
            if (action === 'copy-clean') text = copyRules.clean(fragment.content);
            // A mintához hasonlóan a menüből másolásnál is a fő másológomb mutatja a pipát.
            if (!button.classList.contains('command-quick-copy')) feedbackButton = card.querySelector('.code-action-btn[data-action="copy-all"]');
            closeDropdowns();
        }
        try {
            await writeClipboard(text);
            flashCopied(feedbackButton);
        } catch (err) {
            notify('A másolás nem sikerült.', 'error');
            return;
        }
        commandApi.markItemUsed(item.id).then(result => { item.use_count = result.use_count; }).catch(() => {});
    }

    /** Drops an item from the list (the recipient left the share). */
    function forget(item) {
        state.items = state.items.filter(entry => entry.id !== item.id);
        render();
    }

    async function changeState(item, patch, message) {
        try {
            upsertItem(await commandApi.setItemState(item.id, patch));
            render();
            if (message) notify(message, 'success');
        } catch (err) {
            notify(err.message || 'A módosítás nem sikerült.', 'error');
        }
    }

    grid.addEventListener('click', async event => {
        // Kijelölő módban a kártyára kattintás csak kijelöl (nem másol, nem nyit).
        if (state.selecting) {
            const card = event.target.closest('[data-item-id]');
            if (!card) return;
            event.preventDefault();
            toggleSelected(Number(card.dataset.itemId));
            return;
        }
        const button = event.target.closest('[data-action]');
        if (!button) {
            // Lista nézetben a sorra kattintva nyílik és csukódik a kód.
            const row = state.view === 'list' && !event.target.closest('.code-wrapper, .command-tabs') && event.target.closest('[data-item-id]');
            if (!row) return;
            const id = Number(row.dataset.itemId);
            if (state.openIds.has(id)) state.openIds.delete(id); else state.openIds.add(id);
            row.classList.toggle('is-open', state.openIds.has(id));
            return;
        }
        const card = button.closest('[data-item-id]');
        const item = card && findItem(card.dataset.itemId);
        if (!item) return;
        const action = button.dataset.action;
        event.stopPropagation();

        if (action.startsWith('copy-')) return copyFromCard(action, item, card, button);
        if (action === 'menu') {
            const menu = button.parentElement.querySelector('.cmd-dropdown');
            closeDropdowns(menu);
            menu.classList.toggle('show');
            return;
        }
        if (action === 'tab') {
            state.activeFragment.set(item.id, Number(button.dataset.index));
            rerenderCard(item);
            return;
        }
        if (action === 'star') return changeState(item, { starred: !item.starred });
        if (action === 'edit') return openEditor(item);
        if (action === 'share') return share?.open(item, { onChange: () => render(), onLeft: forget });
        if (action === 'leave') { if (await share?.leave(item)) forget(item); return; }
        if (action === 'trash') return changeState(item, { trashed: true }, 'Kódrészlet a kukába helyezve.');
        if (action === 'restore') return changeState(item, { trashed: false }, 'Kódrészlet visszaállítva.');
        if (action === 'delete') {
            if (!confirm(`Véglegesen törlöd: „${item.title}”?`)) return;
            try {
                await commandApi.deleteItemPermanently(item.id);
                state.items = state.items.filter(entry => entry.id !== item.id);
                render();
                notify('Kódrészlet véglegesen törölve.', 'success');
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
        }
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.cmd-dropdown') && !event.target.closest('[data-action="menu"]') && !event.target.closest('#commandMoreBtn')) closeDropdowns();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeDropdowns();
        if (state.selecting && !document.querySelector('.modal-overlay.active')) stopSelecting();
    });

    // ---------- eszköztár ----------

    categoriesBar.addEventListener('click', event => {
        const chip = event.target.closest('[data-category]');
        if (!chip) return;
        state.category = chip.dataset.category;
        render();
    });

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        searchClear.hidden = !searchInput.value;
        renderGrid();
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        state.query = '';
        searchClear.hidden = true;
        renderGrid();
        searchInput.focus();
    });

    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        prefs.set('commandSort', state.sort);
        renderGrid();
    });

    viewSwitcher.addEventListener('click', event => {
        const button = event.target.closest('[data-view-mode]');
        if (!button) return;
        state.view = button.dataset.viewMode;
        prefs.set('commandView', state.view);
        renderGrid();
    });
    prefs.markSwitcher(viewSwitcher, state.view);

    // A fiókhoz mentett beállítások bejelentkezés után érkeznek meg.
    document.addEventListener('cloudmark:prefs', () => {
        state.sort = prefs.get('commandSort');
        state.view = prefs.get('commandView');
        sortSelect.value = state.sort;
        if (state.loaded) renderGrid(); else prefs.markSwitcher(viewSwitcher, state.view);
    });

    document.querySelectorAll('[data-cmd-state]').forEach(button => button.addEventListener('click', () => {
        state.filter = button.dataset.cmdState;
        document.querySelectorAll('[data-cmd-state]').forEach(other => other.classList.toggle('active', other === button));
        renderGrid();
    }));

    document.getElementById('commandNewBtn').addEventListener('click', () => {
        // Lenyitó sávként működik, mint a könyvjelzőknél: másodszorra becsukja az űrlapot.
        if (!newPanel.hidden) closeEditor();
        else openEditor(null);
    });

    moreButton.addEventListener('click', event => {
        event.stopPropagation();
        closeDropdowns(moreMenu);
        moreMenu.classList.toggle('show');
        moreButton.setAttribute('aria-expanded', String(moreMenu.classList.contains('show')));
    });
    moreMenu.addEventListener('click', async event => {
        const button = event.target.closest('[data-cmd-menu]');
        if (!button) return;
        closeDropdowns();
        const action = button.dataset.cmdMenu;
        if (action === 'categories') return openCategoryManager();
        if (action === 'select') return startSelecting();
        if (action === 'export-json' || action === 'export-md') {
            const format = action === 'export-md' ? 'md' : 'json';
            try {
                const blob = await commandApi.exportItems('command', format);
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `cloudmark-kodtar.${format}`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            } catch (err) {
                notify('Az exportálás nem sikerült.', 'error');
            }
        }
    });

    document.getElementById('commandImportInput').addEventListener('change', async event => {
        const file = event.target.files[0];
        event.target.value = '';
        closeDropdowns();
        if (!file) return;
        let items;
        try {
            const data = JSON.parse(await file.text());
            items = Array.isArray(data) ? data : data.items;
            if (!Array.isArray(items)) throw new Error('format');
        } catch (err) {
            notify('A fájl nem érvényes kódtár lista (JSON tömb vagy CloudMark export).', 'error');
            return;
        }
        if (!confirm(`${items.length} kódrészlet importálása. Folytatod?`)) return;
        try {
            const result = await commandApi.importItems('command', items);
            await load(true);
            notify(`${result.imported} kódrészlet importálva.`, 'success');
        } catch (err) {
            notify(err.message || 'Az importálás nem sikerült.', 'error');
        }
    });

    // ---------- kijelölés és áthelyezés (Inbox rendezése) ----------

    const selectBar = document.getElementById('commandSelectBar');
    const selectCount = document.getElementById('commandSelectCount');
    const selectTarget = document.getElementById('commandSelectTarget');
    const selectMove = document.getElementById('commandSelectMove');

    function startSelecting() {
        state.selecting = true;
        state.selected.clear();
        // Az áthelyezés a saját kategóriáidba visz; a kuka elemei nem mozognak.
        if (state.filter === 'trash') {
            state.filter = 'active';
            document.querySelectorAll('[data-cmd-state]').forEach(other => other.classList.toggle('active', other.dataset.cmdState === 'active'));
        }
        fillCategorySelect(selectTarget, /^\d+$/.test(state.category) ? state.category : '', 'Inbox (nincs kategória)');
        renderGrid();
        notify('Kattints a kártyákra a kijelöléshez, majd válassz kategóriát.', 'info');
    }

    function stopSelecting() {
        state.selecting = false;
        state.selected.clear();
        renderGrid();
    }

    function toggleSelected(id) {
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        const card = grid.querySelector(`[data-item-id="${id}"]`);
        const item = findItem(id);
        if (card && item) card.outerHTML = cardHtml(item);
        renderSelectBar();
    }

    function renderSelectBar() {
        selectBar.hidden = !state.selecting;
        if (!state.selecting) return;
        // Ami már nem látszik (szűrő, keresés), az a kijelölésből is kiesik. Az id-k számként (a szerver szövegként is küldheti).
        const visible = new Set(visibleItems().map(item => Number(item.id)));
        state.selected.forEach(id => { if (!visible.has(id)) state.selected.delete(id); });
        selectCount.textContent = `${state.selected.size} kijelölve`;
        selectMove.disabled = !state.selected.size;
    }

    document.getElementById('commandSelectAll').addEventListener('click', () => {
        const list = visibleItems();
        const all = list.length && list.every(item => state.selected.has(Number(item.id)));
        list.forEach(item => { if (all) state.selected.delete(Number(item.id)); else state.selected.add(Number(item.id)); });
        renderGrid();
    });
    document.getElementById('commandSelectCancel').addEventListener('click', stopSelecting);

    /** The full PUT body of a command with a new category; the server replaces every field, so the rest is sent back. */
    function payloadWithCategory(item, categoryId) {
        return {
            type: 'command',
            title: item.title,
            description: item.description || '',
            categoryId,
            tags: item.tags,
            fragments: item.fragments.map(fragment => ({ content: fragment.content, language: fragment.language || null, label: fragment.label || null })),
            starred: item.starred,
            pinned: item.pinned,
            color: item.color,
            position: item.position,
            extra: item.extra || {},
            ...(isOwn(item) ? {} : { expectedUpdatedAt: item.updated_at })
        };
    }

    selectMove.addEventListener('click', async () => {
        const categoryId = selectTarget.value ? Number(selectTarget.value) : null;
        const items = [...state.selected].map(findItem).filter(item => item && String(item.category_id ?? '') !== String(categoryId ?? ''));
        if (!items.length) { notify('A kijelöltek már ebben a kategóriában vannak.', 'info'); return; }
        selectMove.disabled = true;
        let moved = 0;
        let failed = 0;
        for (const item of items) {
            try {
                upsertItem(await commandApi.updateItem(item.id, payloadWithCategory(item, categoryId)));
                moved += 1;
            } catch (err) {
                failed += 1;
            }
        }
        state.selected.clear();
        render();
        const target = selectTarget.selectedOptions[0]?.textContent.trim() || 'Inbox';
        notify(failed ? `${moved} kódrészlet áthelyezve, ${failed} nem sikerült.` : `${moved} kódrészlet áthelyezve ide: ${target}.`, failed ? 'error' : 'success');
    });

    document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));

    // ---------- szerkesztő ----------

    const editForm = document.getElementById('commandEditForm');
    const fragmentsBox = document.getElementById('cmdFragments');
    const categorySelect = document.getElementById('cmdCategory');
    let editing = null;

    function fillCategorySelect(select, selectedId, emptyLabel) {
        select.innerHTML = `<option value="">${esc(emptyLabel)}</option>` + categoryTree()
            .map(category => `<option value="${Number(category.id)}" ${String(category.id) === String(selectedId) ? 'selected' : ''}>${esc(category.label)}</option>`).join('');
    }

    function defaultLanguageFor(categoryId) {
        const category = state.categories.find(entry => String(entry.id) === String(categoryId));
        return category?.default_language || '';
    }

    function fragmentRowHtml(fragment, index, total) {
        return `
            <div class="fragment-row" data-index="${index}">
                <div class="fragment-row-head">
                    <input type="text" class="fragment-label" maxlength="80" placeholder="Fül neve (pl. PowerShell)" value="${esc(fragment.label || '')}" ${total > 1 ? '' : 'hidden'} aria-label="Fül neve">
                    <input type="text" class="fragment-language" maxlength="30" list="cmdLanguageList" placeholder="Nyelv (pl. bash)" value="${esc(fragment.language || '')}" aria-label="Nyelv">
                    ${total > 1 ? '<button type="button" class="btn-icon fragment-remove" title="Fül törlése" aria-label="Fül törlése"><i class="fa-solid fa-xmark"></i></button>' : ''}
                </div>
                <textarea class="fragment-content" rows="5" spellcheck="false" placeholder="pl. python -m venv venv   # komment" aria-label="Kód">${esc(fragment.content || '')}</textarea>
            </div>`;
    }

    function readFragments() {
        return Array.from(fragmentsBox.querySelectorAll('.fragment-row')).map(row => ({
            label: row.querySelector('.fragment-label').value.trim() || null,
            language: languageValue(row.querySelector('.fragment-language')) || null,
            content: row.querySelector('.fragment-content').value
        }));
    }

    /** The language field's value; while it is focused and emptied to show the whole list, the previous value. */
    function languageValue(input) {
        return (input.value.trim() || input.dataset.previous || '').trim();
    }

    // A nyelv mező javaslatlistája csak a beírt szövegre illőket mutatja, ezért fókuszkor kiürítjük,
    // így a teljes lista látszik; ha nem választanak újat, elhagyáskor visszakerül az előző érték.
    fragmentsBox.addEventListener('focusin', event => {
        const input = event.target.closest('.fragment-language');
        if (!input || !input.value) return;
        input.dataset.previous = input.value;
        input.placeholder = input.value;
        input.value = '';
    });
    fragmentsBox.addEventListener('focusout', event => {
        const input = event.target.closest('.fragment-language');
        if (!input || input.dataset.previous === undefined) return;
        if (!input.value.trim()) input.value = input.dataset.previous;
        delete input.dataset.previous;
        input.placeholder = 'Nyelv (pl. bash)';
    });

    function renderFragmentRows(fragments) {
        fragmentsBox.innerHTML = fragments.map((fragment, index) => fragmentRowHtml(fragment, index, fragments.length)).join('');
    }

    const newButton = document.getElementById('commandNewBtn');
    const newPanel = document.getElementById('commandNewPanel');
    const modalBox = document.querySelector('#commandEditModal .command-edit-modal');

    /** Hides the editor wherever it is open (under the bar for a new command, in the window when editing). */
    function closeEditor() {
        live()?.clearConflictBar(editForm);
        resetAi();
        newPanel.hidden = true;
        newButton.setAttribute('aria-expanded', 'false');
        if (editForm.parentElement !== modalBox) modalBox.appendChild(editForm);
        closeModal('commandEditModal');
        editing = null;
    }

    async function openEditor(item) {
        if (!state.loaded) await load();
        live()?.clearConflictBar(editForm);
        editing = item;
        document.getElementById('commandEditTitle').textContent = item ? 'Kódrészlet szerkesztése' : 'Új kódrészlet';
        document.getElementById('cmdId').value = item ? item.id : '';
        document.getElementById('cmdTitle').value = item?.title || '';
        document.getElementById('cmdDescription').value = item?.description || '';
        const categoryId = item ? item.category_id : (/^\d+$/.test(state.category) ? state.category : '');
        fillCategorySelect(categorySelect, categoryId ?? '', 'Inbox (nincs kategória)');
        if (typeof setTagInputValues === 'function') setTagInputValues('cmdTags', item?.tags || []);
        renderFragmentRows(item && item.fragments.length ? item.fragments : [{ content: '', language: defaultLanguageFor(categoryId) }]);
        resetAi();
        refreshAiRow();
        applyEditorAccess(item);
        if (item) {
            // Meglévő parancs: a szerkesztő ablakban nyílik.
            newPanel.hidden = true;
            newButton.setAttribute('aria-expanded', 'false');
            modalBox.appendChild(editForm);
            openModal('commandEditModal');
            setTimeout(() => document.getElementById('cmdTitle').focus(), 50);
            return;
        }
        // Új parancs: az űrlap a sáv alatt nyílik le, mint a könyvjelzőknél.
        newPanel.appendChild(editForm);
        newPanel.hidden = false;
        newButton.setAttribute('aria-expanded', 'true');
        newPanel.scrollIntoView({ block: 'nearest' });
        document.getElementById('cmdTitle').focus({ preventScroll: true });
    }

    /**
     * Shared command: a viewer may only pick their own category, an editor everything but tags.
     * Called after the form is filled; for an own (or new) command it unlocks everything again.
     */
    function applyEditorAccess(item) {
        const own = !item || isOwn(item);
        const viewOnly = item?.access === 'view';
        editForm.classList.toggle('is-shared-item', !own);
        editForm.classList.toggle('is-view-only', viewOnly);
        editForm.querySelectorAll('#cmdTitle, #cmdDescription, .fragment-row input, .fragment-row textarea').forEach(field => { field.readOnly = viewOnly; });
        editForm.querySelector('[data-tag-input="cmdTags"]')?.classList.toggle('is-readonly', !own);
        const note = document.getElementById('cmdShareNote');
        note.hidden = own;
        note.textContent = own ? '' : `Megosztotta: ${item.shared_by || 'ismeretlen'}. ${viewOnly
            ? 'Csak megtekintheted, a kategóriát magadnak állíthatod.'
            : 'Szerkesztheted, a módosításaidat a tulajdonos is látja. A címkéket csak ő állíthatja.'}`;
        if (!own) aiRow.hidden = true;
    }

    categorySelect.addEventListener('change', () => {
        // Új parancsnál az üres nyelvmezőket kitölti a kategória alapnyelvével.
        if (editing) return;
        const language = defaultLanguageFor(categorySelect.value);
        fragmentsBox.querySelectorAll('.fragment-language').forEach(input => { if (!input.value) input.value = language; });
    });

    document.getElementById('cmdAddFragmentBtn').addEventListener('click', () => {
        const fragments = readFragments();
        fragments.push({ content: '', language: defaultLanguageFor(categorySelect.value), label: null });
        renderFragmentRows(fragments);
        const rows = fragmentsBox.querySelectorAll('.fragment-row');
        rows[rows.length - 1].querySelector('.fragment-label').focus();
    });

    fragmentsBox.addEventListener('click', event => {
        const remove = event.target.closest('.fragment-remove');
        if (!remove) return;
        const index = Number(remove.closest('.fragment-row').dataset.index);
        renderFragmentRows(readFragments().filter((_, position) => position !== index));
    });

    // ---------- AI kitöltés ----------
    // 1) bemásolt kódból kitölti a többi mezőt; 2) a címben / leírásban leírt célból megírja a parancsot is.
    // Csak gombnyomásra fut, és csak javasol: a mezők kiemelve kapják az értéket, Visszavonom visszaállítja őket.

    const ai = window.CloudMark.ai;
    const aiRow = document.getElementById('cmdAiRow');
    const aiButton = document.getElementById('cmdAiFillBtn');
    const aiOverwrite = document.getElementById('cmdAiOverwrite');
    const aiHint = document.getElementById('cmdAiHint');
    const aiExtras = document.getElementById('cmdAiExtras');
    const titleInput = document.getElementById('cmdTitle');
    const descriptionInput = document.getElementById('cmdDescription');
    const tagBox = editForm.querySelector('[data-tag-input="cmdTags"]');
    let aiSnapshot = null;
    let aiExtraTabs = [];
    // Az AI javasolta fülnév az első fülre, ha később egy javasolt második fület is hozzáadnak.
    let aiFirstLabel = '';
    let aiRun = 0;
    let aiBusy = false;

    function snapshotForm() {
        return {
            title: titleInput.value,
            description: descriptionInput.value,
            categoryId: categorySelect.value,
            tags: typeof getTagInputValues === 'function' ? getTagInputValues('cmdTags') : [],
            fragments: readFragments()
        };
    }

    function restoreForm(snapshot) {
        titleInput.value = snapshot.title;
        descriptionInput.value = snapshot.description;
        categorySelect.value = snapshot.categoryId;
        if (typeof setTagInputValues === 'function') setTagInputValues('cmdTags', snapshot.tags);
        renderFragmentRows(snapshot.fragments.length ? snapshot.fragments : [{ content: '', language: '', label: null }]);
    }

    const aiReview = ai ? ai.createReview(document.getElementById('cmdAiReview'), {
        onAccept: () => { aiSnapshot = null; },
        onUndo: () => {
            if (aiSnapshot) restoreForm(aiSnapshot);
            aiSnapshot = null;
            aiExtras.innerHTML = '';
        }
    }) : null;

    function setAiBusy(busy) {
        aiBusy = busy;
        aiButton.disabled = busy;
        aiButton.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> <span>AI dolgozik…</span>'
            : '<i class="fa-solid fa-wand-magic-sparkles"></i> <span>AI kitöltés</span>';
    }

    function resetAi() {
        aiRun += 1;
        aiReview?.clear();
        aiSnapshot = null;
        aiExtraTabs = [];
        aiExtras.innerHTML = '';
        setAiBusy(false);
    }

    function showAiRow(current) {
        const ready = Boolean(current && current.enabled && current.active);
        aiRow.hidden = !(current && current.enabled);
        aiButton.hidden = !ready;
        aiOverwrite.parentElement.hidden = !ready;
        aiHint.innerHTML = ready
            ? `Másold be a kódot, vagy írd a címbe, mit szeretnél. <span class="ai-fill-provider">${esc(current.active.providerLabel)}</span>`
            : 'Az AI kitöltéshez add meg a saját kulcsodat: <button type="button" class="ai-link" data-open-settings="ai">Beállítások → AI</button>';
    }

    function refreshAiRow() {
        if (ai) ai.status(true).then(showAiRow);
    }

    document.addEventListener('cloudmark:ai', event => showAiRow(event.detail));

    function renderAiExtras(suggestion) {
        const cards = [];
        if (suggestion.newCategory && !categorySelect.value) {
            cards.push(`<div class="ai-extra-card"><span><i class="fa-solid fa-folder-plus"></i> Új kategória javaslat: <strong>${esc(suggestion.newCategory)}</strong></span>
                <button type="button" class="btn btn-secondary" data-ai-extra="category" data-name="${esc(suggestion.newCategory)}">Létrehozom</button></div>`);
        }
        aiExtraTabs = suggestion.extraTabs || [];
        aiExtraTabs.forEach((tab, index) => {
            const firstLine = tab.code.split('\n')[0];
            cards.push(`<div class="ai-extra-card"><span><i class="fa-solid fa-plus"></i> Javasolt fül: <strong>${esc(tab.label || tab.language || 'Új fül')}</strong> <code>${esc(firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine)}</code></span>
                <button type="button" class="btn btn-secondary" data-ai-extra="tab" data-index="${index}">Fül hozzáadása</button></div>`);
        });
        aiExtras.innerHTML = cards.join('');
    }

    const LANGUAGE_LABELS = { bash: 'Bash', powershell: 'PowerShell', cmd: 'CMD', sh: 'sh', zsh: 'zsh', python: 'Python', sql: 'SQL', javascript: 'JavaScript', json: 'JSON', yaml: 'YAML', docker: 'Docker', git: 'Git',
        typescript: 'TypeScript', html: 'HTML', css: 'CSS', go: 'Go', java: 'Java', csharp: 'C#', php: 'PHP', regex: 'Regex', markdown: 'Markdown' };

    function languageLabel(language) {
        return LANGUAGE_LABELS[language] || language.charAt(0).toUpperCase() + language.slice(1);
    }

    function applySuggestion(suggestion, providerLabel) {
        // Ha még nyitott egy korábbi javaslat, a Visszavonom az AI előtti állapotra álljon vissza.
        const snapshot = aiReview.active && aiSnapshot ? aiSnapshot : snapshotForm();
        const overwrite = aiOverwrite.checked;
        // Leírt célnál a cím és a leírás mindig rendes szövegre íródik át.
        const rewriteText = suggestion.mode === 'fromText';
        const changed = [];
        const setField = (input, value, force) => {
            if (!value || input.value === value || (!force && !overwrite && input.value.trim())) return;
            input.value = value;
            changed.push(input);
        };
        setField(titleInput, suggestion.title, rewriteText);
        setField(descriptionInput, suggestion.description, rewriteText);
        if (suggestion.categoryId && (overwrite || !categorySelect.value) && categorySelect.value !== String(suggestion.categoryId)
            && categorySelect.querySelector(`option[value="${Number(suggestion.categoryId)}"]`)) {
            categorySelect.value = String(suggestion.categoryId);
            changed.push(categorySelect);
        }
        const currentTags = typeof getTagInputValues === 'function' ? getTagInputValues('cmdTags') : [];
        if (suggestion.tags.length && (overwrite || !currentTags.length) && suggestion.tags.join('\n') !== currentTags.join('\n')) {
            setTagInputValues('cmdTags', suggestion.tags);
            changed.push(tagBox);
        }
        const fragments = readFragments();
        if (!fragments.length) fragments.push({ content: '', language: '', label: null });
        let fragmentChanged = false;
        if (rewriteText && suggestion.code && !fragments[0].content.trim()) {
            fragments[0].content = suggestion.code;
            fragmentChanged = true;
        }
        if (suggestion.language && (overwrite || !fragments[0].language) && fragments[0].language !== suggestion.language) {
            fragments[0].language = suggestion.language;
            fragmentChanged = true;
        }
        // A fül neve csak több fülnél látszik a kártyán, ezért egy fülnél nem írjuk be.
        if (suggestion.label && fragments.length > 1 && (overwrite || !fragments[0].label) && fragments[0].label !== suggestion.label) {
            fragments[0].label = suggestion.label;
            fragmentChanged = true;
        }
        if (fragmentChanged) {
            renderFragmentRows(fragments);
            changed.push(fragmentsBox.querySelector('.fragment-row'));
        }
        aiFirstLabel = suggestion.label || '';
        renderAiExtras(suggestion);
        if (!changed.length) {
            if (!aiExtras.children.length) notify('Nincs mit kitölteni. Az összes mező újraírásához jelöld be a „Mindent újraír” lehetőséget.', 'info');
            return;
        }
        aiSnapshot = snapshot;
        aiReview.start(changed, `AI javaslat (${providerLabel}). Nézd át, írd át, ha kell, majd fogadd el vagy vond vissza.`);
    }

    async function runAiFill() {
        if (!ai || aiBusy || aiButton.hidden || aiRow.hidden) return;
        const first = readFragments()[0] || { content: '', language: '' };
        const input = { title: titleInput.value, description: descriptionInput.value, code: first.content, language: first.language || '' };
        if (!input.code.trim() && !input.title.trim() && !input.description.trim()) {
            notify('Írd be a kódot, vagy a címbe vagy a leírásba azt, hogy mit szeretnél.', 'error');
            titleInput.focus();
            return;
        }
        const run = ++aiRun;
        setAiBusy(true);
        try {
            const result = await ai.fill('command.fill', input);
            // Közben bezárták vagy újranyitották az űrlapot: a javaslat már nem ide tartozik.
            if (run !== aiRun) return;
            applySuggestion(result.suggestion, result.providerLabel);
        } catch (err) {
            if (run === aiRun) notify(err.message || 'Az AI kitöltés nem sikerült.', 'error');
        } finally {
            if (run === aiRun) setAiBusy(false);
        }
    }

    aiButton.addEventListener('click', runAiFill);
    editForm.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            runAiFill();
        }
    });

    aiExtras.addEventListener('click', async event => {
        const button = event.target.closest('[data-ai-extra]');
        if (!button) return;
        const card = button.closest('.ai-extra-card');
        if (button.dataset.aiExtra === 'category') {
            const name = button.dataset.name;
            button.disabled = true;
            try {
                await commandApi.createCategoryOfKind('command', name);
                await refreshCategories();
                const created = state.categories.find(category => category.name === name);
                fillCategorySelect(categorySelect, created ? created.id : '', 'Inbox (nincs kategória)');
                if (aiReview.active) aiReview.mark(categorySelect);
                card.remove();
                notify(`„${name}” kategória létrehozva.`, 'success');
            } catch (err) {
                button.disabled = false;
                notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
            }
            return;
        }
        const tab = aiExtraTabs[Number(button.dataset.index)];
        if (!tab) return;
        if (!aiReview.active) aiSnapshot = snapshotForm();
        const fragments = readFragments();
        // Két fülnél az első is kapjon nevet (a nyelvéből), különben a kártyán csak a nyelv látszik.
        if (fragments[0] && !fragments[0].label && (aiFirstLabel || fragments[0].language)) fragments[0].label = aiFirstLabel || languageLabel(fragments[0].language);
        fragments.push({ content: tab.code, language: tab.language || null, label: tab.label || null });
        renderFragmentRows(fragments);
        const rows = fragmentsBox.querySelectorAll('.fragment-row');
        if (aiReview.active) aiReview.mark(rows[rows.length - 1]);
        else aiReview.start([rows[rows.length - 1]], 'AI javasolt fül hozzáadva. Fogadd el vagy vond vissza.');
        card.remove();
    });

    document.getElementById('cmdCancelBtn').addEventListener('click', closeEditor);

    editForm.addEventListener('submit', async event => {
        event.preventDefault();
        const fragments = readFragments().filter(fragment => fragment.content.trim());
        if (!fragments.length) { notify('Adj meg legalább egy sor kódot.', 'error'); return; }
        const payload = {
            type: 'command',
            title: document.getElementById('cmdTitle').value.trim(),
            description: document.getElementById('cmdDescription').value.trim(),
            categoryId: categorySelect.value || null,
            tags: typeof getTagInputValues === 'function' ? getTagInputValues('cmdTags') : [],
            fragments,
            // A PUT minden mezőt felülír, ezért a nem szerkesztett értékeket visszaküldjük.
            starred: editing ? editing.starred : false,
            pinned: editing ? editing.pinned : false,
            color: editing ? editing.color : null,
            position: editing ? editing.position : null,
            extra: editing ? editing.extra : {}
        };
        // Megosztott parancsnál a szerver 409-cel jelzi, ha közben más módosította.
        if (editing && !isOwn(editing)) payload.expectedUpdatedAt = editing.updated_at;
        try {
            const saved = editing ? await commandApi.updateItem(editing.id, payload) : await commandApi.createItem(payload);
            upsertItem(saved);
            state.activeFragment.delete(saved.id);
            const wasEditing = Boolean(editing);
            closeEditor();
            render();
            notify(wasEditing ? 'Kódrészlet mentve.' : 'Kódrészlet létrehozva.', 'success');
        } catch (err) {
            if (err.status === 409 && err.body?.item) {
                // Valaki közben módosította: a friss változatot mutatjuk, a felhasználó újra elvégezheti a módosítást.
                upsertItem(err.body.item);
                render();
                openEditor(findItem(err.body.item.id));
            }
            notify(err.message || 'A mentés nem sikerült.', 'error');
        }
    });

    // ---------- kategóriák kezelése ----------

    const categoryList = document.getElementById('commandCategoryList');

    function renderCategoryManager() {
        fillCategorySelect(document.getElementById('cmdNewCategoryParent'), '', 'Nincs szülőkategória');
        const tree = categoryTree();
        categoryList.innerHTML = tree.length ? tree.map(category => `
            <div class="command-category-row" data-name="${esc(category.name)}">
                <span class="command-category-name">${esc(category.label)}${category.default_language ? ` <span class="command-lang">${esc(category.default_language)}</span>` : ''}</span>
                <button type="button" class="btn-icon" data-cat-action="rename" title="Átnevezés"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="btn-icon" data-cat-action="delete" title="Törlés"><i class="fa-solid fa-trash"></i></button>
            </div>`).join('') : '<div class="empty-state">Még nincs kódtár kategória.</div>';
    }

    async function openCategoryManager() {
        if (!state.loaded) await load();
        renderCategoryManager();
        openModal('commandCategoryModal');
    }

    async function refreshCategories() {
        state.categories = await commandApi.getCategoriesOfKind('command');
        // A kategórianév az elemeken is megjelenik, ezért azokat is frissítjük.
        state.items = await commandApi.getItems('command', { all: 'true' });
        renderCategoryManager();
        render();
    }

    document.getElementById('commandCategoryForm').addEventListener('submit', async event => {
        event.preventDefault();
        const nameInput = document.getElementById('cmdNewCategoryName');
        const languageInput = document.getElementById('cmdNewCategoryLanguage');
        try {
            await commandApi.createCategoryOfKind('command', nameInput.value.trim(), document.getElementById('cmdNewCategoryParent').value || null, languageInput.value.trim() || null);
            nameInput.value = '';
            languageInput.value = '';
            await refreshCategories();
        } catch (err) {
            notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
        }
    });

    categoryList.addEventListener('click', async event => {
        const button = event.target.closest('[data-cat-action]');
        if (!button) return;
        const row = button.closest('[data-name]');
        const name = row.dataset.name;
        try {
            if (button.dataset.catAction === 'rename') {
                const newName = prompt('Új név:', name);
                if (!newName || !newName.trim() || newName.trim() === name) return;
                await commandApi.renameCategoryOfKind('command', name, newName.trim());
            } else {
                if (!confirm(`Törlöd a(z) „${name}” kategóriát? A benne lévő kódrészletek az Inboxba kerülnek.`)) return;
                await commandApi.deleteCategoryOfKind('command', name);
            }
            await refreshCategories();
        } catch (err) {
            notify(err.message || 'A művelet nem sikerült.', 'error');
        }
    });

    /** The open command was deleted or unshared elsewhere. */
    function dropEditor() {
        closeEditor();
        notify('Ez a kódrészlet közben törlődött, vagy már nem éred el.', 'info');
    }

    /**
     * A newer copy of the command open in the editor arrived from elsewhere. The form is never refilled on its own:
     * a bar offers Frissítés (refill) or Saját változat megtartása (the next save measures against the newer copy, no 409).
     */
    function showRemoteInEditor(item) {
        if (!editing || String(editing.id) !== String(item.id) || !live()?.isNewer(item, editing)) return;
        live().conflictBar(editForm, {
            text: 'Ez a kódrészlet közben máshol módosult.',
            onReload: () => openEditor(findItem(item.id) || item),
            onKeep: () => { editing = { ...(findItem(item.id) || item) }; }
        });
    }

    window.CloudMark.commands = {
        show: () => load(),
        reset,
        openEditor,
        /** Opens a command's editor by id (used by links from tasks). */
        async openById(id) {
            await load();
            let item = findItem(id);
            // Frissen elfogadott megosztás még nincs a betöltött listában.
            if (!item) { await load(true); item = findItem(id); }
            if (item) openEditor(item);
        },
        /** A command changed elsewhere (live.js): `item` is the fresh copy, null when it is gone or no longer visible. */
        applyRemote(id, item) {
            if (!state.loaded) return;
            const previous = findItem(id);
            if (!item || item.type !== 'command') {
                if (!previous) return;
                forget(previous);
                if (editing && String(editing.id) === String(id)) dropEditor();
                return;
            }
            upsertItem(item);
            render();
            showRemoteInEditor(item);
        },
        /** Reloads the list quietly after the live connection was lost for a while. */
        async refreshAll() {
            if (!state.loaded) return;
            try { state.items = await commandApi.getItems('command', { all: 'true' }); } catch (err) { return; }
            render();
            if (!editing?.id) return;
            const current = findItem(editing.id);
            if (current) showRemoteInEditor(current);
            else dropEditor();
        },
        focusSearch: () => searchInput.focus(),
        copyRules
    };
})();
