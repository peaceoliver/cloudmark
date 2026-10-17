/**
 * Értesítések: feladat-emlékeztetők és napi összefoglaló kiküldése (felületen belül, push és e-mail),
 * a csengő API-ja, a „Kész”/„Szundi” gombok végpontja, és a belső futtató végpont, amit a Supabase pg_cron hív percenként.
 *
 * A Render free példány tétlenül elalszik, ezért az időzítés az adatbázisban fut (pg_cron + pg_net):
 * csak akkor hívja a /api/internal/notifications/run végpontot, ha notification_work_pending() igaz.
 * Amíg a szerver ébren van, egy percenkénti belső kör is lefut, így semmi nem marad ki.
 */

const crypto = require('crypto');
const taskDates = require('../public/js/task-parser');

const NOTIFICATION_KINDS = ['task_reminder', 'daily_digest', 'test', 'share_invite', 'share_info'];
const STALE_REMINDER_MS = 12 * 3600 * 1000;
const TEST_COOLDOWN_MS = 30 * 1000;
const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const QUIET_HOURS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const ACTION_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const ACTION_LABELS = { done: 'Kész', snooze: 'Szundi 10 perc' };

/** Whether `date` falls into the „HH:MM-HH:MM” quiet period in the given time zone (it may wrap past midnight). */
function inQuietHours(quietHours, timeZone, date = new Date()) {
    if (!QUIET_HOURS_PATTERN.test(String(quietHours || ''))) return false;
    const [start, end] = quietHours.split('-');
    if (start === end) return false;
    const now = taskDates.localTime(date, timeZone);
    return start < end ? now >= start && now < end : now >= start || now < end;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

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

/** Small HTML page for the e-mail action links (confirm and result). */
function actionPage(title, inner) {
    return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} – CloudMark</title><link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f19;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px;box-sizing:border-box;text-align:center}
