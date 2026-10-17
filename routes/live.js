/**
 * Élő frissítés: a böngészők egy nyitott SSE kapcsolatot tartanak a `GET /api/events` címen, és a szerver minden
 * sikeres mentés után szól azoknak, akik az érintett elemet látják (tulajdonos + elfogadott megosztások címzettjei).
 * Az üzenet csak azt mondja meg, mi változott (`{ type: 'item', id }`), a tartalmat a böngésző a meglévő
 * végpontokról tölti le, így a jogosultság ott dől el. Az üzenetek a szerver memóriájából mennek ki (egy példány fut).
 */

const HEARTBEAT_MS = 25000;
const MAX_CONNECTIONS_PER_USER = 5;
const MAX_TARGETS = 200;

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * What a successful mutating API request changed, from its method, path, body and JSON answer:
 * `{ items: [ids], bookmarks: [ids], shareId, share, scope }` or null when nothing others need to know about.
 * `share` means the bell of everyone involved should refresh too; `scope` ('items' | 'bookmarks') asks the
 * actor's other windows to reload a whole list (imports).
 */
function changeFromRequest(method, path, body = {}, answer = null) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())) return null;
    const clean = String(path || '').replace(/\/+$/, '');
    let match;
    if (clean === '/api/items/import') return { scope: 'items' };
    if (clean === '/api/items') {
        const id = parseId(answer?.id);
        return id ? { items: [id] } : null;
    }
    if ((match = clean.match(/^\/api\/items\/(\d+)(?:\/(state|permanent|complete|snooze|uncomplete))?$/))) {
        return { items: [Number(match[1])] };
    }
    // A széf (fiókok mesterjelszava) változott: a többi ablak újra lekéri, és törlés után zárol.
    if (clean === '/api/vault') return { scope: 'vault' };
    if (clean === '/api/bookmarks/import') return { scope: 'bookmarks' };
    if (clean === '/api/bookmarks') {
        const id = parseId(answer?.id);
        return id ? { bookmarks: [id] } : null;
    }
    if (clean === '/api/bookmarks/bulk') {
        const ids = (Array.isArray(body?.ids) ? body.ids : []).map(parseId).filter(Boolean).slice(0, MAX_TARGETS);
        return ids.length ? { bookmarks: ids, before: true } : null;
    }
    if ((match = clean.match(/^\/api\/bookmarks\/(\d+)(?:\/(state|permanent))?$/))) {
        return { bookmarks: [Number(match[1])] };
    }
    if (clean === '/api/shares') {
        const bookmarkId = parseId(body?.bookmarkId);
        if (bookmarkId) return { bookmarks: [bookmarkId], share: true };
        const itemId = parseId(body?.itemId);
        return itemId ? { items: [itemId], share: true } : null;
    }
    if ((match = clean.match(/^\/api\/shares\/(\d+)(?:\/(accept|decline))?$/))) {
        return { shareId: Number(match[1]), share: true };
    }
    return null;
}

/** Whether the audience has to be read before the route runs (the rows that tell who sees the thing may be gone after it). */
function needsAudienceBefore(method, change) {
    if (!change) return false;
    return String(method).toUpperCase() === 'DELETE' || Boolean(change.shareId) || Boolean(change.before);
}

