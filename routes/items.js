/**
 * Parancsok, jegyzetek és feladatok API-ja az `items` táblán.
 * A könyvjelzők külön táblában maradnak; ez a modul csak a nem-URL típusokat kezeli.
 * A feladat-specifikus végpontok (kipipálás, okos listák összesítője, gyors-beírás) a routes/tasks.js-ben vannak.
 */

const taskDates = require('../public/js/task-parser');
const linkParser = require('../public/js/inline-links');

const ITEM_TYPES = ['command', 'note', 'task'];
const TASK_STATUSES = ['todo', 'doing', 'done'];
const TASK_VIEWS = ['today', 'upcoming', 'overdue', 'inbox', 'done'];
const MAX_REMINDERS = 10;
const MAX_LINKS = 50;
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
/** A validation failure detected inside a transaction; the route answers it with 400. */
class ItemInputError extends Error {}

function parseOptionalDate(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Validates the task-only fields. Reminders and links are left `undefined` when the request
 * does not send them, so an update keeps the existing ones.
 */
function normalizeTaskInput(body) {
    // Ha az állapot nincs megadva, új feladatnál 'todo', módosításnál a régi marad.
    const status = body.status === undefined || body.status === null || body.status === '' ? null : String(body.status);
    if (status !== null && !TASK_STATUSES.includes(status)) return { error: 'Érvénytelen állapot.' };
    const priority = body.priority === undefined || body.priority === null || body.priority === '' ? null : Number(body.priority);
    if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 4)) return { error: 'A prioritás 1 és 4 közötti szám lehet.' };
    const dueAt = parseOptionalDate(body.dueAt);
    if (dueAt === undefined) return { error: 'Érvénytelen határidő.' };
    let recurrenceRule = null;
    if (body.recurrenceRule !== undefined && body.recurrenceRule !== null && body.recurrenceRule !== '') {
        recurrenceRule = taskDates.normalizeRecurrence(String(body.recurrenceRule));
        if (!recurrenceRule) return { error: 'Nem támogatott ismétlődési szabály.' };
        if (!dueAt) return { error: 'Ismétlődő feladathoz határidő is kell.' };
    }
    const parentItemId = body.parentItemId === undefined || body.parentItemId === null || body.parentItemId === '' ? null : Number(body.parentItemId);
    if (parentItemId !== null && (!Number.isInteger(parentItemId) || parentItemId < 1)) return { error: 'Érvénytelen szülőfeladat.' };

    let reminders;
    if (body.reminders !== undefined && body.reminders !== null) {
        if (!Array.isArray(body.reminders) || body.reminders.length > MAX_REMINDERS) return { error: `Legfeljebb ${MAX_REMINDERS} emlékeztető adható meg.` };
        reminders = [];
        for (const raw of body.reminders) {
            const offset = typeof raw === 'number' ? raw : raw?.offsetMinutes;
            if (offset !== undefined && offset !== null) {
                if (!Number.isInteger(offset) || offset < 0 || offset > 525600) return { error: 'Érvénytelen emlékeztető.' };
                if (!dueAt) return { error: 'A határidőhöz kötött emlékeztetőhöz határidő kell.' };
                reminders.push({ offsetMinutes: offset, remindAt: new Date(dueAt.getTime() - offset * 60000) });
            } else {
                const remindAt = parseOptionalDate(raw?.remindAt);
                if (!remindAt) return { error: 'Érvénytelen emlékeztető időpont.' };
                reminders.push({ offsetMinutes: null, remindAt });
            }
        }
    }

    let links;
    if (body.links !== undefined && body.links !== null) {
        if (!Array.isArray(body.links) || body.links.length > MAX_LINKS) return { error: `Legfeljebb ${MAX_LINKS} kapcsolat adható meg.` };
        const seen = new Set();
        links = [];
        for (const raw of body.links) {
            const targetType = String(raw?.targetType ?? raw?.type ?? '');
            const targetId = Number(raw?.targetId ?? raw?.id);
            if (!['item', 'bookmark'].includes(targetType) || !Number.isInteger(targetId) || targetId < 1) return { error: 'Érvénytelen kapcsolat.' };
            const key = `${targetType}:${targetId}`;
            if (!seen.has(key)) { seen.add(key); links.push({ targetType, targetId }); }
        }
    }

    return {
        task: {
            status,
            priority,
            dueAt,
            dueAllDay: dueAt ? body.dueAllDay !== false : true,
            recurrenceRule,
            parentItemId,
            reminders,
            links
        }
    };
}

