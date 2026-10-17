/**
 * Keresési előtagok, amit a böngésző és a szerver is használ (Command Palette, Kódtár lista, /api/search):
 * - `#címke`      csak az ilyen (így kezdődő) címkéjű elemek,
 * - `/kategória`  csak az ilyen (így kezdődő) nevű kategóriában vagy annak alkategóriájában lévők,
 * - `@kód`        csak egy típus (`@kód`, `@jegyzet`, `@feladat`, `@könyvjelző`); más szó után `@` = kategória, mint a feladatoknál a projekt.
 * Minden összevetés kisbetűs és ékezetfüggetlen („kodtar” = „Kódtár”).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.searchQuery = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const ACCENTED = 'áéíóöőúüűàâäãåçèêëìîïñòôõùûýÿÁÉÍÓÖŐÚÜŰ';
    const PLAIN = 'aeiooouuuaaaaaceeeiiinooouuyyaeiooouuu';
    const FOLD = new Map([...ACCENTED].map((char, index) => [char, PLAIN[index]]));

    // Az `@` utáni szavak, amelyek típust jelentenek (hajtogatott alakban).
    const TYPE_WORDS = {
        kod: 'command', kodok: 'command', kodreszlet: 'command', kodtar: 'command', code: 'command', snippet: 'command',
        parancs: 'command', parancsok: 'command',
        jegyzet: 'note', jegyzetek: 'note', note: 'note',
        feladat: 'task', feladatok: 'task', task: 'task',
        konyvjelzo: 'bookmark', konyvjelzok: 'bookmark', link: 'bookmark', bookmark: 'bookmark'
    };

    /** Lower-cases and strips accents character by character, so indexes stay valid on the original text. */
    function foldText(text) {
        return [...String(text ?? '').toLowerCase()].map(char => FOLD.get(char) || char).join('');
    }

    /**
     * Splits a search into free text and filters. A lone `#`, `/` or `@` stays text.
     * Returns { text, tags, categories, types } with folded filter values.
     */
    function parse(input) {
        const words = [];
        const tags = [];
        const categories = [];
        const types = [];
        String(input ?? '').trim().split(/\s+/).filter(Boolean).forEach(word => {
            const sign = word[0];
            const value = foldText(word.slice(1));
            if (!value || !'#/@'.includes(sign)) { words.push(word); return; }
            if (sign === '#') tags.push(value);
            else if (sign === '/') categories.push(value);
            else if (TYPE_WORDS[value]) { if (!types.includes(TYPE_WORDS[value])) types.push(TYPE_WORDS[value]); }
            else categories.push(value);
        });
        return { text: words.join(' '), tags, categories, types };
    }

    function hasFilters(query) {
        return Boolean(query.tags.length || query.categories.length || query.types.length);
    }

    /**
     * Whether an item matches in the browser. `fields` = { texts: [...], tags: [...], categories: [...] } where
     * categories are the item's category and all its parent categories (names).
     */
    function matches(query, fields) {
        const tags = (fields.tags || []).map(foldText);
        const categories = (fields.categories || []).map(foldText);
        if (!query.tags.every(tag => tags.some(name => name.startsWith(tag)))) return false;
        if (!query.categories.every(category => categories.some(name => name.startsWith(category)))) return false;
        if (!query.text) return true;
        const haystack = foldText((fields.texts || []).join('\n'));
        // Több szó: mind szerepeljen valahol (sorrendtől függetlenül).
        return foldText(query.text).split(/\s+/).every(word => haystack.includes(word));
    }

    /** Short Hungarian description of the active filters, e.g. "#docker · /shell · csak kódrészletek". */
    function describe(query) {
        const labels = { command: 'kódrészletek', note: 'jegyzetek', task: 'feladatok', bookmark: 'könyvjelzők' };
        return [
            ...query.tags.map(tag => `#${tag}`),
            ...query.categories.map(category => `/${category}`),
            ...(query.types.length ? [`csak ${query.types.map(type => labels[type]).join(', ')}`] : [])
        ].join(' · ');
    }

    return { ACCENTED, PLAIN, TYPE_WORDS, foldText, parse, hasFilters, matches, describe };
});