/** One SSE frame. */
function frame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createLiveHub({ pool, heartbeatMs = HEARTBEAT_MS, maxPerUser = MAX_CONNECTIONS_PER_USER } = {}) {
    const clients = new Map(); // userId (string) → Set<{ res, clientId }>

    const heartbeat = setInterval(() => {
        for (const set of clients.values()) for (const client of set) client.res.write(': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    function connect(req, res) {
        const userId = String(req.user.id);
        const clientId = String(req.query.client || '').slice(0, 64);
        res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();
        res.write('retry: 5000\n\n');
        res.write(frame('hello', { at: new Date().toISOString() }));
        let set = clients.get(userId);
        if (!set) { set = new Set(); clients.set(userId, set); }
        // A legrégebbi kapcsolat zárul, ha valakinek túl sok ablaka van nyitva.
        while (set.size >= maxPerUser) {
            const oldest = set.values().next().value;
            set.delete(oldest);
            oldest.res.end();
        }
        const client = { res, clientId };
        set.add(client);
        req.on('close', () => {
            set.delete(client);
            if (!set.size && clients.get(userId) === set) clients.delete(userId);
        });
    }

    /** Sends an event to every open window of the given users, except the window that made the change. */
    function send(userIds, event, data, exceptClientId = null) {
        for (const userId of new Set([...userIds].map(String))) {
            const set = clients.get(userId);
            if (!set) continue;
            for (const client of set) {
                if (exceptClientId && client.clientId === exceptClientId) continue;
                client.res.write(frame(event, data));
            }
        }
    }

    /** Users who see one of the items: owners and accepted recipients, also through the parent task of a subtask. */
    async function itemAudience(ids, includePending = false) {
        if (!ids?.length) return [];
        const result = await pool.query(
            `WITH t AS (
                SELECT id FROM items WHERE id = ANY($1::bigint[])
                UNION SELECT parent_item_id FROM items WHERE id = ANY($1::bigint[]) AND parent_item_id IS NOT NULL
             )
             SELECT owner_user_id AS user_id FROM items WHERE id IN (SELECT id FROM t)
             UNION
             SELECT recipient_user_id FROM shares
             WHERE item_id IN (SELECT id FROM t) AND recipient_user_id IS NOT NULL AND ($2 OR status = 'accepted')`,
            [ids, includePending]
        );
        return result.rows.map(row => String(row.user_id));
    }

    /** Users who see one of the bookmarks: the owner (text user_id = username or id) and accepted recipients. */
    async function bookmarkAudience(ids, includePending = false) {
        if (!ids?.length) return [];
        const result = await pool.query(
            `SELECT u.id AS user_id FROM bookmarks b
             JOIN users u ON lower(u.username) = lower(b.user_id) OR u.id::text = b.user_id
             WHERE b.id = ANY($1::bigint[])
             UNION
             SELECT recipient_user_id FROM shares
             WHERE bookmark_id = ANY($1::bigint[]) AND recipient_user_id IS NOT NULL AND ($2 OR status = 'accepted')`,
            [ids, includePending]
        );
        return result.rows.map(row => String(row.user_id));
    }

    /** `{ users, items, bookmarks }` of a change: who to tell and which ids changed. */
    async function resolve(change) {
        const items = [...(change.items || [])];
        const bookmarks = [...(change.bookmarks || [])];
        const users = new Set();
        if (change.shareId) {
            const result = await pool.query('SELECT owner_user_id, recipient_user_id, item_id, bookmark_id FROM shares WHERE id = $1', [change.shareId]);
            const row = result.rows[0];
            if (row) {
                users.add(String(row.owner_user_id));
                if (row.recipient_user_id) users.add(String(row.recipient_user_id));
                if (row.item_id) items.push(Number(row.item_id));
                if (row.bookmark_id) bookmarks.push(Number(row.bookmark_id));
            }
        }
        for (const id of await itemAudience(items, Boolean(change.share))) users.add(id);
        for (const id of await bookmarkAudience(bookmarks, Boolean(change.share))) users.add(id);
        return { users, items, bookmarks };
    }

    function deliver(resolved, actorId, clientId, change) {
        const users = new Set(resolved.users);
        if (actorId) users.add(String(actorId));
        if (change.scope) send([String(actorId)], 'refresh', { scope: change.scope }, clientId);
        for (const id of new Set(resolved.items)) send(users, 'item', { id }, clientId);
        for (const id of new Set(resolved.bookmarks)) send(users, 'bookmark', { id }, clientId);
        // A csengő mindenkinél frissül, a változtatónál is (pl. elfogadott meghívó eltűnik a többi ablakában).
        if (change.share) send(users, 'notifications', {});
    }

    /**
     * Express middleware for every request: after a successful POST/PUT/PATCH/DELETE under /api it tells the
     * people involved. Must be registered before the routes; it never changes the request or the answer.
     */
    async function middleware(req, res, next) {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
        const change = changeFromRequest(req.method, req.path, req.body);
        let before = null;
        if (needsAudienceBefore(req.method, change) && req.headers.cookie) {
            before = await resolve(change).catch(() => null);
        }
        let answer = null;
        const json = res.json.bind(res);
        res.json = body => { answer = body; return json(body); };
        res.on('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;
            const final = changeFromRequest(req.method, req.path, req.body, answer);
            if (!final) return;
            const clientId = String(req.get('X-Client-Id') || '').slice(0, 64) || null;
            resolve(final).then(after => {
                if (before) {
                    before.users.forEach(id => after.users.add(id));
                    after.items.push(...before.items);
                    after.bookmarks.push(...before.bookmarks);
                }
                deliver(after, req.user.id, clientId, final);
            }).catch(err => console.warn('[LIVE] Értesítés sikertelen:', err.message || err));
        });
        next();
    }

    /** For changes made without a request user (e-mail / push „Kész” buttons). */
    async function notifyItem(itemId, actorId = null) {
        try {
            deliver(await resolve({ items: [itemId] }), actorId, null, {});
        } catch (err) {
            console.warn('[LIVE] Értesítés sikertelen:', err.message || err);
        }
    }

    function connectionCount(userId) {
        return clients.get(String(userId))?.size || 0;
    }

    function close() {
        clearInterval(heartbeat);
        for (const set of clients.values()) for (const client of set) client.res.end();
        clients.clear();
    }

    return { connect, send, middleware, notifyItem, resolve, connectionCount, close };
}

function registerLiveRoutes(app, { pool, requireAuth }) {
    const hub = createLiveHub({ pool });
    app.use(hub.middleware);
    app.get('/api/events', requireAuth, (req, res) => hub.connect(req, res));
    return hub;
}

module.exports = { changeFromRequest, needsAudienceBefore, createLiveHub, registerLiveRoutes };
