/**
 * Feladat-specifikus végpontok: kipipálás (ismétlődő feladatnál ugrás a következő esedékességre),
 * visszavonás, okos listák darabszámai a fül jelvényéhez, és a magyar gyors-beírás szerveroldali értelmezése.
 * A feladatok mentése, listázása és törlése a közös /api/items végpontokon megy (routes/items.js).
 */

const taskDates = require('../public/js/task-parser');
const { syncReminders, resolveTimeZone, dayBoundsSql, TASK_VIEW_CONDITIONS } = require('./items');

const MAX_PARSE_LENGTH = 1000;

/**
 * The next due time of a repeating task after `dueAt`, skipping dates before today so that a task
 * left undone for a while jumps to its next upcoming occurrence instead of a past one.
 */
function nextDueAt(task, timeZone, now = new Date()) {
    const dueAt = new Date(task.due_at);
    const time = task.due_all_day ? '00:00' : taskDates.localTime(dueAt, timeZone);
    const today = taskDates.localDate(now, timeZone);
    let date = taskDates.nextOccurrence(task.recurrence_rule, taskDates.localDate(dueAt, timeZone));
    for (let guard = 0; date && date < today && guard < 5000; guard += 1) {
        date = taskDates.nextOccurrence(task.recurrence_rule, date);
    }
    return date ? taskDates.zonedTimeToUtc(date, time, timeZone) : null;
}

function registerTaskRoutes(app, { pool, requireAuth, recordAuditEvent, loadItem, withTransaction }) {
    function parseId(value) {
        const id = Number(value);
        return Number.isInteger(id) && id > 0 ? id : null;
    }

    /**
     * Completes a task. A repeating task stays open and moves to its next occurrence
     * (its reminders and subtasks are re-armed); any other task and its subtasks become done.
     */
    app.post('/api/items/:id/complete', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const timeZone = await resolveTimeZone(pool, req.user.id, req.body?.tz);
            const outcome = await withTransaction(async client => {
                const found = await client.query(
                    "SELECT * FROM items WHERE id = $1 AND owner_user_id = $2 AND type = 'task' FOR UPDATE",
                    [id, req.user.id]
                );
                const task = found.rows[0];
                if (!task) return null;
                const previousDueAt = task.due_at;
                const nextDue = task.recurrence_rule && task.due_at && task.status !== 'done' ? nextDueAt(task, timeZone) : null;
                if (nextDue) {
                    await client.query("UPDATE items SET due_at = $2, status = 'todo', completed_at = NULL, updated_at = NOW() WHERE id = $1", [id, nextDue]);
                    await syncReminders(client, id, nextDue.getTime() - new Date(previousDueAt).getTime());
                    await client.query("UPDATE items SET status = 'todo', completed_at = NULL WHERE parent_item_id = $1 AND trashed = FALSE", [id]);
                } else {
                    await client.query("UPDATE items SET status = 'done', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW() WHERE id = $1", [id]);
                    await client.query("UPDATE items SET status = 'done', completed_at = COALESCE(completed_at, NOW()) WHERE parent_item_id = $1 AND status <> 'done'", [id]);
                    await syncReminders(client, id);
                }
                return { item: await loadItem(client, id, req.user.id), recurring: Boolean(nextDue), previousDueAt, title: task.title };
            });
            if (!outcome) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({
                userId: req.user.id, action: 'task_completed', entityType: 'item', entityId: id,
                details: { title: outcome.title, recurring: outcome.recurring, occurrence: outcome.previousDueAt }, req
            });
            res.json({ item: outcome.item, recurring: outcome.recurring, previousDueAt: outcome.previousDueAt });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * Reopens a task. For undoing a repeating task's completion the client sends the
     * `previousDueAt` it got back, and the task returns to that date.
     */
    app.post('/api/items/:id/uncomplete', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        let restoreDue = null;
        if (req.body?.dueAt !== undefined && req.body?.dueAt !== null) {
            restoreDue = new Date(req.body.dueAt);
            if (Number.isNaN(restoreDue.getTime())) return res.status(400).json({ error: 'Érvénytelen határidő.' });
        }
        try {
            const item = await withTransaction(async client => {
                const found = await client.query(
                    "SELECT due_at, recurrence_rule FROM items WHERE id = $1 AND owner_user_id = $2 AND type = 'task' FOR UPDATE",
                    [id, req.user.id]
                );
                const task = found.rows[0];
                if (!task) return null;
                await client.query("UPDATE items SET status = 'todo', completed_at = NULL, updated_at = NOW() WHERE id = $1", [id]);
                if (restoreDue && task.due_at && task.recurrence_rule) {
                    await client.query('UPDATE items SET due_at = $2 WHERE id = $1', [id, restoreDue]);
                    await syncReminders(client, id, restoreDue.getTime() - new Date(task.due_at).getTime());
                } else {
                    await client.query(
                        `UPDATE item_reminders SET sent_at = NULL, attempts = 0, last_error = NULL
                         WHERE item_id = $1 AND remind_at > NOW()`,
                        [id]
                    );
                }
                return loadItem(client, id, req.user.id);
            });
            if (!item) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'task_reopened', entityType: 'item', entityId: id, details: { title: item.title }, req });
            res.json(item);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Open task counts for the smart lists, for the tab badge and the sidebar. */
    app.get('/api/tasks/summary', requireAuth, async (req, res) => {
        try {
            const timeZone = await resolveTimeZone(pool, req.user.id, req.query.tz);
            const counts = Object.entries(TASK_VIEW_CONDITIONS)
                .filter(([view]) => view !== 'done')
                .map(([view, condition]) => `COUNT(*) FILTER (WHERE ${condition})::int AS ${view}`)
                .join(', ');
            const result = await pool.query(
                `SELECT ${counts}, COUNT(*) FILTER (WHERE i.status <> 'done')::int AS open
                 FROM items i CROSS JOIN (SELECT ${dayBoundsSql('$2')}) d
                 WHERE i.owner_user_id = $1 AND i.type = 'task' AND i.trashed = FALSE AND i.archived = FALSE`,
                [req.user.id, timeZone]
            );
            res.json({ ...result.rows[0], timeZone });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Server-side twin of the quick-add parser (the browser runs the same module locally). */
    app.post('/api/tasks/parse', requireAuth, async (req, res) => {
        const text = String(req.body?.text || '');
        if (text.length > MAX_PARSE_LENGTH) return res.status(400).json({ error: 'Túl hosszú szöveg.' });
        try {
            const timeZone = await resolveTimeZone(pool, req.user.id, req.body?.tz);
            const parsed = taskDates.parse(text, { timeZone });
            res.json({ ...parsed, timeZone, recurrenceText: taskDates.describeRecurrence(parsed.recurrenceRule) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerTaskRoutes, nextDueAt };
