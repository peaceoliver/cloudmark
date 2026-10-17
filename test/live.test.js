const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { changeFromRequest, needsAudienceBefore, createLiveHub } = require('../routes/live');

test('item saves, state changes and task actions name the item', () => {
    assert.deepEqual(changeFromRequest('PUT', '/api/items/12', {}), { items: [12] });
    assert.deepEqual(changeFromRequest('PATCH', '/api/items/12/state', {}), { items: [12] });
    assert.deepEqual(changeFromRequest('POST', '/api/items/7/complete', {}), { items: [7] });
    assert.deepEqual(changeFromRequest('POST', '/api/items/7/snooze', {}), { items: [7] });
    assert.deepEqual(changeFromRequest('DELETE', '/api/items/7/permanent', {}), { items: [7] });
});

test('a new item is known from the answer', () => {
    assert.equal(changeFromRequest('POST', '/api/items', {}, null), null);
    assert.deepEqual(changeFromRequest('POST', '/api/items', {}, { id: 41, type: 'note' }), { items: [41] });
    assert.deepEqual(changeFromRequest('POST', '/api/bookmarks', {}, { id: '9' }), { bookmarks: [9] });
});

test('reads, use counters and clicks tell nobody', () => {
    assert.equal(changeFromRequest('GET', '/api/items/12', {}), null);
    assert.equal(changeFromRequest('POST', '/api/items/12/used', {}), null);
    assert.equal(changeFromRequest('POST', '/api/bookmarks/3/click', {}), null);
    assert.equal(changeFromRequest('POST', '/api/notifications/read', {}), null);
    assert.equal(changeFromRequest('POST', '/api/tasks/parse', {}), null);
});

test('imports refresh the actor’s whole list', () => {
    assert.deepEqual(changeFromRequest('POST', '/api/items/import', {}), { scope: 'items' });
    assert.deepEqual(changeFromRequest('POST', '/api/bookmarks/import', {}), { scope: 'bookmarks' });
});

test('bookmark bulk actions name every valid id', () => {
    assert.deepEqual(changeFromRequest('POST', '/api/bookmarks/bulk', { ids: [1, '2', 'x', -3] }), { bookmarks: [1, 2], before: true });
    assert.equal(changeFromRequest('POST', '/api/bookmarks/bulk', { ids: [] }), null);
});

test('share changes also refresh the bell', () => {
    assert.deepEqual(changeFromRequest('POST', '/api/shares', { itemId: 5 }), { items: [5], share: true });
    assert.deepEqual(changeFromRequest('POST', '/api/shares', { bookmarkId: 8 }), { bookmarks: [8], share: true });
    assert.deepEqual(changeFromRequest('POST', '/api/shares/3/accept', {}), { shareId: 3, share: true });
    assert.deepEqual(changeFromRequest('DELETE', '/api/shares/3', {}), { shareId: 3, share: true });
    assert.equal(changeFromRequest('PATCH', '/api/contacts/4', {}), null);
});

test('deletes and share changes read the audience before the route runs', () => {
    assert.equal(needsAudienceBefore('DELETE', { items: [1] }), true);
    assert.equal(needsAudienceBefore('POST', { shareId: 1, share: true }), true);
    assert.equal(needsAudienceBefore('POST', { bookmarks: [1], before: true }), true);
    assert.equal(needsAudienceBefore('PUT', { items: [1] }), false);
    assert.equal(needsAudienceBefore('PUT', null), false);
});

// ---------- hub: who gets the event ----------

function fakeResponse() {
    const res = new EventEmitter();
    res.chunks = [];
    res.statusCode = 200;
    res.status = code => { res.statusCode = code; return res; };
    res.set = () => res;
    res.write = chunk => { res.chunks.push(chunk); return true; };
    res.end = () => { res.ended = true; };
    res.json = body => body;
    return res;
}

function connect(hub, userId, clientId) {
    const req = new EventEmitter();
    req.user = { id: userId };
    req.query = { client: clientId };
    const res = fakeResponse();
    hub.connect(req, res);
    return { req, res, events: () => res.chunks.filter(chunk => chunk.startsWith('event: ') && !chunk.startsWith('event: hello')) };
}

/** A pool that answers the audience queries from fixed rows. */
function fakePool({ items = {}, bookmarks = {}, shares = {} }) {
    return {
        async query(sql, params) {
            if (sql.includes('FROM shares WHERE id = $1')) return { rows: shares[params[0]] ? [shares[params[0]]] : [] };
            const audience = sql.includes('FROM bookmarks b') ? bookmarks : items;
            const ids = params[0].map(String);
            const users = new Set(ids.flatMap(id => audience[id] || []));
            return { rows: [...users].map(userId => ({ user_id: userId })) };
        }
    };
}

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

