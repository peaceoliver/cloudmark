require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', true);
const SESSION_COOKIE = 'cloudmark_session';

function getPublicBaseUrl(req = null) {
    if (process.env.APP_URL && process.env.APP_URL.trim()) {
        return process.env.APP_URL.trim().replace(/\/+$/, '');
    }
    if (req) {
        const forwardedProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
        if (forwardedHost) return `${Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto}://${forwardedHost}`;
    }
    return `http://localhost:${PORT}`;
}
const DEFAULT_APP_SETTINGS = {
    sessionDays: 30,
    verificationMinutes: 30,
    requireEmailVerification: true,
    bookmarksPerPage: 60
};
const registrationAttempts = new Map();
const defaultSmtpConfig = {
    provider: process.env.EMAIL_PROVIDER || 'smtp',
    apiKey: process.env.EMAIL_API_KEY || '',
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
    },
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
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

        await client.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id BIGSERIAL PRIMARY KEY,
                name VARCHAR(120) NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_hash CHAR(64)');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL');
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS team_role VARCHAR(25) NOT NULL DEFAULT 'member'");

        await client.query(`
            CREATE TABLE IF NOT EXISTS team_members (
                team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(25) NOT NULL DEFAULT 'member',
                joined_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (team_id, user_id)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_events (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(80) NOT NULL,
                entity_type VARCHAR(60) NOT NULL,
                entity_id BIGINT,
                details JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

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

        const adminUser = await client.query('SELECT id, username FROM users WHERE username = $1', ['admin']);
        if (adminUser.rowCount) {
            const adminTeam = await client.query('SELECT id FROM teams WHERE owner_user_id = $1 LIMIT 1', [adminUser.rows[0].id]);
            if (!adminTeam.rowCount) {
                const defaultTeam = await client.query(
                    'INSERT INTO teams (name, owner_user_id) VALUES ($1, $2) RETURNING id',
                    ['admin workspace', adminUser.rows[0].id]
                );
                await client.query(
                    'UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3',
                    [defaultTeam.rows[0].id, 'team_admin', adminUser.rows[0].id]
                );
                await client.query(
                    'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [defaultTeam.rows[0].id, adminUser.rows[0].id, 'team_admin']
                );
            }
        }

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
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query("ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'inbox'");
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS trashed BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS normalized_url TEXT');
        await client.query('UPDATE bookmarks SET normalized_url = url WHERE normalized_url IS NULL');
        await client.query(`
            CREATE TABLE IF NOT EXISTS tags (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(80) NOT NULL,
                UNIQUE(user_id, name)
            );
            CREATE TABLE IF NOT EXISTS bookmark_tags (
                bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
                tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (bookmark_id, tag_id)
            );
            CREATE TABLE IF NOT EXISTS bookmark_shares (
                id BIGSERIAL PRIMARY KEY,
                bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
                token CHAR(64) UNIQUE NOT NULL,
                permission VARCHAR(10) NOT NULL DEFAULT 'view',
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS bookmarks_user_created_idx ON bookmarks(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS bookmarks_search_idx ON bookmarks USING gin(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(url,'') || ' ' || coalesce(description,'')));
            CREATE INDEX IF NOT EXISTS bookmarks_normalized_url_idx ON bookmarks(user_id, normalized_url);
        `);

        // Kategóriák tábla létrehozása
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
            );
        `);
        await client.query('ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
        await client.query('CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories(parent_id)');

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

function normalizeTags(tags) {
    return [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(',')).map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

/** Canonicalizes a URL for duplicate detection without changing the stored URL. */
function normalizeBookmarkUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    try {
        const parsed = new URL(candidate);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;

        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        // Treat common www/ww variants and bare domains as the same bookmark target.
        const canonicalHost = hostname.replace(/^ww\./, 'www.').replace(/^www\./, '');

        parsed.protocol = parsed.protocol.toLowerCase();
        parsed.hostname = canonicalHost;
        if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
        parsed.hash = '';
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach(key => parsed.searchParams.delete(key));
        parsed.search = parsed.searchParams.toString() ? `?${parsed.searchParams.toString()}` : '';
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return parsed.toString();
    } catch (err) {
        return null;
    }
}

async function replaceBookmarkTags(bookmarkId, userId, tags) {
    const names = normalizeTags(tags);
    await pool.query('DELETE FROM bookmark_tags WHERE bookmark_id = $1', [bookmarkId]);
    for (const name of names) {
        const tag = await pool.query(
            `INSERT INTO tags (user_id, name) VALUES ($1, $2)
             ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [userId, name]
        );
        await pool.query('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [bookmarkId, tag.rows[0].id]);
    }
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

async function shouldFetchWebsiteMetadataTitle(userId) {
    const value = await getUserSettingValue(userId, 'fetchMetadataTitle', await shouldFetchWebsiteMetadata(userId));
    return normalizeBooleanSetting(value, true);
}

async function shouldFetchWebsiteMetadataImage(userId) {
    const value = await getUserSettingValue(userId, 'fetchMetadataImage', await shouldFetchWebsiteMetadata(userId));
    return normalizeBooleanSetting(value, true);
}

function resolveBookmarkTitle(title, metadata, url) {
    const manual = String(title || '').trim();
    if (manual) return manual;
    const siteTitle = String(metadata?.title || '').trim();
    if (siteTitle) return siteTitle;
    try {
        return new URL(url).hostname;
    } catch (err) {
        return String(url || 'Névtelen könyvjelző').trim() || 'Névtelen könyvjelző';
    }
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

/** Sends an email via the Resend HTTPS API (bypasses SMTP port blocks on hosts like Render). */
async function sendViaResend({ apiKey, from, to, subject, text, html }) {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || `Resend API hiba (${response.status})`);
    return { messageId: body?.id, response: 'Resend API OK' };
}

/** Sends an email via the SendGrid HTTPS API (bypasses SMTP port blocks on hosts like Render). */
async function sendViaSendgrid({ apiKey, from, to, subject, text, html }) {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: from },
            subject,
            content: [
                { type: 'text/plain', value: text },
                { type: 'text/html', value: html }
            ]
        }),
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.errors?.[0]?.message || `SendGrid API hiba (${response.status})`);
    }
    return { messageId: response.headers.get('x-message-id'), response: 'SendGrid API OK' };
}

/** Sends an email using the configured provider (SMTP transport or an HTTPS email API). */
async function sendEmailWithConfig(smtp, { to, subject, text, html }) {
    const provider = smtp?.provider || 'smtp';
    const from = smtp?.from || smtp?.user || process.env.SMTP_FROM;

    if (provider === 'resend') {
        return sendViaResend({ apiKey: smtp.apiKey, from, to, subject, text, html });
    }
    if (provider === 'sendgrid') {
        return sendViaSendgrid({ apiKey: smtp.apiKey, from, to, subject, text, html });
    }

    const transport = smtp?.host ? nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        auth: { user: smtp.user, pass: smtp.password },
        family: 4,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    }) : mailTransport;
    if (!transport) throw new Error('SMTP nincs konfigurálva');
    const info = await transport.sendMail({ from: smtp?.user || from, to, subject, text, html });
    transport.close();
    return { messageId: info.messageId, response: info.response };
}

/** Sends an account verification link or logs it in local development. */
async function sendVerificationEmail(req, email, token) {
    const verificationUrl = `${getPublicBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    const result = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
    const smtp = result.rows[0]?.value;
    if (!smtp?.host && !smtp?.apiKey && !mailTransport) {
        if (process.env.NODE_ENV === 'production') throw new Error('E-mail küldés nincs konfigurálva');
        console.log(`[DEV] E-mail megerősítő link: ${verificationUrl}`);
        return false;
    }
    try {
        const info = await sendEmailWithConfig(smtp, {
            to: email,
            subject: 'CloudMark e-mail cím megerősítése',
            text: `A fiókod aktiválásához nyisd meg ezt a linket: ${verificationUrl}`,
            html: `<p>A fiókod aktiválásához kattints az alábbi linkre:</p><p><a href="${verificationUrl}">E-mail cím megerősítése</a></p>`
        });
        console.log(`[MAIL] Verification e-mail elküldve: messageId=${info.messageId}, response=${info.response}`);
        return true;
    } catch (mailError) {
        console.error('[MAIL] Verification e-mail send failed:', mailError.message || mailError);
        if (process.env.NODE_ENV === 'production') {
            throw mailError;
        }
        console.log(`[DEV] Fallback verification link: ${verificationUrl}`);
        return false;
    }
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
        SELECT u.id, u.username, u.email, u.role, u.team_id, u.team_role, u.is_active
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()
    `, [hashSessionToken(token)]);
    const user = result.rows[0] || null;
    if (user && user.is_active === false) return null;
    return user;
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

/** Requires either a platform admin or a designated team administrator. */
async function requireTeamAdmin(req, res, next) {
    await requireAuth(req, res, () => {
        if (req.user.role === 'admin' || req.user.team_role === 'team_admin') {
            next();
            return;
        }
        res.status(403).json({ error: 'Team admin jogosultság szükséges' });
    });
}

function getRequestContext(req) {
    return {
        ip: req?.ip || req?.socket?.remoteAddress || null,
        userAgent: req?.headers?.['user-agent'] || null,
        method: req?.method || null,
        path: req?.originalUrl || req?.url || null
    };
}

async function recordAuditEvent({ userId, action, entityType, entityId = null, details = {}, req = null }) {
    try {
        await pool.query(
            `INSERT INTO audit_events (user_id, action, entity_type, entity_id, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId ?? null, action, entityType, entityId ?? null, JSON.stringify({ ...details, ...(req ? getRequestContext(req) : {}) })]
        );
    } catch (err) {
        console.warn('Audit event logging failed:', err.message);
    }
}

async function createDefaultTeamForUser(userId, username) {
    const existing = await pool.query('SELECT id FROM teams WHERE owner_user_id = $1 LIMIT 1', [userId]);
    if (existing.rowCount) {
        await pool.query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [existing.rows[0].id, 'team_admin', userId]);
        return existing.rows[0].id;
    }

    const team = await pool.query(
        'INSERT INTO teams (name, owner_user_id) VALUES ($1, $2) RETURNING id',
        [`${username} workspace`, userId]
    );
    const teamId = team.rows[0].id;
    await pool.query('UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3', [teamId, 'team_admin', userId]);
    await pool.query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [teamId, userId, 'team_admin']);
    return teamId;
}

// --------------------------------------------------------------------------
// API ENDPOINTOK A FRONTENDHEZ
// --------------------------------------------------------------------------

/** Returns the currently authenticated user, if a valid session exists. */
app.get('/api/auth/me', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        res.json(user ? {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            teamId: user.team_id,
            teamRole: user.team_role,
            isSuperuser: user.role === 'admin'
        } : null);
    } catch (err) {
        res.status(500).json({ error: 'Hitelesítési hiba' });
    }
});

