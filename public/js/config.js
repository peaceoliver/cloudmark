const CloudMark = window.CloudMark || {};

CloudMark.config = Object.freeze({
    storageKeys: Object.freeze({
        theme: 'cloudmark_theme',
        viewMode: 'cloudmark_view_mode',
        sortMode: 'cloudmark_sort_mode',
        showImages: 'cloudmark_show_images',
        fetchMetadata: 'cloudmark_fetch_metadata',
        fetchMetadataTitle: 'cloudmark_fetch_metadata_title',
        fetchMetadataImage: 'cloudmark_fetch_metadata_image',
        user: 'cloudmark_user'
    }),
    defaultCategories: Object.freeze(['Inbox', 'Fejlesztés', 'Eszközök', 'Hírek', 'Szórakozás'])
});

window.CloudMark = CloudMark;

/** Reads and parses a localStorage value, returning a fallback on failure. */
window.safeLoad = function safeLoad(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        console.warn('safeLoad parse error for', key, err);
        return fallback;
    }
};
