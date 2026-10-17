const test = require('node:test');
const assert = require('node:assert/strict');
const clip = require('../public/js/clip-parse.js');

test('bookmarklet without selection becomes a bookmark', () => {
    const input = clip.parseClipInput({ url: 'https://example.com/a', title: 'Példa', text: '', source: 'bookmarklet' });
    assert.deepEqual(input, { source: 'bookmarklet', url: 'https://example.com/a', title: 'Példa', text: '', type: 'bookmark' });
});

test('bookmarklet with selection becomes a note', () => {
    const input = clip.parseClipInput({ url: 'https://example.com/a', title: 'Példa', text: 'egy fontos mondat', source: 'bookmarklet' });
    assert.equal(input.type, 'note');
    assert.equal(input.text, 'egy fontos mondat');
});

test('shared text with a link: the link moves to url, short text becomes the title', () => {
    const input = clip.parseClipInput({ title: '', text: 'Jó videó https://youtu.be/abc123', url: '' });
    assert.equal(input.url, 'https://youtu.be/abc123');
    assert.equal(input.title, 'Jó videó');
    assert.equal(input.text, '');
    assert.equal(input.type, 'bookmark');
});

test('shared plain text without a link becomes a note', () => {
    const input = clip.parseClipInput({ text: 'Bevásárlás: tej, kenyér\nés tojás' });
    assert.equal(input.type, 'note');
    assert.equal(input.url, '');
});

test('non-http urls are ignored', () => {
    assert.equal(clip.parseClipInput({ url: 'javascript:alert(1)', title: 'x' }).url, '');
});

test('extractUrl trims trailing punctuation', () => {
    assert.equal(clip.extractUrl('Nézd meg: https://example.com/x?a=1.'), 'https://example.com/x?a=1');
});

test('builders produce API bodies', () => {
    const bookmark = clip.buildBookmark({ url: 'https://e.com', title: '', text: 'leírás', category: 'Inbox', tags: '#a, b' });
    assert.deepEqual(bookmark, { url: 'https://e.com', title: '', description: 'leírás', category: 'Inbox', tags: ['a', 'b'], status: 'read_later' });

    const note = clip.buildNote({ url: 'https://e.com/p', title: 'Cikk', text: 'idézet', categoryId: 5, tags: '' });
    assert.equal(note.body, 'idézet\n\nForrás: https://e.com/p');
    assert.deepEqual(note.extra, { source: { url: 'https://e.com/p', via: 'clip' } });
    assert.equal(note.categoryId, 5);

    const task = clip.buildTask({ url: 'https://www.e.com/p', title: '', text: '', categoryId: null, tags: '' });
    assert.equal(task.title, 'Elolvasni: e.com');
    assert.equal(task.body, 'https://www.e.com/p');
    assert.equal(task.status, 'todo');
});

test('bookmarklet opens /clip on the given origin', () => {
    const link = clip.buildBookmarklet('https://cloudmark.example/');
    assert.ok(link.startsWith('javascript:'));
    const code = decodeURI(link.slice('javascript:'.length));
    assert.ok(code.includes('"https://cloudmark.example/clip?"'));
    assert.ok(code.includes("source:'bookmarklet'"));
    assert.doesNotThrow(() => new Function(code));
});