main{max-width:380px}h1{font-size:1.25rem;margin:12px 0 8px}p{opacity:.8;line-height:1.5;margin:0 0 20px}
button,a.btn{display:inline-block;margin:4px;padding:11px 20px;border-radius:10px;border:0;background:#0284c7;color:#fff;font:600 1rem system-ui,sans-serif;text-decoration:none;cursor:pointer}
button.secondary{background:#334155}img{width:64px;height:64px}</style></head>
<body><main><img src="/icons/icon-192.png" alt="">${inner}</main></body></html>`;
}

/** Shared HTML frame for notification e-mails. */
function emailLayout(title, inner, appUrl, actionsHtml = '') {
    return `<!doctype html><html lang="hu"><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
<div style="font-weight:700;color:#0284c7;font-size:18px;margin-bottom:16px;">CloudMark</div>
<h1 style="font-size:18px;margin:0 0 12px;">${esc(title)}</h1>
${inner}
${actionsHtml}
<p style="margin:24px 0 0;"><a href="${esc(appUrl)}/#/feladatok" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Feladatok megnyitása</a></p>
<p style="margin:20px 0 0;font-size:12px;color:#64748b;">Az értesítéseket a CloudMark csengő ikonjánál kapcsolhatod ki.</p>
</div></body></html>`;
}

function registerNotificationRoutes(app, { pool, requireAuth, recordAuditEvent, getMailer, getPublicBaseUrl, push, taskActions }) {
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

    /** A single-use token for the „Kész” and „Szundi” buttons of one reminder (push and e-mail share it). */
    async function createActionToken(userId, itemId) {
        const token = crypto.randomBytes(24).toString('base64url');
        await pool.query(
            'INSERT INTO notification_action_tokens (token_hash, user_id, item_id, expires_at) VALUES ($1, $2, $3, $4)',
            [hashToken(token), userId, itemId, new Date(Date.now() + ACTION_TOKEN_TTL_MS)]
        );
        return token;
    }

    /** Sends a push to the user's devices unless they are in their quiet hours. */
    async function pushToUser(user, payload, summary, options) {
        if (!push?.configured || inQuietHours(user.quiet_hours, user.timezone)) return null;
        try {
            const result = await push.sendToUser(user.id, payload, options);
            summary.pushes += result.sent;
            summary.errors += result.failed;
            return result;
        } catch (err) {
            summary.errors += 1;
            console.error('[NOTIFY] Push küldése sikertelen:', err.message || err);
            return null;
        }
    }

    /** Whether the user can get e-mail: a verified address and e-mails not switched off. */
    function emailAllowed(user) {
        return Boolean(user.email) && user.is_verified === true && String(user.notify_email ?? 'true') !== 'false';
    }

    async function loadUsers(db, userIds) {
        const result = await db.query(
            `SELECT u.id, u.username, u.email, u.is_verified,
                    (SELECT value #>> '{}' FROM settings_user WHERE user_id = u.id AND setting_key = 'notifyEmail') AS notify_email,
                    (SELECT value #>> '{}' FROM settings_user WHERE user_id = u.id AND setting_key = 'timezone') AS timezone,
                    (SELECT value #>> '{}' FROM settings_user WHERE user_id = u.id AND setting_key = 'quietHours') AS quiet_hours
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
            const notificationId = await insertNotification(pool, { userId: user.id, kind: 'task_reminder', title: item.title, body, itemId: item.id });
            summary.reminders += 1;
            const wantsPush = reminder.channels.includes('push') && push?.configured;
            const wantsEmail = reminder.channels.includes('email') && emailAllowed(user);
            const actionToken = wantsPush || (wantsEmail && taskActions) ? await createActionToken(user.id, item.id) : null;

            if (wantsPush) {
                await pushToUser(user, {
                    type: 'task_reminder', title: item.title, body: body || 'Emlékeztető', itemId: Number(item.id),
                    notificationId: Number(notificationId), actionToken, tag: `task-${item.id}`
                }, summary);
            }

            if (!wantsEmail) continue;
            if (!mailer) { await pool.query("UPDATE item_reminders SET last_error = 'email_not_configured' WHERE id = $1", [reminder.id]); continue; }
            try {
                const recurrence = item.recurrence_rule ? taskDates.describeRecurrence(item.recurrence_rule) : '';
                const actionUrl = action => `${appUrl}/api/notifications/action?token=${encodeURIComponent(actionToken)}&action=${action}`;
                const actionsHtml = actionToken ? `<p style="margin:20px 0 0;">
                    <a href="${esc(actionUrl('done'))}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;margin-right:8px;">✓ Kész</a>
                    <a href="${esc(actionUrl('snooze'))}" style="display:inline-block;background:#e2e8f0;color:#0f172a;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;">Szundi 10 perc</a></p>` : '';
                await mailer({
                    to: user.email,
                    subject: `Emlékeztető: ${item.title}`,
                    text: `${item.title}\n${body || ''}${recurrence ? `\nIsmétlődik: ${recurrence}` : ''}\n\n`
                        + (actionToken ? `Kész: ${actionUrl('done')}\nSzundi 10 perc: ${actionUrl('snooze')}\n\n` : '')
                        + `${appUrl}/#/feladatok`,
                    html: emailLayout(`Emlékeztető: ${item.title}`, `
                        ${due ? `<p style="margin:0 0 6px;"><strong>Határidő:</strong> ${esc(due)}</p>` : ''}
                        ${recurrence ? `<p style="margin:0;color:#64748b;">Ismétlődik: ${esc(recurrence)}</p>` : ''}`, appUrl, actionsHtml)
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
            await pushToUser(user, { type: 'daily_digest', title: 'Napi összefoglaló', body: `${counts} feladat`, tag: 'daily-digest' }, summary, { urgency: 'normal' });
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
            const summary = { reminders: 0, digests: 0, pushes: 0, emails: 0, errors: 0 };
            const mailer = await getMailer().catch(() => null);
            await sendDueReminders(mailer, appUrl, summary);
            await sendDailyDigests(mailer, appUrl, summary);
            await pool.query("DELETE FROM notification_action_tokens WHERE expires_at < NOW() - INTERVAL '1 day'");
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
                    // Megosztásnál: a meghívó állapota (függő meghívónál Elfogadom / Elutasítom), és az elem típusa a megnyitáshoz.
                    `SELECT n.id, n.kind, n.title, n.body, n.item_id, n.created_at, n.read_at,
                            n.share_id, s.status AS share_status, s.item_id AS share_item_id, si.type AS share_item_type,
                            (s.recipient_user_id = n.user_id) AS share_incoming
                     FROM notifications n
                     LEFT JOIN shares s ON s.id = n.share_id
                     LEFT JOIN items si ON si.id = s.item_id
                     WHERE n.user_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
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
                quietHours: QUIET_HOURS_PATTERN.test(user?.quiet_hours || '') ? user.quiet_hours : null,
                pushConfigured: Boolean(push?.configured),
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
            let pushResult = { sent: 0, failed: 0, removed: 0 };
            if (push?.configured) {
                // A teszt a csendes időszakot figyelmen kívül hagyja, hogy azonnal kipróbálható legyen.
                pushResult = await push.sendToUser(req.user.id, { type: 'test', title: 'Teszt értesítés', body: 'Így fognak megjelenni az emlékeztetők.', tag: 'test' })
                    .catch(() => ({ sent: 0, failed: 1, removed: 0 }));
            }
            const pushStatus = !push?.configured ? 'not_configured' : pushResult.sent ? 'sent' : pushResult.failed ? 'error' : 'no_devices';
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
                    return res.json({ inApp: true, email, push: pushStatus, pushDevices: pushResult.sent, error: String(err.message || err) });
                }
            }
            res.json({ inApp: true, email, push: pushStatus, pushDevices: pushResult.sent });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Uses a „Kész”/„Szundi” token once. Returns { status, title } where status is done/snoozed/invalid/gone. */
    async function performAction(token, action) {
        if (!taskActions || typeof token !== 'string' || !ACTION_LABELS[action]) return { status: 'invalid' };
        const claimed = await pool.query(
            `UPDATE notification_action_tokens SET used_at = NOW()
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
             RETURNING user_id, item_id`,
            [hashToken(token)]
        );
        const row = claimed.rows[0];
        if (!row) return { status: 'invalid' };
        if (action === 'done') {
            const outcome = await taskActions.completeTask(row.user_id, Number(row.item_id));
            return outcome ? { status: 'done', title: outcome.title, recurring: outcome.recurring } : { status: 'gone' };
        }
        const snoozed = await taskActions.snoozeTask(row.user_id, Number(row.item_id));
        const item = await pool.query('SELECT title FROM items WHERE id = $1', [row.item_id]);
        return snoozed ? { status: 'snoozed', title: item.rows[0]?.title } : { status: 'gone' };
    }

    function actionResultPage(result, appUrl) {
        const open = `<a class="btn" href="${esc(appUrl)}/#/feladatok">CloudMark megnyitása</a>`;
        if (result.status === 'done') return actionPage('Kész', `<h1>Kész ✓</h1><p>${esc(result.title)}${result.recurring ? ' – a következő alkalomra ugrott.' : ''}</p>${open}`);
        if (result.status === 'snoozed') return actionPage('Szundi', `<h1>10 perc múlva újra szólok</h1><p>${esc(result.title)}</p>${open}`);
        if (result.status === 'gone') return actionPage('Nem található', `<h1>A feladat már nem aktív</h1><p>Lehet, hogy közben kész lett vagy törölted.</p>${open}`);
        return actionPage('Lejárt link', `<h1>Ez a link már nem érvényes</h1><p>A gombok egyszer használhatók, és 7 napig érvényesek.</p>${open}`);
    }

    /**
     * „Kész” / „Szundi” from a push notification (JSON, from the service worker) or from an e-mail (form post).
     * The token is the authorization, so it works without being signed in.
     */
    app.post('/api/notifications/action', async (req, res) => {
        const wantsHtml = req.is('application/x-www-form-urlencoded');
        try {
            const result = await performAction(req.body?.token, req.body?.action);
            if (wantsHtml) return res.status(result.status === 'invalid' ? 410 : 200).type('html').send(actionResultPage(result, getPublicBaseUrl(req)));
            if (result.status === 'invalid') return res.status(410).json({ error: 'A gomb már nem érvényes.', status: result.status });
            res.json(result);
        } catch (err) {
            console.error('[NOTIFY] Művelet sikertelen:', err.message || err);
            if (wantsHtml) return res.status(500).type('html').send(actionPage('Hiba', '<h1>Valami hiba történt</h1><p>Próbáld újra később, vagy nyisd meg a CloudMarkot.</p>'));
            res.status(500).json({ error: 'Action failed' });
        }
    });

    /**
     * The e-mail links land here. It only shows a confirm button that posts the form, because mail
     * scanners open links automatically and must not complete a task by doing so.
     */
    app.get('/api/notifications/action', (req, res) => {
        const action = ACTION_LABELS[req.query.action] ? req.query.action : 'done';
        const token = typeof req.query.token === 'string' ? req.query.token.slice(0, 200) : '';
        res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
        res.type('html').send(actionPage(ACTION_LABELS[action], `<h1>${action === 'done' ? 'Megjelölöd késznek?' : 'Szóljak 10 perc múlva újra?'}</h1>
            <form method="post" action="/api/notifications/action">
              <input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="action" value="${action}">
              <button type="submit">${action === 'done' ? '✓ Kész' : 'Szundi 10 perc'}</button>
            </form>`));
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

module.exports = { registerNotificationRoutes, DIGEST_TIME_PATTERN, QUIET_HOURS_PATTERN, NOTIFICATION_KINDS, inQuietHours };
