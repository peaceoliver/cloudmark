/**
 * Web Push: értesítés küldése a telefonra vagy a számítógépre akkor is, ha a CloudMark nincs megnyitva.
 * A kulcspár (VAPID) környezeti változókból jön; ha nincs beállítva, a push csatorna egyszerűen kikapcsolt.
 *
 * Végpontok: a nyilvános kulcs lekérése, és az eszközök fel- és leiratkozása (eszközönként egy sor).
 */

const webpush = require('web-push');

// Csak a böngészők valódi push szolgáltatásaira küldünk, így a szerver nem hívható rá tetszőleges címre.
const PUSH_HOST_PATTERNS = [
    /^fcm\.googleapis\.com$/,
    /^android\.googleapis\.com$/,
    /^updates\.push\.services\.mozilla\.com$/,
    /(^|\.)push\.services\.mozilla\.com$/,
    /(^|\.)push\.apple\.com$/,
    /(^|\.)notify\.windows\.com$/
];
const MAX_SUBSCRIPTIONS_PER_USER = 20;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

/** Whether `endpoint` is an https address of a known browser push service. */
function isAllowedEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    try {
        const url = new URL(endpoint);
        return url.protocol === 'https:' && !url.port && PUSH_HOST_PATTERNS.some(pattern => pattern.test(url.hostname));
    } catch (err) {
        return false;
    }
}

/** A short device name from the browser's user agent, e.g. „iPhone · Safari”. */
function describeDevice(userAgent = '') {
    const ua = String(userAgent);
    const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Eszköz';
    const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'böngésző';
    return `${device} · ${browser}`;
}

function createPushService({ pool, getSubject }) {
    const publicKey = process.env.VAPID_PUBLIC_KEY || '';
    const privateKey = process.env.VAPID_PRIVATE_KEY || '';
    const configured = Boolean(publicKey && privateKey);

    function vapidDetails() {
        return {
            subject: process.env.VAPID_SUBJECT || getSubject() || 'mailto:admin@example.com',
            publicKey,
            privateKey
        };
    }

    /**
     * Sends `payload` (an object, sent as JSON) to every device of the user.
     * Devices whose subscription has expired (404/410) are removed. Returns { sent, failed, removed }.
     */
    async function sendToUser(userId, payload, { ttl = 12 * 3600, urgency = 'high', topic } = {}) {
        const result = { sent: 0, failed: 0, removed: 0 };
        if (!configured) return result;
        const subscriptions = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
        const body = JSON.stringify(payload);
        await Promise.all(subscriptions.rows.map(async subscription => {
            try {
                await webpush.sendNotification(
                    { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
                    body,
                    { TTL: ttl, urgency, topic, vapidDetails: vapidDetails(), timeout: 10000 }
                );
                result.sent += 1;
                await pool.query('UPDATE push_subscriptions SET last_used_at = NOW(), last_error = NULL WHERE id = $1', [subscription.id]);
            } catch (err) {
                if (err.statusCode === 404 || err.statusCode === 410) {
                    result.removed += 1;
                    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
                } else {
                    result.failed += 1;
                    const message = `${err.statusCode || ''} ${err.body || err.message || err}`.trim().slice(0, 500);
                    await pool.query('UPDATE push_subscriptions SET last_error = $2 WHERE id = $1', [subscription.id, message]);
                }
            }
        }));
        return result;
    }

    return { configured, publicKey, sendToUser };
}

function registerPushRoutes(app, { pool, requireAuth, recordAuditEvent, push }) {
    app.get('/api/push/config', requireAuth, (req, res) => {
        res.json({ configured: push.configured, publicKey: push.configured ? push.publicKey : null });
    });

    app.get('/api/push/subscriptions', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, endpoint, device_label, created_at, last_used_at, last_error
                 FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
                [req.user.id]
            );
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Registers this device (or moves it to the signed-in user if it belonged to someone else). */
    app.post('/api/push/subscriptions', requireAuth, async (req, res) => {
        if (!push.configured) return res.status(503).json({ error: 'A push értesítés nincs beállítva a szerveren.' });
        const subscription = req.body?.subscription || {};
        const endpoint = subscription.endpoint;
        const p256dh = subscription.keys?.p256dh;
        const auth = subscription.keys?.auth;
        if (!isAllowedEndpoint(endpoint)) return res.status(400).json({ error: 'Ismeretlen push szolgáltatás.' });
        if (!KEY_PATTERN.test(String(p256dh || '')) || !KEY_PATTERN.test(String(auth || ''))) return res.status(400).json({ error: 'Érvénytelen feliratkozás.' });
        try {
            const count = await pool.query('SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id = $1 AND endpoint <> $2', [req.user.id, endpoint]);
            if (count.rows[0].count >= MAX_SUBSCRIPTIONS_PER_USER) return res.status(400).json({ error: `Legfeljebb ${MAX_SUBSCRIPTIONS_PER_USER} eszköz kaphat értesítést.` });
            const label = describeDevice(req.get('user-agent'));
            const result = await pool.query(
                `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                   device_label = EXCLUDED.device_label, last_error = NULL
                 RETURNING id, endpoint, device_label, created_at, last_used_at, last_error`,
                [req.user.id, endpoint, p256dh, auth, label]
            );
            await recordAuditEvent({ userId: req.user.id, action: 'push_subscribed', entityType: 'push_subscription', entityId: result.rows[0].id, details: { device: label }, req });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/push/subscriptions/:id', requireAuth, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING device_label', [id, req.user.id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'push_unsubscribed', entityType: 'push_subscription', entityId: id, details: { device: result.rows[0].device_label }, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { createPushService, registerPushRoutes, isAllowedEndpoint, describeDevice };