app.get('/api/teams', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const isAdmin = req.user.role === 'admin';
        const result = await pool.query(
            isAdmin
                ? `SELECT t.*, u.username AS owner_username FROM teams t JOIN users u ON u.id = t.owner_user_id ORDER BY t.created_at DESC`
                : `SELECT t.*, u.username AS owner_username
                   FROM team_members tm
                   JOIN teams t ON t.id = tm.team_id
                   JOIN users u ON u.id = t.owner_user_id
                   WHERE tm.user_id = $1
                   ORDER BY t.created_at DESC`,
            isAdmin ? [] : [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'A team adatok betöltése nem sikerült.' });
    }
});

app.post('/api/teams', requireAuth, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length < 2) return res.status(400).json({ error: 'A csapat neve legalább 2 karakter hosszú legyen.' });

    try {
        const team = await pool.query(
            'INSERT INTO teams (name, owner_user_id) VALUES ($1, $2) RETURNING *',
            [name, req.user.id]
        );
        const teamId = team.rows[0].id;
        await pool.query(
            'UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3',
            [teamId, 'team_admin', req.user.id]
        );
        await pool.query(
            'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [teamId, req.user.id, 'team_admin']
        );
        await recordAuditEvent({ userId: req.user.id, action: 'team_created', entityType: 'team', entityId: teamId, details: { name }, req });
        res.status(201).json(team.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'A csapat létrehozása nem sikerült.' });
    }
});

app.patch('/api/teams/:id/transfer-owner', requireAuth, async (req, res) => {
    const teamId = Number(req.params.id);
    const newOwnerUserId = Number(req.body.userId ?? req.body.newOwnerUserId ?? req.body.newOwnerId);
    if (!teamId || !newOwnerUserId) return res.status(400).json({ error: 'Érvénytelen csapat vagy új tulajdonos azonosító.' });

    try {
        const team = await pool.query('SELECT id, owner_user_id, name FROM teams WHERE id = $1', [teamId]);
        if (!team.rowCount) return res.status(404).json({ error: 'A csapat nem található.' });
        if (team.rows[0].owner_user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Csak a csapat tulajdonosa adhatja át a jogokat.' });
        }
        if (team.rows[0].owner_user_id === newOwnerUserId) {
            return res.status(400).json({ error: 'A jelenlegi tulajdonos már a csapat tulajdonosa.' });
        }

        const member = await pool.query(
            'SELECT u.id, u.username FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = $1 AND u.id = $2',
            [teamId, newOwnerUserId]
        );
        if (!member.rowCount) return res.status(404).json({ error: 'A kiválasztott felhasználó nem tagja a csapatnak.' });

        await pool.query(
            `UPDATE team_members
             SET role = CASE WHEN user_id = $1 THEN 'team_admin' WHEN user_id = $2 THEN 'member' ELSE role END
             WHERE team_id = $3`,
            [newOwnerUserId, req.user.id, teamId]
        );
        await pool.query(
            `UPDATE users
             SET team_role = CASE WHEN id = $1 THEN 'team_admin' WHEN id = $2 THEN 'member' ELSE team_role END
             WHERE id IN ($1, $2)`,
            [newOwnerUserId, req.user.id]
        );
        await pool.query('UPDATE teams SET owner_user_id = $1 WHERE id = $2', [newOwnerUserId, teamId]);
        await recordAuditEvent({
            userId: req.user.id,
            action: 'team_owner_transferred',
            entityType: 'team',
            entityId: teamId,
            details: { teamName: team.rows[0].name, previousOwnerId: req.user.id, newOwnerId: newOwnerUserId, newOwnerUsername: member.rows[0].username },
            req
        });

        res.json({ success: true, teamId, newOwnerUserId, previousOwnerUserId: req.user.id });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A tulajdonjog átadása nem sikerült.' });
    }
});

