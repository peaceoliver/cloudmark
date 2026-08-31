require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'cloudmark_session';
const DEFAULT_APP_SETTINGS = {
    sessionDays: 30,
    verificationMinutes: 30
};
const registrationAttempts = new Map();
const defaultSmtpConfig = {
    from: process.env.SMTP_FROM || '',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false
};

const mailTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
    }
}) : null;

// Középrétegek (Middleware)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple request logger for debugging API hits
app.use((req, res, next) => {
    console.log(new Date().toISOString(), req.method, req.url);
    next();
});

// Statikus fájlok kiszolgálása (a 'public' mappából)
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Adatbázis kapcsolat inicializálása Supabase-hez
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Supabase SSL kapcsolat beállítása
    }
});

/** Ensures the required PostgreSQL tables and default categories exist. */
async function initDatabase() {
    try {
        const client = await pool.connect();

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'user',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_hash CHAR(64)');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ');

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings_app (
                key VARCHAR(100) PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings_user (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                setting_key VARCHAR(100) NOT NULL,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (user_id, setting_key)
            );
        `);

        await client.query(
            `INSERT INTO settings_app (key, value) VALUES ('app', $1)
             ON CONFLICT (key) DO NOTHING`,
            [JSON.stringify(DEFAULT_APP_SETTINGS)]
        );

        if (defaultSmtpConfig.from && defaultSmtpConfig.user && defaultSmtpConfig.password) {
            await client.query(
                `INSERT INTO settings_app (key, value) VALUES ('smtp', $1)
                 ON CONFLICT (key) DO NOTHING`,
                [JSON.stringify(defaultSmtpConfig)]
            );
        }

        const adminPasswordHash = await bcrypt.hash('admin123', 12);
        await client.query(
            `INSERT INTO users (username, password_hash, role, is_verified)
             VALUES ('admin', $1, 'admin', TRUE)
             ON CONFLICT (username) DO UPDATE SET role = 'admin', is_verified = TRUE`,
            [adminPasswordHash]
        );

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash CHAR(64) UNIQUE NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query('DELETE FROM sessions WHERE expires_at < NOW()');
        

        
        // Könyvjelzők tábla létrehozása
        await client.query(`
            CREATE TABLE IF NOT EXISTS bookmarks (
                id BIGSERIAL PRIMARY KEY,
                user_id VARCHAR(100) NOT NULL DEFAULT 'demo',
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                category VARCHAR(100) NOT NULL,
                clicks INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query(`
            ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;
        `);
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS metadata_title TEXT');
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS image_url TEXT');
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS description TEXT');
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS site_name VARCHAR(255)');

        // Kategóriák tábla létrehozása
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL
            );
        `);

        // Alapértelmezett kategóriák feltöltése, ha üres a tábla
        await client.query(`
            INSERT INTO categories (name) 
            VALUES ('Inbox'), ('Fejlesztés'), ('Eszközök'), ('Hírek'), ('Szórakozás')
            ON CONFLICT (name) DO NOTHING;
        `);

        client.release();
        console.log(`[OK] Supabase PostgreSQL tablak sikeresen ellenorizve / letrehozva!`);
    } catch (err) {
        console.error('❌ Hiba az adatbázis inicializálásakor:', err.message);
    }
}

/** Hashes a session token before it is stored in the database. */
function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Hashes an email verification token before it is persisted. */
function hashVerificationToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Extracts a quoted Open Graph or standard HTML meta value. */
function extractMetaValue(html, names) {
    for (const name of names) {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escapedName}["'][^>]+content=["']([^"']*)["']`, 'i')) ||
            html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapedName}["']`, 'i'));
        if (match?.[1]) return match[1].trim();
    }
    return null;
}

function normalizeBooleanSetting(value, fallback = true) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    if (typeof value === 'number') return value !== 0;
    return fallback;
}

async function getUserSettingValue(userId, key, fallback) {
    try {
        const result = await pool.query(
            'SELECT value FROM settings_user WHERE user_id = $1 AND setting_key = $2',
            [userId, key]
        );
        if (!result.rows.length) return fallback;
        const rawValue = result.rows[0].value;
        if (typeof rawValue === 'string') {
            try {
                return JSON.parse(rawValue);
            } catch (err) {
                return rawValue;
            }
        }
        return rawValue ?? fallback;
    } catch (err) {
        return fallback;
    }
}

