const config = CloudMark.config;
const api = CloudMark.api;

let categories = [...config.defaultCategories];
let bookmarks = [];
let currentUser = null;
let activeCategoryFilter = 'All';
let currentSortMode = localStorage.getItem(config.storageKeys.sortMode) || 'newest';

if (localStorage.getItem(config.storageKeys.viewMode) === 'noimage') {
    localStorage.setItem(config.storageKeys.viewMode, 'grid');
}
if (!localStorage.getItem(config.storageKeys.showImages)) {
    localStorage.setItem(config.storageKeys.showImages, 'true');
}

/** Loads the current category list from the server. */
async function loadCategoriesFromServer() {
    try {
        const data = await api.getCategories();
        if (Array.isArray(data) && data.length) categories = data;
    } catch (err) { console.error('Failed to fetch categories:', err); }
}

/** Loads bookmarks and maps database columns to the client model. */
async function loadBookmarksFromServer() {
    try {
        const rows = await api.getBookmarks();
        bookmarks = Array.isArray(rows) ? rows.map(row => ({
            id: row.id, userId: row.user_id || row.userId || 'demo', title: row.title || row.metadata_title || row.url || 'Névtelen könyvjelző',
            url: row.url, category: row.category,
            createdAt: row.created_at ? row.created_at.split('T')[0] : '',
            clicks: row.clicks || row.click_count || 0
            ,metadataTitle: row.metadata_title || '', imageUrl: row.image_url || '',
            description: row.description || '', siteName: row.site_name || ''
        })) : [];
    } catch (err) { console.error('Failed to fetch bookmarks:', err); bookmarks = []; }
}

/** Restores the authenticated user from the server-side session cookie. */
async function loadCurrentUser() {
    try {
        currentUser = await api.getCurrentUser();
    } catch (err) {
        currentUser = null;
    }
}

/** Loads user preferences from the database and applies local fallback values. */
async function loadUserSettings() {
    if (!currentUser) return;
    try {
        const settings = await api.getUserSettings();
        if (settings.theme) {
            localStorage.setItem(config.storageKeys.theme, settings.theme);
            document.documentElement.setAttribute('data-theme', settings.theme);
            updateThemeIcon(settings.theme);
        }
        if (settings.viewMode) {
            localStorage.setItem(config.storageKeys.viewMode, settings.viewMode);
            setBookmarkView(settings.viewMode);
        }
        if (settings.sortMode) {
            currentSortMode = settings.sortMode;
            localStorage.setItem(config.storageKeys.sortMode, settings.sortMode);
        }
        const fetchMetadataTitleValue = settings.fetchMetadataTitle ?? settings.fetchMetadata ?? 'true';
        const fetchMetadataImageValue = settings.fetchMetadataImage ?? settings.fetchMetadata ?? 'true';
        localStorage.setItem(config.storageKeys.fetchMetadataTitle, String(fetchMetadataTitleValue) === 'false' ? 'false' : 'true');
        localStorage.setItem(config.storageKeys.fetchMetadataImage, String(fetchMetadataImageValue) === 'false' ? 'false' : 'true');
        localStorage.setItem(config.storageKeys.fetchMetadata, String(fetchMetadataTitleValue) === 'false' && String(fetchMetadataImageValue) === 'false' ? 'false' : 'true');
    } catch (err) {
        console.warn('Failed to load user settings:', err);
        localStorage.setItem(config.storageKeys.fetchMetadataTitle, 'true');
        localStorage.setItem(config.storageKeys.fetchMetadataImage, 'true');
        localStorage.setItem(config.storageKeys.fetchMetadata, 'true');
    }
}

/** Restores the saved theme or the user's system preference. */
function initTheme() {
    const saved = localStorage.getItem(config.storageKeys.theme) ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
}

/** Updates the theme toggle icon to match the active theme. */
function updateThemeIcon(theme) {
    const button = document.getElementById('themeToggle');
    if (button) button.innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
}

/** Persists the selected bookmark sort mode and refreshes the list. */
function changeSortMode(mode) {
    currentSortMode = mode;
    localStorage.setItem(config.storageKeys.sortMode, mode);
    if (currentUser) api.saveUserSetting('sortMode', mode).catch(err => console.warn('Failed to save sort mode:', err));
    renderBookmarks();
}

/** Copies bookmarklet query parameters into the add-bookmark form. */
function checkIncomingBookmarklet() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('url') || !params.has('title')) return;
    document.getElementById('bmUrl').value = params.get('url');
    document.getElementById('bmTitle').value = params.get('title');
    document.getElementById('incomingAlert').style.display = 'inline-block';
    document.getElementById('addPanel').style.borderColor = 'var(--accent)';
}

document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(config.storageKeys.theme, next);
    if (currentUser) api.saveUserSetting('theme', next).catch(err => console.warn('Failed to save theme:', err));
    updateThemeIcon(next);
});

/** Initializes theme, data, UI state, and event-driven modules. */
async function initApp() {
    initTheme();
    document.getElementById('sortSelect').value = currentSortMode;
    await loadCurrentUser();
    await loadUserSettings();
    await loadCategoriesFromServer();
    await loadBookmarksFromServer();
    renderCategories();
    updateUserUI();
    updateImageToggleButton();
    renderBookmarks();
    renderManageCategoriesList();
    checkIncomingBookmarklet();
}

window.changeSortMode = changeSortMode;
initApp();
