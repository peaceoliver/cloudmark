const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, normalizePermission, presentItem, isStaleSave, viewerJoinSql, visibleSql } = require('../routes/share-access');
const { presentShare, itemLabel } = require('../routes/shares');

test('normalizeEmail lower-cases and rejects bad addresses', () => {
    assert.equal(normalizeEmail('  Anna@Example.COM '), 'anna@example.com');
    assert.equal(normalizeEmail('anna@example'), null);
    assert.equal(normalizeEmail('anna example@x.hu'), null);
    assert.equal(normalizeEmail('<a@b.hu>'), null);
    assert.equal(normalizeEmail(''), null);
    assert.equal(normalizeEmail(`${'a'.repeat(260)}@b.hu`), null);
});

test('normalizePermission accepts only view and edit', () => {
    assert.equal(normalizePermission('view'), 'view');
    assert.equal(normalizePermission('edit'), 'edit');
    assert.equal(normalizePermission('owner'), null);
    assert.equal(normalizePermission(undefined), null);
});

test('presentItem puts the viewer state in place of the item state', () => {
    const item = presentItem({ id: 1, category_id: 5, archived: true, pinned: true, starred: false,
        v_category_id: null, v_archived: false, v_pinned: false, v_starred: true });
    assert.deepEqual(item, { id: 1, category_id: null, archived: false, pinned: false, starred: true });
    assert.equal(presentItem(null), null);
});

test('isStaleSave only flags saves based on an older version', () => {
    const now = '2026-10-17T10:00:00.000Z';
    assert.equal(isStaleSave(now, undefined), false);
    assert.equal(isStaleSave(now, 'nem dátum'), false);
    assert.equal(isStaleSave(now, now), false);
    assert.equal(isStaleSave(now, '2026-10-17T09:59:59.000Z'), true);
    assert.equal(isStaleSave(new Date(now), '2026-10-17T10:00:01.000Z'), false);
});

test('share SQL helpers use the given placeholder', () => {
    assert.match(viewerJoinSql('$3'), /recipient_user_id = \$3/);
    assert.equal(visibleSql('$2'), '(i.owner_user_id = $2 OR (sh.id IS NOT NULL AND i.trashed = FALSE))');
});

test('presentShare hides whether a pending address has an account', () => {
    const base = { id: '7', recipient_email: 'b@x.hu', permission: 'view', created_at: 'x' };
    assert.deepEqual(presentShare({ ...base, status: 'pending', username: 'bela' }),
        { id: 7, email: 'b@x.hu', username: null, permission: 'view', status: 'pending', createdAt: 'x' });
    assert.equal(presentShare({ ...base, status: 'accepted', username: 'bela' }).username, 'bela');
    assert.equal(presentShare({ ...base, status: 'declined', username: 'bela' }).status, 'pending');
});

test('itemLabel shortens and falls back to the type', () => {
    assert.equal(itemLabel({ type: 'note', title: '', body: '  tej\n kenyér ' }), 'tej kenyér');
    assert.equal(itemLabel({ type: 'task', title: '' }), 'Névtelen feladat');
    assert.equal(itemLabel({ type: 'note', title: 'x'.repeat(90) }).length, 81);
});

const { presentBookmark, ownsBookmark } = require('../routes/share-access');
const { buildInviteEmail, parseTarget } = require('../routes/shares');

test('parseTarget picks a bookmark or an item id', () => {
    assert.deepEqual(parseTarget({ bookmarkId: '4' }), { column: 'bookmark_id', id: 4 });
    assert.deepEqual(parseTarget({ itemId: 9 }), { column: 'item_id', id: 9 });
    assert.equal(parseTarget({ itemId: 'x' }), null);
    assert.equal(parseTarget(undefined), null);
});

test('presentBookmark shows the viewer category, star and archive', () => {
    assert.deepEqual(presentBookmark({ id: 1, category: 'Anna', starred: false, archived: false, v_category: null, v_starred: true, v_archived: true }),
        { id: 1, category: null, starred: true, archived: true });
});

test('ownsBookmark matches the text user_id by name or id', () => {
    const user = { id: 7, username: 'Anna' };
    assert.equal(ownsBookmark({ user_id: 'anna' }, user), true);
    assert.equal(ownsBookmark({ user_id: '7' }, user), true);
    assert.equal(ownsBookmark({ user_id: 'bela' }, user), false);
    assert.equal(ownsBookmark({ user_id: null }, user), false);
});

test('invite e-mail escapes the sender and the title', () => {
    const mail = buildInviteEmail({ senderName: 'anna<b>', item: { type: 'bookmark', title: '<script>', url: 'https://x.hu' }, registerUrl: 'https://app/?register=1&email=a%40b.hu' });
    assert.match(mail.subject, /egy könyvjelzőt/);
    assert.ok(!mail.html.includes('<script>') && !mail.html.includes('anna<b>'));
    assert.match(mail.html, /register=1&amp;email=a%40b\.hu/);
    assert.match(mail.text, /https:\/\/app\/\?register=1&email=a%40b\.hu/);
});