app.post('/api/teams/:id/leave', requireAuth, async (req, res) => {
    const teamId = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'Érvénytelen csapat azonosító.' });

    try {
        const team = await pool.query('SELECT id, owner_user_id, name FROM teams WHERE id = $1', [teamId]);
        if (!team.rowCount) return res.status(404).json({ error: 'A csapat nem található.' });
        if (team.rows[0].owner_user_id === req.user.id) {
            return res.status(400).json({ error: 'A csapat tulajdonosa nem léphet ki a csapatból. Adja át a tulajdonjogot vagy törölje a csapatot.' });
        }

        const membership = await pool.query(
            'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
            [teamId, req.user.id]
        );
        if (!membership.rowCount) return res.status(404).json({ error: 'Nem vagy tagja ennek a csapatnak.' });

        await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, req.user.id]);
        await pool.query(
            `UPDATE users
             SET team_id = CASE WHEN team_id = $1 THEN NULL ELSE team_id END,
                 team_role = CASE WHEN team_id = $1 THEN 'member' ELSE team_role END
             WHERE id = $2`,
            [teamId, req.user.id]
        );
        await recordAuditEvent({ userId: req.user.id, action: 'team_left', entityType: 'team', entityId: teamId, details: { teamName: team.rows[0].name }, req });

        res.json({ success: true, teamId });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A csapatból való kilépés nem sikerült.' });
    }
});

app.delete('/api/teams/:id', requireAuth, async (req, res) => {
    const teamId = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'Érvénytelen csapat azonosító.' });

    try {
        const team = await pool.query('SELECT id, owner_user_id, name FROM teams WHERE id = $1', [teamId]);
        if (!team.rowCount) return res.status(404).json({ error: 'A csapat nem található.' });
        if (team.rows[0].owner_user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Csak a csapat tulajdonosa törölheti a csapatot.' });
        }

        const members = await pool.query('SELECT user_id FROM team_members WHERE team_id = $1', [teamId]);
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);

        for (const member of members.rows) {
            await pool.query(
                `UPDATE users
                 SET team_id = CASE WHEN team_id = $1 THEN NULL ELSE team_id END,
                     team_role = CASE WHEN team_id = $1 THEN 'member' ELSE team_role END
                 WHERE id = $2`,
                [teamId, member.user_id]
            );
        }

        await recordAuditEvent({ userId: req.user.id, action: 'team_deleted', entityType: 'team', entityId: teamId, details: { teamName: team.rows[0].name, membersRemoved: members.rows.length }, req });
        res.json({ success: true, teamId });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A csapat törlése nem sikerült.' });
    }
});

app.post('/api/teams/:id/members', requireTeamAdmin, async (req, res) => {
    const teamId = Number(req.params.id);
    const username = String(req.body.username || '').trim();
    const role = ['member', 'team_admin'].includes(String(req.body.role || 'member')) ? String(req.body.role || 'member') : 'member';
    if (!teamId || !username) return res.status(400).json({ error: 'A csapat azonosítója és a felhasználónév kötelező.' });

    try {
        const member = await pool.query(
            'SELECT id, team_id, team_role FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!member.rowCount) return res.status(404).json({ error: 'A felhasználó nem található.' });

        const user = member.rows[0];
        const teamAccess = await pool.query(
            'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
            [teamId, user.id]
        );
        if (!teamAccess.rowCount) {
            await pool.query(
                'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [teamId, user.id, role]
            );
        } else {
            await pool.query(
                'UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3',
                [role, teamId, user.id]
            );
        }

        await pool.query(
            'UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3',
            [teamId, role, user.id]
        );
        await recordAuditEvent({ userId: req.user.id, action: 'team_member_updated', entityType: 'team_member', entityId: user.id, details: { teamId, username, role }, req });

        res.status(201).json({ success: true, userId: user.id, username: username, role });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A felhasználó hozzáadása a csapathoz nem sikerült.' });
    }
});

app.get('/api/teams/:id/members', requireAuth, async (req, res) => {
    const teamId = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'Érvénytelen csapat azonosító.' });

    try {
        const hasAccess = req.user.role === 'admin' || await pool.query(
            'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
            [teamId, req.user.id]
        ).then(result => result.rowCount > 0);

        if (!hasAccess) return res.status(403).json({ error: 'Nincs jogosultságod a csapat tagjainak megtekintéséhez.' });

        const result = await pool.query(
            `SELECT u.id AS user_id, u.username, tm.role
             FROM team_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = $1
             ORDER BY u.username ASC`,
            [teamId]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'A csapat tagjainak betöltése nem sikerült.' });
    }
});

app.patch('/api/teams/:id/members/:userId', requireTeamAdmin, async (req, res) => {
    const teamId = Number(req.params.id);
    const userId = Number(req.params.userId);
    const role = ['member', 'team_admin'].includes(String(req.body.role || 'member')) ? String(req.body.role || 'member') : 'member';

    if (!teamId || !userId) return res.status(400).json({ error: 'Érvénytelen csapat vagy felhasználó azonosító.' });

    try {
        const targetUser = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
        if (!targetUser.rowCount) return res.status(404).json({ error: 'A felhasználó nem található.' });

        await pool.query(
            'UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3',
            [role, teamId, userId]
        );
        await pool.query(
            'UPDATE users SET team_id = $1, team_role = $2 WHERE id = $3',
            [teamId, role, userId]
        );
        await recordAuditEvent({ userId: req.user.id, action: 'team_member_role_changed', entityType: 'team_member', entityId: userId, details: { teamId, username: targetUser.rows[0].username, role }, req });

        res.json({ success: true, userId, role });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A szerep frissítése nem sikerült.' });
    }
});

app.delete('/api/teams/:id/members/:userId', requireTeamAdmin, async (req, res) => {
    const teamId = Number(req.params.id);
    const userId = Number(req.params.userId);

    if (!teamId || !userId) return res.status(400).json({ error: 'Érvénytelen csapat vagy felhasználó azonosító.' });

    try {
        const team = await pool.query('SELECT owner_user_id FROM teams WHERE id = $1', [teamId]);
        if (!team.rowCount) return res.status(404).json({ error: 'A csapat nem található.' });
        if (team.rows[0].owner_user_id === userId) return res.status(400).json({ error: 'A csapat tulajdonosa nem távolítható el.' });

        const targetUser = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
        await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
        await pool.query('UPDATE users SET team_id = NULL, team_role = $1 WHERE id = $2', ['member', userId]);
        await recordAuditEvent({ userId: req.user.id, action: 'team_member_removed', entityType: 'team_member', entityId: userId, details: { teamId, username: targetUser.rows[0]?.username || null }, req });

        res.json({ success: true, userId });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A tag eltávolítása nem sikerült.' });
    }
});

/** Lists every registered user for administrators, including verification/active status. */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.email, u.role, u.is_verified, u.is_active, u.created_at,
                    t.name AS team_name
             FROM users u
             LEFT JOIN teams t ON t.id = u.team_id
             ORDER BY u.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'A felhasználók nem tölthetők be.' });
    }
});