async function shouldFetchWebsiteMetadata(userId) {
    const value = await getUserSettingValue(userId, 'fetchMetadata', true);
    return normalizeBooleanSetting(value, true);
}

/** Fetches lightweight article metadata without making metadata mandatory. */
async function fetchBookmarkMetadata(url) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'CloudMark/1.0 metadata fetcher' },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return {};
        const html = (await response.text()).slice(0, 512 * 1024);
        const image = extractMetaValue(html, ['og:image', 'twitter:image']);
        return {
            title: extractMetaValue(html, ['og:title', 'twitter:title']) || extractMetaValue(html, ['title']),
            imageUrl: image ? new URL(image, url).href : null,
            description: extractMetaValue(html, ['og:description', 'description']),
            siteName: extractMetaValue(html, ['og:site_name']) || new URL(url).hostname
        };
    } catch (err) {
        console.warn('Bookmark metadata fetch failed:', err.message);
        return {};
    }
}

/** Rejects repeated registration attempts from the same client for a short window. */
function isRegistrationRateLimited(req) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const previousAttempt = registrationAttempts.get(key) || 0;
    registrationAttempts.set(key, now);
    return now - previousAttempt < 60 * 1000;
}

/** Sends an account verification link or logs it in local development. */
async function sendVerificationEmail(email, token) {
    const verificationUrl = `${process.env.APP_URL || `http://localhost:${PORT}`}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    const result = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
    const smtp = result.rows[0]?.value;
    const transport = smtp?.host ? nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        auth: { user: smtp.user, pass: smtp.password }
    }) : mailTransport;
    if (!transport) {
        if (process.env.NODE_ENV === 'production') throw new Error('SMTP nincs konfigurálva');
        console.log(`[DEV] E-mail megerősítő link: ${verificationUrl}`);
        return false;
    }
    const sender = smtp?.user || process.env.SMTP_USER || smtp?.from || process.env.SMTP_FROM;
    const info = await transport.sendMail({
        from: sender,
        to: email,
        subject: 'CloudMark e-mail cím megerősítése',
        text: `A fiókod aktiválásához nyisd meg ezt a linket: ${verificationUrl}`,
        html: `<p>A fiókod aktiválásához kattints az alábbi linkre:</p><p><a href="${verificationUrl}">E-mail cím megerősítése</a></p>`
    });
    console.log(`[MAIL] Verification e-mail elküldve: messageId=${info.messageId}, response=${info.response}`);
    return true;
}

/** Returns application settings with safe defaults for missing values. */
async function getAppSettings() {
    const result = await pool.query("SELECT value FROM settings_app WHERE key = 'app'");
    return { ...DEFAULT_APP_SETTINGS, ...(result.rows[0]?.value || {}) };
}

/** Reads the named cookie from an incoming request. */
function getCookie(req, name) {
    const cookies = (req.headers.cookie || '').split(';');
    const cookie = cookies.find(item => item.trim().startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
}

/** Creates a persistent database-backed session and sets its HttpOnly cookie. */
async function createSession(user, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const appSettings = await getAppSettings();
    const sessionDays = Number(appSettings.sessionDays) || DEFAULT_APP_SETTINGS.sessionDays;
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
    await pool.query(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, hashSessionToken(token), expiresAt]
    );
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDays * 24 * 60 * 60}${secure}`);
}

/** Resolves the authenticated user from the database-backed session cookie. */
async function getAuthenticatedUser(req) {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const result = await pool.query(`
        SELECT u.id, u.username, u.email, u.role
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()
    `, [hashSessionToken(token)]);
    return result.rows[0] || null;
}

/** Requires a valid database session before allowing the request to continue. */
async function requireAuth(req, res, next) {
    try {
        req.user = await getAuthenticatedUser(req);
        if (!req.user) return res.status(401).json({ error: 'Bejelentkezés szükséges' });
        next();
    } catch (err) {
        res.status(500).json({ error: 'Hitelesítési hiba' });
    }
}

/** Requires an authenticated administrator before allowing the request to continue. */
async function requireAdmin(req, res, next) {
    await requireAuth(req, res, () => {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin jogosultság szükséges' });
        next();
    });
}

// --------------------------------------------------------------------------
// API ENDPOINTOK A FRONTENDHEZ
// --------------------------------------------------------------------------

/** Returns the currently authenticated user, if a valid session exists. */
app.get('/api/auth/me', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        res.json(user ? { username: user.username, email: user.email, isSuperuser: user.role === 'admin' } : null);
    } catch (err) {
        res.status(500).json({ error: 'Hitelesítési hiba' });
    }
});

/** Registers a user with a bcrypt-hashed password and starts a session. */
app.post('/api/auth/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim() || null;
    const password = String(req.body.password || '');

    if (isRegistrationRateLimited(req)) {
        return res.status(429).json({ error: 'Túl sok regisztrációs próbálkozás. Próbáld újra egy perc múlva.' });
    }
    if (username.length < 3 || password.length < 4 || !email) {
        return res.status(400).json({ error: 'A felhasználónév legalább 3, a jelszó legalább 4 karakter, az e-mail cím pedig kötelező.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const appSettings = await getAppSettings();
        const verificationMinutes = Number(appSettings.verificationMinutes) || DEFAULT_APP_SETTINGS.verificationMinutes;
        const verificationExpiresAt = new Date(Date.now() + verificationMinutes * 60 * 1000);
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, is_verified, verification_token_hash, verification_expires_at)
             VALUES ($1, $2, $3, FALSE, $4, $5)
             RETURNING id, username, email, role`,
            [username, email, passwordHash, hashVerificationToken(verificationToken), verificationExpiresAt]
        );
        const user = result.rows[0];
        try {
            const emailSent = await sendVerificationEmail(email, verificationToken);
            res.status(201).json({ verificationRequired: true, email: user.email, emailSent });
            return;
        } catch (mailError) {
            await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
            throw mailError;
        }
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A felhasználónév vagy e-mail már foglalt.' });
        res.status(500).json({ error: 'A regisztráció nem sikerült. Ellenőrizd az e-mail küldési beállításokat.' });
    }
});

