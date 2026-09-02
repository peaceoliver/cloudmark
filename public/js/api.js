const apiNamespace = window.CloudMark || {};

/** Sends an HTTP request and parses a successful JSON response. */
async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        let message = `API error: ${response.status}`;
        try {
            const body = await response.json();
            if (body.error) message = body.error;
        } catch (err) {
            // Keep the status-based fallback for non-JSON error responses.
        }
        throw new Error(message);
    }
    return response.json();
}

apiNamespace.api = {
    /** Registers a user and establishes a server-side session. */
    register(username, email, password) {
        return requestJson('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
    },

    /** Requests a fresh verification email for an unverified user. */
    resendVerification(username) {
        return requestJson('/api/auth/resend-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
    },

    /** Authenticates a user and establishes a server-side session. */
    login(username, password) {
        return requestJson('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
    },

    /** Changes the current user's password and refreshes its session. */
    changePassword(currentPassword, newPassword) {
        return requestJson('/api/auth/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
    },

    /** Revokes the current server-side session. */
    logout() {
        return requestJson('/api/auth/logout', { method: 'POST' });
    },

    /** Returns the authenticated user for the current session. */
    getCurrentUser() {
        return requestJson('/api/auth/me');
    },

    /** Returns the current user's database-backed UI preferences. */
    getUserSettings() {
        return requestJson('/api/user/settings');
    },

    /** Saves one database-backed UI preference for the current user. */
    saveUserSetting(key, value) {
        return requestJson(`/api/user/settings/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
    },

    /** Returns SMTP settings for an authenticated administrator. */
    getSmtpConfig() {
        return requestJson('/api/admin/smtp-config');
    },

    /** Saves SMTP settings for an authenticated administrator. */
    saveSmtpConfig(settings) {
        return requestJson('/api/admin/smtp-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
    },

    /** Returns all bookmarks from the API. */
    getBookmarks(filters = {}) {
        const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ''));
        return requestJson(`/api/bookmarks${query.toString() ? `?${query}` : ''}`);
    },

    /** Creates a bookmark through the API. */
    createBookmark(bookmark) {
        return requestJson('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bookmark)
        });
    },

    /** Updates a bookmark by its database identifier. */
    updateBookmark(id, bookmark) {
        return requestJson(`/api/bookmarks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bookmark)
        });
    },

    /** Deletes a bookmark by its database identifier. */
    deleteBookmark(id) {
        return requestJson(`/api/bookmarks/${id}`, { method: 'DELETE' });
    },
    updateBookmarkState(id, state) {
        return requestJson(`/api/bookmarks/${id}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    },
    permanentlyDeleteBookmark(id) {
        return requestJson(`/api/bookmarks/${id}/permanent`, { method: 'DELETE' });
    },

    /** Increments the server-side click counter for a bookmark. */
    trackBookmarkClick(id) {
        return requestJson(`/api/bookmarks/${id}/click`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    },

    /** Returns the category names from the API. */
    getCategories() {
        return requestJson('/api/categories');
    },

    /** Creates a category and returns the refreshed category list. */
    createCategory(name, parentId = null) {
        return requestJson('/api/categories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, parentId })
        });
    },

    /** Renames a category and updates related bookmarks server-side. */
    renameCategory(oldName, newName) {
        return requestJson(`/api/categories/${encodeURIComponent(oldName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
        });
    },

    /** Deletes a category and lets the server reassign its bookmarks. */
    deleteCategory(name) {
        return requestJson(`/api/categories/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });
    },
    getTags() { return requestJson('/api/tags'); },
    createTag(name) {
        return requestJson('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
    },
    renameTag(name, newName) {
        return requestJson(`/api/tags/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
        });
    },
    deleteTag(name) {
        return requestJson(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    importBookmarks(bookmarks) {
        return requestJson('/api/bookmarks/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookmarks }) });
    },
    exportBookmarks(format) { return fetch(`/api/bookmarks/export?format=${encodeURIComponent(format)}`).then(response => { if (!response.ok) throw new Error('Export failed'); return response.blob(); }); },
    shareBookmark(id, permission = 'view') {
        return requestJson(`/api/bookmarks/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission }) });
    },
    getSharedBookmark(token) {
        return requestJson(`/api/shares/${encodeURIComponent(token)}`);
    }
};

window.CloudMark = apiNamespace;
