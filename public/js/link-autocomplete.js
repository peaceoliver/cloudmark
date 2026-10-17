/**
 * Belső hivatkozások a felületen: a [[ beírására felugró kereső (a közös /api/search-et hívja),
 * a [[jegyzet:12|…]] tokenek kattintható „pill”-lé alakítása, a linkek megnyitása és a „Hivatkoznak rá” lista.
 * A tokenek feldolgozása a közös inline-links.js-ben van (window.CloudMark.linkParser).
 */
(function () {
    const parser = window.CloudMark.linkParser;
    const api = window.CloudMark.api;
    const KIND_LABEL = { note: 'jegyzet', task: 'feladat', command: 'kódrészlet', bookmark: 'könyvjelző' };
    const KIND_ICON = { note: 'fa-note-sticky', task: 'fa-list-check', command: 'fa-terminal', bookmark: 'fa-bookmark' };
    const SEARCH_DELAY_MS = 200;
    const BACKLINK_CACHE_MS = 30000;

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function notify(message, type) {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    // ---------- megjelenítés ----------

    /** Lookup of the server's `inline_links` (current titles) by token kind + id. */
    function resolver(resolved) {
        const map = new Map((resolved || []).map(link => [`${link.targetType}:${link.targetId}`, link]));
        return link => map.get(`${link.kind === 'bookmark' ? 'bookmark' : 'item'}:${link.id}`) || null;
    }

    function pillHtml(link, target) {
        // A típust a cél adja (ha a tokenben rossz szó áll, akkor is jó helyre nyit), a feliratot a mostani cím.
        const kind = target ? (target.targetType === 'bookmark' ? 'bookmark' : target.itemType) : link.kind;
        const icon = `<i class="fa-solid ${KIND_ICON[kind] || 'fa-link'}"></i>`;
        if (!target) {
            return `<span class="inline-link is-missing" title="Nem található (törölt vagy kukában lévő elem)">${icon} ${esc(link.label || 'Nem található')}</span>`;
        }
        return `<button type="button" class="inline-link" data-inline-open="${esc(kind)}" data-inline-id="${Number(link.id)}"`
            + `${target.url ? ` data-inline-url="${esc(target.url)}"` : ''} title="${esc(KIND_LABEL[kind] || '')} megnyitása">${icon} ${esc(target.title || link.label || 'Névtelen')}</button>`;
    }

    /** `text` as escaped HTML with every link token turned into a pill. */
    function textHtml(text, resolved) {
        const find = resolver(resolved);
        return parser.segments(text).map(part => (part.link ? pillHtml(part.link, find(part.link)) : esc(part.text))).join('');
    }

    /** Only the pills of `text` (for editors that show the raw text), or '' when it has no links. */
    function pillsHtml(text, resolved) {
        const find = resolver(resolved);
        const seen = new Set();
        return parser.parse(text).filter(link => {
            const key = `${link.kind === 'bookmark' ? 'b' : 'i'}:${link.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).map(link => pillHtml(link, find(link))).join('');
    }

    // ---------- megnyitás ----------

    async function open(kind, id, url) {
        const views = window.CloudMark.views;
        if (kind === 'bookmark') {
            if (url && /^https?:\/\//i.test(url)) {
                window.open(url, '_blank', 'noopener');
                api.trackBookmarkClick?.(id)?.catch?.(() => {});
            }
            return;
        }
        // A nyitott jegyzet ablakot előbb mentjük és bezárjuk, különben a cél mögötte nyílna meg.
        if (kind !== 'note') await window.CloudMark.notes?.closeEditor?.();
        if (kind === 'note') {
            views?.showView('notes');
            await window.CloudMark.notes?.openById?.(id);
        } else if (kind === 'task') {
            views?.showView('tasks');
            await window.CloudMark.tasks?.openById?.(id);
        } else if (kind === 'command') {
            views?.showView('commands');
            await window.CloudMark.commands?.openById?.(id);
        }
    }

    // Rögzítő fázisban figyeljük, így a kártya saját kattintása (szerkesztő megnyitása) nem fut le.
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-inline-open]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        open(button.dataset.inlineOpen, Number(button.dataset.inlineId), button.dataset.inlineUrl);
    }, true);

    // ---------- visszahivatkozások ----------

    const backlinkCache = new Map();

    function invalidateBacklinks() { backlinkCache.clear(); }

    /** Fills `box` with the items that link to item `id`; hides it when there are none. */
    async function loadBacklinks(box, id) {
        if (!box || !id) return;
        const cached = backlinkCache.get(String(id));
        let list = cached && Date.now() - cached.at < BACKLINK_CACHE_MS ? cached.list : null;
        if (!list) {
            try {
                list = await api.getBacklinks(id);
                backlinkCache.set(String(id), { at: Date.now(), list });
            } catch (err) {
                return;
            }
        }
        if (!box.isConnected) return;
        box.hidden = !list.length;
        box.innerHTML = list.length ? `
            <div class="inline-backlinks-title"><i class="fa-solid fa-arrow-right-to-bracket"></i> Hivatkoznak rá</div>
            <div class="inline-backlinks-list">${list.map(entry => `
                <button type="button" class="inline-link" data-inline-open="${esc(entry.type)}" data-inline-id="${Number(entry.id)}" title="${esc(KIND_LABEL[entry.type] || '')} megnyitása">
                    <i class="fa-solid ${KIND_ICON[entry.type] || 'fa-link'}"></i> ${esc(entry.title)}
                </button>`).join('')}</div>` : '';
    }

    // ---------- [[ kereső ----------

    const popup = document.createElement('div');
    popup.className = 'link-ac';
    popup.setAttribute('role', 'listbox');
    popup.hidden = true;
    document.body.appendChild(popup);

    let active = null; // { textarea, start, query, matches, index, self }
    let searchTimer = null;

    function close() {
        clearTimeout(searchTimer);
        active = null;
        popup.hidden = true;
        popup.innerHTML = '';
    }

    /** Pixel position of the caret inside a textarea, measured on an invisible copy of it. */
    function caretPoint(textarea, position) {
        const style = getComputedStyle(textarea);
        const mirror = document.createElement('div');
        for (const name of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
            'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize']) {
            mirror.style[name] = style[name];
        }
        Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden' });
        mirror.textContent = textarea.value.slice(0, position);
        const marker = document.createElement('span');
        marker.textContent = '​';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const rect = textarea.getBoundingClientRect();
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
        const point = {
            left: rect.left + marker.offsetLeft - textarea.scrollLeft,
            top: rect.top + marker.offsetTop - textarea.scrollTop,
            lineHeight
        };
        mirror.remove();
        return point;
    }

    function place() {
        if (!active) return;
        const { textarea, start } = active;
        const point = caretPoint(textarea, start);
        const viewport = window.visualViewport;
        const viewHeight = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
        const width = Math.min(340, window.innerWidth - 16);
        const left = Math.max(8, Math.min(point.left, window.innerWidth - width - 8));
        popup.style.width = `${width}px`;
        popup.style.left = `${left}px`;
        const below = point.top + point.lineHeight + 4;
        const height = popup.offsetHeight;
        // Telefonon a billentyűzet felett maradjon: ha alul nem fér el, a sor fölé kerül.
        popup.style.top = `${below + height > viewHeight - 8 && point.top - height - 4 > 8 ? point.top - height - 4 : below}px`;
    }

    function renderPopup() {
        if (!active) return;
        const { matches, query, index, loading } = active;
        const rows = matches.map((match, position) => `
            <button type="button" class="link-ac-item ${position === index ? 'is-active' : ''}" data-ac-index="${position}" role="option" aria-selected="${position === index}">
                <i class="fa-solid ${match.create ? 'fa-plus' : KIND_ICON[match.kind]}"></i>
                <span>${match.create ? `Új jegyzet: „${esc(match.title)}”` : esc(match.title || 'Névtelen')}</span>
                ${match.create ? '' : `<small>${KIND_LABEL[match.kind]}</small>`}
            </button>`).join('');
        const hint = !query.trim()
            ? '<div class="link-ac-hint">Kezdd el gépelni egy jegyzet, feladat, kódrészlet vagy könyvjelző nevét…</div>'
            : (loading && !matches.length ? '<div class="link-ac-hint">Keresés…</div>' : (!matches.length ? '<div class="link-ac-hint">Nincs találat.</div>' : ''));
        popup.innerHTML = rows + hint;
        popup.hidden = false;
        place();
    }

    async function search() {
        if (!active) return;
        const current = active;
        const query = current.query.trim();
        if (!query) { current.matches = []; renderPopup(); return; }
        current.loading = true;
        renderPopup();
        try {
            const found = await api.search(query, { limit: 5 });
            if (active !== current || current.query.trim() !== query) return;
            const self = current.self();
            current.matches = found
                .filter(result => !(self && result.kind === self.kind && String(result.id) === String(self.id)))
                .slice(0, 10)
                .map(result => ({ kind: result.kind, id: result.id, title: result.title }));
            if (query.length >= 2) current.matches.push({ create: true, title: query.slice(0, 300) });
            current.index = 0;
        } catch (err) {
            current.matches = [];
        }
        current.loading = false;
        renderPopup();
    }

    function update(textarea, self) {
        const found = textarea.selectionStart === textarea.selectionEnd ? parser.trigger(textarea.value, textarea.selectionStart) : null;
        if (!found) { if (active?.textarea === textarea) close(); return; }
        const changed = !active || active.textarea !== textarea || active.query !== found.query;
        active = { ...(active?.textarea === textarea ? active : { matches: [], index: 0 }), textarea, start: found.start, query: found.query, self };
        if (!changed) return;
        renderPopup();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(search, SEARCH_DELAY_MS);
    }

    async function choose(position) {
        if (!active) return;
        const { textarea, start } = active;
        let match = active.matches[position];
        if (!match) return;
        close();
        if (match.create) {
            try {
                const created = await api.createItem({ type: 'note', title: match.title, body: '', fragments: [], tags: [], extra: {} });
                window.CloudMark.notes?.remember?.(created);
                match = { kind: 'note', id: created.id, title: created.title };
                notify('Új jegyzet létrehozva.', 'success');
            } catch (err) {
                notify(err.message || 'A jegyzet létrehozása nem sikerült.', 'error');
                return;
            }
        }
        const caret = textarea.selectionStart;
        const token = parser.token(match.kind, match.id, match.title);
        textarea.focus();
        textarea.setRangeText(`${token} `, start, Math.max(caret, start), 'end');
        // A szerkesztők az input eseményre mentenek automatikusan.
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        invalidateBacklinks();
    }

    /**
     * Turns on the [[ search for every textarea matching `selector` inside `root` (also ones rendered later).
     * `self()` returns { kind, id } of the item being edited, so it isn't offered as a link to itself.
     */
    function attach(root, selector, self = () => null) {
        const handle = event => {
            if (event.target.matches?.(selector)) update(event.target, self);
        };
        root.addEventListener('input', handle);
        root.addEventListener('click', handle);
        root.addEventListener('keyup', event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) handle(event);
        });
        root.addEventListener('focusout', event => {
            if (active?.textarea === event.target) setTimeout(() => { if (active && document.activeElement !== active.textarea) close(); }, 150);
        });
        // Rögzítő fázis: az Enter/Esc a listát kezeli, nem a szerkesztőt (pl. nem zárja be az ablakot).
        root.addEventListener('keydown', event => {
            if (!active || active.textarea !== event.target || popup.hidden) return;
            const count = active.matches.length;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!count) return;
                event.preventDefault();
                active.index = (active.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
                renderPopup();
            } else if ((event.key === 'Enter' || event.key === 'Tab') && count && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                event.stopPropagation();
                choose(active.index);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        }, true);
    }

    // Egérrel / ujjal: a mousedown nem veszi el a fókuszt a szövegmezőtől.
    // A stopPropagation miatt a jegyzet gyors-hozzáadása sem csukódik be (az a „kívülre kattintást” figyeli).
    popup.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    popup.addEventListener('click', event => {
        const item = event.target.closest('[data-ac-index]');
        if (item) choose(Number(item.dataset.acIndex));
    });
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    document.addEventListener('scroll', event => { if (active && event.target !== popup) place(); }, true);

    window.CloudMark.inlineLinks = { attach, textHtml, pillsHtml, open, loadBacklinks, invalidateBacklinks, close };
})();