/** Lets an administrator manually verify/activate or deactivate a registered user. */
app.put('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    const isVerified = req.body.isVerified === undefined ? undefined : Boolean(req.body.isVerified);
    const isActive = req.body.isActive === undefined ? undefined : Boolean(req.body.isActive);
    if (!Number.isInteger(userId) || (isVerified === undefined && isActive === undefined)) {
        return res.status(400).json({ error: 'Érvénytelen kérés.' });
    }
    if (userId === req.user.id && isActive === false) {
        return res.status(400).json({ error: 'A saját fiókodat nem tudod deaktiválni.' });
    }
    try {
        const sets = [];
        const values = [];
        let idx = 1;
        if (isVerified !== undefined) {
            sets.push(`is_verified = $${idx++}`);
            values.push(isVerified);
            if (isVerified) { sets.push('verification_token_hash = NULL'); sets.push('verification_expires_at = NULL'); }
        }
        if (isActive !== undefined) {
            sets.push(`is_active = $${idx++}`);
            values.push(isActive);
        }
        values.push(userId);
        const result = await pool.query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, username, email, role, is_verified, is_active`,
            values
        );
        if (!result.rowCount) return res.status(404).json({ error: 'A felhasználó nem található.' });
        if (isActive === false) await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await recordAuditEvent({ userId: req.user.id, action: 'admin_user_status_updated', entityType: 'user', entityId: userId, details: { isVerified, isActive }, req });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'A felhasználó státusza nem frissíthető.' });
    }
});

app.get('/api/admin/audit-events', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ae.*, u.username AS actor_username
             FROM audit_events ae
             LEFT JOIN users u ON u.id = ae.user_id
             ORDER BY ae.created_at DESC LIMIT 200`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Az audit log nem tölthető be.' });
    }
});

app.get('/api/admin/backup/export', requireAdmin, async (req, res) => {
    try {
        const tables = await Promise.all([
            pool.query('SELECT * FROM users ORDER BY id'),
            pool.query('SELECT * FROM teams ORDER BY id'),
            pool.query('SELECT * FROM bookmarks ORDER BY id'),
            pool.query('SELECT * FROM tags ORDER BY id'),
            pool.query('SELECT * FROM bookmark_tags ORDER BY bookmark_id, tag_id'),
            pool.query('SELECT * FROM settings_app ORDER BY key'),
            pool.query('SELECT * FROM settings_user ORDER BY user_id, setting_key')
        ]);
        const payload = {
            exportedAt: new Date().toISOString(),
            schemaVersion: 1,
            data: {
                users: tables[0].rows,
                teams: tables[1].rows,
                bookmarks: tables[2].rows,
                tags: tables[3].rows,
                bookmark_tags: tables[4].rows,
                settings_app: tables[5].rows,
                settings_user: tables[6].rows
            }
        };
        res.type('application/json').attachment('cloudmark-backup.json').send(JSON.stringify(payload, null, 2));
        await recordAuditEvent({ userId: req.user.id, action: 'backup_exported', entityType: 'backup', details: { exportRows: payload.data.bookmarks.length }, req });
    } catch (err) {
        res.status(500).json({ error: 'A biztonsági mentés exportálása nem sikerült.' });
    }
});

app.post('/api/admin/backup/import', requireAdmin, async (req, res) => {
    try {
        const payload = req.body || {};
        const data = payload.data || {};
        if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Érvénytelen mentési csomag.' });

        const tables = ['users', 'teams', 'settings_app', 'settings_user', 'tags', 'bookmarks', 'bookmark_tags'];
        for (const table of tables) {
            const rows = Array.isArray(data[table]) ? data[table] : [];
            if (!rows.length) continue;
            if (table === 'users') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO users (id, username, email, password_hash, role, is_verified, verification_token_hash, verification_expires_at, team_id, team_role, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                         ON CONFLICT (id) DO UPDATE SET
                           username = EXCLUDED.username,
                           email = EXCLUDED.email,
                           password_hash = EXCLUDED.password_hash,
                           role = EXCLUDED.role,
                           is_verified = EXCLUDED.is_verified,
                           verification_token_hash = EXCLUDED.verification_token_hash,
                           verification_expires_at = EXCLUDED.verification_expires_at,
                           team_id = EXCLUDED.team_id,
                           team_role = EXCLUDED.team_role`,
                        [row.id, row.username, row.email, row.password_hash, row.role || 'user', Boolean(row.is_verified), row.verification_token_hash, row.verification_expires_at, row.team_id || null, row.team_role || 'member', row.created_at]
                    );
                }
                continue;
            }
            if (table === 'teams') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO teams (id, name, owner_user_id, created_at) VALUES ($1, $2, $3, $4)
                         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_user_id = EXCLUDED.owner_user_id`,
                        [row.id, row.name, row.owner_user_id, row.created_at]
                    );
                }
                continue;
            }
            if (table === 'settings_app') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO settings_app (key, value, updated_at) VALUES ($1, $2, $3)
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                        [row.key, row.value, row.updated_at]
                    );
                }
                continue;
            }
            if (table === 'settings_user') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO settings_user (user_id, setting_key, value, updated_at) VALUES ($1, $2, $3, $4)
                         ON CONFLICT (user_id, setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                        [row.user_id, row.setting_key, row.value, row.updated_at]
                    );
                }
                continue;
            }
            if (table === 'tags') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO tags (id, user_id, name) VALUES ($1, $2, $3)
                         ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name`,
                        [row.id, row.user_id, row.name]
                    );
                }
                continue;
            }
            if (table === 'bookmarks') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO bookmarks (id, user_id, title, url, category, clicks, created_at, metadata_title, image_url, description, site_name, archived, starred, status, trashed, normalized_url)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                         ON CONFLICT (id) DO UPDATE SET
                           user_id = EXCLUDED.user_id,
                           title = EXCLUDED.title,
                           url = EXCLUDED.url,
                           category = EXCLUDED.category,
                           clicks = EXCLUDED.clicks,
                           metadata_title = EXCLUDED.metadata_title,
                           image_url = EXCLUDED.image_url,
                           description = EXCLUDED.description,
                           site_name = EXCLUDED.site_name,
                           archived = EXCLUDED.archived,
                           starred = EXCLUDED.starred,
                           status = EXCLUDED.status,
                           trashed = EXCLUDED.trashed,
                           normalized_url = EXCLUDED.normalized_url`,
                        [row.id, row.user_id, row.title, row.url, row.category, row.clicks || 0, row.created_at, row.metadata_title, row.image_url, row.description, row.site_name, Boolean(row.archived), Boolean(row.starred), row.status || 'inbox', Boolean(row.trashed), row.normalized_url]
                    );
                }
                continue;
            }
            if (table === 'bookmark_tags') {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES ($1, $2)
                         ON CONFLICT (bookmark_id, tag_id) DO NOTHING`,
                        [row.bookmark_id, row.tag_id]
                    );
                }
            }
        }
        await recordAuditEvent({ userId: req.user.id, action: 'backup_imported', entityType: 'backup', details: { importedTables: tables }, req });
        res.json({ success: true, importedTables: tables });
    } catch (err) {
        res.status(500).json({ error: err.message || 'A mentés visszaállítása nem sikerült.' });
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
        const appSettings = await getAppSettings();
        const requireVerification = appSettings.requireEmailVerification !== false;

        if (!requireVerification) {
            const result = await pool.query(
                `INSERT INTO users (username, email, password_hash, is_verified)
                 VALUES ($1, $2, $3, TRUE)
                 RETURNING id, username, email, role`,
                [username, email, passwordHash]
            );
            const user = result.rows[0];
            await createDefaultTeamForUser(user.id, user.username);
            await recordAuditEvent({ userId: user.id, action: 'user_registered', entityType: 'user', entityId: user.id, details: { email, autoVerified: true }, req });
            res.status(201).json({ verificationRequired: false, email: user.email });
            return;
        }

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationMinutes = Number(appSettings.verificationMinutes) || DEFAULT_APP_SETTINGS.verificationMinutes;
        const verificationExpiresAt = new Date(Date.now() + verificationMinutes * 60 * 1000);
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, is_verified, verification_token_hash, verification_expires_at)
             VALUES ($1, $2, $3, FALSE, $4, $5)
             RETURNING id, username, email, role`,
            [username, email, passwordHash, hashVerificationToken(verificationToken), verificationExpiresAt]
        );
        const user = result.rows[0];
        await createDefaultTeamForUser(user.id, user.username);
        await recordAuditEvent({ userId: user.id, action: 'user_registered', entityType: 'user', entityId: user.id, details: { email }, req });

        try {
            const emailSent = await sendVerificationEmail(req, email, verificationToken);
            res.status(201).json({
                verificationRequired: true,
                email: user.email,
                emailSent,
                verificationUrl: !emailSent ? `${getPublicBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}` : undefined
            });
            return;
        } catch (mailError) {
            console.error('[AUTH] Registration email delivery failed:', mailError.message || mailError);
            res.status(201).json({
                verificationRequired: true,
                email: user.email,
                emailSent: false,
                verificationUrl: `${getPublicBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`
            });
            return;
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
            'SELECT id, username, email, password_hash, role, team_id, team_role, is_verified, is_active FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó.' });
        }
        if (!user.is_verified) return res.status(403).json({ error: 'Előbb erősítsd meg az e-mail címedet.' });
        if (!user.is_active) return res.status(403).json({ error: 'A fiókod fel van függesztve. Vedd fel a kapcsolatot az adminisztrátorral.' });
        if (!user.team_id) await createDefaultTeamForUser(user.id, user.username);
        await createSession(user, res);
        await recordAuditEvent({ userId: user.id, action: 'login', entityType: 'user', entityId: user.id, req });
        res.json({ id: user.id, username: user.username, email: user.email, role: user.role, teamId: user.team_id, teamRole: user.team_role, isSuperuser: user.role === 'admin' });
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

