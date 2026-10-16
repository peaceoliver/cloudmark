const test = require('node:test');
const assert = require('node:assert');
const {
    commandFillMode, buildCommandFill, validateCommandFill, commandFillSchema,
    cleanTags, encryptSecret, decryptSecret, isPrivateAddress, normalizeBaseUrl
} = require('../routes/ai-actions');
const { publicKey } = require('../routes/ai');
const { pickDefaultModel } = require('../routes/ai-providers');

const context = {
    categories: [{ id: 7, name: 'Docker', default_language: 'bash' }, { id: 9, name: 'Git', default_language: null }],
    tags: ['docker', 'konténer']
};

test('commandFillMode picks the case from the filled fields', () => {
    assert.strictEqual(commandFillMode({ code: 'docker ps -a' }), 'fromCode');
    assert.strictEqual(commandFillMode({ code: '  ', title: 'konténerek leállítása' }), 'fromText');
    assert.strictEqual(commandFillMode({ description: 'listázd a fájlokat' }), 'fromText');
    assert.strictEqual(commandFillMode({ code: '', title: ' ' }), null);
});

test('buildCommandFill puts the form inside <form> and lists categories and tags', () => {
    const prompt = buildCommandFill({ code: 'git status' }, context);
    assert.strictEqual(prompt.mode, 'fromCode');
    assert.ok(prompt.user.includes('<code>\ngit status\n</code>'));
    assert.ok(prompt.user.includes('- Docker (default language: bash)'));
    assert.ok(prompt.user.includes('docker, konténer'));
});

test('the schema requires every field and allows nothing else', () => {
    const schema = commandFillSchema();
    assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.strictEqual(schema.additionalProperties, false);
    assert.strictEqual(schema.properties.extraTabs.items.additionalProperties, false);
});

test('validateCommandFill never changes pasted code and maps the category by name', () => {
    const raw = {
        title: 'Konténerek listázása', description: 'Minden konténert listáz.', code: 'rm -rf /',
        language: 'Bash', tags: ['#Docker', 'docker', 'lista'], category: 'docker', newCategory: 'Új', extraTabs: [], unknown: 'x'
    };
    const result = validateCommandFill(raw, { code: 'docker ps -a' }, context);
    assert.strictEqual(result.code, 'docker ps -a');
    assert.strictEqual(result.categoryId, 7);
    assert.strictEqual(result.newCategory, '');
    assert.strictEqual(result.language, 'bash');
    assert.deepStrictEqual(result.tags, ['Docker', 'lista']);
    assert.ok(!('unknown' in result));
});

test('validateCommandFill takes the written code in the text case and drops bad values', () => {
    const raw = {
        title: 'x'.repeat(500), description: 'd', code: 'docker stop $(docker ps -q)\n\n', language: 'not a language!',
        tags: 'docker', category: 'Nincs ilyen', newCategory: 'Git', extraTabs: [
            { label: 'PowerShell', language: 'powershell', code: 'docker ps -q | % { docker stop $_ }' },
            { label: 'Második', language: 'cmd', code: 'x' },
            { label: 'Üres', language: 'sh', code: '   ' }
        ]
    };
    const result = validateCommandFill(raw, { title: 'állítsd le a konténereket' }, context);
    assert.strictEqual(result.mode, 'fromText');
    assert.strictEqual(result.code, 'docker stop $(docker ps -q)');
    assert.strictEqual(result.title.length, 120);
    assert.strictEqual(result.language, '');
    assert.deepStrictEqual(result.tags, []);
    assert.strictEqual(result.categoryId, null);
    // Létező kategória nevét nem javasolja újként.
    assert.strictEqual(result.newCategory, '');
    assert.strictEqual(result.extraTabs.length, 1);
    assert.strictEqual(result.extraTabs[0].label, 'PowerShell');
});

test('validateCommandFill survives a non-object answer', () => {
    const result = validateCommandFill(null, { title: 'valami' }, context);
    assert.strictEqual(result.title, '');
    assert.deepStrictEqual(result.extraTabs, []);
});

test('cleanTags keeps at most five unique tags', () => {
    assert.deepStrictEqual(cleanTags(['a', 'b', 'A', 'c', 'd', 'e', 'f', 7]), ['a', 'b', 'c', 'd', 'e']);
});

test('keys round-trip and are bound to their user', () => {
    const secret = 'x'.repeat(40);
    const encrypted = encryptSecret('AIzaSy-secret-key', secret, 3);
    assert.ok(!encrypted.ciphertext.includes('secret'));
    assert.strictEqual(decryptSecret(encrypted, secret, 3), 'AIzaSy-secret-key');
    assert.throws(() => decryptSecret(encrypted, secret, 4));
    assert.throws(() => decryptSecret(encrypted, 'y'.repeat(40), 3));
});

test('publicKey never exposes the key', () => {
    const row = { id: '5', user_id: 3, provider: 'gemini', key_ciphertext: 'c', key_iv: 'i', key_tag: 't', key_last4: 'a1b2', is_active: true, model: 'gemini-flash-latest' };
    const result = publicKey(row);
    assert.strictEqual(result.last4, 'a1b2');
    assert.ok(!JSON.stringify(result).includes('"c"'));
    assert.strictEqual(result.baseUrl, null);
});

test('normalizeBaseUrl allows only public https addresses', () => {
    assert.strictEqual(normalizeBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
    assert.strictEqual(normalizeBaseUrl('http://api.openai.com/v1'), null);
    assert.strictEqual(normalizeBaseUrl('https://localhost:11434/v1'), null);
    assert.strictEqual(normalizeBaseUrl('https://user:pw@example.com/v1'), null);
    assert.strictEqual(normalizeBaseUrl('nem url'), null);
});

test('isPrivateAddress catches loopback, private and metadata addresses', () => {
    ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']
        .forEach(address => assert.ok(isPrivateAddress(address), address));
    ['8.8.8.8', '104.18.0.1', '2606:4700::1111'].forEach(address => assert.ok(!isPrivateAddress(address), address));
});

test('pickDefaultModel prefers the recommended model when listed', () => {
    assert.strictEqual(pickDefaultModel('gemini', [{ id: 'gemini-pro-latest' }, { id: 'gemini-flash-latest' }]), 'gemini-flash-latest');
    assert.strictEqual(pickDefaultModel('anthropic', [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }]), 'claude-haiku-5-5');
    assert.strictEqual(pickDefaultModel('openai', [{ id: 'some-model' }]), 'some-model');
    assert.strictEqual(pickDefaultModel('gemini', []), 'gemini-flash-latest');
});
