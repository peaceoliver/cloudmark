const test = require('node:test');
const assert = require('node:assert');
const vault = require('../public/js/vault');
const csv = require('../public/js/account-csv');
const { normalizeVaultInput, hashToken, tokenMatches, presentVault } = require('../routes/vault');

// A tesztben kevesebb kör is elég (a szerver legalább 100 000-et fogad el).
const fast = { iterations: 100000 };

/** What GET /api/vault would return for a record sent with POST /api/vault. */
function stored(record) {
    return {
        kdf: record.kdf, iterations: record.iterations, salt: record.salt, wrappedKey: record.wrappedKey, wrappedIv: record.wrappedIv,
        recovery: record.recoveryWrappedKey ? { salt: record.recoverySalt, wrappedKey: record.recoveryWrappedKey, wrappedIv: record.recoveryWrappedIv } : null
    };
}

test('a vault opens with the master password and the recovery key, not with a wrong one', async () => {
    const created = await vault.createVault('Hosszú mesterjelszó 1', fast);
    assert.ok(vault.isRecoveryKey(created.recoveryKey));
    assert.match(created.recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const secret = await vault.encryptSecret(created.key, { password: 'p@ss "word"', secretNote: 'PIN: 1234' });
    assert.ok(!secret.ciphertext.includes('p@ss'));

    const opened = await vault.unlock(stored(created.record), 'Hosszú mesterjelszó 1');
    assert.strictEqual(opened.authToken, created.authToken);
    assert.deepStrictEqual(await vault.decryptSecret(opened.key, secret), { password: 'p@ss "word"', secretNote: 'PIN: 1234' });
    await assert.rejects(vault.unlock(stored(created.record), 'rossz'), err => err.code === 'wrong');

    // Elfelejtett mesterjelszó: a helyreállító kulccsal új adható (kisbetűvel, kötőjel nélkül is).
    const changed = await vault.changePassword(stored(created.record), { recoveryKey: created.recoveryKey.toLowerCase().replace(/-/g, ' ') }, 'Új jelszó 2', fast);
    assert.strictEqual(changed.authToken, created.authToken);
    const next = { ...stored(created.record), ...changed.record, recovery: stored(created.record).recovery };
    const reopened = await vault.unlock(next, 'Új jelszó 2');
    assert.strictEqual((await vault.decryptSecret(reopened.key, secret)).password, 'p@ss "word"');
    await assert.rejects(vault.unlock(next, 'Hosszú mesterjelszó 1'), err => err.code === 'wrong');
    await assert.rejects(vault.changePassword(next, { recoveryKey: 'AAAA-BBBB' }, 'x', fast), err => err.code === 'wrong');
});

test('a new recovery key replaces the old one and keeps the master password', async () => {
    const created = await vault.createVault('mester', fast);
    const renewed = await vault.newRecoveryKey(stored(created.record), 'mester');
    assert.notStrictEqual(renewed.recoveryKey, created.recoveryKey);
    assert.strictEqual(renewed.record.wrappedKey, created.record.wrappedKey);
    const next = stored(renewed.record);
    await assert.rejects(vault.changePassword(next, { recoveryKey: created.recoveryKey }, 'x', fast), err => err.code === 'wrong');
    const changed = await vault.changePassword(next, { recoveryKey: renewed.recoveryKey }, 'új', fast);
    assert.strictEqual(changed.authToken, created.authToken);
});

test('a secret from another vault does not decrypt', async () => {
    const one = await vault.createVault('a', fast);
    const two = await vault.createVault('b', fast);
    const secret = await vault.encryptSecret(one.key, { password: 'x' });
    await assert.rejects(vault.decryptSecret(two.key, secret), err => err.code === 'decrypt');
    assert.deepStrictEqual(await vault.decryptSecret(two.key, null), { password: '', secretNote: '' });
});

test('generatePassword honours length and character sets', () => {
    const password = vault.generatePassword({ length: 32 });
    assert.strictEqual(password.length, 32);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[^a-zA-Z0-9]/);
    assert.match(vault.generatePassword({ length: 12, upper: false, symbols: false, digits: false }), /^[a-z]{12}$/);
    assert.strictEqual(vault.generatePassword({ length: 2 }).length, 8);
    assert.ok(vault.strength('aaaa').score < vault.strength(password).score);
    assert.strictEqual(vault.strength('').label, '');
});