async function runRequest(hub, { method, path, body = {}, user, clientId, status = 200, answer = null }) {
    const req = { method, path, body, user: null, headers: { cookie: 'sid=1' }, get: name => (name === 'X-Client-Id' ? clientId : undefined) };
    const res = fakeResponse();
    res.statusCode = status;
    await hub.middleware(req, res, () => { req.user = user; if (answer) res.json(answer); });
    res.emit('finish');
    await flushAsync();
    await flushAsync();
}

test('a saved item reaches the owner’s other windows and the accepted recipients, not the saving window', async () => {
    const hub = createLiveHub({ pool: fakePool({ items: { 12: ['1', '2'] } }), heartbeatMs: 60000 });
    const ownerTab = connect(hub, 1, 'tab-a');
    const ownerPhone = connect(hub, 1, 'tab-b');
    const recipient = connect(hub, 2, 'tab-c');
    const stranger = connect(hub, 3, 'tab-d');
    await runRequest(hub, { method: 'PUT', path: '/api/items/12', user: { id: 1 }, clientId: 'tab-a' });
    assert.deepEqual(ownerTab.events(), []);
    assert.deepEqual(ownerPhone.events(), ['event: item\ndata: {"id":12}\n\n']);
    assert.deepEqual(recipient.events(), ['event: item\ndata: {"id":12}\n\n']);
    assert.deepEqual(stranger.events(), []);
    hub.close();
});

test('failed requests tell nobody', async () => {
    const hub = createLiveHub({ pool: fakePool({ items: { 12: ['1', '2'] } }), heartbeatMs: 60000 });
    const recipient = connect(hub, 2, 'tab-c');
    await runRequest(hub, { method: 'PUT', path: '/api/items/12', user: { id: 1 }, clientId: 'tab-a', status: 409 });
    assert.deepEqual(recipient.events(), []);
    hub.close();
});

test('revoking a share still tells the former recipient, and refreshes both bells', async () => {
    const pool = fakePool({ items: { 5: ['1'] }, shares: { 3: { owner_user_id: 1, recipient_user_id: 2, item_id: 5, bookmark_id: null } } });
    const hub = createLiveHub({ pool, heartbeatMs: 60000 });
    const owner = connect(hub, 1, 'tab-a');
    const recipient = connect(hub, 2, 'tab-c');
    // A route törli a sort: utána a megosztás már nem található.
    const realQuery = pool.query;
    let deleted = false;
    pool.query = async (sql, params) => (deleted && sql.includes('FROM shares WHERE id = $1') ? { rows: [] } : realQuery(sql, params));
    const req = { method: 'DELETE', path: '/api/shares/3', body: {}, user: null, headers: { cookie: 'sid=1' }, get: () => 'tab-a' };
    const res = fakeResponse();
    await hub.middleware(req, res, () => { deleted = true; req.user = { id: 1 }; });
    res.emit('finish');
    await flushAsync(); await flushAsync();
    assert.deepEqual(recipient.events(), ['event: item\ndata: {"id":5}\n\n', 'event: notifications\ndata: {}\n\n']);
    // A változtató ablak nem kap elem-üzenetet, de a csengője (a többi ablakkal együtt) frissül.
    assert.deepEqual(owner.events(), ['event: notifications\ndata: {}\n\n']);
    hub.close();
});

test('an import asks only the actor’s other windows to reload', async () => {
    const hub = createLiveHub({ pool: fakePool({}), heartbeatMs: 60000 });
    const ownerTab = connect(hub, 1, 'tab-a');
    const ownerPhone = connect(hub, 1, 'tab-b');
    const other = connect(hub, 2, 'tab-c');
    await runRequest(hub, { method: 'POST', path: '/api/items/import', user: { id: 1 }, clientId: 'tab-a' });
    assert.deepEqual(ownerTab.events(), []);
    assert.deepEqual(ownerPhone.events(), ['event: refresh\ndata: {"scope":"items"}\n\n']);
    assert.deepEqual(other.events(), []);
    hub.close();
});

test('a user keeps at most five live connections', () => {
    const hub = createLiveHub({ pool: fakePool({}), heartbeatMs: 60000, maxPerUser: 5 });
    const tabs = Array.from({ length: 6 }, (_, index) => connect(hub, 1, `tab-${index}`));
    assert.equal(hub.connectionCount(1), 5);
    assert.equal(tabs[0].res.ended, true);
    tabs[3].req.emit('close');
    assert.equal(hub.connectionCount(1), 4);
    hub.close();
});
