/*
 * AI kitöltés saját API kulccsal: kulcsok kezelése (titkosítva tárolva, a böngésző soha nem kapja vissza)
 * és a POST /api/ai/fill, amely csak javaslatot ad vissza; menteni a felhasználó Mentés gombja ment.
 */
const rateLimit = require('express-rate-limit');
const { ACTIONS, MAX_INPUT_CHARS, encryptSecret, decryptSecret } = require('./ai-actions');
const taskDates = require('../public/js/task-parser');
const { publicHttpUrl } = require('./safe-fetch');
const { PROVIDERS, AiError, listModels, generate, pickDefaultModel, assertPublicBaseUrl, DEFAULT_OPENAI_BASE_URL } = require('./ai-providers');

const MAX_KEYS_PER_USER = 10;
const MODEL_PATTERN = /^[\w.:/@+-]{1,120}$/;

function encryptionSecret() {
    const secret = process.env.AI_KEY_ENCRYPTION_SECRET;
    return secret && secret.length >= 32 ? secret : null;
}

/** The row as the browser may see it: never the key itself, only its last four characters. */
function publicKey(row) {
    return {
        id: Number(row.id),
        provider: row.provider,
        providerLabel: PROVIDERS[row.provider]?.label || row.provider,
        baseUrl: row.provider === 'openai' ? (row.base_url || DEFAULT_OPENAI_BASE_URL) : null,
        label: row.label || '',
        model: row.model || '',
        last4: row.key_last4,
        isActive: Boolean(row.is_active),
        updatedAt: row.updated_at
    };
}

