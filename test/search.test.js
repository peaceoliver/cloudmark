const test = require('node:test');
const assert = require('node:assert');
const { snippet, likePattern, parseTypes, foldText } = require('../routes/search');

test('snippet returns the matching line', () => {
    assert.strictEqual(snippet('első sor\nmásodik git status sor\nharmadik', 'git'), 'második git status sor');
    assert.strictEqual(snippet('csak egy sor', 'nincs'), 'csak egy sor');
    assert.strictEqual(snippet('', 'x'), '');
});

test('snippet shortens long lines around the match', () => {
    const text = `${'a'.repeat(200)} kulcs ${'b'.repeat(200)}`;
    const result = snippet(text, 'kulcs', 60);
    assert.ok(result.includes('kulcs'));
    assert.ok(result.startsWith('…') && result.endsWith('…'));
});

test('likePattern escapes wildcards', () => {
    assert.strictEqual(likePattern('50%_a\\b'), '50\\%\\_a\\\\b');
});

test('parseTypes keeps known types only', () => {
    assert.deepStrictEqual(parseTypes('note,foo,bookmark'), ['note', 'bookmark']);
    assert.deepStrictEqual(parseTypes(''), ['note', 'task', 'command', 'bookmark', 'account']);
    assert.deepStrictEqual(parseTypes('foo'), ['note', 'task', 'command', 'bookmark', 'account']);
});

test('foldText strips Hungarian accents', () => {
    assert.strictEqual(foldText('Kazán ŐSZ Ütő'), 'kazan osz uto');
});

test('snippet finds the line without accents', () => {
    assert.strictEqual(snippet('első\nkazán szerviz', 'kazan'), 'kazán szerviz');
});
