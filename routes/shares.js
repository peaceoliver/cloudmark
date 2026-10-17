/**
 * Megosztás más felhasználókkal: egy elem (jegyzet, feladat, parancs, minden későbbi `items` típus és könyvjelző) megosztása
 * e-mail cím vagy ismerős alapján, megtekintési vagy szerkesztési joggal. A címzett a csengőben fogadja el
 * (attól a feladótól, akinek már elfogadott valamit, automatikusan bekerül). A jogosultság a share-access.js-ben dől el.
 */

const shareAccess = require('./share-access');

const TYPE_LABELS = { note: 'jegyzet', task: 'feladat', command: 'parancs', bookmark: 'könyvjelző' };
const TYPE_ACCUSATIVE = { note: 'egy jegyzetet', task: 'egy feladatot', command: 'egy parancsot', bookmark: 'egy könyvjelzőt' };
const MAX_SHARES_PER_ITEM = 50;

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** The title shown in notifications: the item's title or the start of its text. */
function itemLabel(item) {
    const text = String(item.title || item.body || item.url || '').replace(/\s+/g, ' ').trim();
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

/** The shared thing from a request: `{ column: 'item_id' | 'bookmark_id', id }`, or null. */
function parseTarget(source) {
    const bookmarkId = parseId(source?.bookmarkId);
    if (bookmarkId) return { column: 'bookmark_id', id: bookmarkId };
    const itemId = parseId(source?.itemId);
    return itemId ? { column: 'item_id', id: itemId } : null;
}

/** The target of a share row. */
function rowTarget(row) {
    return row.bookmark_id ? { column: 'bookmark_id', id: Number(row.bookmark_id) } : { column: 'item_id', id: Number(row.item_id) };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

/** The invitation e-mail for an address that has no account yet. */
function buildInviteEmail({ senderName, item, registerUrl }) {
    const what = TYPE_ACCUSATIVE[item.type] || 'egy elemet';
    const label = itemLabel(item);
    return {
        subject: `${senderName} megosztott veled ${what} a CloudMarkban`,
        text: `${senderName} megosztott veled ${what}: ${label}\n\nRegisztrálj ezzel az e-mail címmel, és az e-mail cím megerősítése után megjelenik a listádban:\n${registerUrl}\n\nHa nem ismered a feladót, hagyd figyelmen kívül ezt a levelet.`,
        html: `<p><strong>${escapeHtml(senderName)}</strong> megosztott veled ${what}: <strong>${escapeHtml(label)}</strong></p>`
            + `<p>Regisztrálj ezzel az e-mail címmel, és az e-mail cím megerősítése után megjelenik a listádban.</p>`
            + `<p><a href="${escapeHtml(registerUrl)}">Regisztráció a CloudMarkba</a></p>`
            + `<p style="color:#64748b;font-size:12px">Ha nem ismered a feladót, hagyd figyelmen kívül ezt a levelet.</p>`
    };
}

function registerShareRoutes(app, { pool, requireAuth, recordAuditEvent, push, shareLimiter, loadItem, getMailer, getPublicBaseUrl }) {
    async function listShares(target) {
        const result = await pool.query(
            `SELECT s.*, u.username FROM shares s LEFT JOIN users u ON u.id = s.recipient_user_id
             WHERE s.${target.column} = $1 AND s.status <> 'declined' ORDER BY s.created_at, s.id`,
            [target.id]
        );
        return result.rows.map(presentShare);
    }

    /** What `user` may do with the target: { access: 'owner' | 'edit' | 'view', ownerUserId, shareId, direct } or null. */
    async function targetAccess(target, user) {
        if (target.column === 'item_id') {
            const access = await shareAccess.itemAccess(pool, target.id, user.id);
            return access && { access: access.access, ownerUserId: access.owner_user_id, shareId: access.share_id, direct: access.direct };
        }
        const access = await shareAccess.bookmarkAccess(pool, target.id, user);
        if (!access) return null;
        // Az admin mindent lát, de csak a saját könyvjelzőjét oszthatja meg.
        if (access.access === 'owner' && !shareAccess.ownsBookmark(access, user)) return { access: 'admin' };
        if (access.access === 'owner') return { access: 'owner', ownerUserId: user.id };
        const owner = await pool.query('SELECT owner_user_id FROM shares WHERE id = $1', [access.share_id]);
        return { access: access.access, ownerUserId: owner.rows[0]?.owner_user_id, shareId: access.share_id, direct: true };
    }

    /** Title, body and type of the shared thing for notifications and e-mails. */
    async function targetInfo(target) {
        if (target.column === 'bookmark_id') {
            const row = (await pool.query('SELECT title, url FROM bookmarks WHERE id = $1', [target.id])).rows[0];
            return row && { type: 'bookmark', title: row.title, url: row.url };
        }
        return (await pool.query('SELECT type, title, body FROM items WHERE id = $1', [target.id])).rows[0];
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

    /**
     * Sends the registration invitation to an address without an account. One invitation per address a day,
     * whoever shares, so the share button cannot be used to flood someone's inbox.
     */
    async function inviteByEmail(email, sender, target, req) {
        const recent = await pool.query(
            "SELECT COUNT(*)::int AS count FROM shares WHERE recipient_email = $1 AND recipient_user_id IS NULL AND created_at > NOW() - INTERVAL '1 day'",
            [email]
        );
        if (recent.rows[0].count > 1) return false;
        const mailer = getMailer ? await getMailer() : null;
        if (!mailer) return false;
        const item = await targetInfo(target);
        if (!item) return false;
        const registerUrl = `${getPublicBaseUrl(req)}/?register=1&email=${encodeURIComponent(email)}`;
        await mailer({ to: email, ...buildInviteEmail({ senderName: sender.username, item, registerUrl }) });
        return true;
    }

    /**
     * After a user confirms their e-mail address: invitations sent to that address before they had an account
     * become ordinary pending shares, with a bell notification to accept them.
     */
    async function claimPendingShares(user) {
        const email = shareAccess.normalizeEmail(user?.email);
        if (!email) return 0;
        const claimed = await pool.query(
            `UPDATE shares SET recipient_user_id = $1
             WHERE recipient_user_id IS NULL AND status = 'pending' AND recipient_email = $2 AND owner_user_id <> $1
             RETURNING *`,
            [user.id, email]
        );
        for (const share of claimed.rows) {
            const [owner, item] = await Promise.all([
                pool.query('SELECT username FROM users WHERE id = $1', [share.owner_user_id]),
                targetInfo(rowTarget(share))
            ]);
            if (!item) continue;
            await notifyUser(user.id, {
                kind: 'share_invite',
                title: `${owner.rows[0]?.username || 'Valaki'} megosztott veled ${TYPE_ACCUSATIVE[item.type] || 'egy elemet'}`,
                body: `${itemLabel(item)} · Fogadd el, és megjelenik a listádban.${share.permission === 'edit' ? ' Szerkesztheted is.' : ''}`,
                shareId: share.id
            });
        }
        return claimed.rowCount;
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
        const target = parseTarget(req.query);
        if (!target) return res.status(400).json({ error: 'Hiányzó elem azonosító.' });
        try {
            const access = await targetAccess(target, req.user);
            if (!access) return res.status(404).json({ error: 'Not found' });
            if (access.access === 'admin') return res.status(403).json({ error: 'Csak a tulajdonos oszthatja meg ezt az elemet.' });
            if (access.access === 'owner') return res.json({ access: 'owner', shares: await listShares(target) });
            const owner = await pool.query('SELECT username FROM users WHERE id = $1', [access.ownerUserId]);
            res.json({ access: access.access, sharedBy: owner.rows[0]?.username || null, shareId: access.direct ? Number(access.shareId) : null, viaParent: !access.direct });
        } catch (err) {
            res.status(500).json({ error: 'A megosztások betöltése nem sikerült.' });
        }
    });

    /**
     * Shares an item by e-mail address (or with a contact, `contactUserId`). The answer is the same whether
     * the address has an account or not, so the endpoint cannot be used to find out who is registered.
     */
    app.post('/api/shares', requireAuth, shareLimiter, async (req, res) => {
        const target = parseTarget(req.body);
        const permission = shareAccess.normalizePermission(req.body?.permission || 'view');
        if (!target) return res.status(400).json({ error: 'Hiányzó elem azonosító.' });
        if (!permission) return res.status(400).json({ error: 'Érvénytelen jogosultság.' });
        try {
            const access = await targetAccess(target, req.user);
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

            const count = await pool.query(`SELECT COUNT(*)::int AS count FROM shares WHERE ${target.column} = $1 AND status <> 'declined'`, [target.id]);
            const existing = await pool.query(`SELECT * FROM shares WHERE ${target.column} = $1 AND recipient_email = $2`, [target.id, email]);
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
                        `UPDATE shares SET permission = $2, status = $3::varchar, recipient_user_id = $4, accepted_at = CASE WHEN $3::varchar = 'accepted' THEN NOW() END, created_at = NOW()
                         WHERE id = $1 RETURNING *`,
                        [share.id, permission, status, recipient?.id || null]
                    )).rows[0]
                    : (await pool.query(
                        `INSERT INTO shares (owner_user_id, ${target.column}, recipient_user_id, recipient_email, permission, status, accepted_at)
                         VALUES ($1, $2, $3, $4, $5, $6::varchar, CASE WHEN $6::varchar = 'accepted' THEN NOW() END) RETURNING *`,
                        [req.user.id, target.id, recipient?.id || null, email, permission, status]
                    )).rows[0];
                if (recipient) notifyKind = autoAccept ? 'share_info' : 'share_invite';
                else if (!existing.rowCount) inviteByEmail(email, req.user, target, req).catch(err => console.error('[SHARE] Meghívó e-mail sikertelen:', err.message || err));
            }

            if (recipient) {
                await upsertContact(req.user.id, recipient.id);
                if (notifyKind) {
                    const item = await targetInfo(target);
                    await notifyUser(recipient.id, {
                        kind: notifyKind,
                        title: `${req.user.username} megosztott veled ${TYPE_ACCUSATIVE[item.type] || 'egy elemet'}`,
                        body: `${itemLabel(item)} · ${notifyKind === 'share_invite' ? 'Fogadd el, és megjelenik a listádban.' : 'Már ott van a listádban.'}`
                            + (permission === 'edit' ? ' Szerkesztheted is.' : ''),
                        shareId: share.id
                    });
                }
            }
            await recordAuditEvent({ userId: req.user.id, action: 'share_created', entityType: 'share', entityId: share.id, details: { [target.column === 'item_id' ? 'itemId' : 'bookmarkId']: target.id, permission }, req });
            res.status(201).json({ success: true, message: 'Megosztás elküldve.', shares: await listShares(target) });
        } catch (err) {
            console.error('[SHARE] Megosztás sikertelen:', err.message || err);
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
            const result = await pool.query('UPDATE shares SET permission = $3 WHERE id = $1 AND owner_user_id = $2 RETURNING item_id, bookmark_id', [id, req.user.id, permission]);
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            await recordAuditEvent({ userId: req.user.id, action: 'share_updated', entityType: 'share', entityId: id, details: { permission }, req });
            res.json({ success: true, shares: await listShares(rowTarget(result.rows[0])) });
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
                'DELETE FROM shares WHERE id = $1 AND (owner_user_id = $2 OR recipient_user_id = $2) RETURNING owner_user_id, item_id, bookmark_id',
                [id, req.user.id]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
            const byOwner = String(result.rows[0].owner_user_id) === String(req.user.id);
            await recordAuditEvent({ userId: req.user.id, action: byOwner ? 'share_revoked' : 'share_left', entityType: 'share', entityId: id, details: { itemId: result.rows[0].item_id, bookmarkId: result.rows[0].bookmark_id }, req });
            res.json({ success: true, shares: byOwner ? await listShares(rowTarget(result.rows[0])) : [] });
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
                const item = await targetInfo(rowTarget(share));
                if (item) {
                    await notifyUser(share.owner_user_id, {
                        kind: 'share_info',
                        title: `${req.user.username} elfogadta a megosztást`,
                        body: itemLabel(item),
                        shareId: share.id
                    });
                }
                await recordAuditEvent({ userId: req.user.id, action: 'share_accepted', entityType: 'share', entityId: id, details: { itemId: share.item_id, bookmarkId: share.bookmark_id }, req });
            }
            if (share.bookmark_id) return res.json({ success: true, bookmarkId: Number(share.bookmark_id) });
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
                "UPDATE shares SET status = 'declined' WHERE id = $1 AND recipient_user_id = $2 AND status = 'pending' RETURNING item_id, bookmark_id",
                [id, req.user.id]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'A megosztás már nem érvényes.' });
            await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE share_id = $1 AND user_id = $2', [id, req.user.id]);
            await recordAuditEvent({ userId: req.user.id, action: 'share_declined', entityType: 'share', entityId: id, details: { itemId: result.rows[0].item_id, bookmarkId: result.rows[0].bookmark_id }, req });
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

    /** Turns automatic accepting of a contact's shares on or off. */
    app.patch('/api/contacts/:userId', requireAuth, async (req, res) => {
        const contactUserId = parseId(req.params.userId);
        if (!contactUserId) return res.status(404).json({ error: 'Not found' });
        if (typeof req.body?.autoAccept !== 'boolean') return res.status(400).json({ error: 'Hiányzó beállítás.' });
        try {
            const result = await pool.query(
                'UPDATE contacts SET auto_accept = $3 WHERE user_id = $1 AND contact_user_id = $2',
                [req.user.id, contactUserId, req.body.autoAccept]
            );
            if (!result.rowCount) return res.status(404).json({ error: 'Az ismerős nem található.' });
            await recordAuditEvent({ userId: req.user.id, action: 'contact_updated', entityType: 'user', entityId: contactUserId, details: { autoAccept: req.body.autoAccept }, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'A mentés nem sikerült.' });
        }
    });

    /** Removes someone from the contacts list; their next share has to be accepted again. Existing shares stay. */
    app.delete('/api/contacts/:userId', requireAuth, async (req, res) => {
        const contactUserId = parseId(req.params.userId);
        if (!contactUserId) return res.status(404).json({ error: 'Not found' });
        try {
            const result = await pool.query('DELETE FROM contacts WHERE user_id = $1 AND contact_user_id = $2', [req.user.id, contactUserId]);
            if (!result.rowCount) return res.status(404).json({ error: 'Az ismerős nem található.' });
            await recordAuditEvent({ userId: req.user.id, action: 'contact_removed', entityType: 'user', entityId: contactUserId, req });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'A törlés nem sikerült.' });
        }
    });

    return { claimPendingShares };
}

module.exports = { registerShareRoutes, presentShare, itemLabel, buildInviteEmail, parseTarget, TYPE_LABELS };
