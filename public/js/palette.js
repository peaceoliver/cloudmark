/*
 * Command Palette (Ctrl+K / ⌘K): egy ablakból keres a jegyzetekben, feladatokban, könyvjelzőkben és parancsokban,
 * megnyitja vagy használja a találatot, és új elemet is létrehoz. „>” előtaggal gyors műveletek.
 */
(function () {
    const api = window.CloudMark.api;
    const overlay = document.getElementById('paletteModal');
    const input = document.getElementById('paletteInput');
    const list = document.getElementById('paletteResults');
    const toggle = document.getElementById('paletteToggle');
    if (!overlay || !input || !list) return;

    const RECENT_KEY = 'cloudmark_palette_recent';
    const RECENT_MAX = 8;
    const DEBOUNCE_MS = 120;
    // A csoportok a fülek sorrendjét követik.
    const GROUPS = [
        { kind: 'note', label: 'Jegyzetek', icon: 'fa-note-sticky' },
        { kind: 'task', label: 'Feladatok', icon: 'fa-list-check' },
        { kind: 'bookmark', label: 'Könyvjelzők', icon: 'fa-bookmark' },
        { kind: 'command', label: 'Parancsok', icon: 'fa-terminal' }
    ];
    const KIND_LABEL = { note: 'jegyzet', task: 'feladat', bookmark: 'könyvjelző', command: 'parancs' };

    let entries = [];
    let active = 0;
    let timer = null;
    let requestId = 0;
    let pending = Promise.resolve();

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    function signedIn() {
        return typeof currentUser !== 'undefined' && Boolean(currentUser);
    }

    function views() {
        return window.CloudMark.views;
    }

    // ---------- legutóbbiak ----------

    function readRecent() {
        try {
            const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (err) { return []; }
    }

    function remember(result) {
        const entry = { kind: result.kind, id: result.id, title: result.title, url: result.url || null, category: result.category || null };
        const next = [entry, ...readRecent().filter(item => !(item.kind === entry.kind && item.id === entry.id))].slice(0, RECENT_MAX);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (err) { /* private mode */ }
    }

    // ---------- műveletek ----------

    async function openResult(result, edit) {
        remember(result);
        if (result.kind === 'note') {
            views().showView('notes');
            await window.CloudMark.notes.openById(result.id);
        } else if (result.kind === 'task') {
            views().showView('tasks');
            await window.CloudMark.tasks.openById(result.id);
        } else if (result.kind === 'bookmark') {
            if (edit) {
                views().showView('bookmarks');
                if (typeof bookmarks !== 'undefined' && bookmarks.some(item => item.id === result.id)) openEditModal(result.id);
                else notify('Ez a könyvjelző most nem szerkeszthető innen.', 'error');
                return;
            }
            // Előbb nyitjuk meg az oldalt (a böngésző csak közvetlenül a billentyű/kattintás után engedi), utána számolunk.
            window.open(result.url, '_blank', 'noopener');
            api.trackBookmarkClick(result.id).catch(() => {});
        } else if (result.kind === 'command') {
            if (edit) {
                views().showView('commands');
                await window.CloudMark.commands.openById(result.id);
                return;
            }
            await copyCommand(result);
        }
    }

    async function copyCommand(result) {
        let code = result.code;
        if (code === undefined) {
            try {
                const item = await api.getItem(result.id);
                code = item.fragments?.[0]?.content || '';
            } catch (err) {
                notify('A parancs nem található.', 'error');
                return;
            }
        }
        try {
            await navigator.clipboard.writeText(code);
        } catch (err) {
            notify('A másolás nem sikerült.', 'error');
            return;
        }
        api.markItemUsed(result.id).catch(() => {});
        notify(`Vágólapra másolva: ${result.title}`, 'success');
    }

    function looksLikeUrl(text) {
        return /^(https?:\/\/|www\.)\S+$/i.test(text) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text);
    }

    async function createNote(text) {
        views().showView('notes');
        await window.CloudMark.notes.show();
        window.CloudMark.notes.openComposer(undefined, { title: text });
    }

    async function createTask(text) {
        views().showView('tasks');
        if (text) await window.CloudMark.tasks.addFromText(text);
        else window.CloudMark.tasks.focusQuickAdd();
    }

    function createBookmark(text) {
        views().showView('bookmarks');
        const trigger = document.querySelector('.add-bookmark-toggle');
        if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
        const url = document.getElementById('bmUrl');
        const title = document.getElementById('bmTitle');
        if (text && looksLikeUrl(text)) url.value = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        else if (text) title.value = text;
        (text && !looksLikeUrl(text) ? url : title).focus();
    }

    async function createCommand(text) {
        views().showView('commands');
        await window.CloudMark.commands.show();
        window.CloudMark.commands.openEditor(null);
        const title = document.getElementById('cmdTitle');
        if (title) { title.value = text; title.focus(); }
    }

    function createEntries(text) {
        const quoted = text ? `: „${text}”` : '';
        return [
            { group: 'Létrehozás', icon: 'fa-plus', label: `Új jegyzet${quoted}`, run: () => createNote(text) },
            { group: 'Létrehozás', icon: 'fa-plus', label: `Új feladat${quoted}`, hint: text ? 'dátum, !1, #címke, @projekt is mehet' : '', run: () => createTask(text) },
            { group: 'Létrehozás', icon: 'fa-plus', label: text && looksLikeUrl(text) ? `Új könyvjelző: ${text}` : 'Új könyvjelző', run: () => createBookmark(text) },
            { group: 'Létrehozás', icon: 'fa-plus', label: `Új parancs${quoted}`, run: () => createCommand(text) }
        ];
    }

    function actionEntries(filter) {
        const all = [
            { label: 'Jegyzetek megnyitása', icon: 'fa-note-sticky', run: () => views().showView('notes') },
            { label: 'Feladatok megnyitása', icon: 'fa-list-check', run: () => views().showView('tasks') },
            { label: 'Könyvjelzők megnyitása', icon: 'fa-bookmark', run: () => views().showView('bookmarks') },
            { label: 'Parancsok megnyitása', icon: 'fa-terminal', run: () => views().showView('commands') },
            { label: 'Beállítások', icon: 'fa-gear', run: () => openUserSettings() },
            { label: 'Téma váltása (világos / sötét)', icon: 'fa-circle-half-stroke', run: () => document.getElementById('themeToggle')?.click() },
            ...createEntries('').map(entry => ({ ...entry, group: undefined }))
        ];
        const query = filter.toLowerCase();
        return all.filter(entry => entry.label.toLowerCase().includes(query)).map(entry => ({ ...entry, group: 'Műveletek', icon: entry.icon || 'fa-bolt' }));
    }

    function resultEntry(result, group) {
        const done = result.kind === 'task' && result.status === 'done';
        const meta = [result.category, ...(result.tags || []).map(tag => `#${tag}`)].filter(Boolean).join(' · ');
        return {
            group: group.label,
            icon: done ? 'fa-circle-check' : group.icon,
            label: result.title,
            sub: result.snippet && result.snippet !== result.title ? result.snippet : '',
            meta,
            code: result.kind === 'command',
            muted: done || result.archived,
            enterHint: { note: 'megnyitás', task: 'megnyitás', bookmark: 'weboldal', command: 'másolás' }[result.kind],
            run: edit => openResult(result, edit)
        };
    }

    // ---------- megjelenítés ----------

    function render(message) {
        if (!entries.length) {
            list.innerHTML = `<div class="palette-empty">${esc(message || 'Nincs találat.')}</div>`;
            return;
        }
        active = Math.min(active, entries.length - 1);
        let lastGroup = null;
        list.innerHTML = entries.map((entry, index) => {
            const header = entry.group !== lastGroup ? `<div class="palette-group">${esc(entry.group)}</div>` : '';
            lastGroup = entry.group;
            return `${header}
                <button type="button" class="palette-item ${index === active ? 'is-active' : ''} ${entry.muted ? 'is-muted' : ''}" data-index="${index}" role="option" aria-selected="${index === active}">
                    <i class="fa-solid ${esc(entry.icon)}" aria-hidden="true"></i>
                    <span class="palette-item-main">
                        <span class="palette-item-title">${esc(entry.label)}</span>
                        ${entry.sub ? `<span class="palette-item-sub ${entry.code ? 'is-code' : ''}">${esc(entry.sub)}</span>` : ''}
                        ${entry.meta ? `<span class="palette-item-meta">${esc(entry.meta)}</span>` : ''}
                        ${entry.hint ? `<span class="palette-item-meta">${esc(entry.hint)}</span>` : ''}
                    </span>
                    ${entry.enterHint ? `<span class="palette-item-enter">${esc(entry.enterHint)} ↵</span>` : ''}
                </button>`;
        }).join('');
        list.querySelector('.palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
    }

    function setActive(index) {
        if (!entries.length) return;
        active = (index + entries.length) % entries.length;
        list.querySelectorAll('.palette-item').forEach(item => {
            const on = Number(item.dataset.index) === active;
            item.classList.toggle('is-active', on);
            item.setAttribute('aria-selected', String(on));
            if (on) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function showRecent() {
        const recent = readRecent();
        entries = recent.map(result => resultEntry(result, { ...GROUPS.find(group => group.kind === result.kind), label: 'Legutóbbiak' }));
        active = 0;
        render('Kezdj el gépelni: keres a jegyzetekben, feladatokban, könyvjelzőkben és parancsokban. „>” után műveletek.');
    }

    async function update() {
        const text = input.value.trim();
        const current = ++requestId;
        if (!text) return showRecent();
        if (text.startsWith('>')) {
            entries = actionEntries(text.slice(1).trim());
            active = 0;
            return render('Nincs ilyen művelet.');
        }
        let results = [];
        try {
            results = await api.search(text, { limit: 5 });
        } catch (err) {
            if (current !== requestId) return;
            entries = createEntries(text);
            active = 0;
            return render();
        }
        if (current !== requestId) return;
        entries = [
            ...GROUPS.flatMap(group => results.filter(result => result.kind === group.kind).map(result => resultEntry(result, group))),
            ...createEntries(text)
        ];
        active = 0;
        render();
    }

    // ---------- nyitás, zárás, billentyűk ----------

    function open() {
        if (!signedIn()) return;
        document.querySelectorAll('.modal-overlay.active').forEach(modal => { if (modal !== overlay) modal.classList.remove('active'); });
        overlay.classList.add('active');
        input.value = '';
        showRecent();
        input.focus();
    }

    function close() {
        overlay.classList.remove('active');
        clearTimeout(timer);
        timer = null;
        requestId++;
    }

    function isOpen() {
        return overlay.classList.contains('active');
    }

    async function run(index, edit) {
        const entry = entries[index];
        if (!entry) return;
        close();
        try {
            await entry.run(edit);
        } catch (err) {
            notify(err.message || 'A művelet nem sikerült.', 'error');
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; pending = update(); }, DEBOUNCE_MS);
    });

    input.addEventListener('keydown', async event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(active + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(active - 1); }
        else if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'Enter') {
            event.preventDefault();
            // A gépelés utáni keresés még futhat: megvárjuk, hogy a friss találatra lépjen az Enter.
            if (timer) { clearTimeout(timer); timer = null; pending = update(); }
            await pending;
            run(active, event.shiftKey);
        }
    });

    list.addEventListener('mousemove', event => {
        const item = event.target.closest('.palette-item');
        if (item && Number(item.dataset.index) !== active) setActive(Number(item.dataset.index));
    });
    list.addEventListener('click', event => {
        const item = event.target.closest('.palette-item');
        if (item) run(Number(item.dataset.index), event.shiftKey);
    });
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
    toggle?.addEventListener('click', () => (isOpen() ? close() : open()));

    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
            if (!signedIn()) return;
            event.preventDefault();
            if (isOpen()) close(); else open();
        }
    });

    window.CloudMark.palette = { open, close };
})();