/** Verifies an email token, activates the user, and redirects to the app. */
app.get('/api/auth/verify-email', async (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).send('Hiányzó megerősítő token.');
    try {
        const result = await pool.query(
            `UPDATE users
             SET is_verified = TRUE, verification_token_hash = NULL, verification_expires_at = NULL
             WHERE verification_token_hash = $1 AND verification_expires_at > NOW()
             RETURNING username`,
            [hashVerificationToken(token)]
        );
        if (!result.rows.length) return res.status(400).send('A megerősítő link érvénytelen vagy lejárt.');
        res.redirect('/?verified=1');
    } catch (err) {
        res.status(500).send('A megerősítés nem sikerült.');
    }
});

/** Verifies a user's password against the database and starts a session. */
app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    try {
        const result = await pool.query(
            'SELECT id, username, email, password_hash, role, is_verified FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó.' });
        }
        if (!user.is_verified) return res.status(403).json({ error: 'Előbb erősítsd meg az e-mail címedet.' });
        await createSession(user, res);
        res.json({ username: user.username, email: user.email, isSuperuser: user.role === 'admin' });
    } catch (err) {
        res.status(500).json({ error: 'A bejelentkezés nem sikerült.' });
    }
});

/** Revokes the current database session and clears its browser cookie. */
app.post('/api/auth/logout', async (req, res) => {
    const token = getCookie(req, SESSION_COOKIE);
    try {
        if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'A kijelentkezés nem sikerült.' });
    }
});

