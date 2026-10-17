/**
 * Fiókok CSV importja és exportja (böngésző + Node tesztek).
 * Felismeri a Chrome / Edge, a Firefox, a Bitwarden és a saját CloudMark exportot; a jelszót a
 * böngésző titkosítja, mielőtt bármi a szerverre menne.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.accountCsv = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const MAX_ROWS = 1000;
    const EXPORT_COLUMNS = ['name', 'url', 'username', 'password', 'note', 'secret_note', 'login_method', 'sso_account', 'category', 'tags'];
    const LOGIN_METHODS = ['password', 'google', 'github', 'microsoft', 'apple', 'facebook', 'sso', 'ssh', 'other'];

    /** RFC 4180 parser: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF. */
    function parseCsv(text) {
        const rows = [];
        let row = [], field = '', quoted = false;
        const input = String(text || '').replace(/^﻿/, '');
        for (let i = 0; i < input.length; i += 1) {
            const char = input[i];
            if (quoted) {
                if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
                else if (char === '"') quoted = false;
                else field += char;
            } else if (char === '"' && field === '') quoted = true;
            else if (char === ',') { row.push(field); field = ''; }
            else if (char === '\n' || char === '\r') {
                if (char === '\r' && input[i + 1] === '\n') i += 1;
                row.push(field); field = '';
                if (row.some(value => value !== '')) rows.push(row);
                row = [];
            } else field += char;
        }
        row.push(field);
        if (row.some(value => value !== '')) rows.push(row);
        return rows;
    }

    function csvField(value) {
        // Nincs képlet-védő aposztróf: a jelszónak betűre pontosan vissza kell jönnie importnál.
        const text = String(value ?? '');
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function toCsv(rows) {
        return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
    }

    /** Host of a URL without www., used as a name when the file has none. */
    function hostName(url) {
        try {
            return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname.replace(/^www\./, '');
        } catch (err) {
            return '';
        }
    }

    /** Which export the header row comes from: 'cloudmark', 'bitwarden', 'firefox', 'chrome' or null. */
    function detectFormat(header) {
        const names = header.map(name => String(name).trim().toLowerCase());
        if (names.includes('login_method') && names.includes('name')) return 'cloudmark';
        if (names.includes('login_uri') || names.includes('login_username')) return 'bitwarden';
        if (names.includes('url') && names.includes('username') && names.includes('password') && names.includes('httprealm')) return 'firefox';
        if (names.includes('password') && (names.includes('url') || names.includes('name'))) return 'chrome';
        return null;
    }

    /**
     * CSV text → { format, accounts: [{ title, url, username, password, note, secretNote, loginMethod, ssoAccount, category, tags }], skipped }.
     * Rows without a password, a name and an address are skipped (Bitwarden notes, cards…).
     */
    function parseAccounts(text) {
        const rows = parseCsv(text);
        if (!rows.length) return { format: null, accounts: [], skipped: 0 };
        const header = rows[0].map(name => String(name).trim().toLowerCase());
        const format = detectFormat(header);
        if (!format) return { format: null, accounts: [], skipped: rows.length - 1 };
        const column = name => header.indexOf(name);
        // A jelszót és a titkos megjegyzést nem vágjuk le: a szóköz is lehet a jelszó része.
        const get = (row, name) => {
            const index = column(name);
            const value = index === -1 ? '' : String(row[index] ?? '');
            return /password|secret_note/.test(name) ? value : value.trim();
        };
        const accounts = [];
        let skipped = 0;
        for (const row of rows.slice(1)) {
            if (accounts.length >= MAX_ROWS) { skipped += 1; continue; }
            let entry;
            if (format === 'bitwarden') {
                const type = get(row, 'type');
                if (type && type !== 'login') { skipped += 1; continue; }
                entry = { title: get(row, 'name'), url: get(row, 'login_uri').split(/[\n,]/)[0].trim(), username: get(row, 'login_username'), password: get(row, 'login_password'), note: get(row, 'notes'), category: get(row, 'folder') };
            } else if (format === 'firefox') {
                entry = { title: '', url: get(row, 'url'), username: get(row, 'username'), password: get(row, 'password'), note: '', category: '' };
            } else if (format === 'cloudmark') {
                const method = get(row, 'login_method').toLowerCase();
                entry = {
                    title: get(row, 'name'), url: get(row, 'url'), username: get(row, 'username'), password: get(row, 'password'),
                    note: get(row, 'note'), secretNote: get(row, 'secret_note'), loginMethod: LOGIN_METHODS.includes(method) ? method : 'password',
                    ssoAccount: get(row, 'sso_account'), category: get(row, 'category'),
                    tags: get(row, 'tags').split(/[,\s]+/).map(tag => tag.replace(/^#/, '').trim()).filter(Boolean)
                };
            } else {
                entry = { title: get(row, 'name'), url: get(row, 'url'), username: get(row, 'username'), password: get(row, 'password'), note: get(row, 'note') || get(row, 'notes'), category: '' };
            }
            if (!entry.title) entry.title = hostName(entry.url) || entry.url;
            if (!entry.title && !entry.password) { skipped += 1; continue; }
            if (!entry.title) entry.title = entry.username || 'Névtelen fiók';
            accounts.push({ secretNote: '', loginMethod: 'password', ssoAccount: '', tags: [], ...entry, title: entry.title.slice(0, 300) });
        }
        return { format, accounts, skipped };
    }

    /** Decrypted accounts → CloudMark CSV (re-importable here and in most password managers as Chrome-like columns). */
    function accountsToCsv(accounts) {
        return toCsv([EXPORT_COLUMNS, ...accounts.map(account => [
            account.title, account.url, account.username, account.password, account.note, account.secretNote,
            account.loginMethod, account.ssoAccount, account.category, (account.tags || []).join(' ')
        ])]);
    }

    return { parseCsv, toCsv, parseAccounts, accountsToCsv, detectFormat, hostName, EXPORT_COLUMNS, MAX_ROWS };
});
