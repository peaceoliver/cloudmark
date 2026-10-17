/**
 * Clipper: a böngésző gombjából (bookmarklet) és a telefon Megosztás menüjéből érkező adatok értelmezése,
 * és belőlük a mentendő könyvjelző / jegyzet / feladat összeállítása. A böngésző és a Node-os tesztek is használják.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.clipParse = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const URL_PATTERN = /https?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/i;
    const MAX_TITLE = 300;
    const MAX_TEXT = 20000;
    // Ennél rövidebb, egysoros megosztott szöveg az oldal címe (pl. YouTube: „Videó címe https://…”), nem idézet.
    const SHORT_SHARE_TEXT = 140;

    function clean(value, max) {
        return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    }

    /** Returns the first http(s) link in a text, or ''. */
    function extractUrl(text) {
        const match = String(text || '').match(URL_PATTERN);
        return match ? match[0] : '';
    }

    function isHttpUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (err) {
            return false;
        }
    }

    function hostOf(value) {
        try {
            return new URL(value).hostname.replace(/^www\./, '');
        } catch (err) {
            return '';
        }
    }

    /**
     * Normalizes the incoming query parameters ({ url, title, text, source }) and picks the default type:
     * selected text → note, a link → bookmark, text only → note.
     */
    function parseClipInput(params = {}) {
        const source = params.source === 'bookmarklet' ? 'bookmarklet' : 'share';
        let url = clean(params.url, 2048);
        let title = clean(params.title, MAX_TITLE);
        let text = clean(params.text, MAX_TEXT);

        if (!isHttpUrl(url)) url = '';
        // Sok app a linket a szövegbe teszi a külön URL mező helyett.
        if (!url) {
            const found = extractUrl(text);
            if (found && isHttpUrl(found)) url = found;
        }
        if (url && text.includes(url)) text = text.split(url).join(' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (text === title) text = '';

        if (source === 'share' && url && text && text.length <= SHORT_SHARE_TEXT && !text.includes('\n')) {
            if (!title) title = text.slice(0, MAX_TITLE);
            text = '';
        }

        const type = text || !url ? 'note' : 'bookmark';
        return { source, url, title, text, type };
    }

    function tagList(tags) {
        return String(tags || '').split(/[,\s]+/).map(tag => tag.replace(/^#/, '').trim()).filter(Boolean).slice(0, 20);
    }

    /** Body for POST /api/bookmarks. `category` is a bookmark category name; an empty title is filled by the server from the page. */
    function buildBookmark({ url, title, text, category, tags, readLater = true }) {
        return {
            url,
            title: clean(title, MAX_TITLE),
            description: clean(text, 2000),
            category,
            tags: tagList(tags),
            status: readLater ? 'read_later' : 'inbox'
        };
    }

    /** Body for POST /api/items with type 'note': the clipped text, then the source link. */
    function buildNote({ url, title, text, categoryId, tags }) {
        const parts = [clean(text, MAX_TEXT)];
        if (url) parts.push(`Forrás: ${url}`);
        return {
            type: 'note',
            title: clean(title, MAX_TITLE) || (url ? hostOf(url) : ''),
            body: parts.filter(Boolean).join('\n\n'),
            categoryId: categoryId || null,
            tags: tagList(tags),
            extra: url ? { source: { url, via: 'clip' } } : {}
        };
    }

    /** Body for POST /api/items with type 'task'; the link and the text go into the description. */
    function buildTask({ url, title, text, categoryId, tags }) {
        const name = clean(title, MAX_TITLE - 12) || hostOf(url);
        return {
            type: 'task',
            title: url ? `Elolvasni: ${name}` : name,
            body: [url, clean(text, MAX_TEXT)].filter(Boolean).join('\n\n'),
            categoryId: categoryId || null,
            tags: tagList(tags),
            status: 'todo',
            extra: url ? { source: { url, via: 'clip' } } : {}
        };
    }

    /** The javascript: link users drag to their bookmarks bar; it opens /clip in a small window. */
    function buildBookmarklet(origin) {
        const target = `${String(origin).replace(/\/+$/, '')}/clip?`;
        const code = "(function(){var s='';try{s=String(window.getSelection()).slice(0,4000);}catch(e){}"
            + "var p=new URLSearchParams({url:location.href,title:document.title,text:s,source:'bookmarklet'});"
            + `window.open(${JSON.stringify(target)}+p.toString(),'cloudmark-clip','width=480,height=700');})();`;
        return `javascript:${encodeURI(code)}`;
    }

    return { extractUrl, parseClipInput, buildBookmark, buildNote, buildTask, buildBookmarklet, tagList };
});
