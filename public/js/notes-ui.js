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

    const state = { items: [], loaded: false, loading: null, query: '', label: null, filter: 'active' };

    const sections = document.getElementById('noteSections');
    const labelsBar = document.getElementById('noteLabelsBar');
    const searchInput = document.getElementById('noteSearch');
    const searchClear = document.getElementById('noteSearchClear');
    const composerWrap = document.getElementById('noteComposerWrap');
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
        state.loading = noteApi.getItems('note', { all: 'true' }).then(items => {
            state.items = items;
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
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        sections.innerHTML = '';
        labelsBar.innerHTML = '';
        composerWrap.innerHTML = '';
    }

    function upsert(item) {
        const index = state.items.findIndex(existing => existing.id === item.id);
        if (index === -1) state.items.unshift(item);
        else state.items[index] = item;
    }

    function findItem(id) {
        return state.items.find(item => String(item.id) === String(id));
    }

    async function saveNote(item, overrides) {
        const saved = await noteApi.updateItem(item.id, notePayload(item, overrides));
        upsert(saved);
        return saved;
    }

    // ---------- megjelenítés ----------

    function visibleNotes() {
        const query = state.query.trim().toLowerCase();
        return state.items.filter(item => {
            if (state.filter === 'trash') { if (!item.trashed) return false; }
            else if (item.trashed) return false;
            else if (state.filter === 'archived' ? !item.archived : item.archived) return false;
            if (state.label && !item.tags.includes(state.label)) return false;
            if (!query) return true;
            const checklist = checklistOf(item) || [];
            return [item.title, item.body, ...item.tags, ...checklist.map(entry => entry.text)]
                .some(value => String(value || '').toLowerCase().includes(query));
        }).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
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
                ${noteBodyHtml(item)}
                ${item.tags.length ? `<div class="note-labels">${item.tags.map(tag => `<span class="note-label">${esc(tag)}</span>`).join('')}</div>` : ''}
                <div class="note-actions">${actions}</div>
            </article>`;
    }

    function renderNotes() {
        const list = visibleNotes();
        if (!list.length) {
            const message = state.query || state.label ? 'Nincs a keresésnek megfelelő jegyzet.'
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
        renderLabels();
        renderNotes();
        composerWrap.hidden = state.filter !== 'active';
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
                <input type="text" class="note-editor-tags" placeholder="Címkék vesszővel (pl. ötlet, munka)" value="${esc((note.tags || []).join(', '))}" aria-label="Címkék">
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

    function checkRowHtml(entry) {
        return `
            <div class="note-editor-check">
                <input type="checkbox" class="note-editor-check-done" ${entry.done ? 'checked' : ''} aria-label="Kész">
                <input type="text" class="note-editor-check-text" maxlength="1000" placeholder="Listaelem" value="${esc(entry.text)}" aria-label="Listaelem">
                <button type="button" class="note-action" data-editor="remove-check" title="Elem törlése" aria-label="Elem törlése"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
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
        root.addEventListener('change', event => { if (event.target.matches('.note-editor-check-done')) onChange(); });
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

    function renderComposer() {
        composerNote = null;
        composerWrap.classList.remove('is-open');
        composerWrap.innerHTML = '<button type="button" class="note-composer-collapsed" data-composer="open">Jegyzet írása…</button>';
    }

    function openComposer() {
        if (state.filter !== 'active') return;
        composerNote = { title: '', body: '', color: null, pinned: false, tags: state.label ? [state.label] : [], extra: {} };
        composerWrap.classList.add('is-open');
        composerWrap.innerHTML = editorHtml(composerNote, { composer: true });
        composerWrap.querySelector('.note-editor-body').focus();
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

    composerWrap.addEventListener('click', event => {
        if (event.target.closest('[data-composer="open"]')) openComposer();
    });
    bindEditor(composerWrap, () => composerNote, next => { composerNote = next; }, { onChange: () => {}, onClose: closeComposer });
    document.addEventListener('mousedown', event => {
        if (composerNote && !composerWrap.contains(event.target)) closeComposer();
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

    // ---------- eszköztár ----------

    labelsBar.addEventListener('click', event => {
        const chip = event.target.closest('[data-label]');
        if (!chip) return;
        state.label = chip.dataset.label || null;
        render();
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
            const item = findItem(id);
            if (item && !item.trashed) openEditor(item);
        }
    };
})();
