/**
 * Fiókok széfje: a böngészőben titkosított széfkulcs tárolása és a fiókok titkainak lekérése.
 * A szerver soha nem látja a mesterjelszót, a széfkulcsot vagy a titkosítatlan jelszavakat: csak
 * base64 blobokat tárol. A titkosítás a public/js/vault.js-ben van.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const shareAccess = require('./share-access');

const KDFS = ['pbkdf2-sha256'];
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function base64Field(value, max) {
    return typeof value === 'string' && value.length <= max && BASE64.test(value) ? value : null;
}

/** SHA-256 hex of the browser's vault token (see vault.js authToken). */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time check of a vault token against the stored hash. */
function tokenMatches(token, keyCheck) {
    if (typeof token !== 'string' || !token || typeof keyCheck !== 'string') return false;
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(keyCheck, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Validates the wrapping sent by the browser. The recovery wrapping is optional as a whole.
 * Returns { value } or { error }.
 */
function normalizeVaultInput(body = {}) {
    const kdf = KDFS.includes(body.kdf) ? body.kdf : null;
    if (!kdf) return { error: 'Nem támogatott kulcsszármaztatás.' };
    const iterations = Number(body.iterations);
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return { error: 'Érvénytelen körszám.' };
    const salt = base64Field(body.salt, 64);
    const wrappedKey = base64Field(body.wrappedKey, 200);
    const wrappedIv = base64Field(body.wrappedIv, 32);
    if (!salt || !wrappedKey || !wrappedIv) return { error: 'Hiányzó vagy érvénytelen széfkulcs.' };
    const value = { kdf, iterations, salt, wrappedKey, wrappedIv, recoverySalt: null, recoveryWrappedKey: null, recoveryWrappedIv: null };
    if (body.recoveryWrappedKey !== undefined && body.recoveryWrappedKey !== null) {
        value.recoverySalt = base64Field(body.recoverySalt, 64);
        value.recoveryWrappedKey = base64Field(body.recoveryWrappedKey, 200);
        value.recoveryWrappedIv = base64Field(body.recoveryWrappedIv, 32);
        if (!value.recoverySalt || !value.recoveryWrappedKey || !value.recoveryWrappedIv) return { error: 'Érvénytelen helyreállító kulcs.' };
    }
    return { value };
}

function presentVault(row) {
    if (!row) return { exists: false };
    return {
        exists: true,
        kdf: row.kdf,
        iterations: row.kdf_iterations,
        salt: row.salt,
        wrappedKey: row.wrapped_key,
        wrappedIv: row.wrapped_iv,
        recovery: row.recovery_wrapped_key ? { salt: row.recovery_salt, wrappedKey: row.recovery_wrapped_key, wrappedIv: row.recovery_wrapped_iv } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function registerVaultRoutes(app, { pool, requireAuth, recordAuditEvent, passwordLimiter }) {
    async function loadVault(userId) {
        return (await pool.query('SELECT * FROM user_vaults WHERE user_id = $1', [userId])).rows[0] || null;
    }

    /** The user's wrapped vault key (or { exists: false }); unwrapping happens in the browser. */
    app.get('/api/vault', requireAuth, async (req, res) => {
        try {
            res.json(presentVault(await loadVault(req.user.id)));
        } catch (err) {
            res.status(500).json({ error: 'A széf betöltése nem sikerült.' });
        }
    });

    /** Creates the vault once: the wrapped key and the hash of the browser's vault token. */
    app.post('/api/vault', requireAuth, async (req, res) => {
        const { value, error } = normalizeVaultInput(req.body);
        if (error) return res.status(400).json({ error });
        const token = typeof req.body?.authToken === 'string' ? req.body.authToken : '';
        if (token.length < 20 || token.length > 200) return res.status(400).json({ error: 'Hiányzó széf azonosító.' });
        try {
            const inserted = await pool.query(
                `INSERT INTO user_vaults (user_id, kdf, kdf_iterations, salt, wrapped_key, wrapped_iv, recovery_salt, recovery_wrapped_key, recovery_wrapped_iv, key_check)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (user_id) DO NOTHING RETURNING *`,
                [req.user.id, value.kdf, value.iterations, value.salt, value.wrappedKey, value.wrappedIv,
                    value.recoverySalt, value.recoveryWrappedKey, value.recoveryWrappedIv, hashToken(token)]
            );
            if (!inserted.rowCount) return res.status(409).json({ error: 'Már van széfed. Frissítsd az oldalt.' });
            await recordAuditEvent({ userId: req.user.id, action: 'vault_created', entityType: 'vault', details: { recovery: Boolean(value.recoveryWrappedKey) }, req });
            res.status(201).json(presentVault(inserted.rows[0]));
        } catch (err) {
            res.status(500).json({ error: 'A széf létrehozása nem sikerült.' });
        }
    });

    /**
     * Replaces the wrapping (new master password, or a new recovery key). Only a browser that has
     * unlocked the vault knows the token, so a stolen session cannot lock the owner out.
     */
    app.put('/api/vault', requireAuth, async (req, res) => {
        const { value, error } = normalizeVaultInput(req.body);
        if (error) return res.status(400).json({ error });
        try {
            const vault = await loadVault(req.user.id);
            if (!vault) return res.status(404).json({ error: 'Még nincs széfed.' });
            if (!tokenMatches(req.body?.authToken, vault.key_check)) return res.status(403).json({ error: 'A széf nincs feloldva ezen az eszközön.' });
            // A helyreállító kulcs marad, ha a kérés nem küld újat.
            const keepRecovery = req.body.recoveryWrappedKey === undefined;
            const updated = await pool.query(
                `UPDATE user_vaults SET kdf = $2, kdf_iterations = $3, salt = $4, wrapped_key = $5, wrapped_iv = $6,
                        recovery_salt = CASE WHEN $10 THEN recovery_salt ELSE $7 END,
                        recovery_wrapped_key = CASE WHEN $10 THEN recovery_wrapped_key ELSE $8 END,
                        recovery_wrapped_iv = CASE WHEN $10 THEN recovery_wrapped_iv ELSE $9 END,
                        updated_at = NOW()
                 WHERE user_id = $1 RETURNING *`,
                [req.user.id, value.kdf, value.iterations, value.salt, value.wrappedKey, value.wrappedIv,
                    value.recoverySalt, value.recoveryWrappedKey, value.recoveryWrappedIv, keepRecovery]
            );
            await recordAuditEvent({ userId: req.user.id, action: keepRecovery ? 'vault_password_changed' : 'vault_recovery_changed', entityType: 'vault', req });
            res.json(presentVault(updated.rows[0]));
        } catch (err) {
            res.status(500).json({ error: 'A széf módosítása nem sikerült.' });
        }
    });

    /**
     * Deletes the vault and every stored account password (the accounts themselves stay), for when both the
     * master password and the recovery key are lost. Needs the login password, since it cannot be undone.
     */
    app.delete('/api/vault', passwordLimiter, requireAuth, async (req, res) => {
        try {
            const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
            const valid = user.rows[0] && await bcrypt.compare(String(req.body?.password || ''), user.rows[0].password_hash);
            if (!valid) return res.status(401).json({ error: 'A belépési jelszó hibás.' });
            const removed = await pool.query(
                `DELETE FROM item_secrets s USING items i WHERE i.id = s.item_id AND i.owner_user_id = $1`,
                [req.user.id]
            );
            await pool.query('DELETE FROM user_vaults WHERE user_id = $1', [req.user.id]);
            await recordAuditEvent({ userId: req.user.id, action: 'vault_deleted', entityType: 'vault', details: { secrets: removed.rowCount }, req });
            res.json({ success: true, removed: removed.rowCount });
        } catch (err) {
            res.status(500).json({ error: 'A széf törlése nem sikerült.' });
        }
    });

    /** The encrypted secret of one of the user's accounts ({ secret: null } when it has none). */
    app.get('/api/items/:id/secret', requireAuth, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Not found' });
        try {
            const access = await shareAccess.itemAccess(pool, id, req.user.id);
            if (!access || access.access !== 'owner' || access.type !== 'account') return res.status(404).json({ error: 'Not found' });
            const row = (await pool.query('SELECT ciphertext, iv FROM item_secrets WHERE item_id = $1', [id])).rows[0];
            res.set('Cache-Control', 'no-store');
            res.json({ secret: row ? { ciphertext: row.ciphertext, iv: row.iv } : null });
        } catch (err) {
            res.status(500).json({ error: 'A titkos adat betöltése nem sikerült.' });
        }
    });
}

module.exports = { registerVaultRoutes, normalizeVaultInput, hashToken, tokenMatches, presentVault };
