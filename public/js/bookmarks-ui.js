const bookmarksConfig = window.CloudMark && window.CloudMark.config ? window.CloudMark.config : {};
let currentBookmarkView = (bookmarksConfig.storageKeys ? localStorage.getItem(bookmarksConfig.storageKeys.viewMode) : null) || 'grid';
let showBookmarkImages = bookmarksConfig.storageKeys ? localStorage.getItem(bookmarksConfig.storageKeys.showImages) !== 'false' : true;
const tagInputState = new Map();
const selectedBookmarkIds = new Set();
let bulkSelectionEnabled = false;

function initTagInputs() {
    document.querySelectorAll('[data-tag-input]').forEach(wrapper => {
        const input = wrapper.querySelector('.tag-entry');
        const state = { values: [], suggestions: [] };
        tagInputState.set(wrapper.dataset.tagInput, state);
        input.addEventListener('focus', () => loadTagSuggestions(wrapper));
        input.addEventListener('input', () => renderTagSuggestions(wrapper));
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addTagValue(wrapper, input.value);
            } else if (event.key === 'Backspace' && !input.value && state.values.length) {
                state.values.pop();
                renderTagChips(wrapper);
            }
        });
        wrapper.addEventListener('click', () => input.focus());
    });
}

async function loadTagSuggestions(wrapper) {
    const state = tagInputState.get(wrapper.dataset.tagInput);
    if (state.suggestions.length || !currentUser || typeof api === 'undefined') return;
    state.suggestions = await api.getTags();
    renderTagSuggestions(wrapper);
}

function addTagValue(wrapper, value) {
    const state = tagInputState.get(wrapper.dataset.tagInput);
    const tag = String(value || '').trim().replace(/,+$/, '').trim();
    if (!tag || state.values.some(item => item.toLowerCase() === tag.toLowerCase())) return;
    state.values.push(tag);
    wrapper.querySelector('.tag-entry').value = '';
    renderTagChips(wrapper);
    renderTagSuggestions(wrapper);
}

function renderTagChips(wrapper) {
    const state = tagInputState.get(wrapper.dataset.tagInput);
    const chips = wrapper.querySelector('.tag-chips');
    chips.innerHTML = '';
    state.values.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = `#${tag}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `${tag} törlése`);
        remove.textContent = '×';
        remove.onclick = event => { event.stopPropagation(); state.values = state.values.filter(item => item !== tag); renderTagChips(wrapper); };
        chip.appendChild(remove);
        chips.appendChild(chip);
    });
}

function renderTagSuggestions(wrapper) {
    const state = tagInputState.get(wrapper.dataset.tagInput);
    const query = wrapper.querySelector('.tag-entry').value.trim().toLowerCase();
    const suggestions = wrapper.querySelector('.tag-suggestions');
    suggestions.innerHTML = '';
    state.suggestions.filter(tag => !state.values.includes(tag) && (!query || tag.toLowerCase().includes(query))).slice(0, 8).forEach(tag => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'tag-suggestion'; button.textContent = `#${tag}`;
        button.onclick = () => addTagValue(wrapper, tag);
        suggestions.appendChild(button);
    });
    suggestions.classList.toggle('visible', suggestions.children.length > 0);
}

function getTagInputValues(id) {
    const state = tagInputState.get(id);
    const entry = document.querySelector(`[data-tag-input="${id}"] .tag-entry`);
    if (entry && entry.value.trim()) addTagValue(document.querySelector(`[data-tag-input="${id}"]`), entry.value);
    return state ? [...state.values] : [];
}

function setTagInputValues(id, values) {
    const wrapper = document.querySelector(`[data-tag-input="${id}"]`);
    const state = tagInputState.get(id);
    if (!wrapper || !state) return;
    state.values = Array.isArray(values) ? values.map(String).map(value => value.trim()).filter(Boolean) : [];
    wrapper.querySelector('.tag-entry').value = '';
    renderTagChips(wrapper);
}

initTagInputs();

