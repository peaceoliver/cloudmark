/**
 * Parancsok (és később jegyzetek, egyéb típusok) API-ja az `items` táblán.
 * A könyvjelzők külön táblában maradnak; ez a modul csak a nem-URL típusokat kezeli.
 */

const ITEM_TYPES = ['command', 'note'];
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_BODY_LENGTH = 100000;
const MAX_FRAGMENTS = 20;
const MAX_FRAGMENT_LENGTH = 100000;
const MAX_EXTRA_LENGTH = 50000;
const MAX_IMPORT_ITEMS = 1000;

/**
 * Validates a language identifier such as bash, powershell or c#.
 * Returns null for empty input, the normalized value when valid, and undefined when invalid.
 */
function normalizeItemLanguage(value) {
    if (value === undefined || value === null || value === '') return null;
    const language = String(value).trim().toLowerCase();
    return /^[a-z0-9+#._-]{1,30}$/.test(language) ? language : undefined;
}

function optionalText(value, maxLength) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.trim() ? text.slice(0, maxLength) : null;
}

/** Turns a request body into validated fragment rows, or returns an error message. */
function normalizeFragments(input, fallbackLanguage) {
    const list = Array.isArray(input) ? input : [];
    if (list.length > MAX_FRAGMENTS) return { error: `Legfeljebb ${MAX_FRAGMENTS} fül adható meg.` };
    const fragments = [];
    for (const raw of list) {
        const content = typeof raw === 'string' ? raw : raw?.content;
        if (typeof content !== 'string') return { error: 'A fül tartalma hiányzik.' };
        if (content.length > MAX_FRAGMENT_LENGTH) return { error: 'Túl hosszú kód.' };
        const language = normalizeItemLanguage(raw?.language ?? fallbackLanguage);
        if (language === undefined) return { error: 'Érvénytelen nyelv.' };
        fragments.push({
            label: optionalText(raw?.label, 80),
            language,
            content: content.replace(/\r\n/g, '\n')
        });
    }
    return { fragments };
}