function registerAiRoutes(app, { pool, requireAuth, recordAuditEvent, fetchPageMetadata = async () => ({}) }) {
    const aiLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Túl sok AI kérés. Várj egy percet.' },
        keyGenerator: req => `ai:${req.user.id}`,
        validate: { trustProxy: false }
    });

    function requireSecret(req, res, next) {
        if (!encryptionSecret()) return res.status(503).json({ error: 'Az AI funkció a szerveren még nincs bekapcsolva.' });
        next();
    }

    async function loadKey(userId, id) {
        if (!/^\d+$/.test(String(id))) return null;
        const result = await pool.query('SELECT * FROM user_ai_keys WHERE id = $1 AND user_id = $2', [id, userId]);
        return result.rows[0] || null;
    }

    function credentialsOf(row) {
        let apiKey;
        try {
            apiKey = decryptSecret({ ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag }, encryptionSecret(), row.user_id);
        } catch (err) {
            throw new AiError(400, 'A mentett AI kulcs nem olvasható. Töröld, és add meg újra a Beállítások AI fülén.');
        }
        return { apiKey, baseUrl: row.base_url || null };
    }

    function sendError(res, err, fallback) {
        if (err instanceof AiError) return res.status(err.status).json({ error: err.message });
        console.error('[AI]', err.message);
        return res.status(500).json({ error: fallback });
    }

    /** Whether the server can use AI and which key is active (drives the AI buttons). */
    app.get('/api/ai/status', requireAuth, async (req, res) => {
        try {
            const enabled = Boolean(encryptionSecret());
            const result = enabled
                ? await pool.query('SELECT * FROM user_ai_keys WHERE user_id = $1 AND is_active LIMIT 1', [req.user.id])
                : { rows: [] };
            const active = result.rows[0];
            res.json({ enabled, active: active ? { provider: active.provider, providerLabel: PROVIDERS[active.provider].label, model: active.model } : null });
        } catch (err) {
            sendError(res, err, 'Az AI állapota nem tölthető be.');
        }
    });

    app.get('/api/ai/keys', requireAuth, requireSecret, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM user_ai_keys WHERE user_id = $1 ORDER BY created_at', [req.user.id]);
            res.json(result.rows.map(publicKey));
        } catch (err) {
            sendError(res, err, 'Az AI kulcsok nem tölthetők be.');
        }
    });

    /** Saves a new key after checking it against the provider's model list; the new key becomes the active one. */
    app.post('/api/ai/keys', requireAuth, requireSecret, aiLimiter, async (req, res) => {
        const provider = String(req.body.provider || '');
        const apiKey = String(req.body.apiKey || '').trim();
        const label = String(req.body.label || '').trim().slice(0, 80) || null;
        if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Ismeretlen AI szolgáltató.' });
        if (apiKey.length < 8 || apiKey.length > 500 || /\s/.test(apiKey)) return res.status(400).json({ error: 'Érvénytelen API kulcs.' });
        try {
            const baseUrl = provider === 'openai' ? await assertPublicBaseUrl(req.body.baseUrl || DEFAULT_OPENAI_BASE_URL) : null;
            const count = await pool.query('SELECT COUNT(*)::int AS count FROM user_ai_keys WHERE user_id = $1', [req.user.id]);
            if (count.rows[0].count >= MAX_KEYS_PER_USER) return res.status(400).json({ error: `Legfeljebb ${MAX_KEYS_PER_USER} AI kulcs menthető.` });
            const models = await listModels(provider, { apiKey, baseUrl });
            const requested = String(req.body.model || '');
            const model = MODEL_PATTERN.test(requested) ? requested : pickDefaultModel(provider, models);
            const encrypted = encryptSecret(apiKey, encryptionSecret(), req.user.id);
            const client = await pool.connect();
            let row;
            try {
                await client.query('BEGIN');
                await client.query('UPDATE user_ai_keys SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_active', [req.user.id]);
                const inserted = await client.query(
                    `INSERT INTO user_ai_keys (user_id, provider, base_url, label, model, key_ciphertext, key_iv, key_tag, key_last4, is_active)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING *`,
                    [req.user.id, provider, baseUrl, label, model, encrypted.ciphertext, encrypted.iv, encrypted.tag, apiKey.slice(-4)]
                );
                await client.query('COMMIT');
                row = inserted.rows[0];
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            await recordAuditEvent({ userId: req.user.id, action: 'ai_key_saved', entityType: 'ai_key', entityId: row.id, details: { provider }, req });
            res.status(201).json({ key: publicKey(row), models });
        } catch (err) {
            sendError(res, err, 'Az AI kulcs mentése nem sikerült.');
        }
    });

    /** Changes the model, the label or which key is active (the key itself can only be replaced by a new one). */
    app.put('/api/ai/keys/:id', requireAuth, requireSecret, async (req, res) => {
        try {
            const row = await loadKey(req.user.id, req.params.id);
            if (!row) return res.status(404).json({ error: 'Az AI kulcs nem található.' });
            const model = req.body.model === undefined ? row.model : String(req.body.model);
            if (!MODEL_PATTERN.test(model || '')) return res.status(400).json({ error: 'Érvénytelen modellnév.' });
            const label = req.body.label === undefined ? row.label : (String(req.body.label).trim().slice(0, 80) || null);
            const isActive = req.body.isActive === undefined ? row.is_active : Boolean(req.body.isActive);
            const client = await pool.connect();
            let updated;
            try {
                await client.query('BEGIN');
                if (isActive && !row.is_active) await client.query('UPDATE user_ai_keys SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_active', [req.user.id]);
                const result = await client.query(
                    'UPDATE user_ai_keys SET model = $1, label = $2, is_active = $3, updated_at = NOW() WHERE id = $4 AND user_id = $5 RETURNING *',
                    [model, label, isActive, row.id, req.user.id]
                );
                await client.query('COMMIT');
                updated = result.rows[0];
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            res.json(publicKey(updated));
        } catch (err) {
            sendError(res, err, 'Az AI kulcs módosítása nem sikerült.');
        }
    });

    app.delete('/api/ai/keys/:id', requireAuth, requireSecret, async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Az AI kulcs nem található.' });
        try {
            const result = await pool.query('DELETE FROM user_ai_keys WHERE id = $1 AND user_id = $2 RETURNING id, provider', [req.params.id, req.user.id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Az AI kulcs nem található.' });
            await recordAuditEvent({ userId: req.user.id, action: 'ai_key_deleted', entityType: 'ai_key', entityId: result.rows[0].id, details: { provider: result.rows[0].provider }, req });
            res.json({ success: true });
        } catch (err) {
            sendError(res, err, 'Az AI kulcs törlése nem sikerült.');
        }
    });

    /** "Kapcsolat tesztelése": lists the provider's models with the saved key. */
    app.get('/api/ai/keys/:id/models', requireAuth, requireSecret, aiLimiter, async (req, res) => {
        try {
            const row = await loadKey(req.user.id, req.params.id);
            if (!row) return res.status(404).json({ error: 'Az AI kulcs nem található.' });
            res.json(await listModels(row.provider, credentialsOf(row)));
        } catch (err) {
            sendError(res, err, 'A modellek lekérése nem sikerült.');
        }
    });

    /** Asks the active key's provider for a suggestion. Nothing is saved here. */
    app.post('/api/ai/fill', requireAuth, requireSecret, aiLimiter, async (req, res) => {
        const action = ACTIONS[String(req.body.action || '')];
        const input = req.body.input && typeof req.body.input === 'object' ? req.body.input : null;
        if (!action || !input) return res.status(400).json({ error: 'Ismeretlen AI művelet.' });
        if (JSON.stringify(input).length > MAX_INPUT_CHARS + 2000) return res.status(400).json({ error: 'Túl hosszú szöveg az AI-nak (legfeljebb kb. 8000 karakter).' });
        if (!action.needsInput(input)) return res.status(400).json({ error: 'Írd be a kódot, vagy a címbe vagy a leírásba azt, hogy mit szeretnél.' });
        try {
            const keyResult = await pool.query('SELECT * FROM user_ai_keys WHERE user_id = $1 AND is_active LIMIT 1', [req.user.id]);
            const row = keyResult.rows[0];
            if (!row) return res.status(400).json({ error: 'Nincs aktív AI kulcs. Add meg a Beállítások AI fülén.' });
            const [categories, tags] = action.kind ? await Promise.all([
                pool.query('SELECT id, name, default_language FROM categories WHERE owner_user_id = $1 AND kind = $2 ORDER BY name', [req.user.id, action.kind]),
                pool.query('SELECT name FROM tags WHERE user_id = $1 ORDER BY name LIMIT 300', [req.user.id])
            ]) : [{ rows: [] }, { rows: [] }];
            const context = { categories: categories.rows, tags: tags.rows.map(tag => tag.name) };
            if (action.needsToday) {
                // A dátumokat a felhasználó időzónájában kell érteni („holnap”, „péntek”).
                context.timeZone = taskDates.isValidTimeZone(input.timeZone) ? input.timeZone : taskDates.DEFAULT_TIME_ZONE;
                context.today = taskDates.localDate(new Date(), context.timeZone);
            }
            // Könyvjelzőnél az oldal címe és leírása is segít; csak nyilvános címről kéri le.
            if (action.fetchPage && publicHttpUrl(input.url)) context.page = await fetchPageMetadata(String(input.url).trim());
            const prompt = action.build(input, context);
            const raw = await generate(row.provider, { ...credentialsOf(row), model: row.model || pickDefaultModel(row.provider, []), ...prompt });
            const suggestion = action.validate(raw, input, context);
            await recordAuditEvent({ userId: req.user.id, action: 'ai_fill', entityType: 'ai', details: { action: req.body.action, provider: row.provider, model: row.model }, req });
            res.json({ suggestion, provider: row.provider, providerLabel: PROVIDERS[row.provider].label, model: row.model });
        } catch (err) {
            sendError(res, err, 'Az AI kitöltés nem sikerült.');
        }
    });
}

module.exports = { registerAiRoutes, publicKey };
