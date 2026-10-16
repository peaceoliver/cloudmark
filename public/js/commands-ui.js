/* Parancstár: parancskártyák, másológombok, szerkesztő és kategóriák. Az adat a /api/items végpontokról jön. */
(function () {
    const commandApi = window.CloudMark.api;
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
        openIds: new Set()
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
        grid.innerHTML = '<div class="empty-state">Parancsok betöltése…</div>';
        state.loading = Promise.all([
            commandApi.getItems('command', { all: 'true' }),
            commandApi.getCategoriesOfKind('command')
        ]).then(([items, categories]) => {
            state.items = items;
            state.categories = categories;
            state.loaded = true;
            render();
        }).catch(err => {
            grid.innerHTML = `<div class="empty-state">A parancsok betöltése nem sikerült: ${esc(err.message)}</div>`;
        }).finally(() => { state.loading = null; });
        return state.loading;
    }

    function reset() {
        state.items = [];
        state.categories = [];
        state.loaded = false;
        state.category = 'all';
        state.query = '';
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

    function visibleItems() {
        const query = state.query.trim().toLowerCase();
        const categoryIds = /^\d+$/.test(state.category) ? descendantIds(state.category) : null;
        const list = state.items.filter(item => {
            if (state.filter === 'trash') { if (!item.trashed) return false; }
            else if (item.trashed || item.archived) return false;
            if (state.filter === 'starred' && !item.starred) return false;
            if (state.category === 'inbox' && item.category_id !== null) return false;
            if (categoryIds && !(item.category_id !== null && categoryIds.has(Number(item.category_id)))) return false;
            if (!query) return true;
            return [item.title, item.description, item.category_name, ...item.fragments.map(fragment => fragment.content), ...item.tags]
                .some(value => String(value || '').toLowerCase().includes(query));
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
        const tabs = fragments.length > 1 ? `
            <div class="command-tabs" role="tablist">
                ${fragments.map((entry, index) => `<button type="button" class="command-tab ${index === fragmentIndex ? 'active' : ''}" role="tab" aria-selected="${index === fragmentIndex}" data-action="tab" data-index="${index}">${esc(entry.label || entry.language || `${index + 1}. fül`)}</button>`).join('')}
            </div>` : '';
        const lineHtml = lines.map((line, index) => `
            <div class="code-line">
                <button type="button" class="line-copy-btn" data-action="copy-line" data-line="${index}" title="Csak ezen sor másolása (kommentek nélkül)" aria-label="Sor másolása"><i class="fa-regular fa-copy"></i></button>
                <pre><code>${esc(line) || ' '}</code></pre>
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
            <button type="button" class="action-btn" data-action="edit" title="Szerkesztés"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="action-btn" data-action="trash" title="Kukába"><i class="fa-solid fa-trash"></i></button>`;
        return `
            <article class="card command-card ${state.openIds.has(item.id) ? 'is-open' : ''}" data-item-id="${Number(item.id)}">
                <div>
                    <div class="command-card-head">
                        <h3 class="card-title">${esc(item.title)}</h3>
                        <div class="command-card-actions">
                            ${item.trashed ? '' : '<button type="button" class="action-btn command-quick-copy" data-action="copy-all" title="Másolás" aria-label="Másolás"><i class="fa-regular fa-copy"></i></button>'}
                            ${stateButtons}
                        </div>
                    </div>
                    <div class="command-card-meta">
                        <span class="card-category">${esc(item.category_name || 'Inbox')}</span>
                        ${fragment.language ? `<span class="command-lang">${esc(fragment.language)}</span>` : ''}
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
        prefs.markSwitcher(viewSwitcher, state.view);
        const list = visibleItems();
        if (!state.items.length) {
            grid.innerHTML = '<div class="empty-state">Még nincs parancsod. Hozz létre egyet az „Új parancs” gombbal, vagy importáld a meglévő listádat (⋮ → Import).</div>';
            return;
        }
        if (!list.length) {
            grid.innerHTML = `<div class="empty-state">${state.filter === 'trash' ? 'A kuka üres.' : 'Nincs a keresésnek megfelelő parancs.'}</div>`;
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
        if (action === 'trash') return changeState(item, { trashed: true }, 'Parancs a kukába helyezve.');
        if (action === 'restore') return changeState(item, { trashed: false }, 'Parancs visszaállítva.');
        if (action === 'delete') {
            if (!confirm(`Véglegesen törlöd: „${item.title}”?`)) return;
            try {
                await commandApi.deleteItemPermanently(item.id);
                state.items = state.items.filter(entry => entry.id !== item.id);
                render();
                notify('Parancs véglegesen törölve.', 'success');
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
        }
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.cmd-dropdown') && !event.target.closest('[data-action="menu"]') && !event.target.closest('#commandMoreBtn')) closeDropdowns();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDropdowns(); });

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

    document.getElementById('commandNewBtn').addEventListener('click', () => openEditor(null));

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
        if (action === 'export-json' || action === 'export-md') {
            const format = action === 'export-md' ? 'md' : 'json';
            try {
                const blob = await commandApi.exportItems('command', format);
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `cloudmark-parancsok.${format}`;
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
            notify('A fájl nem érvényes parancslista (JSON tömb vagy CloudMark export).', 'error');
            return;
        }
        if (!confirm(`${items.length} parancs importálása. Folytatod?`)) return;
        try {
            const result = await commandApi.importItems('command', items);
            await load(true);
            notify(`${result.imported} parancs importálva.`, 'success');
        } catch (err) {
            notify(err.message || 'Az importálás nem sikerült.', 'error');
        }
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
            language: row.querySelector('.fragment-language').value.trim() || null,
            content: row.querySelector('.fragment-content').value
        }));
    }

    function renderFragmentRows(fragments) {
        fragmentsBox.innerHTML = fragments.map((fragment, index) => fragmentRowHtml(fragment, index, fragments.length)).join('');
    }

    async function openEditor(item) {
        if (!state.loaded) await load();
        editing = item;
        document.getElementById('commandEditTitle').textContent = item ? 'Parancs szerkesztése' : 'Új parancs';
        document.getElementById('cmdId').value = item ? item.id : '';
        document.getElementById('cmdTitle').value = item?.title || '';
        document.getElementById('cmdDescription').value = item?.description || '';
        const categoryId = item ? item.category_id : (/^\d+$/.test(state.category) ? state.category : '');
        fillCategorySelect(categorySelect, categoryId ?? '', 'Inbox (nincs kategória)');
        if (typeof setTagInputValues === 'function') setTagInputValues('cmdTags', item?.tags || []);
        renderFragmentRows(item && item.fragments.length ? item.fragments : [{ content: '', language: defaultLanguageFor(categoryId) }]);
        openModal('commandEditModal');
        setTimeout(() => document.getElementById('cmdTitle').focus(), 50);
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
        try {
            const saved = editing ? await commandApi.updateItem(editing.id, payload) : await commandApi.createItem(payload);
            upsertItem(saved);
            state.activeFragment.delete(saved.id);
            closeModal('commandEditModal');
            render();
            notify(editing ? 'Parancs mentve.' : 'Parancs létrehozva.', 'success');
            editing = null;
        } catch (err) {
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
            </div>`).join('') : '<div class="empty-state">Még nincs parancs kategória.</div>';
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
                if (!confirm(`Törlöd a(z) „${name}” kategóriát? A benne lévő parancsok az Inboxba kerülnek.`)) return;
                await commandApi.deleteCategoryOfKind('command', name);
            }
            await refreshCategories();
        } catch (err) {
            notify(err.message || 'A művelet nem sikerült.', 'error');
        }
    });

    window.CloudMark.commands = {
        show: () => load(),
        reset,
        openEditor,
        /** Opens a command's editor by id (used by links from tasks). */
        async openById(id) {
            await load();
            const item = findItem(id);
            if (item) openEditor(item);
        },
        focusSearch: () => searchInput.focus(),
        copyRules
    };
})();
