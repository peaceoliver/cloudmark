/* Jegyzetek (Google Keep-szerű): gyors-hozzáadás, színes kártyák, checklist, rögzítés, archív, kuka. */
(function () {
    const noteApi = window.CloudMark.api;
    const AUTOSAVE_MS = 800;
    const COLORS = [
        { key: '', label: 'Alapértelmezett' },
        { key: 'red', label: 'Piros' },
        { key: 'orange', label: 'Narancs' },
        { key: 'yellow', label: 'Sárga' },
        { key: 'green', label: 'Zöld' },
        { key: 'teal', label: 'Türkiz' },
        { key: 'blue', label: 'Kék' },
        { key: 'purple', label: 'Lila' },
        { key: 'pink', label: 'Rózsaszín' },
        { key: 'brown', label: 'Barna' },
        { key: 'gray', label: 'Szürke' }
    ];
    const COLOR_KEYS = new Set(COLORS.map(color => color.key));

    // category: 'all', 'none' (kategória nélkül) vagy egy kategória id-ja szövegként.
    const prefs = window.CloudMark.prefs;
    const state = {
        items: [], categories: [], loaded: false, loading: null, query: '', label: null, category: 'all', filter: 'active',
        sort: prefs.get('noteSort'), view: prefs.get('noteView')
    };
    const NEW_CATEGORY = '__new__';

    const sections = document.getElementById('noteSections');
    const labelsBar = document.getElementById('noteLabelsBar');
    const categoriesBar = document.getElementById('noteCategoriesBar');
    const searchInput = document.getElementById('noteSearch');
    const sortSelect = document.getElementById('noteSortSelect');
    const viewSwitcher = document.getElementById('noteViewSwitcher');
    const searchClear = document.getElementById('noteSearchClear');
    const composerWrap = document.getElementById('noteComposerWrap');
    const newSection = document.getElementById('noteNewSection');
    const newButton = document.getElementById('noteNewBtn');
    const editBox = document.getElementById('noteEditBox');
    if (!sections) return;

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    function colorClass(color) {
        return COLOR_KEYS.has(color || '') && color ? `note-color-${color}` : '';
    }

    function checklistOf(item) {
        return Array.isArray(item?.extra?.checklist) ? item.extra.checklist : null;
    }

    function parseTags(text) {
        return String(text || '').split(',').map(tag => tag.trim()).filter(Boolean);
    }

    /** Builds the full PUT/POST body; the server replaces every field, so untouched values are sent back. */
    function notePayload(item, overrides = {}) {
        const merged = { ...item, ...overrides };
        return {
            type: 'note',
            title: merged.title || null,
            body: merged.body || null,
            color: merged.color || null,
            pinned: Boolean(merged.pinned),
            starred: Boolean(merged.starred),
            position: merged.position ?? null,
            categoryId: merged.category_id ?? null,
            tags: merged.tags || [],
            extra: merged.extra || {},
            fragments: []
        };
    }

    function isEmptyNote(note) {
        const checklist = checklistOf(note);
        return !String(note.title || '').trim() && !String(note.body || '').trim() && !(checklist && checklist.some(entry => entry.text.trim()));
    }

    // ---------- adatok ----------

    async function load(force = false) {
        if (state.loaded && !force) return;
        if (state.loading && !force) return state.loading;
        sections.innerHTML = '<div class="empty-state">Jegyzetek betöltése…</div>';
        state.loading = Promise.all([noteApi.getItems('note', { all: 'true' }), noteApi.getCategoriesOfKind('note')]).then(([items, categories]) => {
            state.items = items;
            setCategories(categories);
            state.loaded = true;
            render();
        }).catch(err => {
            sections.innerHTML = `<div class="empty-state">A jegyzetek betöltése nem sikerült: ${esc(err.message)}</div>`;
        }).finally(() => { state.loading = null; });
        renderComposer();
        return state.loading;
    }

    function reset() {
        state.items = [];
        state.loaded = false;
        state.query = '';
        state.label = null;
        state.categories = [];
        state.category = 'all';
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        sections.innerHTML = '';
        labelsBar.innerHTML = '';
        categoriesBar.innerHTML = '';
        composerWrap.innerHTML = '';
        composerWrap.hidden = true;
    }

    function upsert(item) {
        const index = state.items.findIndex(existing => existing.id === item.id);
        if (index === -1) state.items.unshift(item);
        else state.items[index] = item;
    }

    function findItem(id) {
        return state.items.find(item => String(item.id) === String(id));
    }

    function setCategories(categories) {
        state.categories = [...categories].sort((a, b) => a.name.localeCompare(b.name, 'hu'));
    }

    function findCategory(id) {
        return state.categories.find(category => String(category.id) === String(id));
    }

    /** Asks for a name and creates a note category; returns the new category or null. */
    async function createCategory() {
        const name = (prompt('Új kategória neve:') || '').trim();
        if (!name) return null;
        try {
            setCategories(await noteApi.createCategoryOfKind('note', name));
            return state.categories.find(category => category.name.toLowerCase() === name.toLowerCase()) || null;
        } catch (err) {
            notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
            return null;
        }
    }

    async function renameCategory(category) {
        const name = (prompt('A kategória új neve:', category.name) || '').trim();
        if (!name || name === category.name) return;
        try {
            await noteApi.renameCategoryOfKind('note', category.name, name);
            category.name = name;
            setCategories(state.categories);
            state.items.forEach(item => { if (String(item.category_id) === String(category.id)) item.category_name = name; });
            render();
            notify('Kategória átnevezve.', 'success');
        } catch (err) {
            notify(err.message || 'Az átnevezés nem sikerült.', 'error');
        }
    }

    async function deleteCategory(category) {
        if (!confirm(`Törlöd a(z) „${category.name}” kategóriát? A benne lévő jegyzetek megmaradnak, és a Kategória nélkül szűrőbe kerülnek.`)) return;
        try {
            await noteApi.deleteCategoryOfKind('note', category.name);
            setCategories(state.categories.filter(entry => entry.id !== category.id));
            state.items.forEach(item => {
                if (String(item.category_id) === String(category.id)) { item.category_id = null; item.category_name = null; }
            });
            if (state.category === String(category.id)) state.category = 'all';
            render();
            notify('Kategória törölve.', 'success');
        } catch (err) {
            notify(err.message || 'A törlés nem sikerült.', 'error');
        }
    }

    async function saveNote(item, overrides) {
        const saved = await noteApi.updateItem(item.id, notePayload(item, overrides));
        upsert(saved);
        return saved;
    }

    // ---------- megjelenítés ----------

    /** Whether the note belongs to the current Jegyzetek / Archívum / Kuka tab. */
    function inCurrentTab(item) {
        if (state.filter === 'trash') return Boolean(item.trashed);
        if (item.trashed) return false;
        return state.filter === 'archived' ? Boolean(item.archived) : !item.archived;
    }

    function visibleNotes() {
        const query = state.query.trim().toLowerCase();
        return state.items.filter(item => {
            if (!inCurrentTab(item)) return false;
            if (state.category === 'none' && item.category_id !== null && item.category_id !== undefined) return false;
            if (/^\d+$/.test(state.category) && String(item.category_id) !== state.category) return false;
            if (state.label && !item.tags.includes(state.label)) return false;
            if (!query) return true;
            const checklist = checklistOf(item) || [];
            return [item.title, item.body, ...item.tags, ...checklist.map(entry => entry.text)]
                .some(value => String(value || '').toLowerCase().includes(query));
        }).sort(compareNotes);
    }

    function compareNotes(a, b) {
        if (state.sort === 'abc') {
            const label = note => String(note.title || note.body || checklistOf(note)?.[0]?.text || '').trim();
            return label(a).localeCompare(label(b), 'hu') || new Date(b.updated_at) - new Date(a.updated_at);
        }
        const field = state.sort === 'newest' ? 'created_at' : 'updated_at';
        return new Date(b[field]) - new Date(a[field]);
    }

    function renderCategories() {
        const addChip = `<button type="button" class="category-chip note-category-add" data-note-category-add title="Új kategória"><i class="fa-solid fa-plus"></i> ${state.categories.length ? '' : 'Új kategória'}</button>`;
        if (!state.categories.length) {
            state.category = 'all';
            categoriesBar.innerHTML = addChip;
            return;
        }
        const pool = state.items.filter(inCurrentTab);
        const chips = [{ key: 'all', label: 'Összes', count: pool.length }];
        chips.push({ key: 'none', label: 'Kategória nélkül', count: pool.filter(item => item.category_id === null || item.category_id === undefined).length });
        state.categories.forEach(category => chips.push({
            key: String(category.id), label: category.name, icon: true, menu: true,
            count: pool.filter(item => String(item.category_id) === String(category.id)).length
        }));
        if (!chips.some(chip => chip.key === state.category)) state.category = 'all';
        categoriesBar.innerHTML = chips.map(chip => `
            <div class="note-category-chip-wrap">
                <button type="button" class="category-chip ${chip.key === state.category ? 'active' : ''}" data-note-category="${esc(chip.key)}">
                    ${chip.icon ? '<i class="fa-regular fa-folder"></i>' : ''}${esc(chip.label)} <span class="command-chip-count">${chip.count}</span>
                </button>
                ${chip.menu ? `
                <button type="button" class="btn-icon note-category-more" data-note-category-menu="${esc(chip.key)}" title="Kategória műveletek" aria-label="${esc(chip.label)} műveletek"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                <div class="note-category-dropdown" role="menu">
                    <button type="button" class="cmd-dropdown-item" data-note-category-action="rename" data-category-id="${esc(chip.key)}"><i class="fa-solid fa-pen"></i> Átnevezés</button>
                    <button type="button" class="cmd-dropdown-item" data-note-category-action="delete" data-category-id="${esc(chip.key)}"><i class="fa-solid fa-trash"></i> Törlés</button>
                </div>` : ''}
            </div>`).join('') + addChip;
    }

    function renderLabels() {
        const labels = [...new Set(state.items.filter(item => !item.trashed).flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b, 'hu'));
        if (state.label && !labels.includes(state.label)) state.label = null;
        labelsBar.innerHTML = labels.length ? [`<button type="button" class="category-chip ${state.label ? '' : 'active'}" data-label="">Összes</button>`]
            .concat(labels.map(label => `<button type="button" class="category-chip ${label === state.label ? 'active' : ''}" data-label="${esc(label)}"><i class="fa-solid fa-tag"></i> ${esc(label)}</button>`)).join('') : '';
    }

    function noteBodyHtml(item) {
        const checklist = checklistOf(item);
        if (checklist) {
            const open = checklist.map((entry, index) => ({ ...entry, index })).filter(entry => !entry.done);
            const done = checklist.map((entry, index) => ({ ...entry, index })).filter(entry => entry.done);
            const row = entry => `
                <label class="note-check ${entry.done ? 'is-done' : ''}">
                    <input type="checkbox" data-action="check" data-index="${entry.index}" ${entry.done ? 'checked' : ''} ${item.trashed ? 'disabled' : ''}>
                    <span>${esc(entry.text)}</span>
                </label>`;
            return `<div class="note-checklist">${open.map(row).join('')}${done.length ? `<div class="note-check-done-label">${done.length} kipipált elem</div>${done.map(row).join('')}` : ''}</div>`;
        }
        return item.body ? `<div class="note-body">${esc(item.body)}</div>` : '';
    }

    function paletteHtml(current) {
        return `<div class="note-palette" role="menu">${COLORS.map(color => `
            <button type="button" class="note-swatch ${colorClass(color.key) || 'note-color-default'} ${color.key === (current || '') ? 'active' : ''}" data-action="set-color" data-color="${color.key}" title="${color.label}" aria-label="${color.label}"></button>`).join('')}</div>`;
    }

    function cardHtml(item) {
        const actions = item.trashed ? `
            <button type="button" class="note-action" data-action="restore" title="Visszaállítás"><i class="fa-solid fa-rotate-left"></i></button>
            <button type="button" class="note-action" data-action="delete" title="Végleges törlés"><i class="fa-solid fa-trash-can"></i></button>` : `
            <div class="note-color-menu">
                <button type="button" class="note-action" data-action="palette" title="Háttérszín"><i class="fa-solid fa-palette"></i></button>
                ${paletteHtml(item.color)}
            </div>
            <button type="button" class="note-action" data-action="${item.archived ? 'unarchive' : 'archive'}" title="${item.archived ? 'Visszahelyezés az archívumból' : 'Archiválás'}"><i class="fa-solid ${item.archived ? 'fa-box-open' : 'fa-box-archive'}"></i></button>
            <button type="button" class="note-action" data-action="trash" title="Törlés"><i class="fa-solid fa-trash"></i></button>`;
        return `
            <article class="note-card ${colorClass(item.color)}" data-item-id="${Number(item.id)}" tabindex="0">
                ${item.trashed ? '' : `<button type="button" class="note-pin ${item.pinned ? 'is-pinned' : ''}" data-action="pin" title="${item.pinned ? 'Rögzítés feloldása' : 'Rögzítés'}"><i class="fa-solid fa-thumbtack"></i></button>`}
                ${item.title ? `<h3 class="note-title">${esc(item.title)}</h3>` : ''}
                ${item.category_name ? `<div class="card-meta note-card-meta"><span class="card-category">${esc(item.category_name)}</span></div>` : ''}
                ${noteBodyHtml(item)}
                ${item.tags.length ? `<div class="card-tags">${item.tags.map(tag => `#${esc(tag)}`).join(' ')}</div>` : ''}
                <div class="note-actions">${actions}</div>
            </article>`;
    }

    /** Kanban: one column per note category (plus „Kategória nélkül”); cards move between columns by dragging. */
    function kanbanColumns() {
        const none = { key: 'none', id: null, name: 'Kategória nélkül' };
        const own = state.categories.map(category => ({ key: String(category.id), id: category.id, name: category.name }));
        if (state.category === 'none') return [none];
        if (/^\d+$/.test(state.category)) return own.filter(column => column.key === state.category);
        return [none, ...own];
    }

    function renderKanban(list) {
        const columns = kanbanColumns();
        const canAdd = state.filter === 'active';
        const ordered = notes => state.filter === 'active' ? [...notes.filter(item => item.pinned), ...notes.filter(item => !item.pinned)] : notes;
        sections.innerHTML = `<div class="notes-kanban">${columns.map(column => {
            const notes = ordered(list.filter(item => column.id === null
                ? item.category_id === null || item.category_id === undefined
                : String(item.category_id) === column.key));
            return `
                <section class="kanban-column" data-kanban-column="${esc(column.key)}" aria-label="${esc(column.name)}">
                    <div class="kanban-column-head"><span>${esc(column.name)}</span><span class="command-chip-count">${notes.length}</span></div>
                    <div class="kanban-column-body">${notes.map(cardHtml).join('') || '<div class="kanban-empty">Húzz ide egy jegyzetet</div>'}</div>
                    ${canAdd ? `<button type="button" class="kanban-add" data-kanban-add="${esc(column.key)}"><i class="fa-solid fa-plus"></i> Jegyzet</button>` : ''}
                </section>`;
        }).join('')}${canAdd && state.category === 'all' ? '<button type="button" class="kanban-new-column" data-kanban-new-category><i class="fa-solid fa-folder-plus"></i> Új kategória</button>' : ''}</div>`;
    }

    function renderNotes() {
        sections.classList.remove('notes-view-grid', 'notes-view-compact', 'notes-view-list', 'notes-view-kanban');
        sections.classList.add(`notes-view-${state.view}`);
        prefs.markSwitcher(viewSwitcher, state.view);
        const list = visibleNotes();
        if (state.view === 'kanban') return renderKanban(list);
        if (!list.length) {
            const message = state.query || state.label ? 'Nincs a keresésnek megfelelő jegyzet.'
                : state.category === 'none' ? 'Nincs kategória nélküli jegyzet.'
                : state.category !== 'all' ? 'Ebben a kategóriában még nincs jegyzet.'
                : state.filter === 'trash' ? 'A kuka üres.'
                : state.filter === 'archived' ? 'Nincs archivált jegyzet.'
                : 'Még nincs jegyzeted. Írd be az elsőt fent!';
            sections.innerHTML = `<div class="empty-state notes-empty">${message}</div>`;
            return;
        }
        if (state.filter !== 'active') {
            sections.innerHTML = `<div class="notes-grid">${list.map(cardHtml).join('')}</div>`;
            return;
        }
        const pinned = list.filter(item => item.pinned);
        const others = list.filter(item => !item.pinned);
        sections.innerHTML = (pinned.length ? `<div class="notes-section-title">Rögzített</div><div class="notes-grid">${pinned.map(cardHtml).join('')}</div>` : '')
            + (others.length ? `${pinned.length ? '<div class="notes-section-title">Egyéb</div>' : ''}<div class="notes-grid">${others.map(cardHtml).join('')}</div>` : '');
    }

    function render() {
        renderCategories();
        renderLabels();
        renderNotes();
        newSection.hidden = state.filter !== 'active';
    }

    // ---------- szerkesztő (közös a gyors-hozzáadáshoz és a modálhoz) ----------

    function editorHtml(note, { composer }) {
        const checklist = checklistOf(note);
        const items = checklist ? checklist.map(entry => checkRowHtml(entry)).join('') + checkRowHtml({ text: '', done: false }) : '';
        return `
            <div class="note-editor ${colorClass(note.color)}" data-color="${esc(note.color || '')}">
                <input type="text" class="note-editor-title" maxlength="300" placeholder="Cím" value="${esc(note.title || '')}" aria-label="Cím">
                ${checklist
                    ? `<div class="note-editor-checklist">${items}</div>`
                    : `<textarea class="note-editor-body" rows="${composer ? 3 : 8}" placeholder="Jegyzet írása…" aria-label="Jegyzet">${esc(note.body || '')}</textarea>`}
                <div class="note-editor-meta">
                    <label class="note-editor-category-wrap" title="Kategória">
                        <i class="fa-regular fa-folder"></i>
                        <select class="note-editor-category" aria-label="Kategória">${categoryOptionsHtml(note.category_id)}</select>
                    </label>
                    <input type="text" class="note-editor-tags" placeholder="Címkék vesszővel (pl. ötlet, munka)" value="${esc((note.tags || []).join(', '))}" aria-label="Címkék">
                </div>
                <div class="note-editor-bar">
                    <div class="note-color-menu">
                        <button type="button" class="note-action" data-editor="palette" title="Háttérszín"><i class="fa-solid fa-palette"></i></button>
                        ${paletteHtml(note.color).replace(/data-action="set-color"/g, 'data-editor="set-color"')}
                    </div>
                    <button type="button" class="note-action" data-editor="toggle-checklist" title="${checklist ? 'Szöveges jegyzet' : 'Jelölőnégyzetek'}"><i class="fa-regular ${checklist ? 'fa-file-lines' : 'fa-square-check'}"></i></button>
                    <button type="button" class="note-action ${note.pinned ? 'is-pinned' : ''}" data-editor="pin" title="Rögzítés"><i class="fa-solid fa-thumbtack"></i></button>
                    <span class="note-editor-status" aria-live="polite"></span>
                    <button type="button" class="btn btn-secondary note-editor-close" data-editor="close">Bezárás</button>
                </div>
            </div>`;
    }

    function categoryOptionsHtml(selectedId) {
        const selected = selectedId === null || selectedId === undefined ? '' : String(selectedId);
        return `<option value="">Kategória nélkül</option>`
            + state.categories.map(category => `<option value="${Number(category.id)}" ${String(category.id) === selected ? 'selected' : ''}>${esc(category.name)}</option>`).join('')
            + `<option value="${NEW_CATEGORY}">+ Új kategória…</option>`;
    }

    function checkRowHtml(entry) {
        return `
            <div class="note-editor-check">
                <input type="checkbox" class="note-editor-check-done" ${entry.done ? 'checked' : ''} aria-label="Kész">
                <input type="text" class="note-editor-check-text" maxlength="1000" placeholder="Listaelem" value="${esc(entry.text)}" aria-label="Listaelem">
                <button type="button" class="note-action" data-editor="remove-check" title="Elem törlése" aria-label="Elem törlése"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
    }

    function categoryValue(select) {
        return select && /^\d+$/.test(select.value) ? Number(select.value) : null;
    }

    /** Reads the editor fields back into note fields. */
    function readEditor(root, base) {
        const editor = root.querySelector('.note-editor');
        const checklistBox = editor.querySelector('.note-editor-checklist');
        const extra = { ...(base.extra || {}) };
        let body = null;
        if (checklistBox) {
            extra.checklist = Array.from(checklistBox.querySelectorAll('.note-editor-check'))
                .map(row => ({ text: row.querySelector('.note-editor-check-text').value, done: row.querySelector('.note-editor-check-done').checked }))
                .filter(entry => entry.text.trim());
        } else {
            delete extra.checklist;
            body = editor.querySelector('.note-editor-body').value;
        }
        return {
            ...base,
            title: editor.querySelector('.note-editor-title').value.trim(),
            body,
            color: editor.dataset.color || null,
            pinned: editor.querySelector('[data-editor="pin"]').classList.contains('is-pinned'),
            tags: parseTags(editor.querySelector('.note-editor-tags').value),
            category_id: categoryValue(editor.querySelector('.note-editor-category')),
            extra
        };
    }

    /** Wires an editor rendered into `root`; `onChange` runs after every edit, `onClose` on the close button. */
    function bindEditor(root, getBase, setBase, { onChange, onClose }) {
        root.addEventListener('input', event => {
            const text = event.target.closest('.note-editor-check-text');
            // Az utolsó (üres) sorba írva új üres sor jelenik meg, mint a Keepben.
            if (text && text.closest('.note-editor-check') === text.closest('.note-editor-checklist').lastElementChild && text.value) {
                text.closest('.note-editor-checklist').insertAdjacentHTML('beforeend', checkRowHtml({ text: '', done: false }));
            }
            onChange();
        });
        root.addEventListener('change', async event => {
            if (event.target.matches('.note-editor-check-done')) onChange();
            const select = event.target.closest('.note-editor-category');
            if (!select) return;
            if (select.value === NEW_CATEGORY) {
                const previous = getBase()?.category_id ?? null;
                const created = await createCategory();
                const keep = created ? created.id : previous;
                document.querySelectorAll('.note-editor-category').forEach(other => {
                    const value = other === select ? keep : categoryValue(other);
                    other.innerHTML = categoryOptionsHtml(value);
                });
                if (!created) return;
                renderCategories();
            }
            onChange();
        });
        root.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target.matches('.note-editor-check-text')) {
                event.preventDefault();
                const row = event.target.closest('.note-editor-check');
                const next = row.nextElementSibling || (row.insertAdjacentHTML('afterend', checkRowHtml({ text: '', done: false })), row.nextElementSibling);
                next.querySelector('.note-editor-check-text').focus();
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onClose(); }
        });
        root.addEventListener('click', event => {
            const button = event.target.closest('[data-editor]');
            if (!button) return;
            const editor = root.querySelector('.note-editor');
            const action = button.dataset.editor;
            if (action === 'palette') {
                editor.querySelector('.note-palette').classList.toggle('show');
                return;
            }
            if (action === 'set-color') {
                const color = button.dataset.color;
                COLORS.forEach(entry => { if (entry.key) editor.classList.remove(`note-color-${entry.key}`); });
                if (color) editor.classList.add(`note-color-${color}`);
                editor.dataset.color = color;
                editor.querySelectorAll('.note-swatch').forEach(swatch => swatch.classList.toggle('active', swatch === button));
                editor.querySelector('.note-palette').classList.remove('show');
                onChange();
                return;
            }
            if (action === 'pin') {
                button.classList.toggle('is-pinned');
                onChange();
                return;
            }
            if (action === 'remove-check') {
                button.closest('.note-editor-check').remove();
                onChange();
                return;
            }
            if (action === 'toggle-checklist') {
                // Szöveg ↔ lista: a sorokból listaelemek lesznek és fordítva, ahogy a Keepben.
                const current = readEditor(root, getBase());
                const checklist = checklistOf(current);
                const next = checklist
                    ? { ...current, body: checklist.map(entry => entry.text).join('\n'), extra: (({ checklist: _, ...rest }) => rest)(current.extra) }
                    : { ...current, body: null, extra: { ...current.extra, checklist: String(current.body || '').split('\n').filter(line => line.trim()).map(text => ({ text, done: false })) } };
                setBase(next);
                root.innerHTML = editorHtml(next, { composer: root === composerWrap });
                onChange();
                return;
            }
            if (action === 'close') onClose();
        });
    }

    // ---------- gyors-hozzáadás ----------

    let composerNote = null;
    let composerSaving = false;

    // A felső „Jegyzet írása…” sáv nyitja; a szerkesztő közvetlenül a sáv alatt jelenik meg.
    function renderComposer() {
        composerNote = null;
        composerWrap.classList.remove('is-open');
        composerWrap.innerHTML = '';
        composerWrap.hidden = true;
    }

    /** Opens the new-note editor under the bar; `categoryKey` ('none' or an id) preselects a category (kanban „+ Jegyzet”). */
    function openComposer(categoryKey) {
        if (state.filter !== 'active') return;
        const key = typeof categoryKey === 'string' ? categoryKey : state.category;
        composerNote = {
            title: '', body: '', color: null, pinned: false, tags: state.label ? [state.label] : [], extra: {},
            category_id: /^\d+$/.test(key) ? Number(key) : null
        };
        composerWrap.hidden = false;
        composerWrap.classList.add('is-open');
        composerWrap.innerHTML = editorHtml(composerNote, { composer: true });
        composerWrap.querySelector('.note-editor-body').focus({ preventScroll: true });
        composerWrap.scrollIntoView({ block: 'nearest' });
    }

    async function closeComposer() {
        if (!composerNote || composerSaving) return;
        const note = readEditor(composerWrap, composerNote);
        renderComposer();
        if (isEmptyNote(note)) return;
        composerSaving = true;
        try {
            upsert(await noteApi.createItem(notePayload(note)));
            render();
        } catch (err) {
            notify(err.message || 'A jegyzet mentése nem sikerült.', 'error');
        } finally {
            composerSaving = false;
        }
    }

    newButton.addEventListener('click', () => { if (!composerNote) openComposer(); });
    bindEditor(composerWrap, () => composerNote, next => { composerNote = next; }, { onChange: () => {}, onClose: closeComposer });
    document.addEventListener('mousedown', event => {
        if (composerNote && !composerWrap.contains(event.target) && !newButton.contains(event.target)) closeComposer();
    });

    // ---------- szerkesztő modál automatikus mentéssel ----------

    let editing = null;
    let saveTimer = null;
    let savePromise = Promise.resolve();

    function setStatus(text) {
        const status = editBox.querySelector('.note-editor-status');
        if (status) status.textContent = text;
    }

    function queueSave() {
        clearTimeout(saveTimer);
        setStatus('Mentés…');
        saveTimer = setTimeout(flushSave, AUTOSAVE_MS);
    }

    function flushSave() {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (!editing) return savePromise;
        const note = readEditor(editBox, editing);
        if (isEmptyNote(note)) { setStatus('Üres jegyzet nem menthető'); return savePromise; }
        savePromise = savePromise.then(() => saveNote(editing, note)).then(saved => {
            if (editing && editing.id === saved.id) editing = { ...saved };
            setStatus('Mentve');
            render();
        }).catch(err => {
            setStatus('');
            notify(err.message || 'A jegyzet mentése nem sikerült.', 'error');
        });
        return savePromise;
    }

    function openEditor(item) {
        editing = { ...item };
        editBox.innerHTML = editorHtml(editing, { composer: false });
        openModal('noteEditModal');
        setTimeout(() => (editBox.querySelector('.note-editor-body') || editBox.querySelector('.note-editor-title')).focus(), 50);
    }

    async function closeEditor() {
        if (!editing) return;
        await flushSave();
        editing = null;
        closeModal('noteEditModal');
    }

    bindEditor(editBox, () => editing, next => { editing = next; }, { onChange: queueSave, onClose: closeEditor });
    document.getElementById('noteEditModal').addEventListener('mousedown', event => {
        if (event.target.id === 'noteEditModal') closeEditor();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && editing && document.getElementById('noteEditModal').classList.contains('active')) closeEditor();
    });

    // ---------- kártya műveletek ----------

    async function changeState(item, patch, message) {
        try {
            upsert(await noteApi.setItemState(item.id, patch));
            render();
            if (message) notify(message, 'success');
        } catch (err) {
            notify(err.message || 'A módosítás nem sikerült.', 'error');
        }
    }

    sections.addEventListener('click', async event => {
        const add = event.target.closest('[data-kanban-add]');
        if (add) return openComposer(add.dataset.kanbanAdd);
        if (event.target.closest('[data-kanban-new-category]')) {
            if (await createCategory()) render();
            return;
        }
        const card = event.target.closest('[data-item-id]');
        if (!card) return;
        const item = findItem(card.dataset.itemId);
        if (!item) return;
        const button = event.target.closest('[data-action]');
        if (!button) {
            if (!event.target.closest('.note-check') && !item.trashed) openEditor(item);
            return;
        }
        const action = button.dataset.action;
        if (action === 'check') {
            const checklist = checklistOf(item).map((entry, index) => index === Number(button.dataset.index) ? { ...entry, done: button.checked } : entry);
            try { await saveNote(item, { extra: { ...item.extra, checklist } }); render(); }
            catch (err) { notify(err.message || 'A mentés nem sikerült.', 'error'); }
            return;
        }
        if (action === 'palette') {
            const palette = button.parentElement.querySelector('.note-palette');
            document.querySelectorAll('.note-palette.show').forEach(other => { if (other !== palette) other.classList.remove('show'); });
            palette.classList.toggle('show');
            return;
        }
        if (action === 'set-color') {
            try { await saveNote(item, { color: button.dataset.color || null }); render(); }
            catch (err) { notify(err.message || 'A mentés nem sikerült.', 'error'); }
            return;
        }
        if (action === 'pin') return changeState(item, { pinned: !item.pinned });
        if (action === 'archive') return changeState(item, { archived: true, pinned: false }, 'Jegyzet archiválva.');
        if (action === 'unarchive') return changeState(item, { archived: false }, 'Jegyzet visszahelyezve.');
        if (action === 'trash') return changeState(item, { trashed: true }, 'Jegyzet a kukába helyezve.');
        if (action === 'restore') return changeState(item, { trashed: false }, 'Jegyzet visszaállítva.');
        if (action === 'delete') {
            if (!confirm('Véglegesen törlöd ezt a jegyzetet?')) return;
            try {
                await noteApi.deleteItemPermanently(item.id);
                state.items = state.items.filter(entry => entry.id !== item.id);
                render();
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
        }
    });

    sections.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.target.matches('.note-card')) return;
        const item = findItem(event.target.dataset.itemId);
        if (item && !item.trashed) openEditor(item);
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.note-color-menu')) document.querySelectorAll('.note-palette.show').forEach(palette => palette.classList.remove('show'));
    });

    // ---------- kanban: áthúzás oszlopok között (egér: azonnal, érintés: hosszú nyomás után) ----------

    const LONG_PRESS_MS = 350;
    let drag = null;

    function columnAt(x, y) {
        return document.elementFromPoint(x, y)?.closest('.kanban-column') || null;
    }

    function startDrag() {
        const rect = drag.card.getBoundingClientRect();
        drag.active = true;
        drag.offsetX = drag.startX - rect.left;
        drag.offsetY = drag.startY - rect.top;
        drag.ghost = drag.card.cloneNode(true);
        drag.ghost.classList.add('kanban-ghost');
        drag.ghost.style.width = `${rect.width}px`;
        document.body.appendChild(drag.ghost);
        drag.card.classList.add('is-dragging');
        sections.querySelector('.notes-kanban').classList.add('is-dragging');
        drag.frame = requestAnimationFrame(autoScroll);
        try { drag.card.setPointerCapture(drag.pointerId); } catch (err) { /* már elengedték */ }
        moveDrag(drag.startX, drag.startY);
    }

    function moveDrag(x, y) {
        drag.x = x; drag.y = y;
        drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
        const column = columnAt(x, y);
        sections.querySelectorAll('.kanban-column.is-drop-target').forEach(other => { if (other !== column) other.classList.remove('is-drop-target'); });
        column?.classList.add('is-drop-target');
    }

    // A tábla széléhez érve (amíg ott marad az ujj vagy az egér) vízszintesen görget; telefonon egyszerre egy oszlop látszik.
    function autoScroll() {
        if (!drag?.active) return;
        const board = sections.querySelector('.notes-kanban');
        const bounds = board.getBoundingClientRect();
        const edge = Math.min(48, bounds.width / 6);
        const step = drag.x < bounds.left + edge ? -12 : drag.x > bounds.right - edge ? 12 : 0;
        if (step) {
            board.scrollLeft += step;
            moveDrag(drag.x, drag.y);
        }
        drag.frame = requestAnimationFrame(autoScroll);
    }

    function endDrag(drop) {
        const current = drag;
        drag = null;
        clearTimeout(current.timer);
        if (!current.active) return;
        cancelAnimationFrame(current.frame);
        current.ghost.remove();
        sections.querySelector('.notes-kanban')?.classList.remove('is-dragging');
        current.card.classList.remove('is-dragging');
        sections.querySelectorAll('.kanban-column.is-drop-target').forEach(column => column.classList.remove('is-drop-target'));
        // A húzás végén érkező kattintás ne nyissa meg a szerkesztőt.
        const swallow = event => { event.stopPropagation(); event.preventDefault(); };
        sections.addEventListener('click', swallow, true);
        setTimeout(() => sections.removeEventListener('click', swallow, true), 0);
        if (!drop) return;
        const column = columnAt(current.x, current.y);
        if (column) moveToCategory(current.item, column.dataset.kanbanColumn);
    }

    async function moveToCategory(item, key) {
        const categoryId = /^\d+$/.test(key) ? Number(key) : null;
        if (String(item.category_id ?? '') === String(categoryId ?? '')) return;
        const previous = { category_id: item.category_id, category_name: item.category_name };
        item.category_id = categoryId;
        item.category_name = categoryId === null ? null : findCategory(categoryId)?.name || null;
        render();
        try {
            await saveNote(item, { category_id: categoryId });
            render();
        } catch (err) {
            Object.assign(item, previous);
            render();
            notify(err.message || 'Az áthelyezés nem sikerült.', 'error');
        }
    }

    sections.addEventListener('pointerdown', event => {
        if (state.view !== 'kanban' || drag || event.button > 0) return;
        const card = event.target.closest('.kanban-column .note-card');
        if (!card || event.target.closest('button, input, a, .note-palette')) return;
        const item = findItem(card.dataset.itemId);
        if (!item || item.trashed) return;
        drag = { card, item, pointerId: event.pointerId, touch: event.pointerType !== 'mouse', startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
        if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.active) startDrag(); }, LONG_PRESS_MS);
    });
    document.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.active) { event.preventDefault(); moveDrag(event.clientX, event.clientY); return; }
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        // Egérrel pár pixel mozgás indítja a húzást; érintésnél a hosszú nyomás előtti mozgás görgetés.
        if (!drag.touch && distance > 5) startDrag();
        else if (drag.touch && distance > 8) endDrag(false);
    });
    document.addEventListener('pointerup', event => { if (drag && event.pointerId === drag.pointerId) endDrag(true); });
    document.addEventListener('pointercancel', event => { if (drag && event.pointerId === drag.pointerId) endDrag(false); });
    // Húzás közben az ujj mozgása ne görgesse az oldalt.
    sections.addEventListener('touchmove', event => { if (drag?.active) event.preventDefault(); }, { passive: false });
    sections.addEventListener('contextmenu', event => { if (drag) event.preventDefault(); });

    // ---------- ⋮ menü ----------

    document.getElementById('noteMoreMenu')?.addEventListener('click', async event => {
        const button = event.target.closest('[data-note-menu]');
        if (!button) return;
        const action = button.dataset.noteMenu;
        if (action === 'new-category') {
            const created = await createCategory();
            if (created) { state.category = String(created.id); render(); }
            return;
        }
        const format = action === 'export-md' ? 'md' : 'json';
        try {
            const blob = await noteApi.exportItems('note', format);
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `cloudmark-jegyzetek.${format}`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        } catch (err) {
            notify('Az exportálás nem sikerült.', 'error');
        }
    });

    document.getElementById('noteImportInput')?.addEventListener('change', async event => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        let items;
        try {
            const data = JSON.parse(await file.text());
            items = Array.isArray(data) ? data : data.items;
            if (!Array.isArray(items)) throw new Error('format');
        } catch (err) {
            notify('A fájl nem érvényes jegyzetlista (JSON tömb vagy CloudMark export).', 'error');
            return;
        }
        if (!confirm(`${items.length} jegyzet importálása. Folytatod?`)) return;
        try {
            const result = await noteApi.importItems('note', items);
            await load(true);
            notify(`${result.imported} jegyzet importálva.`, 'success');
        } catch (err) {
            notify(err.message || 'Az importálás nem sikerült.', 'error');
        }
    });

    // ---------- eszköztár ----------

    /** Puts an open chip menu under its ⋮ button (the menu is fixed, so the scrolling chip row cannot clip it). */
    function placeCategoryMenu(menu) {
        const rect = menu.parentElement.querySelector('[data-note-category-menu]').getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
    }

    function closeCategoryMenus(except) {
        categoriesBar.querySelectorAll('.note-category-dropdown.show').forEach(menu => { if (menu !== except) menu.classList.remove('show'); });
    }

    categoriesBar.addEventListener('click', async event => {
        const more = event.target.closest('[data-note-category-menu]');
        if (more) {
            const menu = more.parentElement.querySelector('.note-category-dropdown');
            closeCategoryMenus(menu);
            if (menu.classList.toggle('show')) placeCategoryMenu(menu);
            return;
        }
        const action = event.target.closest('[data-note-category-action]');
        if (action) {
            closeCategoryMenus();
            const category = findCategory(action.dataset.categoryId);
            if (!category) return;
            if (action.dataset.noteCategoryAction === 'rename') await renameCategory(category);
            else await deleteCategory(category);
            return;
        }
        if (event.target.closest('[data-note-category-add]')) {
            const created = await createCategory();
            if (created) { state.category = String(created.id); render(); }
            return;
        }
        const chip = event.target.closest('[data-note-category]');
        if (!chip) return;
        state.category = chip.dataset.noteCategory || 'all';
        render();
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.note-category-chip-wrap')) closeCategoryMenus();
    });
    window.addEventListener('resize', () => closeCategoryMenus());
    // Görgetéskor a nyitott menü a gombjával együtt mozog.
    const followCategoryMenu = () => categoriesBar.querySelectorAll('.note-category-dropdown.show').forEach(placeCategoryMenu);
    window.addEventListener('scroll', followCategoryMenu, { passive: true });
    categoriesBar.addEventListener('scroll', followCategoryMenu, { passive: true });

    labelsBar.addEventListener('click', event => {
        const chip = event.target.closest('[data-label]');
        if (!chip) return;
        state.label = chip.dataset.label || null;
        render();
    });

    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        prefs.set('noteSort', state.sort);
        renderNotes();
    });

    viewSwitcher.addEventListener('click', event => {
        const button = event.target.closest('[data-view-mode]');
        if (!button) return;
        state.view = button.dataset.viewMode;
        prefs.set('noteView', state.view);
        renderNotes();
    });
    prefs.markSwitcher(viewSwitcher, state.view);

    document.addEventListener('cloudmark:prefs', () => {
        state.sort = prefs.get('noteSort');
        state.view = prefs.get('noteView');
        sortSelect.value = state.sort;
        if (state.loaded) renderNotes(); else prefs.markSwitcher(viewSwitcher, state.view);
    });

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        searchClear.hidden = !searchInput.value;
        renderNotes();
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        state.query = '';
        searchClear.hidden = true;
        renderNotes();
        searchInput.focus();
    });

    document.querySelectorAll('[data-note-state]').forEach(button => button.addEventListener('click', () => {
        state.filter = button.dataset.noteState;
        document.querySelectorAll('[data-note-state]').forEach(other => other.classList.toggle('active', other === button));
        if (state.filter !== 'active') renderComposer();
        render();
    }));

    window.CloudMark.notes = {
        show: () => load(),
        reset,
        openComposer,
        /** Opens a note's editor by id (used by links from tasks). */
        async openById(id) {
            await load();
            // A jegyzet közben máshol is létrejöhetett (pl. másik eszközön): ha nincs meg, újratöltjük a listát.
            if (!findItem(id)) await load(true);
            const item = findItem(id);
            if (item && !item.trashed) openEditor(item);
        }
    };
})();
