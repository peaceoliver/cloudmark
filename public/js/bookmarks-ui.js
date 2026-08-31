let currentBookmarkView = localStorage.getItem(CloudMark.config.storageKeys.viewMode) || 'grid';

/** Persists the selected bookmark layout and refreshes the grid. */
function setBookmarkView(viewMode) {
    currentBookmarkView = viewMode; localStorage.setItem(config.storageKeys.viewMode, viewMode);
    if (currentUser && typeof api !== 'undefined') api.saveUserSetting('viewMode', viewMode).catch(err => console.warn('Failed to save view mode:', err));
    document.querySelectorAll('.view-btn').forEach(button => button.classList.remove('active'));

    const buttonMap = {
        grid: 'btnViewGrid',
        compact: 'btnViewCompact',
        list: 'btnViewList',
        noimage: 'btnViewNoimage'
    };

    const button = document.getElementById(buttonMap[viewMode] || `btnView${viewMode[0].toUpperCase()}${viewMode.slice(1)}`);
    if (button) button.classList.add('active');
    renderBookmarks();
}

/** Filters, sorts, and renders bookmarks visible to the current user. */
function renderBookmarks() {
    const grid = document.getElementById('bookmarkGrid'); const addPanel = document.getElementById('addPanel');
    grid.innerHTML = ''; grid.className = `dashboard-grid${currentBookmarkView === 'grid' ? '' : ` view-${currentBookmarkView}`}`;
    if (addPanel) addPanel.style.display = currentUser ? 'block' : 'none';
    const userId = currentUser ? currentUser.username : 'demo';
    let visible = !currentUser ? bookmarks.filter(bookmark => bookmark.userId === 'admin' || bookmark.userId === 'demo' || bookmark.category === 'MAIN') : currentUser.isSuperuser ? [...bookmarks] : bookmarks.filter(bookmark => bookmark.userId === userId || bookmark.userId === 'demo');
    if (activeCategoryFilter !== 'All') visible = visible.filter(bookmark => bookmark.category === activeCategoryFilter);
    visible.sort((a, b) => currentSortMode === 'abc' ? (a.title || '').localeCompare(b.title || '', 'hu') : currentSortMode === 'oldest' ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0) : currentSortMode === 'frequency' ? (b.clicks || 0) - (a.clicks || 0) : new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (!visible.length) { grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-secondary)"><i class="fa-solid fa-folder-open" style="font-size:2.5rem"></i><p>Nincs megjeleníthető könyvjelző ebben a kategóriában.</p></div>'; return; }
    visible.forEach(bookmark => grid.appendChild(createBookmarkCard(bookmark)));
}

/** Builds a bookmark card and wires its actions. */
function createBookmarkCard(bookmark) {
    const card = document.createElement('div'); card.className = 'card';
    const fetchMetadataEnabled = localStorage.getItem(config.storageKeys.fetchMetadata) !== 'false';
    if (fetchMetadataEnabled && bookmark.imageUrl) {
        const image = document.createElement('img'); image.className = 'card-cover'; image.src = bookmark.imageUrl; image.alt = bookmark.metadataTitle || bookmark.title;
        image.loading = 'lazy'; image.onerror = () => image.remove(); card.appendChild(image);
    }
    const left = document.createElement('div'); const header = document.createElement('div'); header.className = 'card-header';
    const title = document.createElement('a'); title.href = bookmark.url; title.target = '_blank'; title.className = 'card-title'; title.textContent = bookmark.title;
    title.onclick = event => { event.preventDefault(); trackClickAndOpen(bookmark.id, bookmark.url); };
    const titleContainer = document.createElement('div'); titleContainer.style.cssText = 'display:flex; align-items:center; gap:0.5rem; overflow:hidden;'; titleContainer.appendChild(title);
    const category = document.createElement('span'); category.className = 'card-category'; category.textContent = bookmark.category; header.append(titleContainer, category);
    const url = document.createElement('div'); url.className = 'card-url'; url.textContent = bookmark.url; left.append(header, url);
    if (fetchMetadataEnabled && bookmark.metadataTitle && bookmark.metadataTitle !== bookmark.title) {
        const articleTitle = document.createElement('div'); articleTitle.className = 'card-metadata-title'; articleTitle.textContent = bookmark.metadataTitle; left.appendChild(articleTitle);
    }
    const footer = document.createElement('div'); footer.className = 'card-footer'; footer.innerHTML = `<span><i class="fa-regular fa-clock"></i> ${bookmark.createdAt}</span>`;
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const edit = document.createElement('button'); edit.className = 'action-btn'; edit.title = 'Szerkesztés'; edit.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>'; edit.onclick = () => openEditModal(bookmark.id);
    const remove = document.createElement('button'); remove.className = 'action-btn'; remove.title = 'Törlés'; remove.innerHTML = '<i class="fa-solid fa-trash"></i>'; remove.onclick = () => deleteBookmark(bookmark.id); actions.append(edit, remove); footer.appendChild(actions); card.append(left, footer); return card;
}

/** Populates a category select while preserving a valid selection. */
function populateCategorySelect(id, selectedValue = null) {
    const select = document.getElementById(id); if (!select) return; const current = selectedValue || select.value;
    select.innerHTML = ''; categories.forEach(category => select.append(new Option(category, category))); if (categories.includes(current)) select.value = current;
}

/** Deletes a bookmark and refreshes the list. */
async function deleteBookmark(id) { try { await api.deleteBookmark(id); await loadBookmarksFromServer(); renderBookmarks(); showNotification('A könyvjelző törölve.', 'success'); } catch (err) { showNotification('Hiba történt a törlés során.', 'error'); } }

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
    populateCategorySelect('editBmCategory', bookmark.category); openModal('editModal');
}

document.getElementById('bookmarkForm').addEventListener('submit', async event => {
    event.preventDefault(); const title = document.getElementById('bmTitle'); const url = document.getElementById('bmUrl'); const category = document.getElementById('bmCategory');
    try { await api.createBookmark({ userId: currentUser ? currentUser.username : 'demo', title: title.value, url: url.value, category: category.value }); await loadBookmarksFromServer(); event.target.reset(); history.replaceState({}, document.title, location.pathname); document.getElementById('incomingAlert').style.display = 'none'; document.getElementById('addPanel').style.borderColor = 'var(--border-color)'; renderBookmarks(); showNotification('A könyvjelző mentve.', 'success'); } catch (err) { showNotification('Hiba történt a mentés során.', 'error'); }
});

document.getElementById('editBookmarkForm').addEventListener('submit', async event => {
    event.preventDefault(); const id = Number(document.getElementById('editBmId').value); const data = { title: document.getElementById('editBmTitle').value.trim(), url: document.getElementById('editBmUrl').value.trim(), category: document.getElementById('editBmCategory').value };
    try { await api.updateBookmark(id, data); await loadBookmarksFromServer(); } catch (err) { const bookmark = bookmarks.find(item => item.id === id); if (bookmark) Object.assign(bookmark, data); }
    renderBookmarks(); closeModal('editModal'); showNotification('A könyvjelző módosítva.', 'success');
});

window.setBookmarkView = setBookmarkView; window.deleteBookmark = deleteBookmark; window.trackClickAndOpen = trackClickAndOpen; window.openEditModal = openEditModal;