test('the server validates the wrapping and checks the vault token', () => {
    assert.ok(normalizeVaultInput({}).error);
    assert.ok(normalizeVaultInput({ kdf: 'pbkdf2-sha256', iterations: 1000, salt: 'AAAA', wrappedKey: 'AAAA', wrappedIv: 'AAAA' }).error);
    const ok = normalizeVaultInput({ kdf: 'pbkdf2-sha256', iterations: 600000, salt: 'AAAA', wrappedKey: 'AAAA', wrappedIv: 'AAAA' });
    assert.strictEqual(ok.value.recoveryWrappedKey, null);
    assert.ok(normalizeVaultInput({ kdf: 'pbkdf2-sha256', iterations: 600000, salt: 'AAAA', wrappedKey: 'AAAA', wrappedIv: 'AAAA', recoveryWrappedKey: 'AAAA' }).error);
    assert.ok(normalizeVaultInput({ kdf: 'pbkdf2-sha256', iterations: 600000, salt: 'AA<A', wrappedKey: 'AAAA', wrappedIv: 'AAAA' }).error);
    const check = hashToken('token-123');
    assert.ok(tokenMatches('token-123', check));
    assert.ok(!tokenMatches('token-124', check));
    assert.ok(!tokenMatches(undefined, check));
    assert.deepStrictEqual(presentVault(null), { exists: false });
    assert.ok(!('key_check' in presentVault({ kdf: 'pbkdf2-sha256', kdf_iterations: 1, salt: 's', wrapped_key: 'k', wrapped_iv: 'i', key_check: 'x' })));
});

test('CSV import recognises Chrome, Firefox, Bitwarden and its own export', () => {
    const chrome = csv.parseAccounts('name,url,username,password,note\r\nGitHub,https://github.com/login,sanci,"pa,ss""1",\r\n,https://www.jellyfin.org,admin,x,médiaszerver\r\n');
    assert.strictEqual(chrome.format, 'chrome');
    assert.deepStrictEqual(chrome.accounts.map(a => [a.title, a.username, a.password]), [['GitHub', 'sanci', 'pa,ss"1'], ['jellyfin.org', 'admin', 'x']]);
    assert.strictEqual(chrome.accounts[1].note, 'médiaszerver');

    const firefox = csv.parseAccounts('"url","username","password","httpRealm","formActionOrigin","guid"\n"http://192.168.1.1","admin","router1","","","{1}"\n');
    assert.strictEqual(firefox.format, 'firefox');
    assert.strictEqual(firefox.accounts[0].title, '192.168.1.1');

    const bitwarden = csv.parseAccounts('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nOtthon,,login,Portainer,"több\nsoros",,,https://pi.local:9443,admin,pw,\n,,note,Titkos jegyzet,szöveg,,,,,,\n');
    assert.strictEqual(bitwarden.format, 'bitwarden');
    assert.strictEqual(bitwarden.accounts.length, 1);
    assert.strictEqual(bitwarden.skipped, 1);
    assert.deepStrictEqual([bitwarden.accounts[0].category, bitwarden.accounts[0].note], ['Otthon', 'több\nsoros']);

    const own = [{ title: 'Router', url: '192.168.0.1', username: 'admin', password: '=x,"y"\n', note: 'n', secretNote: 's', loginMethod: 'password', ssoAccount: '', category: 'Otthon', tags: ['halo', 'eszkoz'] }];
    const back = csv.parseAccounts(csv.accountsToCsv(own));
    assert.strictEqual(back.format, 'cloudmark');
    assert.deepStrictEqual(back.accounts[0], own[0]);

    assert.strictEqual(csv.parseAccounts('a,b\n1,2\n').format, null);
});
