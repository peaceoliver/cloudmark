/*
 * Közös kereső: egyszerre keres a jegyzetekben, feladatokban, parancsokban, könyvjelzőkben és fiókokban.
 * Fiókoknál csak a nem titkos mezőkben (név, cím, felhasználónév); a titkosított jelszó külön táblában van.
 * A Command Palette (Ctrl+K) és a feladatok „Kapcsolt elemek” mezője használja.
 */
const shareAccess = require('./share-access');

const searchQuery = require('../public/js/search-query');

const SEARCH_TYPES = ['note', 'task', 'command', 'bookmark', 'account'];
const MAX_QUERY_LENGTH = 200;
const MAX_FILTERS = 5;
// Ékezetek nélkül is talál: „kazan” megtalálja a „Kazán”-t és fordítva (a magyar ékezetes betűk alapbetűvé válnak).
const { ACCENTED, PLAIN, foldText } = searchQuery;

/** SQL expression that lower-cases and strips accents, to match against a folded pattern. */
function fold(expression) {
    return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

/** Escapes LIKE wildcards so the user's text is matched literally. */
function likePattern(text) {
    return String(text).replace(/[\\%_]/g, char => `\\${char}`);
}

/** The line of `text` that contains `query` (or its first line), shortened around the match. */
function snippet(text, query, max = 120) {
    const value = String(text || '');
    if (!value.trim()) return '';
    // A hajtogatás betűnként történik, így az indexek az eredeti szövegre is érvényesek.
    const index = query ? foldText(value).indexOf(foldText(query)) : -1;
    const lineStart = index === -1 ? 0 : value.lastIndexOf('\n', index) + 1;
    let lineEnd = value.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = value.length;
    let line = value.slice(lineStart, lineEnd).trim() || value.trim().split('\n')[0];
    if (line.length > max) {
        const at = index === -1 ? 0 : Math.max(0, index - lineStart - 30);
        line = `${at > 0 ? '…' : ''}${line.slice(at, at + max).trim()}…`;
    }
    return line;
}

/** Parses ?types=note,task into a list of known types (all of them when missing). */
function parseTypes(value) {
    if (!value) return SEARCH_TYPES;
    const list = String(value).split(',').map(type => type.trim()).filter(type => SEARCH_TYPES.includes(type));
    return list.length ? list : SEARCH_TYPES;
}

function registerSearchRoutes(app, { pool, requireAuth }) {
    app.get('/api/search', requireAuth, async (req, res) => {
        // Előtagok: #címke, /kategória, @kód (search-query.js); a maradék a szabad szöveg.
        const parsed = searchQuery.parse(String(req.query.q || '').slice(0, MAX_QUERY_LENGTH));
        const query = parsed.text;
        const tags = parsed.tags.slice(0, MAX_FILTERS);
        const categories = parsed.categories.slice(0, MAX_FILTERS);
        if (!query && !tags.length && !categories.length && !parsed.types.length) return res.json({ results: [] });
        let types = parseTypes(req.query.types);
        if (parsed.types.length) types = types.filter(type => parsed.types.includes(type));
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 20);
        const folded = foldText(query);
        const contains = `%${likePattern(folded)}%`;
        const prefix = `${likePattern(folded)}%`;
        const prefixes = list => list.map(value => `${likePattern(value)}%`);
        const itemTypes = types.filter(type => type !== 'bookmark');
        try {
            // Elemek: $1 néző, $2 tartalmazza, $3 így kezdődik, $4 típusok, $5 limit, $6 címkék, $7 kategóriák.
            const itemText = query ? `(${fold('i.title')} LIKE $2 ESCAPE '\\' OR ${fold('i.body')} LIKE $2 ESCAPE '\\' OR ${fold('i.description')} LIKE $2 ESCAPE '\\'
                                OR ${fold('c.name')} LIKE $2 ESCAPE '\\'
                                OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND ${fold('t.name')} LIKE $2 ESCAPE '\\')
                                OR EXISTS (SELECT 1 FROM item_fragments f WHERE f.item_id = i.id AND ${fold('f.content')} LIKE $2 ESCAPE '\\')
                                OR (i.extra ? 'checklist' AND ${fold("(i.extra->'checklist')::text")} LIKE $2 ESCAPE '\\')
                                OR (i.type = 'account' AND (${fold("i.extra->>'url'")} LIKE $2 ESCAPE '\\' OR ${fold("i.extra->>'username'")} LIKE $2 ESCAPE '\\'
                                    OR ${fold("i.extra->>'ssoAccount'")} LIKE $2 ESCAPE '\\')))` : 'TRUE';
            // Minden címke-előtagnak legyen egyező címkéje.
            const itemTags = `NOT EXISTS (SELECT 1 FROM unnest($6::text[]) AS wanted(pattern)
                                WHERE NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND ${fold('t.name')} LIKE wanted.pattern ESCAPE '\\'))`;
            // A kategória vagy bármelyik szülője (beágyazott mappák: a szülő a gyerekek elemeit is mutatja).
            const itemCategories = `NOT EXISTS (SELECT 1 FROM unnest($7::text[]) AS wanted(pattern)
                                WHERE NOT EXISTS (
                                    WITH RECURSIVE up(id, parent_id, name, depth) AS (
                                        SELECT c0.id, c0.parent_id, c0.name, 0 FROM categories c0 WHERE c0.id = v.category_id
                                        UNION ALL
                                        SELECT cp.id, cp.parent_id, cp.name, up.depth + 1 FROM categories cp JOIN up ON cp.id = up.parent_id WHERE up.depth < 10
                                    )
                                    SELECT 1 FROM up WHERE ${fold('up.name')} LIKE wanted.pattern ESCAPE '\\'))`;
            // Könyvjelzők: $1 felhasználó, $2, $3, $4 limit, $5 néző id, $6 címkék, $7 kategóriák.
            const bookmarkCategory = 'CASE WHEN bsh.id IS NULL THEN b.category ELSE bshc.name END';
            const bookmarkText = query ? `BOOL_OR(${fold('b.title')} LIKE $2 ESCAPE '\\' OR ${fold('b.url')} LIKE $2 ESCAPE '\\' OR ${fold('b.description')} LIKE $2 ESCAPE '\\'
                                    OR ${fold('b.category')} LIKE $2 ESCAPE '\\' OR COALESCE(${fold('t.name')} LIKE $2 ESCAPE '\\', FALSE))` : 'TRUE';
            const [itemRows, bookmarkRows] = await Promise.all([
                itemTypes.length ? pool.query(
                    `WITH matches AS (
                         SELECT i.id, i.type, i.title, i.body, i.description, i.status, v.archived, i.due_at, i.due_all_day, i.extra,
                                i.priority, i.updated_at, c.name AS category_name, sh.id IS NOT NULL AS shared,
                                (SELECT f.content FROM item_fragments f WHERE f.item_id = i.id ORDER BY f.position LIMIT 1) AS code,
                                (SELECT f.language FROM item_fragments f WHERE f.item_id = i.id ORDER BY f.position LIMIT 1) AS language,
                                COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), '{}') AS tags,
                                CASE WHEN ${fold('i.title')} LIKE $3 ESCAPE '\\' THEN 0 WHEN ${fold('i.title')} LIKE $2 ESCAPE '\\' THEN 1 ELSE 2 END AS rank
                         FROM items i
                         ${shareAccess.viewerJoinSql('$1')}
                         LEFT JOIN categories c ON c.id = v.category_id
                         WHERE ${shareAccess.visibleSql('$1')} AND i.trashed = FALSE AND i.type = ANY($4)
                           AND ${itemText} AND ${itemTags} AND ${itemCategories}
                     ), ranked AS (
                         SELECT *, ROW_NUMBER() OVER (PARTITION BY type ORDER BY rank, archived, (status = 'done'), updated_at DESC) AS position
                         FROM matches
                     )
                     SELECT * FROM ranked WHERE position <= $5 ORDER BY type, position`,
                    [req.user.id, contains, prefix, itemTypes, limit, prefixes(tags), prefixes(categories)]
                ) : { rows: [] },
                types.includes('bookmark') ? pool.query(
                    // A megosztott könyvjelzők is (elfogadott megosztás), a címzett saját kategóriájával.
                    `SELECT b.id, b.title, b.url, b.description, (bsh.id IS NOT NULL) AS shared,
                            ${bookmarkCategory} AS category, b.created_at,
                            COALESCE(array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags,
                            MIN(CASE WHEN ${fold('b.title')} LIKE $3 ESCAPE '\\' THEN 0 WHEN ${fold('b.title')} LIKE $2 ESCAPE '\\' THEN 1 ELSE 2 END) AS rank
                     FROM bookmarks b ${shareAccess.bookmarkJoinSql('$5')}
                     LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
                     LEFT JOIN tags t ON t.id = bt.tag_id
                     WHERE (LOWER(CAST(b.user_id AS TEXT)) = ANY($1) OR bsh.id IS NOT NULL) AND b.trashed = FALSE
                       AND NOT EXISTS (SELECT 1 FROM unnest($6::text[]) AS wanted(pattern)
                           WHERE NOT EXISTS (SELECT 1 FROM bookmark_tags bt2 JOIN tags t2 ON t2.id = bt2.tag_id WHERE bt2.bookmark_id = b.id AND ${fold('t2.name')} LIKE wanted.pattern ESCAPE '\\'))
                       AND NOT EXISTS (SELECT 1 FROM unnest($7::text[]) AS wanted(pattern)
                           WHERE NOT COALESCE(${fold(bookmarkCategory)} LIKE wanted.pattern ESCAPE '\\', FALSE))
                     GROUP BY b.id, bsh.id, bshc.id
                     HAVING ${bookmarkText}
                     ORDER BY rank, CASE WHEN bsh.id IS NULL THEN b.archived ELSE bsh.recipient_archived END, b.created_at DESC
                     LIMIT $4`,
                    [[String(req.user.username || '').toLowerCase(), String(req.user.id)], contains, prefix, limit, req.user.id, prefixes(tags), prefixes(categories)]
                ) : { rows: [] }
            ]);
            const results = [
                ...itemRows.rows.map(row => ({
                    kind: row.type,
                    id: Number(row.id),
                    title: row.title || snippet(row.body, '', 60) || 'Névtelen jegyzet',
                    snippet: row.type === 'command' ? snippet(row.code, query)
                        : row.type === 'account' ? [row.extra?.username, row.extra?.url].filter(Boolean).join(' · ')
                            : snippet(row.body || row.description, query),
                    category: row.category_name || null,
                    tags: row.tags,
                    status: row.status || null,
                    archived: Boolean(row.archived),
                    shared: Boolean(row.shared),
                    dueAt: row.due_at,
                    dueAllDay: row.due_all_day,
                    priority: row.priority,
                    code: row.type === 'command' ? row.code || '' : undefined,
                    language: row.type === 'command' ? row.language || null : undefined,
                    url: row.type === 'account' ? row.extra?.url || '' : undefined,
                    username: row.type === 'account' ? row.extra?.username || '' : undefined,
                    loginMethod: row.type === 'account' ? row.extra?.loginMethod || 'password' : undefined
                })),
                ...bookmarkRows.rows.map(row => ({
                    kind: 'bookmark',
                    id: Number(row.id),
                    title: row.title || row.url,
                    snippet: row.url,
                    url: row.url,
                    category: row.category || null,
                    tags: row.tags,
                    shared: Boolean(row.shared)
                }))
            ];
            res.json({ results });
        } catch (err) {
            res.status(500).json({ error: 'A keresés nem sikerült.' });
        }
    });
}

module.exports = { registerSearchRoutes, snippet, likePattern, parseTypes, foldText, SEARCH_TYPES };