/** Validates the shared item fields used by create, update and import. */
function normalizeItemInput(body, type) {
    const title = optionalText(body.title, MAX_TITLE_LENGTH);
    if (type === 'command' && !title) return { error: 'A cím megadása kötelező.' };
    const extra = body.extra === undefined ? {} : body.extra;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return { error: 'Érvénytelen kiegészítő adat.' };
    if (JSON.stringify(extra).length > MAX_EXTRA_LENGTH) return { error: 'Túl nagy kiegészítő adat.' };
    const color = optionalText(body.color, 20);
    if (color && !/^[a-z0-9#-]{1,20}$/i.test(color)) return { error: 'Érvénytelen szín.' };
    const categoryId = body.categoryId === undefined || body.categoryId === null || body.categoryId === '' ? null : Number(body.categoryId);
    if (categoryId !== null && !Number.isInteger(categoryId)) return { error: 'Érvénytelen kategória.' };
    const position = body.position === undefined || body.position === null || body.position === '' ? null : Number(body.position);
    if (position !== null && !Number.isInteger(position)) return { error: 'Érvénytelen sorrend.' };

    const { fragments, error } = normalizeFragments(body.fragments, body.language);
    if (error) return { error };
    if (type === 'command' && !fragments.some(fragment => fragment.content.trim())) return { error: 'A parancs kódja nem lehet üres.' };

    const value = {
        title,
        description: optionalText(body.description, MAX_DESCRIPTION_LENGTH),
        categoryId,
        body: optionalText(body.body, MAX_BODY_LENGTH),
        color,
        pinned: Boolean(body.pinned),
        starred: Boolean(body.starred),
        position,
        extra,
        fragments,
        tags: body.tags
    };
    if (type === 'note' && !value.title && !value.body && !extra.checklist) return { error: 'Üres jegyzet nem menthető.' };
    return { value };
}

function registerItemRoutes(app, { pool, requireAuth, recordAuditEvent, normalizeTags }) {
    const ITEM_SELECT = `
        SELECT i.*, c.name AS category_name,
               COALESCE((SELECT json_agg(json_build_object('id', f.id, 'position', f.position, 'label', f.label, 'language', f.language, 'content', f.content) ORDER BY f.position)
                         FROM item_fragments f WHERE f.item_id = i.id), '[]') AS fragments,
               COALESCE((SELECT array_agg(t.name ORDER BY t.name)
                         FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), '{}') AS tags
        FROM items i
        LEFT JOIN categories c ON c.id = i.category_id`;

    async function loadItem(db, id, userId) {
        const result = await db.query(`${ITEM_SELECT} WHERE i.id = $1 AND i.owner_user_id = $2`, [id, userId]);
        return result.rows[0] || null;
    }

    async function categoryBelongsToUser(db, categoryId, userId, type) {
        if (categoryId === null) return true;
        const result = await db.query('SELECT 1 FROM categories WHERE id = $1 AND owner_user_id = $2 AND kind = $3', [categoryId, userId, type]);
        return result.rowCount > 0;
    }

    async function replaceFragments(db, itemId, fragments) {
        await db.query('DELETE FROM item_fragments WHERE item_id = $1', [itemId]);
        for (const [position, fragment] of fragments.entries()) {
            await db.query(
                'INSERT INTO item_fragments (item_id, position, label, language, content) VALUES ($1, $2, $3, $4, $5)',
                [itemId, position, fragment.label, fragment.language, fragment.content]
            );
        }
    }

    async function replaceItemTags(db, itemId, userId, tags) {
        await db.query('DELETE FROM item_tags WHERE item_id = $1', [itemId]);
        for (const name of normalizeTags(tags)) {
            const tag = await db.query(
                `INSERT INTO tags (user_id, name) VALUES ($1, $2)
                 ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
                [userId, name]
            );
            await db.query('INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [itemId, tag.rows[0].id]);
        }
    }

    async function withTransaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    function parseId(value) {
        const id = Number(value);
        return Number.isInteger(id) && id > 0 ? id : null;
    }

    /** Lists the user's items of one type with fragments and tags, for client-side filtering. */
    app.get('/api/items', requireAuth, async (req, res) => {
        const type = String(req.query.type || '');
        if (!ITEM_TYPES.includes(type)) return res.status(400).json({ error: 'Érvénytelen típus.' });
        const params = [req.user.id, type];
        const conditions = ['i.owner_user_id = $1', 'i.type = $2'];
        if (req.query.all !== 'true') {
            if (req.query.trash === 'true') conditions.push('i.trashed = TRUE');
            else {
                conditions.push('i.trashed = FALSE');
                if (req.query.archived !== 'true') conditions.push('i.archived = FALSE');
            }
        }
        try {
            const result = await pool.query(
                `${ITEM_SELECT} WHERE ${conditions.join(' AND ')}
                 ORDER BY i.pinned DESC, i.position ASC NULLS LAST, i.updated_at DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Exports the user's items of one type as JSON (re-importable) or Markdown. */
    app.get('/api/items/export', requireAuth, async (req, res) => {
        const type = String(req.query.type || '');
        if (!ITEM_TYPES.includes(type)) return res.status(400).json({ error: 'Érvénytelen típus.' });
        try {
            const result = await pool.query(
                `${ITEM_SELECT} WHERE i.owner_user_id = $1 AND i.type = $2 AND i.trashed = FALSE
                 ORDER BY c.name NULLS FIRST, i.position ASC NULLS LAST, i.title`,
                [req.user.id, type]
            );
            const rows = result.rows;
            await recordAuditEvent({ userId: req.user.id, action: 'items_exported', entityType: 'item', details: { type, format: req.query.format || 'json', count: rows.length }, req });
            if (req.query.format === 'md') {
                const markdown = rows.map(item => {
                    const parts = [`### ${item.title || 'Névtelen'}`];
                    if (item.category_name) parts.push(`*${item.category_name}*`);
                    if (item.description) parts.push(item.description);
                    item.fragments.forEach(fragment => {
                        if (item.fragments.length > 1 && fragment.label) parts.push(`**${fragment.label}**`);
                        parts.push(`\`\`\`${fragment.language || 'bash'}\n${fragment.content}\n\`\`\``);
                    });
                    if (item.body) parts.push(item.body);
                    if (item.tags.length) parts.push(item.tags.map(tag => `#${tag}`).join(' '));
                    return parts.join('\n\n');
                }).join('\n\n---\n\n');
                return res.type('text/markdown').attachment(`cloudmark-${type}.md`).send(markdown + '\n');
            }
            const payload = {
                exportedAt: new Date().toISOString(),
                type,
                items: rows.map(item => ({
                    title: item.title,
                    description: item.description,
                    category: item.category_name,
                    body: item.body,
                    color: item.color,
                    pinned: item.pinned,
                    starred: item.starred,
                    archived: item.archived,
                    extra: item.extra,
                    tags: item.tags,
                    fragments: item.fragments.map(({ label, language, content }) => ({ label, language, content }))
                }))
            };
            res.type('application/json').attachment(`cloudmark-${type}.json`).send(JSON.stringify(payload, null, 2));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * Imports items of one type. Accepts this API's own export and the parancstár sample format
     * ({ category, title, description, code, tags }); category names are created on demand.
     */
    app.post('/api/items/import', requireAuth, async (req, res) => {
        const type = String(req.body?.type || '');
        if (!ITEM_TYPES.includes(type)) return res.status(400).json({ error: 'Érvénytelen típus.' });
        const list = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!list) return res.status(400).json({ error: 'Hiányzó elemlista.' });
        if (list.length > MAX_IMPORT_ITEMS) return res.status(400).json({ error: `Egyszerre legfeljebb ${MAX_IMPORT_ITEMS} elem importálható.` });

        const prepared = [];
        for (const [index, raw] of list.entries()) {
            if (!raw || typeof raw !== 'object') return res.status(400).json({ error: `Érvénytelen elem: ${index + 1}.` });
            const fragments = Array.isArray(raw.fragments) ? raw.fragments
                : typeof raw.code === 'string' ? [{ content: raw.code, language: raw.language }] : [];
            const { value, error } = normalizeItemInput({ ...raw, categoryId: null, fragments }, type);
            if (error) return res.status(400).json({ error: `${index + 1}. elem: ${error}` });
            prepared.push({ value, category: optionalText(raw.category, 100)?.trim() || null, archived: Boolean(raw.archived) });
        }

        try {
            const created = await withTransaction(async client => {
                const categoryIds = new Map();
                let count = 0;
                for (const { value, category, archived } of prepared) {
                    let categoryId = null;
                    if (category) {
                        const key = category.toLowerCase();
                        if (!categoryIds.has(key)) {
                            const existing = await client.query(
                                'SELECT id FROM categories WHERE owner_user_id = $1 AND kind = $2 AND LOWER(name) = LOWER($3)',
                                [req.user.id, type, category]
                            );
                            const id = existing.rows[0]?.id ?? (await client.query(
                                'INSERT INTO categories (name, owner_user_id, kind) VALUES ($1, $2, $3) RETURNING id',
                                [category, req.user.id, type]
                            )).rows[0].id;
                            categoryIds.set(key, id);
                        }
                        categoryId = categoryIds.get(key);
                    }
                    const inserted = await client.query(
                        `INSERT INTO items (owner_user_id, type, title, description, category_id, body, color, pinned, starred, archived, extra)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
                        [req.user.id, type, value.title, value.description, categoryId, value.body, value.color, value.pinned, value.starred, archived, value.extra]
                    );
                    await replaceFragments(client, inserted.rows[0].id, value.fragments);
                    await replaceItemTags(client, inserted.rows[0].id, req.user.id, value.tags);
                    count += 1;
                }
                return count;
            });
            await recordAuditEvent({ userId: req.user.id, action: 'items_imported', entityType: 'item', details: { type, count: created }, req });
            res.status(201).json({ success: true, imported: created });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/items/:id', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const item = await loadItem(pool, id, req.user.id);
            if (!item) return res.status(404).json({ error: 'Not found' });
            res.json(item);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/items', requireAuth, async (req, res) => {
        const type = String(req.body?.type || '');
        if (!ITEM_TYPES.includes(type)) return res.status(400).json({ error: 'Érvénytelen típus.' });
        const { value, error } = normalizeItemInput(req.body, type);
        if (error) return res.status(400).json({ error });
        try {
            const item = await withTransaction(async client => {
                if (!(await categoryBelongsToUser(client, value.categoryId, req.user.id, type))) return null;
                const inserted = await client.query(
                    `INSERT INTO items (owner_user_id, type, title, description, category_id, body, color, pinned, starred, position, extra)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
                    [req.user.id, type, value.title, value.description, value.categoryId, value.body, value.color, value.pinned, value.starred, value.position, value.extra]
                );
                await replaceFragments(client, inserted.rows[0].id, value.fragments);
                await replaceItemTags(client, inserted.rows[0].id, req.user.id, value.tags);
                return loadItem(client, inserted.rows[0].id, req.user.id);
            });
            if (!item) return res.status(403).json({ error: 'Nincs jogosultságod ehhez a kategóriához.' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_created', entityType: 'item', entityId: item.id, details: { type, title: item.title }, req });
            res.status(201).json(item);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Replaces an item's editable fields, fragments and tags; the type cannot change. */
    app.put('/api/items/:id', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const existing = await pool.query('SELECT type FROM items WHERE id = $1 AND owner_user_id = $2', [id, req.user.id]);
            if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
            const type = existing.rows[0].type;
            const { value, error } = normalizeItemInput(req.body, type);
            if (error) return res.status(400).json({ error });
            const item = await withTransaction(async client => {
                if (!(await categoryBelongsToUser(client, value.categoryId, req.user.id, type))) return null;
                await client.query(
                    `UPDATE items SET title = $3, description = $4, category_id = $5, body = $6, color = $7,
                            pinned = $8, starred = $9, position = $10, extra = $11, updated_at = NOW()
                     WHERE id = $1 AND owner_user_id = $2`,
                    [id, req.user.id, value.title, value.description, value.categoryId, value.body, value.color, value.pinned, value.starred, value.position, value.extra]
                );
                await replaceFragments(client, id, value.fragments);
                await replaceItemTags(client, id, req.user.id, value.tags);
                return loadItem(client, id, req.user.id);
            });
            if (!item) return res.status(403).json({ error: 'Nincs jogosultságod ehhez a kategóriához.' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_updated', entityType: 'item', entityId: id, details: { type, title: item.title }, req });
            res.json(item);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Toggles starred, pinned, archived or trashed without touching the content. */
    app.patch('/api/items/:id/state', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        const fields = [], values = [id, req.user.id];
        for (const key of ['starred', 'pinned', 'archived', 'trashed']) {
            if (req.body[key] !== undefined) { values.push(Boolean(req.body[key])); fields.push(`${key} = $${values.length}`); }
        }
        if (!fields.length) return res.status(400).json({ error: 'Nincs módosítandó állapot.' });
        try {
            const result = await pool.query(`UPDATE items SET ${fields.join(', ')} WHERE id = $1 AND owner_user_id = $2 RETURNING id`, values);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_state_updated', entityType: 'item', entityId: id, details: { fields: Object.keys(req.body) }, req });
            res.json(await loadItem(pool, id, req.user.id));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Counts a copy so the UI can sort by most used; deliberately not audited (it fires on every copy). */
    app.post('/api/items/:id/used', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query('UPDATE items SET use_count = use_count + 1 WHERE id = $1 AND owner_user_id = $2 RETURNING use_count', [id, req.user.id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            res.json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Moves an item to the trash; permanent deletion is available for trashed items only. */
    app.delete('/api/items/:id', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query('UPDATE items SET trashed = TRUE, archived = FALSE WHERE id = $1 AND owner_user_id = $2 RETURNING id', [id, req.user.id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_trashed', entityType: 'item', entityId: id, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/items/:id/permanent', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query('DELETE FROM items WHERE id = $1 AND owner_user_id = $2 AND trashed = TRUE RETURNING id', [id, req.user.id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_deleted_permanent', entityType: 'item', entityId: id, details: { permanent: true }, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerItemRoutes, normalizeItemLanguage, ITEM_TYPES };