/** Returns bookmarks visible to the current session, keeping public demo/admin entries public. */
app.get('/api/bookmarks', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        let query = `SELECT b.*, COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
                     FROM bookmarks b LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
                     LEFT JOIN tags t ON t.id = bt.tag_id`;
        let params = [];
        const conditions = [];

        if (user) {
            if (user.role === 'admin') {
                // administrators can search the complete collection
            } else {
                const userIds = [...new Set([
                    String(user.username || '').toLowerCase(),
                    String(user.id || '').toLowerCase(),
                    'demo',
                    'admin'
                ].filter(Boolean))];
                conditions.push('LOWER(CAST(b.user_id AS TEXT)) = ANY($1)');
                params = [userIds];
            }
        } else {
            conditions.push('LOWER(CAST(b.user_id AS TEXT)) = ANY($1)');
            params = [['demo', 'admin', 'main']];
        }
        if (req.query.q) {
            params.push(`%${String(req.query.q).slice(0, 200)}%`);
            conditions.push(`(b.title ILIKE $${params.length} OR b.url ILIKE $${params.length} OR b.category ILIKE $${params.length} OR b.description ILIKE $${params.length} OR t.name ILIKE $${params.length})`);
        }
        if (req.query.tag) {
            params.push(String(req.query.tag).slice(0, 80));
            conditions.push(`t.name = $${params.length}`);
        }
        if (req.query.all !== 'true') {
            if (req.query.trash === 'true') conditions.push('b.trashed = TRUE');
            else {
                conditions.push('b.trashed = FALSE');
                if (req.query.archived !== 'true') conditions.push('b.archived = FALSE');
            }
        }
        if (req.query.status && ['inbox', 'read_later', 'to_review', 'done'].includes(req.query.status)) conditions.push(`b.status = $${params.length + 1}`), params.push(req.query.status);
        if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
        query += ' GROUP BY b.id ORDER BY b.created_at DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Creates a bookmark for the requested user. */
app.post('/api/bookmarks', requireAuth, async (req, res) => {
    const { title, url, category, tags = [], status = 'inbox', starred = false, description } = req.body;
    const normalizedUrl = normalizeBookmarkUrl(url);
    if (!normalizedUrl) return res.status(400).json({ error: 'Érvénytelen URL.' });
    if (!['inbox', 'read_later', 'to_review', 'done'].includes(status)) return res.status(400).json({ error: 'Érvénytelen állapot.' });
    try {
        const duplicate = await pool.query('SELECT id, title FROM bookmarks WHERE user_id = $1 AND normalized_url = $2 AND trashed = FALSE LIMIT 1', [req.user.username, normalizedUrl]);
        if (duplicate.rows.length) return res.status(409).json({ error: 'Ez a hivatkozás már szerepel a könyvjelzőid között.', duplicate: duplicate.rows[0] });
        const fetchTitle = await shouldFetchWebsiteMetadataTitle(req.user.id);
        const fetchImage = await shouldFetchWebsiteMetadataImage(req.user.id);
        const metadata = (fetchTitle || fetchImage) ? await fetchBookmarkMetadata(url) : {};
        const resolvedTitle = resolveBookmarkTitle(title, metadata, url);
        const resolvedDescription = String(description || '').trim() || metadata.description || null;
        const result = await pool.query(
            `INSERT INTO bookmarks (user_id, title, url, category, metadata_title, image_url, description, site_name, status, starred, normalized_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [
                req.user.username,
                resolvedTitle,
                url,
                category,
                fetchTitle ? metadata.title : null,
                fetchImage ? metadata.imageUrl : null,
                resolvedDescription,
                metadata.siteName,
                status,
                Boolean(starred),
                normalizedUrl
            ]
        );
        await replaceBookmarkTags(result.rows[0].id, req.user.id, tags);
        await recordAuditEvent({ userId: req.user.id, action: 'bookmark_created', entityType: 'bookmark', entityId: result.rows[0].id, details: { title: resolvedTitle, category, status, url: normalizedUrl }, req });
        res.status(201).json({ ...result.rows[0], tags: normalizeTags(tags) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Moves a bookmark to the trash; permanent deletion is available via the trash action. */
app.delete('/api/bookmarks/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        let result;
        if (req.user.role === 'admin') {
            result = await pool.query('UPDATE bookmarks SET trashed = TRUE, archived = FALSE WHERE id = $1 RETURNING id', [id]);
        } else {
            result = await pool.query(
                'UPDATE bookmarks SET trashed = TRUE, archived = FALSE WHERE id = $1 AND (LOWER(CAST(user_id AS TEXT)) = LOWER($2) OR LOWER(CAST(user_id AS TEXT)) = LOWER($3))',
                [id, req.user.username, String(req.user.id)]
            );
        }
        if (!result.rowCount) return res.status(404).json({ error: 'A könyvjelző nem található.' });
        await recordAuditEvent({ userId: req.user.id, action: 'bookmark_trashed', entityType: 'bookmark', entityId: Number(id), details: { trashed: true }, req });
        res.json({ message: 'Könyvjelző sikeresen törölve' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/bookmarks/:id/state', requireAuth, async (req, res) => {
    const { archived, trashed, starred, status } = req.body;
    const fields = [], values = [req.params.id];
    if (archived !== undefined) { fields.push(`archived = $${values.length + 1}`); values.push(Boolean(archived)); }
    if (trashed !== undefined) { fields.push(`trashed = $${values.length + 1}`); values.push(Boolean(trashed)); }
    if (starred !== undefined) { fields.push(`starred = $${values.length + 1}`); values.push(Boolean(starred)); }
    if (status !== undefined) { if (!['inbox', 'read_later', 'to_review', 'done'].includes(status)) return res.status(400).json({ error: 'Érvénytelen állapot.' }); fields.push(`status = $${values.length + 1}`); values.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'Nincs módosítandó állapot.' });
    let owner = '';
    if (req.user.role !== 'admin') {
        values.push(req.user.username, String(req.user.id));
        owner = ' AND (LOWER(CAST(user_id AS TEXT)) = LOWER($' + (values.length - 1) + ') OR LOWER(CAST(user_id AS TEXT)) = LOWER($' + values.length + '))';
    }
    try {
        const result = await pool.query(`UPDATE bookmarks SET ${fields.join(', ')} WHERE id = $1${owner} RETURNING *`, values);
        if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
        await recordAuditEvent({ userId: req.user.id, action: 'bookmark_state_updated', entityType: 'bookmark', entityId: Number(req.params.id), details: { fields: Object.keys(req.body), archived, trashed, starred, status }, req });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bookmarks/:id/permanent', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM bookmarks WHERE id = $1 AND trashed = TRUE AND (user_id = $2 OR user_id = $3) RETURNING id', [req.params.id, req.user.username, String(req.user.id)]);
        if (!result.rowCount && req.user.role !== 'admin') return res.status(404).json({ error: 'Not found' });
        if (req.user.role === 'admin') await pool.query('DELETE FROM bookmarks WHERE id = $1 AND trashed = TRUE', [req.params.id]);
        await recordAuditEvent({ userId: req.user.id, action: 'bookmark_deleted_permanent', entityType: 'bookmark', entityId: Number(req.params.id), details: { permanent: true }, req });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookmarks/bulk', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0) : [];
    const action = String(req.body?.action || '').trim();
    if (!ids.length) return res.status(400).json({ error: 'Legalább egy könyvjelző kiválasztása szükséges.' });

    try {
        let query = '';
        let params = [ids];
        let userAwareFilter = '';
        if (req.user.role !== 'admin') {
            const userIds = [...new Set([
                String(req.user.username || '').toLowerCase(),
                String(req.user.id || '').toLowerCase(),
                'demo',
                'admin'
            ].filter(Boolean))];
            params.push(userIds);
            userAwareFilter = ' AND LOWER(CAST(user_id AS TEXT)) = ANY($2)';
        }

        if (['archive', 'restore', 'trash', 'star', 'unstar', 'status', 'category', 'delete'].includes(action)) {
            const fields = [];
            if (action === 'archive') fields.push('archived = TRUE');
            if (action === 'restore') fields.push('archived = FALSE', 'trashed = FALSE');
            if (action === 'trash' || action === 'delete') fields.push('trashed = TRUE', 'archived = FALSE');
            if (action === 'star') fields.push('starred = TRUE');
            if (action === 'unstar') fields.push('starred = FALSE');
            if (action === 'status') {
                const status = String(req.body?.status || '').trim();
                if (!['inbox', 'read_later', 'to_review', 'done'].includes(status)) return res.status(400).json({ error: 'Érvénytelen állapot.' });
                fields.push(`status = $${params.length + 1}`);
                params.push(status);
            }
            if (action === 'category') {
                const category = String(req.body?.category || '').trim();
                if (!category) return res.status(400).json({ error: 'Kategória megadása kötelező.' });
                fields.push(`category = $${params.length + 1}`);
                params.push(category);
            }
            if (!fields.length) return res.status(400).json({ error: 'Nincs módosítandó művelet.' });
            query = `UPDATE bookmarks SET ${fields.join(', ')} WHERE id = ANY($1)${userAwareFilter} RETURNING *`;
            const result = await pool.query(query, params);
            await recordAuditEvent({ userId: req.user.id, action: `bookmark_bulk_${action === 'delete' ? 'trash' : action}`, entityType: 'bookmark', details: { count: result.rowCount, ids, category: req.body?.category }, req });
            return res.json({ updated: result.rowCount, action: action === 'delete' ? 'trash' : action });
        }

        return res.status(400).json({ error: 'Ismeretlen tömeges művelet.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Updates a bookmark's title, URL, and category. */
app.put('/api/bookmarks/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { title, url, category, tags = [], status, starred, description } = req.body;
    const normalizedUrl = normalizeBookmarkUrl(url);
    if (!normalizedUrl) return res.status(400).json({ error: 'Érvénytelen URL.' });
    try {
        const fetchTitle = await shouldFetchWebsiteMetadataTitle(req.user.id);
        const fetchImage = await shouldFetchWebsiteMetadataImage(req.user.id);
        const metadata = (fetchTitle || fetchImage) ? await fetchBookmarkMetadata(url) : {};
        const resolvedTitle = resolveBookmarkTitle(title, metadata, url);
        const resolvedDescription = description !== undefined ? (String(description || '').trim() || null) : undefined;
        
        let query = `UPDATE bookmarks SET title = $1, url = $2, category = $3, metadata_title = $5, image_url = $6, site_name = $7, normalized_url = $8`;
        let params = [resolvedTitle, url, category, id, fetchTitle ? metadata.title : null, fetchImage ? metadata.imageUrl : null, metadata.siteName, normalizedUrl];
        
        if (resolvedDescription !== undefined) {
            query += `, description = $${params.length + 1}`;
            params.push(resolvedDescription);
        } else if (metadata.description) {
            query += `, description = COALESCE(description, $${params.length + 1})`;
            params.push(metadata.description);
        }

        if (status !== undefined) { if (!['inbox', 'read_later', 'to_review', 'done'].includes(status)) return res.status(400).json({ error: 'Érvénytelen állapot.' }); query += `, status = $${params.length + 1}`; params.push(status); }
        if (starred !== undefined) { query += `, starred = $${params.length + 1}`; params.push(Boolean(starred)); }
        
        query += ' WHERE id = $4';
        if (req.user.role !== 'admin') {
            query += ` AND (LOWER(CAST(user_id AS TEXT)) = LOWER($${params.length + 1}) OR LOWER(CAST(user_id AS TEXT)) = LOWER($${params.length + 2}))`;
            params.push(req.user.username, String(req.user.id));
        }
        query += ' RETURNING *';
        const result = await pool.query(query, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        await replaceBookmarkTags(result.rows[0].id, req.user.id, tags);
        await recordAuditEvent({ userId: req.user.id, action: 'bookmark_updated', entityType: 'bookmark', entityId: Number(id), details: { title: resolvedTitle, category, status, url: normalizedUrl, tags: normalizeTags(tags) }, req });
        res.json({ ...result.rows[0], tags: normalizeTags(tags) });
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

app.post('/api/tags', requireAuth, async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 80) return res.status(400).json({ error: 'Érvénytelen címke név' });
    try {
        const existing = await pool.query('SELECT id FROM tags WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [req.user.id, name]);
        if (existing.rowCount) return res.status(409).json({ error: 'A címke már létezik' });
        const result = await pool.query('INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING name', [req.user.id, name]);
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tags', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT name FROM tags WHERE user_id = $1 ORDER BY name', [req.user.id]);
        res.json(result.rows.map(row => row.name));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tags/:name', requireAuth, async (req, res) => {
    const oldName = req.params.name.trim();
    const newName = String(req.body.newName || '').trim();
    if (!newName || newName.length > 80) return res.status(400).json({ error: 'Érvénytelen címke' });
    try {
        const existing = await pool.query('SELECT id FROM tags WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [req.user.id, newName]);
        if (existing.rowCount && oldName.toLowerCase() !== newName.toLowerCase()) return res.status(409).json({ error: 'A címke már létezik' });
        const result = await pool.query('UPDATE tags SET name = $1 WHERE user_id = $2 AND name = $3 RETURNING name', [newName, req.user.id, oldName]);
        if (!result.rowCount) return res.status(404).json({ error: 'Címke nem található' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tags/:name', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM tags WHERE user_id = $1 AND name = $2 RETURNING id', [req.user.id, req.params.name.trim()]);
        if (!result.rowCount) return res.status(404).json({ error: 'Címke nem található' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookmarks/import', requireAuth, async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : (req.body.bookmarks || []);
    const targetCategory = String(req.body.targetCategory || '').trim() || null;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'bookmarks tömb szükséges' });
    let imported = 0;
    try {
        for (const item of items.slice(0, 5000)) {
            if (!item.url) continue;
            const normalizedUrl = normalizeBookmarkUrl(item.url);
            if (!normalizedUrl) continue;
            const duplicate = await pool.query('SELECT id FROM bookmarks WHERE user_id = $1 AND normalized_url = $2 AND trashed = FALSE LIMIT 1', [req.user.username, normalizedUrl]);
            if (duplicate.rowCount) continue;
            const title = resolveBookmarkTitle(item.title, {}, item.url);
            const fallbackCategory = targetCategory || item.category || 'Inbox';
            const row = await pool.query(
                `INSERT INTO bookmarks (user_id,title,url,category,description,starred,normalized_url,status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                [req.user.username, title, item.url, fallbackCategory, item.description || null, Boolean(item.starred), normalizedUrl, ['inbox', 'read_later', 'to_review', 'done'].includes(item.status) ? item.status : 'inbox']
            );
            await replaceBookmarkTags(row.rows[0].id, req.user.id, item.tags || []);
            imported++;
        }
        res.status(201).json({ imported });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bookmarks/export', requireAuth, async (req, res) => {
    try {
        const idsQuery = String(req.query.ids || '').split(',').map(value => Number(value.trim())).filter(Number.isFinite);
        const filters = [];
        const params = [req.user.username, String(req.user.id)];
        let index = 2;

        if (idsQuery.length) {
            index += 1;
            filters.push(`b.id = ANY($${index}::int[])`);
            params.push(idsQuery);
        }

        if (req.query.category && String(req.query.category).trim() && String(req.query.category).trim() !== 'All') {
            index += 1;
            filters.push(`b.category = $${index}`);
            params.push(String(req.query.category).trim());
        }

        if (req.query.state && String(req.query.state).trim() && String(req.query.state).trim() !== 'active') {
            const stateValue = String(req.query.state).trim();
            index += 1;
            if (stateValue === 'starred') {
                filters.push(`b.starred = TRUE`);
            } else if (stateValue === 'archived') {
                filters.push(`b.archived = TRUE`);
            } else if (stateValue === 'trash') {
                filters.push(`b.trashed = TRUE`);
            } else if (['read_later', 'to_review', 'done'].includes(stateValue)) {
                filters.push(`b.status = $${index}`);
                params.push(stateValue);
            }
        }

        if (req.query.search && String(req.query.search).trim()) {
            const searchValue = `%${String(req.query.search).trim().toLowerCase()}%`;
            index += 1;
            filters.push(`(LOWER(COALESCE(b.title, '')) LIKE $${index} OR LOWER(COALESCE(b.url, '')) LIKE $${index} OR LOWER(COALESCE(b.category, '')) LIKE $${index} OR LOWER(COALESCE(b.description, '')) LIKE $${index})`);
            params.push(searchValue);
        }

        if (req.query.tag && String(req.query.tag).trim()) {
            const tagName = String(req.query.tag).trim();
            const tagQuery = `EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND LOWER(t.name) = LOWER($${index + 1}))`;
            index += 1;
            filters.push(tagQuery);
            params.push(tagName);
        }

        const whereClause = filters.length ? `AND ${filters.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT b.*, COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') tags
             FROM bookmarks b LEFT JOIN bookmark_tags bt ON bt.bookmark_id=b.id
             LEFT JOIN tags t ON t.id=bt.tag_id
             WHERE LOWER(CAST(b.user_id AS TEXT)) IN (LOWER($1), LOWER($2)) ${whereClause}
             GROUP BY b.id ORDER BY b.created_at DESC`,
            params
        );
        if ((req.query.format || 'json').toLowerCase() === 'html') {
            const esc = value => String(value || '').replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>CloudMark export</TITLE><DL><p>\n' +
                result.rows.map(b => `<DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor(new Date(b.created_at).getTime()/1000)}">${esc(b.title)}</A>`).join('\n') + '\n</DL><p>';
            res.type('application/x-netscape-bookmark').attachment('cloudmark-bookmarks.html').send(html);
        } else {
            res.type('application/json').attachment('cloudmark-bookmarks.json').send(JSON.stringify(result.rows, null, 2));
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookmarks/:id/share', requireAuth, async (req, res) => {
    try {
        const owned = await pool.query('SELECT id FROM bookmarks WHERE id=$1 AND (user_id=$2 OR user_id=$3)', [req.params.id, req.user.username, String(req.user.id)]);
        if (!owned.rows.length) return res.status(404).json({ error: 'Not found' });
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query('INSERT INTO bookmark_shares (bookmark_id,token,permission,expires_at) VALUES ($1,$2,$3,$4)', [req.params.id, token, req.body.permission === 'edit' ? 'edit' : 'view', req.body.expiresAt || null]);
        res.status(201).json({ token, url: `${getPublicBaseUrl(req)}/share/${token}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shares/:token', async (req, res) => {
    try {
        const result = await pool.query(`SELECT b.*, s.permission FROM bookmark_shares s JOIN bookmarks b ON b.id=s.bookmark_id WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`, [req.params.token]);
        if (!result.rows.length) return res.status(404).json({ error: 'A megosztási hivatkozás lejárt vagy érvénytelen' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


/** Returns category names in their database order. */
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, parent_id FROM categories ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Creates a category and returns the refreshed category list. */
app.post('/api/categories', async (req, res) => {
    const { name, parentId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Missing name' });
    try {
        const parent = parentId === null || parentId === undefined || parentId === '' ? null : Number(parentId);
        if (parent !== null && (!Number.isInteger(parent) || !(await pool.query('SELECT 1 FROM categories WHERE id = $1', [parent])).rowCount)) {
            return res.status(400).json({ error: 'Érvénytelen szülőkategória.' });
        }
        await pool.query('INSERT INTO categories (name, parent_id) VALUES ($1, $2)', [name.trim(), parent]);
        const result = await pool.query('SELECT id, name, parent_id FROM categories ORDER BY id ASC');
        res.status(201).json(result.rows);
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
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const renamed = await client.query('UPDATE categories SET name = $1 WHERE name = $2 RETURNING id', [newName.trim(), oldName]);
            if (!renamed.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'A kategória nem található.' }); }
            await client.query('UPDATE bookmarks SET category = $1 WHERE category = $2', [newName.trim(), oldName]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

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
        if (catName === 'Inbox') return res.status(400).json({ error: 'Az Inbox nem törölhető.' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const deleted = await client.query('DELETE FROM categories WHERE name = $1 RETURNING id', [catName]);
            if (!deleted.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'A kategória nem található.' }); }
            await client.query('UPDATE bookmarks SET category = $1 WHERE category = $2', ['Inbox', catName]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        
        // Ha külön kategória táblád van:

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
        res.json({
            ...smtp,
            provider: smtp.provider || 'smtp',
            password: '',
            apiKey: '',
            passwordConfigured: Boolean(smtp.password),
            apiKeyConfigured: Boolean(smtp.apiKey)
        });
    } catch (err) {
        res.status(500).json({ error: 'Az SMTP beállítások nem tölthetők be.' });
    }
});

/** Checks raw TCP reachability to an SMTP host/port, bypassing TLS/auth to isolate network blocks. */
app.post('/api/admin/smtp-ping', requireAdmin, async (req, res) => {
    const host = String(req.body?.host || 'smtp.gmail.com');
    const port = Number(req.body?.port || 587);
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        res.json({ host, port, elapsedMs: Date.now() - start, ...result });
    };

    socket.setTimeout(8000);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, error: 'timeout' }));
    socket.once('error', (err) => finish({ reachable: false, error: err.message, code: err.code }));
    socket.connect(port, host);
});

/** Sends a test email using either the SMTP transport or the configured HTTPS email API provider. */
app.post('/api/admin/smtp-test', requireAdmin, async (req, res) => {
    try {
        const incoming = req.body || {};
        const existing = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
        const saved = existing.rows[0]?.value || {};
        const provider = incoming.provider || saved.provider || 'smtp';

        const settings = {
            provider,
            apiKey: incoming.apiKey || saved.apiKey,
            from: incoming.from || saved.from || incoming.user || saved.user || process.env.SMTP_FROM,
            user: incoming.user || saved.user || process.env.SMTP_USER,
            password: incoming.password || saved.password || process.env.SMTP_PASSWORD,
            host: incoming.host || saved.host || process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(incoming.port ?? saved.port ?? process.env.SMTP_PORT ?? 587),
            secure: Boolean(incoming.secure ?? saved.secure ?? (String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'))
        };
        const to = incoming.to || settings.user || settings.from;

        if (provider === 'resend' || provider === 'sendgrid') {
            if (!settings.apiKey || !settings.from) {
                return res.status(400).json({ error: 'Az API kulcs és a küldő e-mail cím megadása kötelező.' });
            }
        } else if (!settings.from || !settings.user || !settings.host || !Number(settings.port) || !settings.password) {
            return res.status(400).json({ error: 'Az SMTP teszteléshez a küldő, felhasználó, host, port és jelszó megadása kötelező.' });
        }

        const info = await sendEmailWithConfig(settings, {
            to,
            subject: 'CloudMark teszt e-mail',
            text: 'Ez egy teszt üzenet a CloudMark alkalmazásból. Ha megérkezett, az e-mail küldési beállítás működik.',
            html: '<p>Ez egy teszt üzenet a CloudMark alkalmazásból.</p><p>Ha megérkezett, az e-mail küldési beállítás működik.</p>'
        });

        res.json({ success: true, messageId: info.messageId, response: info.response, to, provider });
    } catch (err) {
        console.error('[EMAIL TEST] failed:', err.message || err);
        res.status(500).json({ error: err.message || 'A teszt e-mail küldése nem sikerült.' });
    }
});

/** Stores email delivery settings (SMTP or HTTPS API provider) submitted by an authenticated administrator. */
app.put('/api/admin/smtp-config', requireAdmin, async (req, res) => {
    const { provider = 'smtp', from, user, password, host, port, secure, apiKey } = req.body;
    const existing = await pool.query("SELECT value FROM settings_app WHERE key = 'smtp'");
    const existingSettings = existing.rows[0]?.value || {};

    let settings;
    if (provider === 'resend' || provider === 'sendgrid') {
        if (!from) return res.status(400).json({ error: 'A küldő e-mail cím megadása kötelező.' });
        const resolvedApiKey = apiKey || existingSettings.apiKey || '';
        if (!resolvedApiKey) return res.status(400).json({ error: 'Az API kulcs megadása kötelező az első mentéskor.' });
        settings = { provider, from, apiKey: resolvedApiKey };
    } else {
        if (!from || !user || !host || !Number(port)) {
            return res.status(400).json({ error: 'A küldő, felhasználó, szerver és port megadása kötelező.' });
        }
        const existingPassword = existingSettings.password || '';
        settings = { provider: 'smtp', from, user, password: password || existingPassword, host, port: Number(port), secure: Boolean(secure) };
        if (!settings.password) return res.status(400).json({ error: 'Az SMTP jelszó megadása kötelező az első mentéskor.' });
    }

    try {
        await pool.query(
            `INSERT INTO settings_app (key, value, updated_at) VALUES ('smtp', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [JSON.stringify(settings)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Az e-mail beállítások mentése nem sikerült.' });
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
    const allowedKeys = ['theme', 'viewMode', 'sortMode', 'fetchMetadata', 'fetchMetadataTitle', 'fetchMetadataImage'];
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

/** Returns non-sensitive public app settings for all visitors (e.g. pagination page size). */
app.get('/api/public-config', async (req, res) => {
    try {
        const settings = await getAppSettings();
        res.json({ bookmarksPerPage: settings.bookmarksPerPage });
    } catch (err) {
        res.json({ bookmarksPerPage: DEFAULT_APP_SETTINGS.bookmarksPerPage });
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
    const requireEmailVerification = Boolean(req.body.requireEmailVerification);
    const bookmarksPerPage = Number(req.body.bookmarksPerPage);
    if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365 || !Number.isInteger(verificationMinutes) || verificationMinutes < 5 || verificationMinutes > 1440
        || !Number.isInteger(bookmarksPerPage) || bookmarksPerPage < 5 || bookmarksPerPage > 500) {
        return res.status(400).json({ error: 'Érvénytelen app-beállítási érték.' });
    }
    try {
        const settings = { sessionDays, verificationMinutes, requireEmailVerification, bookmarksPerPage };
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
        const emailSent = await sendVerificationEmail(req, result.rows[0].email, token);
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