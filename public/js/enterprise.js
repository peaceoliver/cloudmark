/* Enterprise search, import and export controls. */
(function () {
    function refresh() {
        window.enterpriseSearch = document.getElementById('bookmarkSearch').value;
        window.enterpriseTagFilter = document.getElementById('tagFilter').value;
        renderBookmarks();
    }
    document.getElementById('bookmarkSearch').addEventListener('input', refresh);
    document.getElementById('tagFilter').addEventListener('input', refresh);

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
