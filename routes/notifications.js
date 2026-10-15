/**
 * Értesítések: feladat-emlékeztetők és napi összefoglaló kiküldése (felületen belül + e-mail),
 * a csengő API-ja, és a belső futtató végpont, amit a Supabase pg_cron hív percenként.
 *
 * A Render free példány tétlenül elalszik, ezért az időzítés az adatbázisban fut (pg_cron + pg_net):
 * csak akkor hívja a /api/internal/notifications/run végpontot, ha notification_work_pending() igaz.
 * Amíg a szerver ébren van, egy percenkénti belső kör is lefut, így semmi nem marad ki.
 */

const crypto = require('crypto');
const taskDates = require('../public/js/task-parser');

const NOTIFICATION_KINDS = ['task_reminder', 'daily_digest', 'test'];
const STALE_REMINDER_MS = 12 * 3600 * 1000;
const TEST_COOLDOWN_MS = 30 * 1000;
const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function settingValue(value) {
    return value === undefined || value === null ? null : value;
}

/** Hungarian due text in the user's time zone, e.g. „2026. okt. 16. 09:00”. */
function formatDue(dueAt, allDay, timeZone) {
    if (!dueAt) return '';
    const options = { timeZone, year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' };
    if (!allDay) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
    return new Intl.DateTimeFormat('hu-HU', options).format(new Date(dueAt));
}

/** Shared HTML frame for notification e-mails. */
function emailLayout(title, inner, appUrl) {
    return `<!doctype html><html lang="hu"><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
<div style="font-weight:700;color:#0284c7;font-size:18px;margin-bottom:16px;">CloudMark</div>
<h1 style="font-size:18px;margin:0 0 12px;">${esc(title)}</h1>
${inner}
<p style="margin:24px 0 0;"><a href="${esc(appUrl)}/#/feladatok" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Feladatok megnyitása</a></p>
<p style="margin:20px 0 0;font-size:12px;color:#64748b;">Az értesítéseket a CloudMark csengő ikonjánál kapcsolhatod ki.</p>
</div></body></html>`;
}

function registerNotificationRoutes(app, { pool, requireAuth, recordAuditEvent, getMailer, getPublicBaseUrl }) {
    let running = null;
    let lastBaseUrl = null;
    const lastTestByUser = new Map();

    async function insertNotification(db, { userId, kind, title, body = null, itemId = null }) {
        const result = await db.query(
            'INSERT INTO notifications (user_id, kind, title, body, item_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [userId, kind, title, body, itemId]
        );
        return result.rows[0].id;
    }

    /** Whether the user can get e-mail: a verified address and e-mails not switched off. */
    function emailAllowed(user) {
        return Boolean(user.email) && user.is_verified === true && String(user.notify_email ?? 'true') !== 'false';
    }

    async function loadUsers(db, userIds) {
        const result = await db.query(
            `SELECT u.id, u.username, u.email, u.is_verified,
                    (SELECT value #>> '{}' FROM settings_user WHERE user_id = u.id AND setting_key = 'notifyEmail') AS notify_email,
                    (SELECT value #>> '{}' FROM settings_user WHERE user_id = u.id AND setting_key = 'timezone') AS timezone
             FROM users u WHERE u.id = ANY($1)`,
            [userIds]
        );
        return new Map(result.rows.map(row => [String(row.id), {
            ...row,
            timezone: taskDates.isValidTimeZone(row.timezone) ? row.timezone : taskDates.DEFAULT_TIME_ZONE
        }]));
    }

    /** Sends every due task reminder once: always in the app, by e-mail when allowed. */
    async function sendDueReminders(mailer, appUrl, summary) {
        const claimed = await pool.query(
            `WITH due AS (
                SELECT r.id FROM item_reminders r JOIN items i ON i.id = r.item_id
                WHERE r.sent_at IS NULL AND r.remind_at <= NOW()
                  AND i.type = 'task' AND i.trashed = FALSE AND i.status <> 'done'
                ORDER BY r.remind_at
                LIMIT 200
                FOR UPDATE OF r SKIP LOCKED
             )
             UPDATE item_reminders r SET sent_at = NOW(), attempts = r.attempts + 1
             FROM due WHERE r.id = due.id
             RETURNING r.id, r.item_id, r.remind_at, r.channels`
        );
        if (!claimed.rowCount) return;
        const items = await pool.query(
            'SELECT id, owner_user_id, title, due_at, due_all_day, recurrence_rule FROM items WHERE id = ANY($1)',
            [[...new Set(claimed.rows.map(row => row.item_id))]]
        );
        const itemsById = new Map(items.rows.map(item => [String(item.id), item]));
        const users = await loadUsers(pool, [...new Set(items.rows.map(item => item.owner_user_id))]);

        for (const reminder of claimed.rows) {
            const item = itemsById.get(String(reminder.item_id));
            const user = item && users.get(String(item.owner_user_id));
            if (!item || !user) continue;
            // Ha a szerver sokáig nem futott, a nagyon régi emlékeztetőt már nem küldjük ki.
            if (Date.now() - new Date(reminder.remind_at).getTime() > STALE_REMINDER_MS) {
                await pool.query("UPDATE item_reminders SET last_error = 'expired' WHERE id = $1", [reminder.id]);
                continue;
            }
            const due = formatDue(item.due_at, item.due_all_day, user.timezone);
            const body = due ? `Határidő: ${due}` : null;
            await insertNotification(pool, { userId: user.id, kind: 'task_reminder', title: item.title, body, itemId: item.id });
            summary.reminders += 1;

            if (!reminder.channels.includes('email') || !emailAllowed(user)) continue;
            if (!mailer) { await pool.query("UPDATE item_reminders SET last_error = 'email_not_configured' WHERE id = $1", [reminder.id]); continue; }
            try {
                const recurrence = item.recurrence_rule ? taskDates.describeRecurrence(item.recurrence_rule) : '';
                await mailer({
                    to: user.email,
                    subject: `Emlékeztető: ${item.title}`,
                    text: `${item.title}\n${body || ''}${recurrence ? `\nIsmétlődik: ${recurrence}` : ''}\n\n${appUrl}/#/feladatok`,
                    html: emailLayout(`Emlékeztető: ${item.title}`, `
                        ${due ? `<p style="margin:0 0 6px;"><strong>Határidő:</strong> ${esc(due)}</p>` : ''}
                        ${recurrence ? `<p style="margin:0;color:#64748b;">Ismétlődik: ${esc(recurrence)}</p>` : ''}`, appUrl)
                });
                summary.emails += 1;
            } catch (err) {
                summary.errors += 1;
                await pool.query('UPDATE item_reminders SET last_error = $2 WHERE id = $1', [reminder.id, String(err.message || err).slice(0, 500)]);
            }
        }
    }

    /** Sends the daily digest to every user whose chosen time has passed today and who has not had one yet. */
    async function sendDailyDigests(mailer, appUrl, summary) {
        const due = await pool.query(
            `SELECT digest.user_id, l.local_now::date::text AS local_date, COALESCE(zone.value #>> '{}', 'Europe/Budapest') AS timezone
             FROM settings_user digest
             LEFT JOIN settings_user zone ON zone.user_id = digest.user_id AND zone.setting_key = 'timezone'
             LEFT JOIN settings_user last_sent ON last_sent.user_id = digest.user_id AND last_sent.setting_key = 'dailyDigestLastSent'
             CROSS JOIN LATERAL (SELECT NOW() AT TIME ZONE COALESCE(zone.value #>> '{}', 'Europe/Budapest') AS local_now) l
             WHERE digest.setting_key = 'dailyDigestTime'
               AND CASE WHEN (digest.value #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                        THEN l.local_now::time >= (digest.value #>> '{}')::time ELSE FALSE END
               AND COALESCE(last_sent.value #>> '{}', '') <> l.local_now::date::text`
        );
        if (!due.rowCount) return;
        const users = await loadUsers(pool, due.rows.map(row => row.user_id));
        for (const row of due.rows) {
            // A mai dátum beírása egyben „lefoglalja” a küldést: párhuzamos futásnál csak az egyik kap sort vissza.
            const claimed = await pool.query(
                `INSERT INTO settings_user (user_id, setting_key, value, updated_at) VALUES ($1, 'dailyDigestLastSent', $2, NOW())
                 ON CONFLICT (user_id, setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                 WHERE settings_user.value IS DISTINCT FROM EXCLUDED.value
                 RETURNING user_id`,
                [row.user_id, JSON.stringify(row.local_date)]
            );
            if (!claimed.rowCount) continue;
            const user = users.get(String(row.user_id));
            if (!user) continue;
            const tasks = await pool.query(
                `SELECT i.id, i.title, i.due_at, i.due_all_day, i.priority, c.name AS project,
                        CASE WHEN (i.due_all_day AND i.due_at < d.today_start) OR (NOT i.due_all_day AND i.due_at < NOW()) THEN 'overdue'
                             WHEN i.due_at < d.tomorrow_start THEN 'today' ELSE 'tomorrow' END AS bucket
                 FROM items i
                 LEFT JOIN categories c ON c.id = i.category_id
                 CROSS JOIN (SELECT (date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2) AS today_start,
                                    ((date_trunc('day', NOW() AT TIME ZONE $2) + INTERVAL '1 day') AT TIME ZONE $2) AS tomorrow_start,
                                    ((date_trunc('day', NOW() AT TIME ZONE $2) + INTERVAL '2 days') AT TIME ZONE $2) AS after_tomorrow) d
                 WHERE i.owner_user_id = $1 AND i.type = 'task' AND i.trashed = FALSE AND i.archived = FALSE
                   AND i.status <> 'done' AND i.due_at < d.after_tomorrow
                 ORDER BY i.due_at, i.priority NULLS LAST`,
                [row.user_id, user.timezone]
            );
            if (!tasks.rowCount) continue;
            const groups = { overdue: [], today: [], tomorrow: [] };
            tasks.rows.forEach(task => groups[task.bucket].push(task));
            const counts = [
                groups.overdue.length ? `${groups.overdue.length} lejárt` : '',
                groups.today.length ? `${groups.today.length} mai` : '',
                groups.tomorrow.length ? `${groups.tomorrow.length} holnapi` : ''
            ].filter(Boolean).join(', ');
            await insertNotification(pool, { userId: user.id, kind: 'daily_digest', title: 'Napi összefoglaló', body: `${counts} feladat` });
            summary.digests += 1;
            if (!mailer || !emailAllowed(user)) continue;
            const section = (label, list, color) => list.length ? `
                <h2 style="font-size:14px;margin:18px 0 6px;color:${color};">${label} (${list.length})</h2>
                <ul style="margin:0;padding-left:20px;">${list.map(task => `<li style="margin:4px 0;">${task.priority ? `<strong>P${task.priority}</strong> ` : ''}${esc(task.title)}${task.due_all_day ? '' : ` <span style="color:#64748b;">${esc(taskDates.localTime(new Date(task.due_at), user.timezone))}</span>`}${task.project ? ` <span style="color:#64748b;">· ${esc(task.project)}</span>` : ''}</li>`).join('')}</ul>` : '';
            const textSection = (label, list) => list.length ? `${label}:\n${list.map(task => `- ${task.title}`).join('\n')}\n` : '';
            try {
                await mailer({
                    to: user.email,
                    subject: `CloudMark napi összefoglaló: ${counts} feladat`,
                    text: [textSection('Lejárt', groups.overdue), textSection('Ma', groups.today), textSection('Holnap', groups.tomorrow), `${appUrl}/#/feladatok`].join('\n'),
                    html: emailLayout('Napi összefoglaló', section('Lejárt', groups.overdue, '#e11d48') + section('Ma', groups.today, '#059669') + section('Holnap', groups.tomorrow, '#0284c7'), appUrl)
                });
                summary.emails += 1;
            } catch (err) {
                summary.errors += 1;
                console.error('[NOTIFY] Napi összefoglaló küldése sikertelen:', err.message || err);
            }
        }
    }

    /** One pass over everything that is due; concurrent calls share the running pass. */
    function runNotifications(appUrl) {
        if (running) return running;
        running = (async () => {
            const summary = { reminders: 0, digests: 0, emails: 0, errors: 0 };
            const mailer = await getMailer().catch(() => null);
            await sendDueReminders(mailer, appUrl, summary);
            await sendDailyDigests(mailer, appUrl, summary);
            if (summary.reminders || summary.digests) console.log('[NOTIFY]', JSON.stringify(summary));
            return summary;
        })().finally(() => { running = null; });
        return running;
    }

    function secretMatches(given) {
        const expected = process.env.CRON_SECRET || '';
        if (!expected || typeof given !== 'string') return false;
        const a = crypto.createHash('sha256').update(given).digest();
        const b = crypto.createHash('sha256').update(expected).digest();
        return crypto.timingSafeEqual(a, b);
    }

    /** Called by the Supabase pg_cron job (and usable by any external cron) with the shared secret. */
    app.post('/api/internal/notifications/run', async (req, res) => {
        if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET nincs beállítva.' });
        if (!secretMatches(req.get('x-cron-secret'))) return res.status(401).json({ error: 'Unauthorized' });
        try {
            res.json(await runNotifications(getPublicBaseUrl(req)));
        } catch (err) {
            console.error('[NOTIFY] Futtatás sikertelen:', err.message || err);
            res.status(500).json({ error: 'Notification run failed' });
        }
    });

    app.get('/api/notifications', requireAuth, async (req, res) => {
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
        lastBaseUrl = getPublicBaseUrl(req);
        try {
            const [items, unread] = await Promise.all([
                pool.query(
                    `SELECT n.id, n.kind, n.title, n.body, n.item_id, n.created_at, n.read_at
                     FROM notifications n WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
                    [req.user.id, limit]
                ),
                pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id])
            ]);
            res.json({ items: items.rows, unread: unread.rows[0].count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Marks the given notifications (or all of them with `all: true`) as read. */
    app.post('/api/notifications/read', requireAuth, async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 500) : [];
        if (!req.body?.all && !ids.length) return res.status(400).json({ error: 'Nincs megjelölendő értesítés.' });
        try {
            const result = req.body?.all
                ? await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.user.id])
                : await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [req.user.id, ids]);
            res.json({ success: true, updated: result.rowCount });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** The user's notification preferences plus what the server can actually deliver. */
    app.get('/api/notifications/settings', requireAuth, async (req, res) => {
        try {
            const users = await loadUsers(pool, [req.user.id]);
            const user = users.get(String(req.user.id));
            const digest = await pool.query("SELECT value #>> '{}' AS value FROM settings_user WHERE user_id = $1 AND setting_key = 'dailyDigestTime'", [req.user.id]);
            const mailer = await getMailer().catch(() => null);
            res.json({
                notifyEmail: String(user?.notify_email ?? 'true') !== 'false',
                dailyDigestTime: DIGEST_TIME_PATTERN.test(digest.rows[0]?.value || '') ? digest.rows[0].value : null,
                email: user?.email || null,
                emailVerified: user?.is_verified === true,
                emailConfigured: Boolean(mailer),
                timeZone: user?.timezone || taskDates.DEFAULT_TIME_ZONE
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Sends a test notification to the bell and, when possible, by e-mail. */
    app.post('/api/notifications/test', requireAuth, async (req, res) => {
        const last = lastTestByUser.get(String(req.user.id)) || 0;
        if (Date.now() - last < TEST_COOLDOWN_MS) return res.status(429).json({ error: 'Várj egy kicsit a következő teszt előtt.' });
        lastTestByUser.set(String(req.user.id), Date.now());
        try {
            await insertNotification(pool, { userId: req.user.id, kind: 'test', title: 'Teszt értesítés', body: 'Így fognak megjelenni az emlékeztetők.' });
            const user = (await loadUsers(pool, [req.user.id])).get(String(req.user.id));
            const mailer = await getMailer().catch(() => null);
            let email = 'sent';
            if (!mailer) email = 'not_configured';
            else if (!user?.email) email = 'no_address';
            else if (!user.is_verified) email = 'not_verified';
            else if (!emailAllowed(user)) email = 'disabled';
            else {
                const appUrl = getPublicBaseUrl(req);
                try {
                    await mailer({
                        to: user.email,
                        subject: 'CloudMark teszt értesítés',
                        text: `Ez egy teszt értesítés a CloudMarkból. Így fognak érkezni a feladat-emlékeztetők.\n\n${appUrl}/#/feladatok`,
                        html: emailLayout('Teszt értesítés', '<p style="margin:0;">Így fognak érkezni a feladat-emlékeztetők.</p>', appUrl)
                    });
                } catch (err) {
                    email = 'error';
                    await recordAuditEvent({ userId: req.user.id, action: 'notification_test_failed', entityType: 'notification', details: { error: String(err.message || err).slice(0, 300) }, req });
                    return res.json({ inApp: true, email, error: String(err.message || err) });
                }
            }
            res.json({ inApp: true, email });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Amíg a szerver ébren van, percenként magától is körbenéz (a pg_cron az alvó példányt ébreszti).
    const intervalMs = Number(process.env.NOTIFICATIONS_INTERVAL_MS ?? 60000);
    if (intervalMs > 0) {
        // A belső körnek nincs kérése, ezért a legutóbb látott nyilvános címet használja a linkekhez.
        const tick = () => runNotifications(lastBaseUrl || getPublicBaseUrl()).catch(err => console.error('[NOTIFY] Belső kör hiba:', err.message || err));
        setTimeout(tick, 15000).unref();
        setInterval(tick, intervalMs).unref();
    }

    return { runNotifications };
}

module.exports = { registerNotificationRoutes, DIGEST_TIME_PATTERN, NOTIFICATION_KINDS };
