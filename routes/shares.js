/**
 * Megosztás más felhasználókkal: egy elem (jegyzet, feladat, parancs, és minden későbbi `items` típus) megosztása
 * e-mail cím vagy ismerős alapján, megtekintési vagy szerkesztési joggal. A címzett a csengőben fogadja el
 * (attól a feladótól, akinek már elfogadott valamit, automatikusan bekerül). A jogosultság a share-access.js-ben dől el.
 */

const shareAccess = require('./share-access');

const TYPE_LABELS = { note: 'jegyzet', task: 'feladat', command: 'parancs' };
const TYPE_ACCUSATIVE = { note: 'egy jegyzetet', task: 'egy feladatot', command: 'egy parancsot' };
const MAX_SHARES_PER_ITEM = 50;

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** The title shown in notifications: the item's title or the start of its text. */
function itemLabel(item) {
    const text = String(item.title || item.body || '').replace(/\s+/g, ' ').trim();
    return text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : `Névtelen ${TYPE_LABELS[item.type] || 'elem'}`;
}

/** One share as the owner sees it in the Megosztás window; pending invitations look the same whether the address has an account or not. */
function presentShare(row) {
    return {
        id: Number(row.id),
        email: row.recipient_email,
        username: row.status === 'accepted' ? row.username || null : null,
        permission: row.permission,
        status: row.status === 'accepted' ? 'accepted' : 'pending',
        createdAt: row.created_at
    };
}

