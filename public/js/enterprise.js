/* Enterprise search, import and export controls. */
(function () {
    function refresh() {
        window.enterpriseSearch = document.getElementById('bookmarkSearch').value;
        window.enterpriseTagFilter = document.getElementById('tagFilter').value;
        renderBookmarks();
    }
    document.getElementById('bookmarkSearch').addEventListener('input', refresh);
    document.getElementById('tagFilter').addEventListener('input', refresh);

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

    async function download(format) {
        try {
            const blob = await api.exportBookmarks(format);
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
            let items;
            if (file.name.toLowerCase().endsWith('.json')) {
                const parsed = JSON.parse(text);
                items = Array.isArray(parsed) ? parsed : parsed.bookmarks;
            } else {
                const doc = new DOMParser().parseFromString(text, 'text/html');
                items = [...doc.querySelectorAll('a[href]')].map(a => ({ title: a.textContent.trim(), url: a.href, category: 'Inbox' }));
            }
            const result = await api.importBookmarks(items || []);
            await loadBookmarksFromServer();
            renderBookmarks();
            showNotification(`${result.imported} könyvjelző importálva.`, 'success');
        } catch (err) { showNotification('Az importálás sikertelen: érvénytelen fájl.', 'error'); }
        this.value = '';
    });
})();
