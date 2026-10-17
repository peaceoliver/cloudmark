/**
 * Clipper oldal (/clip): a bookmarkletből vagy a telefon Megosztás menüjéből érkező oldalt / szöveget
 * könyvjelzőként, jegyzetként vagy feladatként menti. Önálló oldal, a fő felülettől független.
 */
(function () {
    const { api, config, clipParse } = window.CloudMark;
    const $ = id => document.getElementById(id);

    const VIEW_HASH = { bookmark: '#/konyvjelzok', note: '#/jegyzetek', task: '#/feladatok' };
    const CATEGORY_KIND = { bookmark: 'bookmark', note: 'note', task: 'task' };
    const SAVED_TEXT = { bookmark: 'Könyvjelző mentve', note: 'Jegyzet mentve', task: 'Feladat mentve' };
    const LAST_CATEGORY_KEY = 'cloudmark_clip_categories';

    const input = clipParse.parseClipInput(Object.fromEntries(new URLSearchParams(location.search)));
    const state = { type: input.type, categories: {}, saving: false };
    // Felugró ablakban (bookmarklet) mentés után bezárható; a telepített appban a megosztás teljes oldalon nyílik.
    const isPopup = Boolean(window.opener) || window.name === 'cloudmark-clip';

    function applyTheme() {
        let saved = null;
        try { saved = localStorage.getItem(config.storageKeys.theme); } catch (err) { /* private mode */ }
        const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', theme);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = theme === 'light' ? '#ffffff' : '#0b0f19';
    }

    function show(id) {
        ['clipLoading', 'clipLogin', 'clipForm', 'clipDone'].forEach(name => { $(name).hidden = name !== id; });
    }

    function showError(id, message) {
        $(id).textContent = message || '';
        $(id).hidden = !message;
    }

    /** Remembers the last category per type, so repeated clips land in the same place. */
    function lastCategories() {
        try { return JSON.parse(localStorage.getItem(LAST_CATEGORY_KEY)) || {}; } catch (err) { return {}; }
    }

    function rememberCategory(type, value) {
        try { localStorage.setItem(LAST_CATEGORY_KEY, JSON.stringify({ ...lastCategories(), [type]: value })); } catch (err) { /* ignore */ }
    }

    async function loadCategories(type) {
        if (!state.categories[type]) {
            const kind = CATEGORY_KIND[type];
            state.categories[type] = await (kind === 'bookmark' ? api.getCategories() : api.getCategoriesOfKind(kind)).catch(() => []);
        }
        return state.categories[type];
    }

    async function renderCategories() {
        const type = state.type;
        const list = await loadCategories(type);
        if (type !== state.type) return;
        const select = $('clipCategory');
        select.replaceChildren();
        if (type !== 'bookmark') select.append(new Option(type === 'task' ? 'Nincs projekt' : 'Nincs kategória', ''));
        list.forEach(category => select.append(new Option(category.name, type === 'bookmark' ? category.name : String(category.id))));
        const remembered = lastCategories()[type];
        if (remembered && [...select.options].some(option => option.value === remembered)) select.value = remembered;
        else if (type === 'bookmark') {
            const inbox = list.find(category => category.name.toLowerCase() === 'inbox');
            if (inbox) select.value = inbox.name;
        }
    }

    function setType(type) {
        state.type = type;
        document.querySelectorAll('[data-clip-type]').forEach(button => {
            const active = button.dataset.clipType === type;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        $('clipCategoryLabel').textContent = type === 'task' ? 'Projekt' : 'Kategória';
        $('clipTextLabel').textContent = type === 'bookmark' ? 'Leírás' : type === 'task' ? 'Megjegyzés' : 'Szöveg';
        document.querySelector('[data-clip-field="readLater"]').hidden = type !== 'bookmark';
        $('clipUrl').required = type === 'bookmark';
        showError('clipError', '');
        renderCategories();
    }

    function fillForm() {
        $('clipTitle').value = input.title;
        $('clipUrl').value = input.url;
        $('clipText').value = input.text;
        setType(state.type);
        show('clipForm');
        $('clipTitle').focus();
    }

    function finish(type) {
        $('clipDoneText').textContent = SAVED_TEXT[type];
        $('clipOpenApp').href = `/${VIEW_HASH[type]}`;
        show('clipDone');
        if (isPopup) setTimeout(() => window.close(), 1500);
    }

    async function save(event) {
        event.preventDefault();
        if (state.saving) return;
        const type = state.type;
        const values = {
            url: $('clipUrl').value.trim(),
            title: $('clipTitle').value,
            text: $('clipText').value,
            tags: $('clipTags').value
        };
        const category = $('clipCategory').value;
        if (type === 'bookmark' && !values.url) { showError('clipError', 'A könyvjelzőhöz URL kell.'); return; }
        if (type === 'bookmark' && !category) { showError('clipError', 'Válassz kategóriát.'); return; }
        if (type === 'task' && !values.title.trim() && !values.url) { showError('clipError', 'A feladathoz cím kell.'); return; }
        if (type === 'note' && !values.title.trim() && !values.text.trim() && !values.url) { showError('clipError', 'Üres jegyzet nem menthető.'); return; }

        state.saving = true;
        $('clipSave').disabled = true;
        showError('clipError', '');
        try {
            if (type === 'bookmark') {
                await api.createBookmark(clipParse.buildBookmark({ ...values, category, readLater: $('clipReadLater').checked }));
            } else {
                const build = type === 'note' ? clipParse.buildNote : clipParse.buildTask;
                await api.createItem(build({ ...values, categoryId: category ? Number(category) : null }));
            }
            rememberCategory(type, category);
            finish(type);
        } catch (err) {
            showError('clipError', err.message || 'A mentés nem sikerült.');
            // Már elmentett hivatkozás (409): a meglévő könyvjelzőt is meg lehet nyitni.
            if (type === 'bookmark' && /már szerepel/.test(err.message || '')) {
                const link = document.createElement('a');
                link.href = `/${VIEW_HASH.bookmark}`;
                link.target = isPopup ? '_blank' : '_self';
                link.textContent = ' Könyvjelzők megnyitása';
                $('clipError').append(link);
            }
        } finally {
            state.saving = false;
            $('clipSave').disabled = false;
        }
    }

    async function login(event) {
        event.preventDefault();
        showError('clipLoginError', '');
        try {
            await api.login($('clipUsername').value.trim(), $('clipPassword').value);
            fillForm();
        } catch (err) {
            showError('clipLoginError', err.message || 'A bejelentkezés nem sikerült.');
        }
    }

    async function init() {
        applyTheme();
        document.querySelectorAll('[data-clip-type]').forEach(button => button.addEventListener('click', () => setType(button.dataset.clipType)));
        $('clipForm').addEventListener('submit', save);
        $('clipLogin').addEventListener('submit', login);
        $('clipCancel').addEventListener('click', () => { if (isPopup) window.close(); else location.href = '/'; });
        let user = null;
        try { user = await api.getCurrentUser(); } catch (err) { user = null; }
        if (user) fillForm();
        else { show('clipLogin'); $('clipUsername').focus(); }
    }

    init();
})();
