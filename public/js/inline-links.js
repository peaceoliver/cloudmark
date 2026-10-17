/**
 * Belső hivatkozások ([[ link) a jegyzetek és feladatok szövegében, amit a böngésző és a szerver is használ.
 * A szövegben így néz ki egy link: [[jegyzet:123|Kazán szervizelés]]. Az azonosító számít, a cím csak
 * tartalék felirat (a kártya mindig az elem mostani címét mutatja), így átnevezéskor sem törik el.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.linkParser = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const MAX_LINKS = 50;
    const MAX_LABEL_LENGTH = 120;
    const MAX_QUERY_LENGTH = 60;
    // A szövegben magyar szó jelöli a típust; a könyvjelző ékezet nélkül is elfogadott.
    const WORD_TO_KIND = { jegyzet: 'note', feladat: 'task', parancs: 'command', 'könyvjelző': 'bookmark', konyvjelzo: 'bookmark' };
    const KIND_TO_WORD = { note: 'jegyzet', task: 'feladat', command: 'parancs', bookmark: 'könyvjelző' };
    const TOKEN = /\[\[(jegyzet|feladat|parancs|könyvjelző|konyvjelzo):(\d{1,15})(?:\|([^\]|\n]*))?\]\]/g;

    /** Every link token in `text`, in order: { kind, id, label, start, end }. */
    function parse(text) {
        const value = String(text || '');
        const found = [];
        for (const match of value.matchAll(TOKEN)) {
            found.push({
                kind: WORD_TO_KIND[match[1]],
                id: Number(match[2]),
                label: (match[3] || '').trim(),
                start: match.index,
                end: match.index + match[0].length
            });
        }
        return found;
    }

    /** The `item_links` key of a parsed link: bookmarks live in their own table, everything else is an item. */
    function targetOf(link) {
        return { targetType: link.kind === 'bookmark' ? 'bookmark' : 'item', targetId: link.id };
    }

    /** Distinct link targets of `text` (at most MAX_LINKS), without a link to the item itself. */
    function targets(text, selfId) {
        const seen = new Set();
        const list = [];
        for (const link of parse(text)) {
            const target = targetOf(link);
            if (target.targetType === 'item' && selfId !== undefined && selfId !== null && String(target.targetId) === String(selfId)) continue;
            const key = `${target.targetType}:${target.targetId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push(target);
            if (list.length >= MAX_LINKS) break;
        }
        return list;
    }

    /** Cleans a title so it can sit inside a token (no brackets, pipes or line breaks). */
    function cleanLabel(title) {
        const label = String(title || '').replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
        return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1).trim()}…` : label;
    }

    /** The token written into the text for a chosen item. */
    function token(kind, id, title) {
        const word = KIND_TO_WORD[kind];
        if (!word || !/^\d+$/.test(String(id))) return '';
        const label = cleanLabel(title);
        return `[[${word}:${id}${label ? `|${label}` : ''}]]`;
    }

    /**
     * When the caret stands right after an unfinished `[[…`, returns where it starts and what was typed
     * after it ({ start, query }); otherwise null. A line break or a closing `]` ends the search.
     */
    function trigger(text, caret) {
        const before = String(text || '').slice(0, caret);
        const start = before.lastIndexOf('[[');
        if (start === -1) return null;
        const query = before.slice(start + 2);
        if (/[\]\n|]/.test(query) || query.length > MAX_QUERY_LENGTH) return null;
        return { start, query };
    }

    /** Splits `text` into plain text and link parts for rendering: [{ text } | { link }]. */
    function segments(text) {
        const value = String(text || '');
        const parts = [];
        let at = 0;
        for (const link of parse(value)) {
            if (link.start > at) parts.push({ text: value.slice(at, link.start) });
            parts.push({ link });
            at = link.end;
        }
        if (at < value.length) parts.push({ text: value.slice(at) });
        return parts;
    }

    return { MAX_LINKS, KIND_TO_WORD, parse, targetOf, targets, cleanLabel, token, trigger, segments };
});
