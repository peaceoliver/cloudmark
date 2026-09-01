const bookmarksConfig = window.CloudMark && window.CloudMark.config ? window.CloudMark.config : {};
let currentBookmarkView = (bookmarksConfig.storageKeys ? localStorage.getItem(bookmarksConfig.storageKeys.viewMode) : null) || 'grid';
let showBookmarkImages = bookmarksConfig.storageKeys ? localStorage.getItem(bookmarksConfig.storageKeys.showImages) !== 'false' : true;
const tagInputState = new Map();

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
    toggleButton.title = showBookmarkImages ? 'Képek elrejtése' : 'Képek megjelenítése';
    toggleButton.innerHTML = showBookmarkImages
        ? '<i class="fa-solid fa-image"></i>'
        : '<i class="fa-solid fa-image-slash"></i>';
}

function toggleImageVisibility(forceValue) {
    const nextValue = typeof forceValue === 'boolean' ? forceValue : !showBookmarkImages;
    showBookmarkImages = nextValue;
    localStorage.setItem(bookmarksConfig.storageKeys.showImages, String(nextValue));
    updateImageToggleButton();
    renderBookmarks();
}

/** Filters, sorts, and renders bookmarks visible to the current user. */
function renderBookmarks() {
    const grid = document.getElementById('bookmarkGrid'); const addPanel = document.getElementById('addPanel');
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
    if (!visible.length) { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-secondary)"><i class="fa-solid fa-folder-open" style="font-size:2.5rem"></i><p>Nincs megjeleníthető könyvjelző ebben a kategóriában.</p></div>'; return; }
    visible.forEach(bookmark => grid.appendChild(createBookmarkCard(bookmark)));
}

/** Builds a bookmark card and wires its actions. */
function createBookmarkCard(bookmark) {
    const card = document.createElement('div'); card.className = 'card';
    const fetchMetadataTitleEnabled = localStorage.getItem(bookmarksConfig.storageKeys.fetchMetadataTitle) !== 'false';
    const fetchMetadataImageEnabled = localStorage.getItem(bookmarksConfig.storageKeys.fetchMetadataImage) !== 'false';
    const primaryTitle = (bookmark.title && String(bookmark.title).trim()) || (bookmark.metadataTitle && String(bookmark.metadataTitle).trim()) || 'Névtelen könyvjelző';
    const shouldShowImage = showBookmarkImages && fetchMetadataImageEnabled && bookmark.imageUrl;
    if (shouldShowImage) {
        const image = document.createElement('img'); image.className = 'card-cover'; image.src = bookmark.imageUrl; image.alt = primaryTitle;
        image.loading = 'lazy'; image.onerror = () => image.remove(); card.appendChild(image);
    }
    const left = document.createElement('div'); left.className = 'card-content'; const header = document.createElement('div'); header.className = 'card-header';
    const title = document.createElement('a'); title.href = bookmark.url; title.target = '_blank'; title.className = 'card-title'; title.textContent = primaryTitle;
    title.onclick = event => { event.preventDefault(); trackClickAndOpen(bookmark.id, bookmark.url); };
    const titleContainer = document.createElement('div'); titleContainer.className = 'card-title-container'; titleContainer.appendChild(title);
    const category = document.createElement('span'); category.className = 'card-category'; category.textContent = bookmark.category; header.append(titleContainer, category);
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
    const later = document.createElement('button'); later.className = 'action-btn'; later.title = 'Olvasás később'; later.innerHTML = '<i class="fa-solid fa-clock"></i>'; later.onclick = () => updateBookmarkState(bookmark.id, { status: bookmark.status === 'read_later' ? 'inbox' : 'read_later' });
    const review = document.createElement('button'); review.className = 'action-btn'; review.title = 'Ellenőrzésre'; review.innerHTML = '<i class="fa-solid fa-flag"></i>'; review.onclick = () => updateBookmarkState(bookmark.id, { status: bookmark.status === 'to_review' ? 'inbox' : 'to_review' });
    const archive = document.createElement('button'); archive.className = 'action-btn'; archive.title = bookmark.trashed || bookmark.archived ? 'Visszaállítás' : 'Archiválás'; archive.innerHTML = `<i class="fa-solid fa-box-${bookmark.archived ? 'open' : 'archive'}"></i>`; archive.onclick = () => updateBookmarkState(bookmark.id, bookmark.trashed ? { trashed: false } : { archived: !bookmark.archived });
    const edit = document.createElement('button'); edit.className = 'action-btn'; edit.title = 'Szerkesztés'; edit.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>'; edit.onclick = () => openEditModal(bookmark.id);
    const share = document.createElement('button'); share.className = 'action-btn'; share.title = 'Megosztás'; share.innerHTML = '<i class="fa-solid fa-share-nodes"></i>'; share.onclick = async () => { try { const result = await api.shareBookmark(bookmark.id); await navigator.clipboard.writeText(result.url); showNotification('Megosztási hivatkozás a vágólapra másolva.', 'success'); } catch (err) { showNotification('A megosztás nem sikerült.', 'error'); } };
    const remove = document.createElement('button'); remove.className = 'action-btn'; remove.title = bookmark.trashed ? 'Végleges törlés' : 'Kukába helyezés'; remove.innerHTML = '<i class="fa-solid fa-trash"></i>'; remove.onclick = () => bookmark.trashed ? permanentlyDeleteBookmark(bookmark.id) : deleteBookmark(bookmark.id); actions.append(star, later, review, archive, edit, share, remove); footer.appendChild(actions); card.append(left, footer); return card;
}

/** Populates a category select while preserving a valid selection. */
function populateCategorySelect(id, selectedValue = null) {
    const select = document.getElementById(id); if (!select) return; const current = selectedValue || select.value;
    select.innerHTML = ''; categories.forEach(category => select.append(new Option(category, category))); if (categories.includes(current)) select.value = current;
}

/** Deletes a bookmark and refreshes the list. */
async function deleteBookmark(id) { try { await api.deleteBookmark(id); await loadBookmarksFromServer(); renderBookmarks(); showNotification('A könyvjelző törölve.', 'success'); } catch (err) { showNotification('Hiba történt a törlés során.', 'error'); } }
async function updateBookmarkState(id, state) { try { await api.updateBookmarkState(id, state); await loadBookmarksFromServer(); renderBookmarks(); } catch (err) { showNotification(err.message || 'Állapot mentése sikertelen.', 'error'); } }
async function permanentlyDeleteBookmark(id) { if (!confirm('Véglegesen törlöd ezt a könyvjelzőt?')) return; try { await api.permanentlyDeleteBookmark(id); await loadBookmarksFromServer(); renderBookmarks(); } catch (err) { showNotification('A végleges törlés sikertelen.', 'error'); } }

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

window.setBookmarkView = setBookmarkView; window.toggleImageVisibility = toggleImageVisibility; window.deleteBookmark = deleteBookmark; window.updateBookmarkState = updateBookmarkState; window.permanentlyDeleteBookmark = permanentlyDeleteBookmark; window.trackClickAndOpen = trackClickAndOpen; window.openEditModal = openEditModal;