/** Returns all bookmarks ordered by creation time. */
app.get('/api/bookmarks', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bookmarks ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Creates a bookmark for the requested user. */
app.post('/api/bookmarks', requireAuth, async (req, res) => {
    const { title, url, category } = req.body;
    try {
        const metadata = (await shouldFetchWebsiteMetadata(req.user.id)) ? await fetchBookmarkMetadata(url) : {};
        const result = await pool.query(
            `INSERT INTO bookmarks (user_id, title, url, category, metadata_title, image_url, description, site_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [req.user.username, title, url, category, metadata.title, metadata.imageUrl, metadata.description, metadata.siteName]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Deletes a bookmark by its database identifier. */
app.delete('/api/bookmarks/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const owner = req.user.role === 'admin' ? '' : ' AND user_id = $2';
        const values = req.user.role === 'admin' ? [id] : [id, req.user.username];
        await pool.query(`DELETE FROM bookmarks WHERE id = $1${owner}`, values);
        res.json({ message: 'Könyvjelző sikeresen törölve' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Updates a bookmark's title, URL, and category. */
app.put('/api/bookmarks/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { title, url, category } = req.body;
    try {
        const metadata = (await shouldFetchWebsiteMetadata(req.user.id)) ? await fetchBookmarkMetadata(url) : {};
        const owner = req.user.role === 'admin' ? '' : ' AND user_id = $9';
        const result = await pool.query(
            `UPDATE bookmarks SET title = $1, url = $2, category = $3, metadata_title = $5, image_url = $6, description = $7, site_name = $8 WHERE id = $4${owner} RETURNING *`,
            req.user.role === 'admin'
                ? [title, url, category, id, metadata.title, metadata.imageUrl, metadata.description, metadata.siteName]
                : [title, url, category, id, metadata.title, metadata.imageUrl, metadata.description, metadata.siteName, req.user.username]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/** Increments the click counter for a bookmark. */
app.post('/api/bookmarks/:id/click', async (req, res) => {
    const bookmarkId = req.params.id;
    try {
        // Növeljük a clicks oszlop értékét 1-gyel az adatbázisban a PostgreSQL pool segítségével
        await pool.query(
            'UPDATE bookmarks SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1',
            [bookmarkId]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Hiba a kattintás frissítésekor:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


/** Returns category names in their database order. */
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query('SELECT name FROM categories ORDER BY id ASC');
        res.json(result.rows.map(row => row.name));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Creates a category and returns the refreshed category list. */
app.post('/api/categories', async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Missing name' });
    try {
        await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name.trim()]);
        const result = await pool.query('SELECT name FROM categories ORDER BY id ASC');
        res.status(201).json(result.rows.map(row => row.name));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Renames a category and updates matching bookmarks. */
app.put('/api/categories/:oldName', async (req, res) => {
    const oldName = req.params.oldName;
    const { newName } = req.body;

    if (!newName || !newName.trim()) {
        return res.status(400).json({ error: 'Az új név megadása kötelező!' });
    }

    try {
        // Ha Supabase / PostgreSQL adatbázist használsz:
        // 1. Átírjuk a kategóriát magában a categories táblában (vagy tömbben, attól függően hol tárolod)
        // 2. Frissítjük a hivatkozott könyvjelzőket is, hogy ne vesszenek el!
        await pool.query('UPDATE bookmarks SET category = $1 WHERE category = $2', [newName.trim(), oldName]);
        
        // Ha külön kategória táblád van az adatbázisban:
        await pool.query('UPDATE categories SET name = $1 WHERE name = $2', [newName.trim(), oldName]).catch(() => {});

        res.json({ success: true, message: 'Kategoria sikeresen atnevezve' });
    } catch (err) {
        console.error('Hiba kategoria atnevezes soran:', err);
        res.status(500).json({ error: 'Szerver hiba' });
    }
});

/** Deletes a category and moves its bookmarks to Inbox. */
app.delete('/api/categories/:name', async (req, res) => {
    const catName = req.params.name;

    try {
        // Opcionális: Ha törlöd a kategóriát, az abba tartozó könyvjelzőket áthelyezheted "Inbox"-ba, vagy törölheted. 
        // Itt átrakjuk őket "Inbox"-ba, hogy ne törlődjenek a könyvjelzők:
        await pool.query('UPDATE bookmarks SET category = $1 WHERE category = $2', ['Inbox', catName]);
        
        // Ha külön kategória táblád van:
        await pool.query('DELETE FROM categories WHERE name = $1', [catName]).catch(() => {});

        res.json({ success: true, message: 'Kategoria törölve' });
    } catch (err) {
        console.error('Hiba kategoria törles soran:', err);
        res.status(500).json({ error: 'Szerver hiba' });
    }
});




/** Returns SMTP settings to an authenticated administrator. */
app.get('/api/admin/smtp-config', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
        const smtp = result.rows[0]?.value || defaultSmtpConfig;
        res.json({ ...smtp, password: '', passwordConfigured: Boolean(smtp.password) });
    } catch (err) {
        res.status(500).json({ error: 'Az SMTP beállítások nem tölthetők be.' });
    }
});

/** Stores SMTP settings submitted by an authenticated administrator. */
app.put('/api/admin/smtp-config', requireAdmin, async (req, res) => {
    const { from, user, password, host, port, secure } = req.body;
    if (!from || !user || !host || !Number(port)) {
        return res.status(400).json({ error: 'A küldő, felhasználó, szerver és port megadása kötelező.' });
    }
    try {
        const existing = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
        const existingPassword = existing.rows[0]?.value?.password || '';
        const settings = { from, user, password: password || existingPassword, host, port: Number(port), secure: Boolean(secure) };
        if (!settings.password) return res.status(400).json({ error: 'Az SMTP jelszó megadása kötelező az első mentéskor.' });
        await pool.query(
            `INSERT INTO settings_app (key, value, updated_at) VALUES ('smtp', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [JSON.stringify(settings)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Az SMTP beállítások mentése nem sikerült.' });
    }
});

/** Returns the authenticated user's saved UI preferences. */
app.get('/api/user/settings', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT setting_key, value FROM settings_user WHERE user_id = $1',
            [req.user.id]
        );
        res.json(Object.fromEntries(result.rows.map(row => [row.setting_key, row.value])));
    } catch (err) {
        res.status(500).json({ error: 'A felhasználói beállítások nem tölthetők be.' });
    }
});

/** Saves one supported UI preference for the authenticated user. */
app.put('/api/user/settings/:key', requireAuth, async (req, res) => {
    const allowedKeys = ['theme', 'viewMode', 'sortMode', 'fetchMetadata'];
    const { key } = req.params;
    if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Ismeretlen felhasználói beállítás.' });
    if (req.body.value === undefined || req.body.value === null || String(req.body.value).trim() === '') return res.status(400).json({ error: 'Érvénytelen beállítási érték.' });

    try {
        await pool.query(
            `INSERT INTO settings_user (user_id, setting_key, value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, setting_key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [req.user.id, key, JSON.stringify(req.body.value)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'A felhasználói beállítás mentése nem sikerült.' });
    }
});

/** Returns global application settings to an authenticated administrator. */
app.get('/api/admin/app-config', requireAdmin, async (req, res) => {
    try { res.json(await getAppSettings()); }
    catch (err) { res.status(500).json({ error: 'Az alkalmazásbeállítások nem tölthetők be.' }); }
});

/** Saves global application settings submitted by an authenticated administrator. */
app.put('/api/admin/app-config', requireAdmin, async (req, res) => {
    const sessionDays = Number(req.body.sessionDays);
    const verificationMinutes = Number(req.body.verificationMinutes);
    if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365 || !Number.isInteger(verificationMinutes) || verificationMinutes < 5 || verificationMinutes > 1440) {
        return res.status(400).json({ error: 'Érvénytelen app-beállítási érték.' });
    }
    try {
        const settings = { sessionDays, verificationMinutes };
        await pool.query(
            `INSERT INTO settings_app (key, value, updated_at) VALUES ('app', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [JSON.stringify(settings)]
        );
        res.json(settings);
    } catch (err) { res.status(500).json({ error: 'Az alkalmazásbeállítás mentése nem sikerült.' }); }
});

// Főoldal kiszolgálása
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Szerver indítása
app.listen(PORT, async () => {
    console.log(`[INFO] A CloudMark szerver fut a http://localhost:${PORT} cimen`);
    await initDatabase();
});

/** Issues a fresh verification token for an unverified account. */
app.post('/api/auth/resend-verification', async (req, res) => {
    const username = String(req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'A felhasználónév kötelező.' });
    if (isRegistrationRateLimited(req)) {
        return res.status(429).json({ error: 'Túl sok próbálkozás. Próbáld újra egy perc múlva.' });
    }

    try {
        const appSettings = await getAppSettings();
        const verificationMinutes = Number(appSettings.verificationMinutes) || DEFAULT_APP_SETTINGS.verificationMinutes;
        const token = crypto.randomBytes(32).toString('hex');
        const result = await pool.query(
            `UPDATE users
             SET verification_token_hash = $1, verification_expires_at = $2
             WHERE LOWER(username) = LOWER($3) AND is_verified = FALSE
             RETURNING email`,
            [hashVerificationToken(token), new Date(Date.now() + verificationMinutes * 60 * 1000), username]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Nincs ilyen megerősítetlen felhasználó.' });
        const emailSent = await sendVerificationEmail(result.rows[0].email, token);
        res.json({ verificationRequired: true, emailSent });
    } catch (err) {
        console.error('Verification e-mail újraküldése sikertelen:', err.message);
        res.status(500).json({ error: 'A megerősítő e-mail küldése nem sikerült.' });
    }
});

/** Changes the authenticated user's password after verifying the current one. */
app.put('/api/auth/password', requireAuth, async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 4) return res.status(400).json({ error: 'Az új jelszó legalább 4 karakter legyen.' });

    try {
        const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const valid = result.rows[0] && await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'A jelenlegi jelszó hibás.' });

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.user.id]);
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
        await createSession(req.user, res);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'A jelszó módosítása nem sikerült.' });
    }
});