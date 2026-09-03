/* Enterprise search, import and export controls. */
(function () {
    function refresh() {
        window.enterpriseSearch = document.getElementById('bookmarkSearch').value;
        currentBookmarkPage = 1;
        renderBookmarks();
    }
    document.getElementById('bookmarkSearch').addEventListener('input', refresh);

    async function renderTagsManagement() {
        const container = document.getElementById('manageTagsList');
        container.innerHTML = '<span style="color:var(--text-secondary)">Betöltés...</span>';
        const tags = await api.getTags();
        container.innerHTML = '';
        if (!tags.length) {
            container.innerHTML = '<span style="color:var(--text-secondary)">Még nincs létrehozott címke.</span>';
            return;
        }
        tags.forEach(tag => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:0.5rem 0.75rem; border-radius:8px; border:1px solid var(--border-color);';
            row.innerHTML = `<span style="font-weight:600">#${tag}</span><span style="display:flex; gap:0.4rem;"><button class="action-btn" title="Átnevezés"><i class="fa-solid fa-pen"></i></button><button class="action-btn" title="Törlés"><i class="fa-solid fa-trash"></i></button></span>`;
            row.querySelector('button').onclick = async () => {
                const newName = prompt(`A(z) "${tag}" címke új neve:`, tag);
                if (!newName || !newName.trim() || newName.trim() === tag) return;
                try { await api.renameTag(tag, newName.trim()); await renderTagsManagement(); await loadBookmarksFromServer(); renderBookmarks(); showNotification('A címke átnevezve.', 'success'); }
                catch (err) { showNotification('Nem sikerült átnevezni a címkét.', 'error'); }
            };
            row.querySelectorAll('button')[1].onclick = async () => {
                if (!confirm(`Biztosan törlöd a(z) "${tag}" címkét?`)) return;
                try { await api.deleteTag(tag); await renderTagsManagement(); await loadBookmarksFromServer(); renderBookmarks(); showNotification('A címke törölve.', 'success'); }
                catch (err) { showNotification('Nem sikerült törölni a címkét.', 'error'); }
            };
            container.appendChild(row);
        });
    }

    async function createNewTag() {
        const input = document.getElementById('newTagName');
        const name = input.value.trim();
        if (!name) {
            showNotification('Add meg a címke nevét.', 'error');
            return;
        }
        try {
            await api.createTag(name);
            input.value = '';
            await renderTagsManagement();
            showNotification('A címke létrehozva.', 'success');
        } catch (err) {
            showNotification(err.message || 'Nem sikerült létrehozni a címkét.', 'error');
        }
    }
    window.createNewTag = createNewTag;

    document.getElementById('manageTagsBtn').onclick = async () => {
        openModal('tagModal');
        try { await renderTagsManagement(); } catch (err) { showNotification('Nem sikerült betölteni a címkéket.', 'error'); }
    };

    function getVisibleBookmarkIds() {
        return Array.from(document.querySelectorAll('.card[data-bookmark-id]')).map(card => Number(card.dataset.bookmarkId)).filter(Number.isFinite);
    }

    function getImportTargetCategory() {
        const select = document.getElementById('importBookmarkTargetCategory');
        const value = select ? select.value : '';
        return value && value !== 'all' ? value : null;
    }

    async function refreshImportTargetCategoryOptions() {
        const select = document.getElementById('importBookmarkTargetCategory');
        if (!select) return;
        const categories = await api.getCategories();
        const currentValue = select.value;
        select.innerHTML = '<option value="">Import célkategória (opcionális)</option>';
        categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category.name || category;
            option.textContent = category.name || category;
            select.appendChild(option);
        });
        if (currentValue) select.value = currentValue;
    }

    function parseHtmlBookmarkFile(text, fallbackCategory = null) {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const items = [];

        function walkList(node, currentCategory) {
            const nodes = Array.from(node.children || []);
            for (const child of nodes) {
                if (child.tagName === 'DT') {
                    const folderHeading = child.querySelector('H3');
                    const nestedList = child.querySelector('DL');
                    if (folderHeading && nestedList) {
                        const folderName = folderHeading.textContent.trim();
                        if (folderName) walkList(nestedList, folderName);
                    }
                    const link = child.querySelector('A[href]');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (!href) continue;
                        items.push({
                            title: link.textContent.trim() || href,
                            url: href,
                            category: currentCategory || fallbackCategory || 'Inbox'
                        });
                    }
                    continue;
                }
                if (child.tagName === 'DL') {
                    walkList(child, currentCategory);
                }
            }
        }

        const rootList = doc.querySelector('DL');
        if (rootList) walkList(rootList, fallbackCategory || 'Inbox');
        else {
            [...doc.querySelectorAll('a[href]')].forEach(link => {
                const href = link.getAttribute('href');
                if (!href) return;
                items.push({ title: link.textContent.trim() || href, url: href, category: fallbackCategory || 'Inbox' });
            });
        }
        return items;
    }

    async function download(format) {
        try {
            const params = {};
            const exportMode = document.getElementById('exportModeSelect')?.value || 'visible';

            if (exportMode === 'visible') {
                const visibleIds = getVisibleBookmarkIds();
                if (!visibleIds.length) {
                    showNotification('Nincsenek látható könyvjelzők az exporthoz.', 'error');
                    return;
                }
                params.ids = visibleIds.join(',');
            } else if (exportMode === 'filtered') {
                if (activeCategoryFilter && activeCategoryFilter !== 'All') {
                    params.category = activeCategoryFilter;
                }
                if (bookmarkStateFilter && bookmarkStateFilter !== 'active') {
                    params.state = bookmarkStateFilter;
                }
                const searchValue = String(window.enterpriseSearch || '').trim();
                if (searchValue) params.search = searchValue;
            }

            const blob = await api.exportBookmarks(format, params);
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `cloudmark-bookmarks.${format === 'html' ? 'html' : 'json'}`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (err) { showNotification('Az exportálás nem sikerült.', 'error'); }
    }

    document.getElementById('exportJsonBtn').onclick = () => download('json');
    document.getElementById('exportHtmlBtn').onclick = () => download('html');

    document.getElementById('importBookmarksInput').addEventListener('change', async function () {
        const file = this.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const targetCategory = getImportTargetCategory();
            let items;
            if (file.name.toLowerCase().endsWith('.json')) {
                const parsed = JSON.parse(text);
                items = Array.isArray(parsed) ? parsed : (parsed.bookmarks || []);
                if (targetCategory) {
                    items = items.map(item => ({ ...item, category: item.category || targetCategory }));
                }
            } else {
                items = parseHtmlBookmarkFile(text, targetCategory || 'Inbox');
            }
            const result = await api.importBookmarks(items || [], targetCategory || null);
            await loadBookmarksFromServer();
            renderBookmarks();
            showNotification(`${result.imported} könyvjelző importálva.`, 'success');
        } catch (err) { showNotification('Az importálás sikertelen: érvénytelen fájl.', 'error'); }
        this.value = '';
    });

    refreshImportTargetCategoryOptions();
})();