function normalizeItemInput(body, type) {
    const title = optionalText(body.title, MAX_TITLE_LENGTH);
    if ((type === 'command' || type === 'task') && !title) return { error: 'A cím megadása kötelező.' };
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
    if (type === 'task') {
        const { task, error: taskError } = normalizeTaskInput(body);
        if (taskError) return { error: taskError };
        value.task = task;
    }
    return { value };
}

/**
 * Re-aligns a task's reminders with its due time: relative reminders follow the due time
 * (and are dropped when it is cleared), and reminders whose time has already passed are marked
 * as sent so that the scheduler never fires them late.
 * `shiftMs` moves fixed-time reminders too, used when a repeating task jumps to its next date.
 */
async function syncReminders(db, itemId, shiftMs = 0) {
    await db.query(
        `DELETE FROM item_reminders r USING items i
         WHERE r.item_id = i.id AND i.id = $1 AND r.offset_minutes IS NOT NULL AND i.due_at IS NULL`,
        [itemId]
    );
    await db.query(
        `UPDATE item_reminders r
         SET remind_at = CASE WHEN r.offset_minutes IS NOT NULL THEN i.due_at - make_interval(mins => r.offset_minutes)
                              ELSE r.remind_at + make_interval(secs => $2::double precision / 1000) END,
             sent_at = CASE WHEN $2::double precision <> 0 THEN NULL ELSE r.sent_at END,
             attempts = CASE WHEN $2::double precision <> 0 THEN 0 ELSE r.attempts END,
             last_error = CASE WHEN $2::double precision <> 0 THEN NULL ELSE r.last_error END
         FROM items i
         WHERE r.item_id = i.id AND i.id = $1`,
        [itemId, shiftMs]
    );
    await db.query(
        `UPDATE item_reminders r SET sent_at = NOW()
         FROM items i
         WHERE r.item_id = i.id AND i.id = $1 AND r.sent_at IS NULL
           AND (r.remind_at <= NOW() OR i.status = 'done')`,
        [itemId]
    );
}

/** SQL fragment with the start of today, tomorrow and the 8th day in time zone $tz, as timestamptz. */
function dayBoundsSql(tzParam) {
    return `(date_trunc('day', NOW() AT TIME ZONE ${tzParam}) AT TIME ZONE ${tzParam}) AS today_start,
            ((date_trunc('day', NOW() AT TIME ZONE ${tzParam}) + INTERVAL '1 day') AT TIME ZONE ${tzParam}) AS tomorrow_start,
            ((date_trunc('day', NOW() AT TIME ZONE ${tzParam}) + INTERVAL '8 days') AT TIME ZONE ${tzParam}) AS week_end`;
}

/** WHERE conditions (on alias i, with bounds alias d) for the smart task lists. */
const TASK_VIEW_CONDITIONS = {
    overdue: `i.status <> 'done' AND i.due_at IS NOT NULL
              AND ((i.due_all_day AND i.due_at < d.today_start) OR (NOT i.due_all_day AND i.due_at < NOW()))`,
    today: `i.status <> 'done' AND i.due_at < d.tomorrow_start`,
    upcoming: `i.status <> 'done' AND i.due_at >= d.tomorrow_start AND i.due_at < d.week_end`,
    inbox: `i.status <> 'done' AND i.category_id IS NULL AND i.parent_item_id IS NULL`,
    done: `i.status = 'done'`
};

/** The user's time zone: a valid explicit value, then the saved setting, then Europe/Budapest. */
async function resolveTimeZone(db, userId, explicit) {
    if (taskDates.isValidTimeZone(explicit)) return explicit;
    try {
        const result = await db.query("SELECT value FROM settings_user WHERE user_id = $1 AND setting_key = 'timezone'", [userId]);
        const saved = result.rows[0]?.value;
        if (taskDates.isValidTimeZone(saved)) return saved;
    } catch (err) { /* fall back to the default */ }
    return taskDates.DEFAULT_TIME_ZONE;
}

