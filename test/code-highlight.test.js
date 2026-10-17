const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const codeHighlight = require('../public/js/code-highlight');

/** Loads the vendored highlight.js and code-highlight.js the way the browser does (globals on self). */
function browserApi() {
    const context = {};
    context.self = context;
    context.window = context;
    vm.createContext(context);
    for (const file of ['vendor/highlight.min.js', 'code-highlight.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8'), context);
    }
    return context.CloudMark.codeHighlight;
}

test('splitHtmlLines closes and reopens spans that cross a line break', () => {
    const lines = codeHighlight.splitHtmlLines('echo <span class="hljs-string">&quot;a\nb&quot;</span> x\n<span class="a"><span class="b">c</span></span>');
    assert.deepStrictEqual(lines, [
        'echo <span class="hljs-string">&quot;a</span>',
        '<span class="hljs-string">b&quot;</span> x',
        '<span class="a"><span class="b">c</span></span>'
    ]);
});

test('without highlight.js the lines are only escaped', () => {
    assert.deepStrictEqual(codeHighlight.highlightLines('a <b>\n& c', 'bash'), ['a &lt;b&gt;', '&amp; c']);
});

test('highlights with the library language names and keeps one entry per line', () => {
    const api = browserApi();
    const lines = api.highlightLines('docker stop $(docker ps -q) # comment\necho "x\ny"', 'docker');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[0], /hljs-comment/);
    assert.match(lines[2], /^<span class="hljs-string">/);
    assert.strictEqual(api.resolveLanguage('cmd'), 'dos');
    assert.strictEqual(api.resolveLanguage('nincs-ilyen'), null);
});

test('user text never becomes markup', () => {
    const api = browserApi();
    const lines = api.highlightLines('<img src=x onerror=alert(1)>', 'bash');
    assert.ok(!lines.join('').includes('<img'));
});