function registerShareRoutes(app, { pool, requireAuth, recordAuditEvent, push, shareLimiter, loadItem }) {
    async function listItemShares(itemId) {
        const result = await pool.query(
            `SELECT s.*, u.username FROM shares s LEFT JOIN users u ON u.id = s.recipient_user_id
             WHERE s.item_id = $1 AND s.status <> 'declined' ORDER BY s.created_at, s.id`,
            [itemId]
        );
        return result.rows.map(presentShare);
    }

    async function notifyUser(userId, { kind, title, body, shareId }) {
        const inserted = await pool.query(
            'INSERT INTO notifications (user_id, kind, title, body, share_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [userId, kind, title, body, shareId]
        );
        if (push?.configured) {
            push.sendToUser(userId, { type: kind, title, body, tag: `share-${shareId}`, notificationId: inserted.rows[0].id })
                .catch(err => console.error('[SHARE] Push küldése sikertelen:', err.message || err));
        }
    }

    async function upsertContact(userId, contactUserId, autoAccept = null) {
        if (String(userId) === String(contactUserId)) return;
        await pool.query(
            `INSERT INTO contacts (user_id, contact_user_id, auto_accept) VALUES ($1, $2, COALESCE($3, FALSE))
             ON CONFLICT (user_id, contact_user_id) DO UPDATE SET auto_accept = COALESCE($3, contacts.auto_accept)`,
            [userId, contactUserId, autoAccept]
        );
    }

    /** Who shares an item with whom, or (for a recipient) who shared it with them. */
    app.get('/api/shares', requireAuth, async (req, res) => {
        const itemId = parseId(req.query.itemId);
        if (!itemId) return res.status(400).json({ error: 'Hiányzó elem azonosító.' });
        try {
            const access = await shareAccess.itemAccess(pool, itemId, req.user.id);
            if (!access) return res.status(404).json({ error: 'Not found' });
            if (access.access === 'owner') return res.json({ access: 'owner', shares: await listItemShares(itemId) });
            const owner = await pool.query('SELECT username FROM users WHERE id = $1', [access.owner_user_id]);
            res.json({ access: access.access, sharedBy: owner.rows[0]?.username || null, shareId: access.direct ? Number(access.share_id) : null, viaParent: !access.direct });
        } catch (err) {
            res.status(500).json({ error: 'A megosztások betöltése nem sikerült.' });
        }
    });

    /**
     * Shares an item by e-mail address (or with a contact, `contactUserId`). The answer is the same whether
     * the address has an account or not, so the endpoint cannot be used to find out who is registered.
     */
    app.post('/api/shares', requireAuth, shareLimiter, async (req, res) => {
        const itemId = parseId(req.body?.itemId);
        const permission = shareAccess.normalizePermission(req.body?.permission || 'view');
        if (!itemId) return res.status(400).json({ error: 'Hiányzó elem azonosító.' });
        if (!permission) return res.status(400).json({ error: 'Érvénytelen jogosultság.' });
        try {
            const access = await shareAccess.itemAccess(pool, itemId, req.user.id);
            if (!access) return res.status(404).json({ error: 'Not found' });
            if (access.access !== 'owner') return res.status(403).json({ error: 'Csak a tulajdonos oszthatja meg ezt az elemet.' });

            let email = null;
            let recipient = null;
            const contactUserId = parseId(req.body?.contactUserId);
            if (contactUserId) {
                const contact = await pool.query(
                    `SELECT u.id, u.username, LOWER(u.email) AS email FROM contacts c JOIN users u ON u.id = c.contact_user_id
                     WHERE c.user_id = $1 AND c.contact_user_id = $2 AND u.is_active = TRUE AND u.email IS NOT NULL`,
                    [req.user.id, contactUserId]
                );
                if (!contact.rowCount) return res.status(404).json({ error: 'Az ismerős nem található.' });
                recipient = contact.rows[0];
                email = shareAccess.normalizeEmail(recipient.email);
            } else {
                email = shareAccess.normalizeEmail(req.body?.email);
                if (!email) return res.status(400).json({ error: 'Érvénytelen e-mail cím.' });
                const found = await pool.query(
                    `SELECT id, username FROM users
                     WHERE LOWER(email) = $1 AND is_active = TRUE AND is_verified = TRUE ORDER BY id LIMIT 1`,
                    [email]
                );
                recipient = found.rows[0] || null;
            }
            if (!email) return res.status(400).json({ error: 'Az ismerősnek nincs érvényes e-mail címe.' });
            if (email === String(req.user.email || '').trim().toLowerCase() || (recipient && String(recipient.id) === String(req.user.id))) {
                return res.status(400).json({ error: 'Saját magaddal nem oszthatod meg.' });
            }

            const count = await pool.query("SELECT COUNT(*)::int AS count FROM shares WHERE item_id = $1 AND status <> 'declined'", [itemId]);
            const existing = await pool.query('SELECT * FROM shares WHERE item_id = $1 AND recipient_email = $2', [itemId, email]);
            if (!existing.rowCount && count.rows[0].count >= MAX_SHARES_PER_ITEM) {
                return res.status(400).json({ error: `Egy elem legfeljebb ${MAX_SHARES_PER_ITEM} személlyel osztható meg.` });
            }

            const autoAccept = recipient ? (await pool.query(
                'SELECT auto_accept FROM contacts WHERE user_id = $1 AND contact_user_id = $2',
                [recipient.id, req.user.id]
            )).rows[0]?.auto_accept === true : false;

            let share = existing.rows[0];
            let notifyKind = null;
            // Elutasított, vagy regisztráció előtt küldött meghívó: újra meghívjuk.
            const reinvite = share && (share.status === 'declined' || (share.status === 'pending' && !share.recipient_user_id && recipient));
            if (share && !reinvite) {
                // Már megosztva vele: csak a jog változik.
                share = (await pool.query('UPDATE shares SET permission = $2 WHERE id = $1 RETURNING *', [share.id, permission])).rows[0];
            } else {
                const status = autoAccept ? 'accepted' : 'pending';
                share = share
                    ? (await pool.query(
                        `UPDATE shares SET permission = $2, status = $3, recipient_user_id = $4, accepted_at = CASE WHEN $3 = 'accepted' THEN NOW() END, created_at = NOW()
                         WHERE id = $1 RETURNING *`,
                        [share.id, permission, status, recipient?.id || null]
                    )).rows[0]
                    : (await pool.query(
                        `INSERT INTO shares (owner_user_id, item_id, recipient_user_id, recipient_email, permission, status, accepted_at)
                         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'accepted' THEN NOW() END) RETURNING *`,
                        [req.user.id, itemId, recipient?.id || null, email, permission, status]
                    )).rows[0];
                if (recipient) notifyKind = autoAccept ? 'share_info' : 'share_invite';
            }

            if (recipient) {
                await upsertContact(req.user.id, recipient.id);
                if (notifyKind) {
                    const item = (await pool.query('SELECT type, title, body FROM items WHERE id = $1', [itemId])).rows[0];
                    await notifyUser(recipient.id, {
                        kind: notifyKind,
                        title: `${req.user.username} megosztott veled ${TYPE_ACCUSATIVE[item.type] || 'egy elemet'}`,
                        body: `${itemLabel(item)} · ${notifyKind === 'share_invite' ? 'Fogadd el, és megjelenik a listádban.' : 'Már ott van a listádban.'}`
                            + (permission === 'edit' ? ' Szerkesztheted is.' : ''),
                        shareId: share.id
                    });
                }
            }
            await recordAuditEvent({ userId: req.user.id, action: 'share_created', entityType: 'share', entityId: share.id, details: { itemId, permission }, req });
            res.status(201).json({ success: true, message: 'Megosztás elküldve.', shares: await listItemShares(itemId) });
        } catch (err) {
            res.status(500).json({ error: 'A megosztás nem sikerült.' });
        }
    });

    /** The owner changes a recipient's permission. */
    app.patch('/api/shares/:id', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        const permission = shareAccess.normalizePermission(req.body?.permission);
        if (!id) return res.status(404).json({ error: 'Not found' });
        if (!permission) return res.status(400).json({ error: 'Érvénytelen jogosultság.' });
        try {
            const result = await pool.query('UPDATE shares SET permission = $3 WHERE id = $1 AND owner_user_id = $2 RETURNING item_id', [id, req.user.id, permission]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'share_updated', entityType: 'share', entityId: id, details: { permission }, req });
            res.json({ success: true, shares: await listItemShares(result.rows[0].item_id) });
        } catch (err) {
            res.status(500).json({ error: 'A módosítás nem sikerült.' });
        }
    });

    /** The owner revokes a share, or the recipient removes the item from their own list. */
    app.delete('/api/shares/:id', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query(
                'DELETE FROM shares WHERE id = $1 AND (owner_user_id = $2 OR recipient_user_id = $2) RETURNING owner_user_id, item_id',
                [id, req.user.id]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            const byOwner = String(result.rows[0].owner_user_id) === String(req.user.id);
            await recordAuditEvent({ userId: req.user.id, action: byOwner ? 'share_revoked' : 'share_left', entityType: 'share', entityId: id, details: { itemId: result.rows[0].item_id }, req });
            res.json({ success: true, shares: byOwner ? await listItemShares(result.rows[0].item_id) : [] });
        } catch (err) {
            res.status(500).json({ error: 'A megosztás törlése nem sikerült.' });
        }
    });

    /** The recipient accepts an invitation: the item appears in their list, and later shares from the same person need no accepting. */
    app.post('/api/shares/:id/accept', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query(
                `UPDATE shares SET status = 'accepted', accepted_at = NOW()
                 WHERE id = $1 AND recipient_user_id = $2 AND status = 'pending' RETURNING *`,
                [id, req.user.id]
            );
            const share = result.rows[0] || (await pool.query("SELECT * FROM shares WHERE id = $1 AND recipient_user_id = $2 AND status = 'accepted'", [id, req.user.id])).rows[0];
            if (!share) return res.status(404).json({ error: 'A megosztás már nem érvényes.' });
            await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE share_id = $1 AND user_id = $2', [id, req.user.id]);
            if (result.rowCount) {
                await upsertContact(req.user.id, share.owner_user_id, true);
                await upsertContact(share.owner_user_id, req.user.id);
                const item = (await pool.query('SELECT type, title, body FROM items WHERE id = $1', [share.item_id])).rows[0];
                if (item) {
                    await notifyUser(share.owner_user_id, {
                        kind: 'share_info',
                        title: `${req.user.username} elfogadta a megosztást`,
                        body: itemLabel(item),
                        shareId: share.id
                    });
                }
                await recordAuditEvent({ userId: req.user.id, action: 'share_accepted', entityType: 'share', entityId: id, details: { itemId: share.item_id }, req });
            }
            const item = await loadItem(pool, share.item_id, req.user.id);
            res.json({ success: true, item });
        } catch (err) {
            res.status(500).json({ error: 'Az elfogadás nem sikerült.' });
        }
    });

    /** The recipient declines; the owner is not told, and may share again later. */
    app.post('/api/shares/:id/decline', requireAuth, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query(
                "UPDATE shares SET status = 'declined' WHERE id = $1 AND recipient_user_id = $2 AND status = 'pending' RETURNING item_id",
                [id, req.user.id]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'A megosztás már nem érvényes.' });
            await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE share_id = $1 AND user_id = $2', [id, req.user.id]);
            await recordAuditEvent({ userId: req.user.id, action: 'share_declined', entityType: 'share', entityId: id, details: { itemId: result.rows[0].item_id }, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'Az elutasítás nem sikerült.' });
        }
    });

    /**
     * The user's contacts for the share window's suggestions. The e-mail address is only included for people
     * the user shared with themselves (they typed it); others are picked by their user id.
     */
    app.get('/api/contacts', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT u.id, u.username, c.auto_accept,
                        CASE WHEN EXISTS (SELECT 1 FROM shares s WHERE s.owner_user_id = $1 AND s.recipient_user_id = u.id) THEN LOWER(u.email) END AS email
                 FROM contacts c JOIN users u ON u.id = c.contact_user_id
                 WHERE c.user_id = $1 AND u.is_active = TRUE
                 ORDER BY LOWER(u.username)`,
                [req.user.id]
            );
            res.json(result.rows.map(row => ({ userId: Number(row.id), username: row.username, email: row.email || null, autoAccept: row.auto_accept })));
        } catch (err) {
            res.status(500).json({ error: 'Az ismerősök betöltése nem sikerült.' });
        }
    });
}

module.exports = { registerShareRoutes, presentShare, itemLabel, TYPE_LABELS };
