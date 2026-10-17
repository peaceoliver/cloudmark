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

test('validateCommandFill keeps a short tab label and the snippet prompt asks for retrieval-friendly fields', () => {
    const result = validateCommandFill({ label: ` ${'Bash'.repeat(30)} ` }, { code: 'ls' }, context);
    assert.strictEqual(result.label.length, 80);
    assert.strictEqual(validateCommandFill({ label: 42 }, { code: 'ls' }, context).label, '');
    const prompt = buildCommandFill({ code: 'ls' }, context);
    assert.match(prompt.system, /area of work/);
    assert.ok(prompt.schema.required.includes('label'));
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

test('generate retries an overloaded provider, then tries the fallback model', async () => {
    const { PROVIDERS, generate } = require('../routes/ai-providers');
    const original = PROVIDERS.gemini.generate;
    const calls = [];
    const overloaded = Object.assign(new Error('The model is overloaded.'), { status: 503 });
    try {
        PROVIDERS.gemini.generate = async ({ model }) => {
            calls.push(model);
            if (model === 'gemini-flash-latest') throw overloaded;
            return { ok: true };
        };
        const result = await generate('gemini', { model: 'gemini-flash-latest' }, { sleep: async () => {} });
        assert.deepStrictEqual(result, { ok: true });
        assert.deepStrictEqual(calls, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);

        calls.length = 0;
        PROVIDERS.gemini.generate = async ({ model }) => { calls.push(model); throw overloaded; };
        await assert.rejects(generate('gemini', { model: 'gemini-flash-latest' }, { sleep: async () => {} }), err => err.status === 503 && /túlterhelt/.test(err.message));
        assert.strictEqual(calls.length, 6);

        calls.length = 0;
        PROVIDERS.gemini.generate = async ({ model }) => { calls.push(model); throw Object.assign(new Error('API key not valid'), { status: 400 }); };
        await assert.rejects(generate('gemini', { model: 'gemini-flash-latest' }, { sleep: async () => {} }), err => err.status === 400);
        assert.strictEqual(calls.length, 1);
    } finally {
        PROVIDERS.gemini.generate = original;
    }
});

test('every action schema requires all of its fields and allows nothing else', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const ctx = { ...context, today: '2026-10-16', timeZone: 'Europe/Budapest', page: {} };
    const input = { url: 'https://example.com', title: 'x', body: 'y', text: 'z' };
    const check = schema => {
        if (schema.type === 'object') {
            assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
            assert.strictEqual(schema.additionalProperties, false);
            Object.values(schema.properties).forEach(check);
        }
        if (schema.type === 'array') check(schema.items);
    };
    Object.entries(ACTIONS).forEach(([name, action]) => {
        const prompt = action.build(input, ctx);
        assert.ok(prompt.user.includes('<form>'), name);
        check(prompt.schema);
    });
});

test('bookmark.fill needs a web address and maps the category', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const action = ACTIONS['bookmark.fill'];
    assert.strictEqual(action.needsInput({ url: 'javascript:alert(1)' }), null);
    assert.strictEqual(action.needsInput({ url: 'https://github.com/peaceoliver/cloudmark' }), 'fromUrl');
    const prompt = action.build({ url: 'https://github.com' }, { ...context, page: { title: 'GitHub', description: 'Code hosting' } });
    assert.ok(prompt.user.includes('<page_title>GitHub</page_title>'));
    const result = action.validate({ title: 'GitHub', description: 'Kódtárhely.', tags: ['git', 'Git'], category: 'GIT', newCategory: 'Fejlesztés' }, {}, context);
    assert.deepStrictEqual(result.tags, ['git']);
    assert.strictEqual(result.categoryId, 9);
    assert.strictEqual(result.newCategory, '');
});