/** Persists the selected bookmark layout and refreshes the grid. */
function setBookmarkView(viewMode) {
    const normalizedMode = ['grid', 'compact', 'list'].includes(viewMode) ? viewMode : 'grid';
    currentBookmarkView = normalizedMode;
    localStorage.setItem(bookmarksConfig.storageKeys.viewMode, normalizedMode);
    if (currentUser && typeof api !== 'undefined') api.saveUserSetting('viewMode', normalizedMode).catch(err => console.warn('Failed to save view mode:', err));
    document.querySelectorAll('.view-btn').forEach(button => button.classList.remove('active'));

    const buttonMap = {
        grid: 'btnViewGrid',
        compact: 'btnViewCompact',
        list: 'btnViewList'
    };

    const button = document.getElementById(buttonMap[currentBookmarkView]);
    if (button) button.classList.add('active');
    updateImageToggleButton();
    renderBookmarks();
}

function updateImageToggleButton() {
    const toggleButton = document.getElementById('btnToggleImages');
    if (!toggleButton) return;
    toggleButton.classList.toggle('active', !showBookmarkImages);
    toggleButton.classList.toggle('images-hidden', !showBookmarkImages);
    toggleButton.title = showBookmarkImages ? 'Képek elrejtése' : 'Képek megjelenítése';
    toggleButton.innerHTML = '<i class="fa-solid fa-image"></i>';
}

function toggleImageVisibility(forceValue) {
    const nextValue = typeof forceValue === 'boolean' ? forceValue : !showBookmarkImages;
    showBookmarkImages = nextValue;
    localStorage.setItem(bookmarksConfig.storageKeys.showImages, String(nextValue));
    updateImageToggleButton();
    renderBookmarks();
}

/** Filters, sorts, and renders bookmarks visible to the current user. */
function updateBulkSelectionToggleUI() {
    const button = document.getElementById('bulkSelectionToggleBtn');
    if (!button) return;
    const text = button.querySelector('.bulk-toggle-text');
    const isEnabled = bulkSelectionEnabled;
    button.classList.toggle('is-enabled', isEnabled);
    button.setAttribute('aria-pressed', String(isEnabled));
    if (text) text.textContent = isEnabled ? 'Bulk ON' : 'Bulk OFF';
}

updateBulkSelectionToggleUI();

function toggleBulkSelectionMode(forceValue) {
    const nextValue = typeof forceValue === 'boolean' ? forceValue : !bulkSelectionEnabled;
    bulkSelectionEnabled = nextValue;
    if (!bulkSelectionEnabled) {
        selectedBookmarkIds.clear();
    }
    renderSelectionToolbar();
    updateBulkSelectionToggleUI();
    if (typeof bookmarks !== 'undefined') {
        renderBookmarks();
    }
}

function renderSelectionToolbar() {
    const bar = document.getElementById('bulkSelectionBar');
    const countNode = document.getElementById('bulkSelectionCount');
    if (!bar || !countNode) return;
    const count = selectedBookmarkIds.size;
    const shouldShow = bulkSelectionEnabled;
    bar.style.display = shouldShow ? 'flex' : 'none';
    countNode.textContent = String(count);
    const bulkSelect = document.getElementById('bulkCategorySelect');
    if (bulkSelect && !bulkSelect.value) {
        bulkSelect.value = bulkSelect.options[0]?.value || '';
    }
}

