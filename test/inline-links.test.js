const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../public/js/inline-links');

test('a szövegből kiolvassa a linkeket típussal, azonosítóval és felirattal', () => {
    const text = 'Lásd [[jegyzet:12|Kazán]] és [[könyvjelző:7|Gyártó oldal]], meg [[konyvjelzo:8]] [[parancs:3|ssh]]';
    const found = links.parse(text);
    assert.deepEqual(found.map(link => [link.kind, link.id, link.label]), [
        ['note', 12, 'Kazán'], ['bookmark', 7, 'Gyártó oldal'], ['bookmark', 8, ''], ['command', 3, 'ssh']
    ]);
    assert.equal(text.slice(found[0].start, found[0].end), '[[jegyzet:12|Kazán]]');
});

test('ismeretlen típus, hiányzó szám vagy sortörés nem link', () => {
    assert.deepEqual(links.parse('[[valami:1|x]] [[jegyzet:|x]] [[jegyzet:1|a\nb]] [[Kazán]]'), []);
});

test('a célok egyediek, és az elem nem hivatkozhat önmagára', () => {
    const text = '[[jegyzet:5|a]] [[feladat:5|b]] [[jegyzet:9]] [[könyvjelző:9]] [[jegyzet:9|újra]]';
    assert.deepEqual(links.targets(text, 5), [
        { targetType: 'item', targetId: 9 },
        { targetType: 'bookmark', targetId: 9 }
    ]);
});

test('legfeljebb 50 cél', () => {
    const text = Array.from({ length: 60 }, (_, index) => `[[jegyzet:${index + 1}]]`).join(' ');
    assert.equal(links.targets(text).length, links.MAX_LINKS);
});

test('a token tisztítja a címet', () => {
    assert.equal(links.token('note', 4, 'Kazán [régi] | 2026\nszerviz'), '[[jegyzet:4|Kazán régi 2026 szerviz]]');
    assert.equal(links.token('bookmark', 2, ''), '[[könyvjelző:2]]');
    assert.equal(links.token('valami', 2, 'x'), '');
    assert.equal(links.parse(links.token('task', 11, 'Számla')).length, 1);
});

test('a [[ után gépelt szöveget felismeri a kurzornál', () => {
    assert.deepEqual(links.trigger('Lásd [[kaz', 10), { start: 5, query: 'kaz' });
    assert.deepEqual(links.trigger('[[', 2), { start: 0, query: '' });
    assert.equal(links.trigger('[[jegyzet:1|x]] után', 20), null);
    assert.equal(links.trigger('[[kaz\nmásik sor', 15), null);
    assert.equal(links.trigger('nincs link', 5), null);
});

test('szöveg és link részekre bontás', () => {
    const parts = links.segments('a [[feladat:2|b]] c');
    assert.deepEqual(parts.map(part => part.text ?? `link:${part.link.id}`), ['a ', 'link:2', ' c']);
});
