/*
 * Közös kereső: egyszerre keres a jegyzetekben, feladatokban, parancsokban és könyvjelzőkben.
 * A Command Palette (Ctrl+K) és a feladatok „Kapcsolt elemek” mezője használja.
 */
const shareAccess = require('./share-access');

const SEARCH_TYPES = ['note', 'task', 'command', 'bookmark'];
const MAX_QUERY_LENGTH = 200;
// Ékezetek nélkül is talál: „kazan” megtalálja a „Kazán”-t és fordítva (a magyar ékezetes betűk alapbetűvé válnak).
const ACCENTED = 'áéíóöőúüűàâäãåçèêëìîïñòôõùûýÿÁÉÍÓÖŐÚÜŰ';
const PLAIN = 'aeiooouuuaaaaaceeeiiinooouuyyaeiooouuu';

/** SQL expression that lower-cases and strips accents, to match against a folded pattern. */
function fold(expression) {
    return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

/** The same folding in JS for the search text. */
function foldText(text) {
    const map = new Map([...ACCENTED].map((char, index) => [char, PLAIN[index]]));
    return [...String(text).toLowerCase()].map(char => map.get(char) || char).join('');
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
        const query = String(req.query.q || '').trim().slice(0, MAX_QUERY_LENGTH);
        if (!query) return res.json({ results: [] });
        const types = parseTypes(req.query.types);
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 20);
        const folded = foldText(query);
        const contains = `%${likePattern(folded)}%`;
        const prefix = `${likePattern(folded)}%`;
        const itemTypes = types.filter(type => type !== 'bookmark');
        try {
            const [itemRows, bookmarkRows] = await Promise.all([
                itemTypes.length ? pool.query(
                    `WITH matches AS (
                         SELECT i.id, i.type, i.title, i.body, i.description, i.status, v.archived, i.due_at, i.due_all_day,
                                i.priority, i.updated_at, c.name AS category_name, sh.id IS NOT NULL AS shared,
                                (SELECT f.content FROM item_fragments f WHERE f.item_id = i.id ORDER BY f.position LIMIT 1) AS code,
                                (SELECT f.language FROM item_fragments f WHERE f.item_id = i.id ORDER BY f.position LIMIT 1) AS language,
                                COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), '{}') AS tags,
                                CASE WHEN ${fold('i.title')} LIKE $3 ESCAPE '\\' THEN 0 WHEN ${fold('i.title')} LIKE $2 ESCAPE '\\' THEN 1 ELSE 2 END AS rank
                         FROM items i
                         ${shareAccess.viewerJoinSql('$1')}
                         LEFT JOIN categories c ON c.id = v.category_id
                         WHERE ${shareAccess.visibleSql('$1')} AND i.trashed = FALSE AND i.type = ANY($4)
                           AND (${fold('i.title')} LIKE $2 ESCAPE '\\' OR ${fold('i.body')} LIKE $2 ESCAPE '\\' OR ${fold('i.description')} LIKE $2 ESCAPE '\\'
                                OR ${fold('c.name')} LIKE $2 ESCAPE '\\'
                                OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND ${fold('t.name')} LIKE $2 ESCAPE '\\')
                                OR EXISTS (SELECT 1 FROM item_fragments f WHERE f.item_id = i.id AND ${fold('f.content')} LIKE $2 ESCAPE '\\')
                                OR (i.extra ? 'checklist' AND ${fold("(i.extra->'checklist')::text")} LIKE $2 ESCAPE '\\'))
                     ), ranked AS (
                         SELECT *, ROW_NUMBER() OVER (PARTITION BY type ORDER BY rank, archived, (status = 'done'), updated_at DESC) AS position
                         FROM matches
                     )
                     SELECT * FROM ranked WHERE position <= $5 ORDER BY type, position`,
                    [req.user.id, contains, prefix, itemTypes, limit]
                ) : { rows: [] },
                types.includes('bookmark') ? pool.query(
                    `SELECT b.id, b.title, b.url, b.description, b.category, b.created_at,
                            COALESCE(array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags,
                            MIN(CASE WHEN ${fold('b.title')} LIKE $3 ESCAPE '\\' THEN 0 WHEN ${fold('b.title')} LIKE $2 ESCAPE '\\' THEN 1 ELSE 2 END) AS rank
                     FROM bookmarks b
                     LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
                     LEFT JOIN tags t ON t.id = bt.tag_id
                     WHERE LOWER(CAST(b.user_id AS TEXT)) = ANY($1) AND b.trashed = FALSE
                     GROUP BY b.id
                     HAVING BOOL_OR(${fold('b.title')} LIKE $2 ESCAPE '\\' OR ${fold('b.url')} LIKE $2 ESCAPE '\\' OR ${fold('b.description')} LIKE $2 ESCAPE '\\'
                                    OR ${fold('b.category')} LIKE $2 ESCAPE '\\' OR COALESCE(${fold('t.name')} LIKE $2 ESCAPE '\\', FALSE))
                     ORDER BY rank, b.archived, b.created_at DESC
                     LIMIT $4`,
                    [[String(req.user.username || '').toLowerCase(), String(req.user.id)], contains, prefix, limit]
                ) : { rows: [] }
            ]);
            const results = [
                ...itemRows.rows.map(row => ({
                    kind: row.type,
                    id: Number(row.id),
                    title: row.title || snippet(row.body, '', 60) || 'Névtelen jegyzet',
                    snippet: row.type === 'command' ? snippet(row.code, query) : snippet(row.body || row.description, query),
                    category: row.category_name || null,
                    tags: row.tags,
                    status: row.status || null,
                    archived: Boolean(row.archived),
                    shared: Boolean(row.shared),
                    dueAt: row.due_at,
                    dueAllDay: row.due_all_day,
                    priority: row.priority,
                    code: row.type === 'command' ? row.code || '' : undefined,
                    language: row.type === 'command' ? row.language || null : undefined
                })),
                ...bookmarkRows.rows.map(row => ({
                    kind: 'bookmark',
                    id: Number(row.id),
                    title: row.title || row.url,
                    snippet: row.url,
                    url: row.url,
                    category: row.category || null,
                    tags: row.tags
                }))
            ];
            res.json({ results });
        } catch (err) {
            res.status(500).json({ error: 'A keresés nem sikerült.' });
        }
    });
}

module.exports = { registerSearchRoutes, snippet, likePattern, parseTypes, foldText, SEARCH_TYPES };