function populateBulkCategorySelect() {
    const select = document.getElementById('bulkCategorySelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">Válassz kategóriát</option>';
    const treeItems = categoryTree ? categoryTree() : [];
    treeItems.forEach(({ category, depth }) => {
        const name = categoryName(category);
        select.add(new Option(`${'— '.repeat(depth)}${name}`, name));
    });
    if (categories && categories.length && currentValue && categories.some(category => categoryName(category) === currentValue)) {
        select.value = currentValue;
    }
}

function confirmBulkAction(action, extra = {}) {
    const labels = {
        star: 'biztosan hozzáadsz kedvencnek',
        unstar: 'biztosan eltávolítod a kedvencek közül',
        archive: 'biztosan archiválod',
        restore: 'biztosan visszaállítod',
        status: `biztosan állapotot állítasz be erre: ${extra.status === 'read_later' ? 'Olvasás később' : extra.status === 'to_review' ? 'Ellenőrzésre' : extra.status || 'állapot'}`,
        category: `biztosan kategóriát módosítasz erre: ${extra.category || 'kategória'}`,
        trash: 'biztosan a kukába helyezed'
    };
    const label = labels[action] || 'biztosan végrehajtod';
    return window.confirm(`A kiválasztott könyvjelzőkön elvégzi ezt a műveletet?\n\n${label}`);
}

function toggleBookmarkSelection(id) {
    if (!bulkSelectionEnabled) return;
    if (selectedBookmarkIds.has(id)) selectedBookmarkIds.delete(id);
    else selectedBookmarkIds.add(id);
    renderSelectionToolbar();
}

function selectVisibleBookmarks() {
    if (!bulkSelectionEnabled) return;
    const visibleIds = Array.from(document.querySelectorAll('.bookmark-select-input')).map(input => Number(input.value)).filter(Number.isFinite);
    if (!visibleIds.length) return;
    const allSelected = visibleIds.every(id => selectedBookmarkIds.has(id));
    visibleIds.forEach(id => { if (allSelected) selectedBookmarkIds.delete(id); else selectedBookmarkIds.add(id); });
    renderSelectionToolbar();
    renderBookmarks();
}

function renderBookmarks() {
    if (typeof bookmarks === 'undefined') {
        bookmarks = [];
    }
    const grid = document.getElementById('bookmarkGrid'); const addPanel = document.getElementById('addPanel');
    if (!grid) return;
    const layoutClass = currentBookmarkView === 'grid' ? '' : ` view-${currentBookmarkView}`;
    grid.innerHTML = ''; grid.className = `dashboard-grid${layoutClass}`;
    if (addPanel) addPanel.style.display = currentUser ? 'block' : 'none';
    const userIds = currentUser
        ? new Set([
            String(currentUser.username || '').toLowerCase(),
            String(currentUser.id || '').toLowerCase(),
            'demo',
            'admin'
        ].filter(Boolean))
        : new Set(['demo', 'admin', 'main']);
    let visible = !currentUser
        ? bookmarks.filter(bookmark => userIds.has(String(bookmark.userId || '').toLowerCase()))
        : currentUser.isSuperuser
            ? [...bookmarks]
            : bookmarks.filter(bookmark => userIds.has(String(bookmark.userId || '').toLowerCase()));
    if (activeCategoryFilter !== 'All') visible = visible.filter(bookmark => bookmark.category === activeCategoryFilter);
    if (bookmarkStateFilter === 'starred') visible = visible.filter(bookmark => bookmark.starred);
    else if (bookmarkStateFilter === 'archived') visible = visible.filter(bookmark => bookmark.archived);
    else if (bookmarkStateFilter === 'trash') visible = visible.filter(bookmark => bookmark.trashed);
    else if (['read_later', 'to_review', 'done'].includes(bookmarkStateFilter)) visible = visible.filter(bookmark => bookmark.status === bookmarkStateFilter);
    else visible = visible.filter(bookmark => !bookmark.archived && !bookmark.trashed);
    const search = String(window.enterpriseSearch || '').toLowerCase();
    const tagFilter = String(window.enterpriseTagFilter || '').toLowerCase();
    if (search) visible = visible.filter(bookmark => [bookmark.title, bookmark.url, bookmark.category, bookmark.description, ...(bookmark.tags || [])].join(' ').toLowerCase().includes(search));
    if (tagFilter) visible = visible.filter(bookmark => (bookmark.tags || []).some(tag => tag.toLowerCase().includes(tagFilter)));
    visible.sort((a, b) => currentSortMode === 'abc' ? (a.title || '').localeCompare(b.title || '', 'hu') : currentSortMode === 'oldest' ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0) : currentSortMode === 'frequency' ? (b.clicks || 0) - (a.clicks || 0) : new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (!visible.length) { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-secondary)"><i class="fa-solid fa-folder-open" style="font-size:2.5rem"></i><p>Nincs megjeleníthető könyvjelző ebben a kategóriában.</p></div>'; renderSelectionToolbar(); return; }
    visible.forEach(bookmark => grid.appendChild(createBookmarkCard(bookmark)));
    renderSelectionToolbar();
}

/** Builds a bookmark card and wires its actions. */
function createBookmarkCard(bookmark) {
    const card = document.createElement('div'); card.className = 'card';
    card.dataset.bookmarkId = String(bookmark.id);
    const fetchMetadataTitleEnabled = localStorage.getItem(bookmarksConfig.storageKeys.fetchMetadataTitle) !== 'false';
    const fetchMetadataImageEnabled = localStorage.getItem(bookmarksConfig.storageKeys.fetchMetadataImage) !== 'false';
    const primaryTitle = (bookmark.title && String(bookmark.title).trim()) || (bookmark.metadataTitle && String(bookmark.metadataTitle).trim()) || 'Névtelen könyvjelző';
    const shouldShowImage = showBookmarkImages && fetchMetadataImageEnabled && bookmark.imageUrl;
    let selectionControl = null;
    if (bulkSelectionEnabled) {
        selectionControl = document.createElement('label');
        selectionControl.className = 'bookmark-select-wrap';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'bookmark-select-input';
        checkbox.value = String(bookmark.id);
        checkbox.checked = selectedBookmarkIds.has(bookmark.id);
        checkbox.onchange = () => toggleBookmarkSelection(Number(bookmark.id));
        selectionControl.appendChild(checkbox);
        if (shouldShowImage) {
            const selectionRow = document.createElement('div');
            selectionRow.className = 'bookmark-selection-row';
            selectionRow.appendChild(selectionControl);
            card.appendChild(selectionRow);
        } else {
            card.appendChild(selectionControl);
        }
    }
    if (shouldShowImage) {
        const image = document.createElement('img'); image.className = 'card-cover'; image.src = bookmark.imageUrl; image.alt = primaryTitle;
        image.loading = 'lazy'; image.onerror = () => image.remove(); card.appendChild(image);
    }
    const left = document.createElement('div'); left.className = 'card-content'; const header = document.createElement('div'); header.className = 'card-header';
    const title = document.createElement('a'); title.href = bookmark.url; title.target = '_blank'; title.className = 'card-title'; title.textContent = primaryTitle;
    title.onclick = event => { event.preventDefault(); trackClickAndOpen(bookmark.id, bookmark.url); };
    const titleContainer = document.createElement('div'); titleContainer.className = 'card-title-container'; titleContainer.appendChild(title);
    const category = document.createElement('span'); category.className = 'card-category'; category.textContent = bookmark.category;
    if (bulkSelectionEnabled) {
        if (!shouldShowImage) {
            header.appendChild(selectionControl);
        }
        header.append(titleContainer, category);
    } else {
        header.append(titleContainer, category);
    }
    if (bookmark.tags && bookmark.tags.length) {
        const tags = document.createElement('div'); tags.className = 'card-tags'; tags.textContent = bookmark.tags.map(tag => `#${tag}`).join(' '); left.appendChild(tags);
    }
    const url = document.createElement('div'); url.className = 'card-url'; url.textContent = bookmark.url; left.append(header, url);
    if (fetchMetadataTitleEnabled && bookmark.metadataTitle && bookmark.metadataTitle.trim() && bookmark.metadataTitle.trim() !== primaryTitle.trim()) {
        const articleTitle = document.createElement('div'); articleTitle.className = 'card-metadata-title'; articleTitle.textContent = bookmark.metadataTitle; left.appendChild(articleTitle);
    }
    const footer = document.createElement('div'); footer.className = 'card-footer'; footer.innerHTML = `<span><i class="fa-regular fa-clock"></i> ${bookmark.createdAt}</span>`;
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const star = document.createElement('button'); star.className = 'action-btn' + (bookmark.starred ? ' is-starred' : ''); star.title = 'Kedvenc'; star.innerHTML = `<i class="fa-${bookmark.starred ? 'solid' : 'regular'} fa-star"></i>`; star.onclick = () => updateBookmarkState(bookmark.id, { starred: !bookmark.starred });
    const later = document.createElement('button'); later.className = 'action-btn' + (bookmark.status === 'read_later' ? ' is-read-later' : ''); later.title = 'Olvasás később'; later.innerHTML = '<i class="fa-solid fa-clock"></i>'; later.onclick = () => updateBookmarkState(bookmark.id, { status: bookmark.status === 'read_later' ? 'inbox' : 'read_later' });
    const review = document.createElement('button'); review.className = 'action-btn' + (bookmark.status === 'to_review' ? ' is-to-review' : ''); review.title = 'Ellenőrzésre'; review.innerHTML = '<i class="fa-solid fa-flag"></i>'; review.onclick = () => updateBookmarkState(bookmark.id, { status: bookmark.status === 'to_review' ? 'inbox' : 'to_review' });
    const archive = document.createElement('button'); archive.className = 'action-btn'; archive.title = bookmark.trashed || bookmark.archived ? 'Visszaállítás' : 'Archiválás'; archive.innerHTML = `<i class="fa-solid fa-box-${bookmark.archived ? 'open' : 'archive'}"></i>`; archive.onclick = () => updateBookmarkState(bookmark.id, bookmark.trashed ? { trashed: false } : { archived: !bookmark.archived });
    const preview = document.createElement('button'); preview.className = 'action-btn'; preview.title = 'Előnézet'; preview.innerHTML = '<i class="fa-solid fa-eye"></i>'; preview.onclick = () => openPreviewModal(bookmark);
    const edit = document.createElement('button'); edit.className = 'action-btn'; edit.title = 'Szerkesztés'; edit.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>'; edit.onclick = () => openEditModal(bookmark.id);
    const share = document.createElement('button'); share.className = 'action-btn'; share.title = 'Megosztás'; share.innerHTML = '<i class="fa-solid fa-share-nodes"></i>'; share.onclick = async () => { try { const result = await api.shareBookmark(bookmark.id); await navigator.clipboard.writeText(result.url); showNotification('Megosztási hivatkozás a vágólapra másolva.', 'success'); } catch (err) { showNotification('A megosztás nem sikerült.', 'error'); } };
    const remove = document.createElement('button'); remove.className = 'action-btn'; remove.title = bookmark.trashed ? 'Végleges törlés' : 'Kukába helyezés'; remove.innerHTML = '<i class="fa-solid fa-trash"></i>'; remove.onclick = () => bookmark.trashed ? permanentlyDeleteBookmark(bookmark.id) : deleteBookmark(bookmark.id); actions.append(star, later, review, archive, preview, edit, share, remove); footer.appendChild(actions); card.append(left, footer); return card;
}

/** Populates a category select while preserving a valid selection. */
function populateCategorySelect(id, selectedValue = null) {
    const select = document.getElementById(id); if (!select) return; const current = selectedValue || select.value;
    select.innerHTML = '';
    if (typeof categoryTree === 'function') {
        categoryTree().forEach(({ category, depth }) => {
            const name = categoryName(category);
            select.append(new Option(`${'— '.repeat(depth)}${name}`, name));
        });
    } else categories.forEach(category => select.append(new Option(categoryName(category), categoryName(category))));
    if (categories.some(category => categoryName(category) === current)) select.value = current;
}

/** Deletes a bookmark and refreshes the list. */
async function deleteBookmark(id) {
    if (!confirm('Biztosan kukába helyezed ezt a könyvjelzőt? A kukából később visszaállítható.')) return;
    try { await api.deleteBookmark(id); await loadBookmarksFromServer(); renderBookmarks(); showNotification('A könyvjelző a kukába került.', 'success'); } catch (err) { showNotification(err.message || 'Hiba történt a törlés során.', 'error'); }
}
async function updateBookmarkState(id, state) { try { await api.updateBookmarkState(id, state); await loadBookmarksFromServer(); renderBookmarks(); } catch (err) { showNotification(err.message || 'Állapot mentése sikertelen.', 'error'); } }
async function permanentlyDeleteBookmark(id) { if (!confirm('Véglegesen törlöd ezt a könyvjelzőt?')) return; try { await api.permanentlyDeleteBookmark(id); await loadBookmarksFromServer(); renderBookmarks(); } catch (err) { showNotification('A végleges törlés sikertelen.', 'error'); } }

async function applyBulkAction(action, extra = {}) {
    if (!selectedBookmarkIds.size) { showNotification('Előbb válassz ki legalább egy könyvjelzőt.', 'error'); return; }
    if (!confirmBulkAction(action, extra)) return;
    const ids = [...selectedBookmarkIds];
    try {
        await api.bulkBookmarkAction(ids, action, extra);
        selectedBookmarkIds.clear();
        await loadBookmarksFromServer();
        renderBookmarks();
        renderSelectionToolbar();
        showNotification('A tömeges művelet elkészült.', 'success');
    } catch (err) {
        showNotification(err.message || 'A tömeges művelet nem sikerült.', 'error');
    }
}

function applyBulkCategoryChange() {
    const select = document.getElementById('bulkCategorySelect');
    if (!select) return;
    const category = String(select.value || '').trim();
    if (!category) {
        showNotification('Válassz ki egy kategóriát a módosításhoz.', 'error');
        return;
    }
    applyBulkAction('category', { category });
}

function openPreviewModal(bookmark) {
    const content = document.getElementById('previewBookmarkContent');
    const openLink = document.getElementById('previewBookmarkOpen');
    const primaryTitle = bookmark.title || bookmark.metadataTitle || 'Névtelen könyvjelző';
    const tags = (bookmark.tags || []).map(tag => `#${tag}`).join(', ') || 'Nincs címke';
    content.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">Cím</div>
                <h3 style="margin:0;">${primaryTitle}</h3>
            </div>
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">URL</div>
                <a href="${bookmark.url}" target="_blank" rel="noopener noreferrer" style="word-break: break-all; color: var(--accent);">${bookmark.url}</a>
            </div>
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">Kategória</div>
                <div>${bookmark.category || 'Inbox'}</div>
            </div>
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">Állapot</div>
                <div>${bookmark.status || 'inbox'} • ${bookmark.starred ? 'Kedvenc' : 'Nem kedvenc'}</div>
            </div>
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">Leírás</div>
                <div>${bookmark.description || 'Nincs leírás'}</div>
            </div>
            <div>
                <div style="font-size:0.8rem; color: var(--text-secondary); margin-bottom:0.25rem; text-transform: uppercase; letter-spacing: 0.08rem;">Címkék</div>
                <div>${tags}</div>
            </div>
        </div>
    `;
    openLink.href = bookmark.url;
    openModal('previewModal');
}

/** Records a click locally and remotely before opening the bookmark. */
async function trackClickAndOpen(id, url) {
    const bookmark = bookmarks.find(item => item.id === id); if (bookmark) bookmark.clicks = (bookmark.clicks || 0) + 1;
    try { await api.trackBookmarkClick(id); } catch (err) { console.warn('Click tracking failed:', err); }
    window.open(url, '_blank'); renderBookmarks();
}

/** Opens the edit modal with the selected bookmark's values. */
function openEditModal(id) {
    const bookmark = bookmarks.find(item => item.id === id); if (!bookmark) return;
    document.getElementById('editBmId').value = bookmark.id;
    document.getElementById('editBmTitle').value = bookmark.title;
    document.getElementById('editBmUrl').value = bookmark.url;
    setTagInputValues('editBmTags', bookmark.tags || []);
    populateCategorySelect('editBmCategory', bookmark.category); openModal('editModal');
}

document.getElementById('bookmarkForm').addEventListener('submit', async event => {
    event.preventDefault(); const title = document.getElementById('bmTitle'); const url = document.getElementById('bmUrl'); const category = document.getElementById('bmCategory');
    try { await api.createBookmark({ userId: currentUser ? currentUser.username : 'demo', title: title.value, url: url.value, category: category.value, tags: getTagInputValues('bmTags') }); await loadBookmarksFromServer(); event.target.reset(); setTagInputValues('bmTags', []); history.replaceState({}, document.title, location.pathname); document.getElementById('incomingAlert').style.display = 'none'; document.getElementById('addPanel').style.borderColor = 'var(--border-color)'; renderBookmarks(); showNotification('A könyvjelző mentve.', 'success'); } catch (err) { showNotification('Hiba történt a mentés során.', 'error'); }
});

document.getElementById('editBookmarkForm').addEventListener('submit', async event => {
    event.preventDefault(); const id = Number(document.getElementById('editBmId').value); const data = { title: document.getElementById('editBmTitle').value.trim(), url: document.getElementById('editBmUrl').value.trim(), category: document.getElementById('editBmCategory').value, tags: getTagInputValues('editBmTags') };
    try { await api.updateBookmark(id, data); await loadBookmarksFromServer(); } catch (err) { const bookmark = bookmarks.find(item => item.id === id); if (bookmark) Object.assign(bookmark, data); }
    renderBookmarks(); closeModal('editModal'); showNotification('A könyvjelző módosítva.', 'success');
});

window.setBookmarkView = setBookmarkView; window.toggleImageVisibility = toggleImageVisibility; window.deleteBookmark = deleteBookmark; window.updateBookmarkState = updateBookmarkState; window.permanentlyDeleteBookmark = permanentlyDeleteBookmark; window.trackClickAndOpen = trackClickAndOpen; window.openEditModal = openEditModal; window.openPreviewModal = openPreviewModal; window.confirmBulkAction = confirmBulkAction; window.applyBulkAction = applyBulkAction; window.applyBulkCategoryChange = applyBulkCategoryChange; window.populateBulkCategorySelect = populateBulkCategorySelect; window.toggleBookmarkSelection = toggleBookmarkSelection; window.selectVisibleBookmarks = selectVisibleBookmarks;
