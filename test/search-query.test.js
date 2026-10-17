const test = require('node:test');
const assert = require('node:assert');
const searchQuery = require('../public/js/search-query');

test('parse splits free text and #tag, /category, @type filters', () => {
    const parsed = searchQuery.parse('docker stop #Docker /Shell @kód');
    assert.deepStrictEqual(parsed, { text: 'docker stop', tags: ['docker'], categories: ['shell'], types: ['command'] });
});

test('parse folds accents and maps type words', () => {
    assert.deepStrictEqual(searchQuery.parse('@jegyzet @Könyvjelző #pénzügy').types, ['note', 'bookmark']);
    assert.deepStrictEqual(searchQuery.parse('#pénzügy').tags, ['penzugy']);
});

test('@ with an unknown word is a category, like a project in the task quick-add', () => {
    const parsed = searchQuery.parse('számla @Otthon');
    assert.deepStrictEqual(parsed.categories, ['otthon']);
    assert.deepStrictEqual(parsed.types, []);
    assert.strictEqual(parsed.text, 'számla');
});

test('a lone sign stays text', () => {
    assert.deepStrictEqual(searchQuery.parse('C # /'), { text: 'C # /', tags: [], categories: [], types: [] });
    assert.strictEqual(searchQuery.hasFilters(searchQuery.parse('C #')), false);
});

test('matches: tag and category prefixes, parents count, every word must appear', () => {
    const fields = { texts: ['Összes Docker konténer leállítása', 'docker stop $(docker ps -q)'], tags: ['docker', 'containers'], categories: ['git', 'shell'] };
    assert.ok(searchQuery.matches(searchQuery.parse('kontener leallitasa'), fields));
    assert.ok(searchQuery.matches(searchQuery.parse('#dock /she'), fields));
    assert.ok(searchQuery.matches(searchQuery.parse('stop /shell'), fields));
    assert.ok(!searchQuery.matches(searchQuery.parse('#git'), fields));
    assert.ok(!searchQuery.matches(searchQuery.parse('/backend'), fields));
    assert.ok(!searchQuery.matches(searchQuery.parse('docker python'), fields));
});

test('describe lists the active filters in Hungarian', () => {
    assert.strictEqual(searchQuery.describe(searchQuery.parse('#docker /shell @kód')), '#docker · /shell · csak kódrészletek');
});