test('task.fill keeps only existing projects and sane priorities', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const validate = ACTIONS['task.fill'].validate;
    assert.deepStrictEqual(validate({ tags: ['pénzügy'], project: 'docker', priority: 2 }, {}, context), { tags: ['pénzügy'], categoryId: 7, categoryName: 'Docker', priority: 2 });
    assert.deepStrictEqual(validate({ tags: [], project: 'Új projekt', priority: 9 }, {}, context), { tags: [], categoryId: null, categoryName: '', priority: null });
});

test('task.parse drops past or invalid dates and times', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const ctx = { ...context, today: '2026-10-16', timeZone: 'Europe/Budapest' };
    const validate = ACTIONS['task.parse'].validate;
    const good = validate({ title: 'Könyvelő felhívása', dueDate: '2026-10-20', dueTime: '09:30', priority: 2, tags: ['pénzügy'], project: '' }, { text: 'kedden hívd fel' }, ctx);
    assert.deepStrictEqual([good.dueDate, good.dueTime, good.priority], ['2026-10-20', '09:30', 2]);
    assert.strictEqual(validate({ title: 'x', dueDate: '2026-10-15', dueTime: '09:30' }, { text: 'x' }, ctx).dueDate, '');
    assert.strictEqual(validate({ title: 'x', dueDate: '2026-02-30' }, { text: 'x' }, ctx).dueDate, '');
    const noDate = validate({ title: '', dueDate: '', dueTime: '25:00' }, { text: 'valami teendő' }, ctx);
    assert.strictEqual(noDate.dueTime, '');
    assert.strictEqual(noDate.title, 'valami teendő');
    assert.ok(ACTIONS['task.parse'].build({ text: 'x' }, ctx).system.includes('2026-10-16 (péntek)'));
});

test('task.subtasks drops duplicates and existing steps, at most seven', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const result = ACTIONS['task.subtasks'].validate({ subtasks: ['Ajánlat kérése', 'ajánlat kérése', 'Számla', '', 'a', 'b', 'c', 'd', 'e', 'f'] }, { subtasks: ['Számla'] });
    assert.deepStrictEqual(result.subtasks, ['Ajánlat kérése', 'a', 'b', 'c', 'd', 'e', 'f']);
});

test('note actions read checklists and clean the answers', () => {
    const { ACTIONS } = require('../routes/ai-actions');
    const ctx = { ...context, today: '2026-10-16', timeZone: 'Europe/Budapest' };
    assert.strictEqual(ACTIONS['note.summary'].needsInput({ title: 'csak cím' }), null);
    assert.strictEqual(ACTIONS['note.fill'].needsInput({ checklist: ['tej', 'kenyér'] }), 'fromText');
    assert.ok(ACTIONS['note.fill'].build({ checklist: ['tej'] }, ctx).user.includes('- tej'));
    assert.strictEqual(ACTIONS['note.summary'].validate({ summary: 'x'.repeat(900) }).summary.length, 600);
    const tasks = ACTIONS['note.tasks'].validate({ tasks: [{ title: 'Tej vétele', dueDate: '2026-10-17' }, { title: 'tej vétele', dueDate: '' }, { title: 'Régi', dueDate: '2020-01-01' }] }, {}, ctx);
    assert.deepStrictEqual(tasks.tasks, [{ title: 'Tej vétele', dueDate: '2026-10-17' }, { title: 'Régi', dueDate: '' }]);
});

test('publicHttpUrl refuses private and non-web addresses', () => {
    const { publicHttpUrl } = require('../routes/safe-fetch');
    assert.ok(publicHttpUrl('http://example.com/a?b=1'));
    ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost:3000', 'file:///etc/passwd', 'http://u:p@example.com', 'http://10.0.0.5', 'http://printer.local']
        .forEach(url => assert.strictEqual(publicHttpUrl(url), null, url));
});

test('publicLookup refuses a host name that resolves to a private address', async () => {
    const { publicLookup } = require('../routes/safe-fetch');
    const error = await new Promise(resolve => publicLookup('localhost', {}, err => resolve(err)));
    assert.strictEqual(error && error.code, 'EPRIVATE');
});