function registerItemRoutes(app, { pool, requireAuth, recordAuditEvent, normalizeTags }) {
    const ITEM_SELECT = `
        SELECT i.*, c.name AS category_name,
               COALESCE((SELECT json_agg(json_build_object('id', f.id, 'position', f.position, 'label', f.label, 'language', f.language, 'content', f.content) ORDER BY f.position)
                         FROM item_fragments f WHERE f.item_id = i.id), '[]') AS fragments,
               COALESCE((SELECT array_agg(t.name ORDER BY t.name)
                         FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), '{}') AS tags,
               COALESCE((SELECT json_agg(json_build_object('id', r.id, 'offsetMinutes', r.offset_minutes, 'remindAt', r.remind_at, 'sentAt', r.sent_at, 'channels', r.channels) ORDER BY r.remind_at)
                         FROM item_reminders r WHERE r.item_id = i.id AND r.is_snooze = FALSE), '[]') AS reminders,
               COALESCE((SELECT json_agg(json_build_object('targetType', l.target_type, 'targetId', l.target_id, 'itemType', li.type,
                                                           'title', COALESCE(li.title, b.title), 'url', b.url) ORDER BY l.created_at, l.target_type DESC, l.target_id)
                         FROM item_links l
                         LEFT JOIN items li ON l.target_type = 'item' AND li.id = l.target_id AND li.owner_user_id = i.owner_user_id AND li.trashed = FALSE
                         LEFT JOIN bookmarks b ON l.target_type = 'bookmark' AND b.id = l.target_id AND b.trashed = FALSE
                         WHERE l.item_id = i.id AND l.origin = 'manual' AND (li.id IS NOT NULL OR b.id IS NOT NULL)), '[]') AS links,
               COALESCE((SELECT json_agg(json_build_object('targetType', l.target_type, 'targetId', l.target_id, 'itemType', li.type,
                                                           'title', COALESCE(li.title, b.title), 'url', b.url) ORDER BY l.created_at, l.target_type DESC, l.target_id)
                         FROM item_links l
                         LEFT JOIN items li ON l.target_type = 'item' AND li.id = l.target_id AND li.owner_user_id = i.owner_user_id AND li.trashed = FALSE
                         LEFT JOIN bookmarks b ON l.target_type = 'bookmark' AND b.id = l.target_id AND b.trashed = FALSE
                         WHERE l.item_id = i.id AND l.origin = 'inline' AND (li.id IS NOT NULL OR b.id IS NOT NULL)), '[]') AS inline_links,
               (SELECT COUNT(*) FROM items s WHERE s.parent_item_id = i.id AND s.trashed = FALSE)::int AS subtask_count,
               (SELECT COUNT(*) FROM items s WHERE s.parent_item_id = i.id AND s.trashed = FALSE AND s.status = 'done')::int AS subtask_done_count
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

    /** Checks that the parent is the user's own top-level task and that this task has no subtasks itself. */
    async function validateParent(db, itemId, parentItemId, userId) {
        if (parentItemId === null) return null;
        if (itemId !== null && String(parentItemId) === String(itemId)) return 'Egy feladat nem lehet a saját részfeladata.';
        const parent = await db.query(
            "SELECT parent_item_id FROM items WHERE id = $1 AND owner_user_id = $2 AND type = 'task'",
            [parentItemId, userId]
        );
        if (!parent.rowCount) return 'A szülőfeladat nem található.';
        if (parent.rows[0].parent_item_id !== null) return 'Részfeladatnak nem lehet további részfeladata.';
        if (itemId !== null) {
            const children = await db.query('SELECT 1 FROM items WHERE parent_item_id = $1 LIMIT 1', [itemId]);
            if (children.rowCount) return 'Részfeladatokkal rendelkező feladat nem lehet részfeladat.';
        }
        return null;
    }

    /** Checks that every link target exists and belongs to the user. */
    async function validateLinks(db, itemId, links, user) {
        const itemIds = links.filter(link => link.targetType === 'item').map(link => link.targetId);
        const bookmarkIds = links.filter(link => link.targetType === 'bookmark').map(link => link.targetId);
        if (itemId !== null && itemIds.some(id => String(id) === String(itemId))) return 'Egy elem nem kapcsolható önmagához.';
        if (itemIds.length) {
            const found = await db.query('SELECT COUNT(*)::int AS count FROM items WHERE id = ANY($1) AND owner_user_id = $2', [itemIds, user.id]);
            if (found.rows[0].count !== itemIds.length) return 'A kapcsolt elem nem található.';
        }
        if (bookmarkIds.length) {
            const found = await db.query(
                'SELECT COUNT(*)::int AS count FROM bookmarks WHERE id = ANY($1) AND (user_id = $2 OR user_id = $3)',
                [bookmarkIds, user.username, String(user.id)]
            );
            if (found.rows[0].count !== bookmarkIds.length) return 'A kapcsolt könyvjelző nem található.';
        }
        return null;
    }

    /**
     * Rebuilds the item's inline links ([[jegyzet:12|…]] in the body). Targets that don't exist or aren't the
     * user's own are skipped rather than rejected, so pasted text never blocks saving; the card shows them as missing.
     */
    async function syncInlineLinks(db, itemId, body, user) {
        await db.query("DELETE FROM item_links WHERE item_id = $1 AND origin = 'inline'", [itemId]);
        const targets = linkParser.targets(body, itemId);
        if (!targets.length) return;
        const itemIds = targets.filter(target => target.targetType === 'item').map(target => target.targetId);
        const bookmarkIds = targets.filter(target => target.targetType === 'bookmark').map(target => target.targetId);
        if (itemIds.length) {
            await db.query(
                `INSERT INTO item_links (item_id, target_type, target_id, origin)
                 SELECT $1, 'item', id, 'inline' FROM items WHERE id = ANY($2) AND owner_user_id = $3 ON CONFLICT DO NOTHING`,
                [itemId, itemIds, user.id]
            );
        }
        if (bookmarkIds.length) {
            await db.query(
                `INSERT INTO item_links (item_id, target_type, target_id, origin)
                 SELECT $1, 'bookmark', id, 'inline' FROM bookmarks WHERE id = ANY($2) AND (user_id = $3 OR user_id = $4) ON CONFLICT DO NOTHING`,
                [itemId, bookmarkIds, user.username, String(user.id)]
            );
        }
    }

    /**
     * Writes the task columns, reminders and links of a task inside a transaction.
     * Returns an error message for invalid references, otherwise null.
     */
    async function saveTaskFields(db, itemId, task, user) {
        const parentError = await validateParent(db, itemId, task.parentItemId, user.id);
        if (parentError) return parentError;
        if (task.links) {
            const linkError = await validateLinks(db, itemId, task.links, user);
            if (linkError) return linkError;
        }
        await db.query(
            `UPDATE items SET status = COALESCE($2, status, 'todo'), priority = $3, due_at = $4, due_all_day = $5, recurrence_rule = $6, parent_item_id = $7,
                    completed_at = CASE WHEN $8 THEN COALESCE(completed_at, NOW()) WHEN $9 THEN completed_at ELSE NULL END
             WHERE id = $1`,
            [itemId, task.status, task.priority, task.dueAt, task.dueAllDay, task.recurrenceRule, task.parentItemId, task.status === 'done', task.status === null]
        );
        if (task.reminders) {
            await db.query('DELETE FROM item_reminders WHERE item_id = $1 AND is_snooze = FALSE', [itemId]);
            for (const reminder of task.reminders) {
                await db.query(
                    'INSERT INTO item_reminders (item_id, offset_minutes, remind_at) VALUES ($1, $2, $3)',
                    [itemId, reminder.offsetMinutes, reminder.remindAt]
                );
            }
        }
        await syncReminders(db, itemId);
        if (task.links) {
            await db.query("DELETE FROM item_links WHERE item_id = $1 AND origin = 'manual'", [itemId]);
            for (const link of task.links) {
                await db.query('INSERT INTO item_links (item_id, target_type, target_id) VALUES ($1, $2, $3)', [itemId, link.targetType, link.targetId]);
            }
        }
        return null;
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

    /**
     * Lists the user's items of one type with fragments and tags, for client-side filtering.
     * Tasks also accept a smart list (`view=today|upcoming|overdue|inbox|done`) evaluated in the
     * user's time zone (`tz`), and are ordered by due date; the done list is paged with limit/offset.
     */
    app.get('/api/items', requireAuth, async (req, res) => {
        const type = String(req.query.type || '');
        if (!ITEM_TYPES.includes(type)) return res.status(400).json({ error: 'Érvénytelen típus.' });
        const view = req.query.view ? String(req.query.view) : null;
        if (view && (type !== 'task' || !TASK_VIEWS.includes(view))) return res.status(400).json({ error: 'Érvénytelen nézet.' });
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
            let from = '';
            let order = 'i.pinned DESC, i.position ASC NULLS LAST, i.updated_at DESC';
            let page = '';
            if (type === 'task') {
                order = `i.status = 'done', i.due_at ASC NULLS LAST, i.priority ASC NULLS LAST, i.position ASC NULLS LAST, i.created_at ASC`;
                if (view) {
                    params.push(await resolveTimeZone(pool, req.user.id, req.query.tz));
                    from = `CROSS JOIN (SELECT ${dayBoundsSql(`$${params.length}`)}) d`;
                    conditions.push(`(${TASK_VIEW_CONDITIONS[view]})`);
                }
                if (view === 'done') {
                    order = 'i.completed_at DESC NULLS LAST, i.id DESC';
                    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
                    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
                    page = `LIMIT ${limit} OFFSET ${offset}`;
                }
            }
            const result = await pool.query(
                `${ITEM_SELECT} ${from} WHERE ${conditions.join(' AND ')}
                 ORDER BY ${order} ${page}`,
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
            const tz = type === 'task' ? await resolveTimeZone(pool, req.user.id, req.query.tz) : null;
            await recordAuditEvent({ userId: req.user.id, action: 'items_exported', entityType: 'item', details: { type, format: req.query.format || 'json', count: rows.length }, req });
            if (req.query.format === 'md' && type === 'task') {
                const line = item => {
                    const due = item.due_at ? ` (${item.due_all_day ? taskDates.localDate(item.due_at, tz) : `${taskDates.localDate(item.due_at, tz)} ${taskDates.localTime(item.due_at, tz)}`})` : '';
                    const extras = [item.priority ? `P${item.priority}` : '', item.recurrence_rule ? taskDates.describeRecurrence(item.recurrence_rule) : '', ...item.tags.map(tag => `#${tag}`)].filter(Boolean).join(' ');
                    return `[${item.status === 'done' ? 'x' : ' '}] ${item.title}${due}${extras ? ` ${extras}` : ''}`;
                };
                const markdown = rows.filter(item => !item.parent_item_id).map(item => {
                    const children = rows.filter(child => String(child.parent_item_id) === String(item.id)).map(child => `  - ${line(child)}`);
                    return [`- ${line(item)}`, ...children].join('\n');
                }).join('\n');
                return res.type('text/markdown').attachment('cloudmark-task.md').send(markdown + '\n');
            }
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
                    fragments: item.fragments.map(({ label, language, content }) => ({ label, language, content })),
                    ...(type === 'task' ? {
                        ref: String(item.id),
                        parentRef: item.parent_item_id ? String(item.parent_item_id) : null,
                        status: item.status,
                        priority: item.priority,
                        dueAt: item.due_at,
                        dueAllDay: item.due_all_day,
                        recurrenceRule: item.recurrence_rule,
                        completedAt: item.completed_at,
                        reminders: item.reminders.map(({ offsetMinutes, remindAt }) => (offsetMinutes !== null ? { offsetMinutes } : { remindAt }))
                    } : {})
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
            const { value, error } = normalizeItemInput({ ...raw, categoryId: null, fragments, parentItemId: null, links: null }, type);
            if (error) return res.status(400).json({ error: `${index + 1}. elem: ${error}` });
            prepared.push({
                value,
                category: optionalText(raw.category, 100)?.trim() || null,
                archived: Boolean(raw.archived),
                ref: raw.ref === undefined || raw.ref === null ? null : String(raw.ref),
                parentRef: raw.parentRef === undefined || raw.parentRef === null ? null : String(raw.parentRef)
            });
        }

        try {
            const created = await withTransaction(async client => {
                const categoryIds = new Map();
                const refs = new Map();
                let count = 0;
                for (const { value, category, archived, ref } of prepared) {
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
                        `INSERT INTO items (owner_user_id, type, title, description, category_id, body, color, pinned, starred, archived, extra, status)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                        [req.user.id, type, value.title, value.description, categoryId, value.body, value.color, value.pinned, value.starred, archived, value.extra, value.task ? value.task.status || 'todo' : null]
                    );
                    await replaceFragments(client, inserted.rows[0].id, value.fragments);
                    await replaceItemTags(client, inserted.rows[0].id, req.user.id, value.tags);
                    if (value.task) await saveTaskFields(client, inserted.rows[0].id, value.task, req.user);
                    if (ref) refs.set(ref, inserted.rows[0].id);
                    count += 1;
                }
                // Részfeladatok: a szülőt a csomagon belüli `ref` alapján kötjük be, ha az maga nem részfeladat.
                for (const { ref, parentRef } of prepared) {
                    if (type !== 'task' || !ref || !parentRef || !refs.has(parentRef) || parentRef === ref) continue;
                    const parentIsTopLevel = !prepared.some(entry => entry.ref === parentRef && entry.parentRef && refs.has(entry.parentRef));
                    if (parentIsTopLevel) await client.query('UPDATE items SET parent_item_id = $2 WHERE id = $1', [refs.get(ref), refs.get(parentRef)]);
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
                    `INSERT INTO items (owner_user_id, type, title, description, category_id, body, color, pinned, starred, position, extra, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                    [req.user.id, type, value.title, value.description, value.categoryId, value.body, value.color, value.pinned, value.starred, value.position, value.extra, value.task ? value.task.status || 'todo' : null]
                );
                await replaceFragments(client, inserted.rows[0].id, value.fragments);
                await replaceItemTags(client, inserted.rows[0].id, req.user.id, value.tags);
                await syncInlineLinks(client, inserted.rows[0].id, value.body, req.user);
                if (value.task) {
                    const taskError = await saveTaskFields(client, inserted.rows[0].id, value.task, req.user);
                    if (taskError) throw new ItemInputError(taskError);
                }
                return loadItem(client, inserted.rows[0].id, req.user.id);
            });
            if (!item) return res.status(403).json({ error: 'Nincs jogosultságod ehhez a kategóriához.' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_created', entityType: 'item', entityId: item.id, details: { type, title: item.title }, req });
            res.status(201).json(item);
        } catch (err) {
            res.status(err instanceof ItemInputError ? 400 : 500).json({ error: err.message });
        }
    });

    /** Items that link to this one (by hand or with [[…]] in their text), for the „Hivatkoznak rá” list. */
    app.get('/api/items/:id/backlinks', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const own = await pool.query('SELECT 1 FROM items WHERE id = $1 AND owner_user_id = $2', [id, req.user.id]);
            if (!own.rowCount) return res.status(404).json({ error: 'Not found' });
            const result = await pool.query(
                `SELECT i.id, i.type, i.title, i.body, i.status, MAX(l.created_at) AS linked_at
                 FROM item_links l JOIN items i ON i.id = l.item_id
                 WHERE l.target_type = 'item' AND l.target_id = $1 AND i.owner_user_id = $2 AND i.trashed = FALSE
                 GROUP BY i.id ORDER BY linked_at DESC LIMIT 100`,
                [id, req.user.id]
            );
            res.json(result.rows.map(row => ({
                id: row.id,
                type: row.type,
                title: row.title || String(row.body || '').trim().split('\n')[0].slice(0, 80) || 'Névtelen',
                status: row.status
            })));
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
                await syncInlineLinks(client, id, value.body, req.user);
                if (value.task) {
                    const taskError = await saveTaskFields(client, id, value.task, req.user);
                    if (taskError) throw new ItemInputError(taskError);
                }
                return loadItem(client, id, req.user.id);
            });
            if (!item) return res.status(403).json({ error: 'Nincs jogosultságod ehhez a kategóriához.' });
            await recordAuditEvent({ userId: req.user.id, action: 'item_updated', entityType: 'item', entityId: id, details: { type, title: item.title }, req });
            res.json(item);
        } catch (err) {
            res.status(err instanceof ItemInputError ? 400 : 500).json({ error: err.message });
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
            // A részfeladatok a szülővel együtt kerülnek kukába, archívumba, és onnan vissza.
            const cascadeFields = [], cascadeValues = [id, req.user.id];
            for (const key of ['archived', 'trashed']) {
                if (req.body[key] !== undefined) { cascadeValues.push(Boolean(req.body[key])); cascadeFields.push(`${key} = $${cascadeValues.length}`); }
            }
            if (cascadeFields.length) {
                await pool.query(`UPDATE items SET ${cascadeFields.join(', ')} WHERE parent_item_id = $1 AND owner_user_id = $2`, cascadeValues);
            }
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
            await pool.query('UPDATE items SET trashed = TRUE, archived = FALSE WHERE parent_item_id = $1 AND owner_user_id = $2', [id, req.user.id]);
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
    return { loadItem, withTransaction };
}

module.exports = { registerItemRoutes, normalizeItemLanguage, syncReminders, resolveTimeZone, dayBoundsSql, TASK_VIEW_CONDITIONS, ITEM_TYPES };
