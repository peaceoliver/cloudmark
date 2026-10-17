/**
 * Fiókok széfje: végpontig titkosítás a böngészőben (Web Crypto), a Node tesztek is ezt futtatják.
 *
 * - Mesterjelszó → PBKDF2-SHA256 (600 000 kör, véletlen só) → kulcstitkosító kulcs (KEK).
 * - A széfkulcs 32 véletlen bájt; a KEK-kel AES-GCM-mel becsomagolva kerül a szerverre, és a
 *   helyreállító kulccsal is (ha a mesterjelszó elveszik). A szerver egyiket sem tudja kinyitni.
 * - A fiók titka ({ password, secretNote }) a széfkulccsal titkosított JSON, saját véletlen IV-vel.
 * - Az `authToken` a széfkulcsból számolt ujjlenyomat: a szerver ennek a hash-ét tárolja, így csak
 *   feloldott széf cserélheti le a csomagolást, de a kulcsról nem tud meg semmit.
 * A mesterjelszó és a széfkulcs csak a memóriában él (CryptoKey, nem kinyerhető).
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.CloudMark = root.CloudMark || {};
        root.CloudMark.vault = api;
    }
})(typeof self !== 'undefined' ? self : this, function (root) {
    const KDF = 'pbkdf2-sha256';
    const ITERATIONS = 600000;
    // A helyreállító kulcs 160 bit véletlen, ezért kevesebb kör is elég (a szerver nem tárolja külön).
    const RECOVERY_ITERATIONS = 100000;
    const KEY_AAD = 'cloudmark-vault-key-v1';
    const SECRET_AAD = 'cloudmark-secret-v1';
    // Crockford base32: nincs benne I, L, O, U, így kézzel is jól begépelhető.
    const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    const cryptoApi = () => (root && root.crypto && root.crypto.subtle ? root.crypto : globalThis.crypto);
    const subtle = () => cryptoApi().subtle;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    /** Thrown when a password or recovery key does not open the vault, or a secret does not decrypt. */
    class VaultError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }

    function randomBytes(length) {
        const bytes = new Uint8Array(length);
        cryptoApi().getRandomValues(bytes);
        return bytes;
    }

    function toBase64(bytes) {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (typeof Buffer !== 'undefined') return Buffer.from(view).toString('base64');
        let binary = '';
        view.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    function fromBase64(text) {
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(text), 'base64'));
        const binary = atob(String(text));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /** AES-GCM key from a password (or recovery key) with PBKDF2-SHA256. */
    async function deriveKek(password, salt, iterations) {
        const material = await subtle().importKey('raw', encoder.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
        return subtle().deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function wrapRaw(raw, password, iterations) {
        const salt = randomBytes(16);
        const iv = randomBytes(12);
        const kek = await deriveKek(password, salt, iterations);
        const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(KEY_AAD) }, kek, raw);
        return { salt: toBase64(salt), wrappedKey: toBase64(new Uint8Array(wrapped)), wrappedIv: toBase64(iv) };
    }

    async function unwrapRaw({ salt, wrappedKey, wrappedIv }, password, iterations) {
        const kek = await deriveKek(password, fromBase64(salt), iterations);
        try {
            const raw = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(wrappedIv), additionalData: encoder.encode(KEY_AAD) }, kek, fromBase64(wrappedKey));
            return new Uint8Array(raw);
        } catch (err) {
            throw new VaultError('wrong', 'Hibás jelszó.');
        }
    }

    /** The usable (non-extractable) vault key and its token; the raw bytes are wiped afterwards. */
    async function openRaw(raw) {
        try {
            const key = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            const prefix = encoder.encode('cloudmark-vault-auth:');
            const joined = new Uint8Array(prefix.length + raw.length);
            joined.set(prefix);
            joined.set(raw, prefix.length);
            const digest = new Uint8Array(await subtle().digest('SHA-256', joined));
            joined.fill(0);
            return { key, authToken: toBase64(digest) };
        } finally {
            raw.fill(0);
        }
    }

    /** XXXX-XXXX-… (8 groups, 160 bits) from 20 random bytes. */
    function formatRecoveryKey(bytes) {
        let bits = 0, value = 0, out = '';
        bytes.forEach(byte => {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                out += BASE32[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        });
        if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
        return out.match(/.{1,4}/g).join('-');
    }

    /** Upper-case, without spaces and dashes, with the look-alike letters mapped (O→0, I/L→1). */
    function normalizeRecoveryKey(text) {
        return String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    }

    function isRecoveryKey(text) {
        const clean = normalizeRecoveryKey(text);
        return clean.length === 32 && [...clean].every(char => BASE32.includes(char));
    }

    /**
     * A new vault: { record (for POST /api/vault), key, authToken, recoveryKey }.
     * The recovery key is shown to the user once and never stored.
     */
    async function createVault(masterPassword, { iterations = ITERATIONS } = {}) {
        const raw = randomBytes(32);
        const recoveryKey = formatRecoveryKey(randomBytes(20));
        const main = await wrapRaw(raw, masterPassword, iterations);
        const recovery = await wrapRaw(raw, normalizeRecoveryKey(recoveryKey), RECOVERY_ITERATIONS);
        const record = {
            kdf: KDF,
            iterations,
            ...main,
            recoverySalt: recovery.salt,
            recoveryWrappedKey: recovery.wrappedKey,
            recoveryWrappedIv: recovery.wrappedIv
        };
        const opened = await openRaw(raw);
        return { record, recoveryKey, ...opened };
    }

    /** Opens the vault from GET /api/vault with the master password: { key, authToken }. */
    async function unlock(vault, masterPassword) {
        if (!vault || vault.kdf !== KDF) throw new VaultError('unsupported', 'Ismeretlen széfformátum.');
        return openRaw(await unwrapRaw(vault, masterPassword, vault.iterations));
    }

    async function rawFrom(vault, { password, recoveryKey }) {
        if (recoveryKey !== undefined) {
            if (!vault.recovery) throw new VaultError('no-recovery', 'Ehhez a széfhez nincs helyreállító kulcs.');
            if (!isRecoveryKey(recoveryKey)) throw new VaultError('wrong', 'Hibás helyreállító kulcs.');
            try {
                return await unwrapRaw(vault.recovery, normalizeRecoveryKey(recoveryKey), RECOVERY_ITERATIONS);
            } catch (err) {
                throw new VaultError('wrong', 'Hibás helyreállító kulcs.');
            }
        }
        return unwrapRaw(vault, password, vault.iterations);
    }

    /**
     * New master password, opened with the old one (`{ password }`) or with the recovery key (`{ recoveryKey }`).
     * Returns { record (for PUT /api/vault, recovery wrapping kept), key, authToken }.
     */
    async function changePassword(vault, credentials, newPassword, { iterations = ITERATIONS } = {}) {
        const raw = await rawFrom(vault, credentials);
        const main = await wrapRaw(raw, newPassword, iterations);
        const opened = await openRaw(raw);
        return { record: { kdf: KDF, iterations, ...main }, ...opened };
    }

    /** A fresh recovery key (the old one stops working): { record (PUT /api/vault), recoveryKey, authToken }. */
    async function newRecoveryKey(vault, password) {
        const raw = await rawFrom(vault, { password });
        const recoveryKey = formatRecoveryKey(randomBytes(20));
        const recovery = await wrapRaw(raw, normalizeRecoveryKey(recoveryKey), RECOVERY_ITERATIONS);
        const record = {
            kdf: vault.kdf,
            iterations: vault.iterations,
            salt: vault.salt,
            wrappedKey: vault.wrappedKey,
            wrappedIv: vault.wrappedIv,
            recoverySalt: recovery.salt,
            recoveryWrappedKey: recovery.wrappedKey,
            recoveryWrappedIv: recovery.wrappedIv
        };
        const opened = await openRaw(raw);
        return { record, recoveryKey, authToken: opened.authToken };
    }

    /** Encrypts an account's secret fields ({ password, secretNote }) as { ciphertext, iv }. */
    async function encryptSecret(key, secret) {
        const iv = randomBytes(12);
        const plain = encoder.encode(JSON.stringify({ password: String(secret?.password || ''), secretNote: String(secret?.secretNote || '') }));
        const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(SECRET_AAD) }, key, plain);
        plain.fill(0);
        return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
    }

    async function decryptSecret(key, secret) {
        if (!secret) return { password: '', secretNote: '' };
        try {
            const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(secret.iv), additionalData: encoder.encode(SECRET_AAD) }, key, fromBase64(secret.ciphertext));
            const value = JSON.parse(decoder.decode(plain));
            return { password: String(value.password || ''), secretNote: String(value.secretNote || '') };
        } catch (err) {
            throw new VaultError('decrypt', 'Ez a titok nem nyitható ki ezzel a széfkulccsal.');
        }
    }

    const CHARSETS = {
        lower: 'abcdefghijkmnopqrstuvwxyz',
        upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
        digits: '23456789',
        symbols: '!#$%&*+-=?@^_~'
    };

    /** Unbiased random index below `max` (rejection sampling). */
    function randomIndex(max) {
        const limit = Math.floor(0x100000000 / max) * max;
        const buffer = new Uint32Array(1);
        do cryptoApi().getRandomValues(buffer); while (buffer[0] >= limit);
        return buffer[0] % max;
    }

    /**
     * A random password with at least one character of every chosen set. Look-alike characters
     * (0/O, 1/l/I) are left out so it can be typed from a screen.
     */
    function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
        const sets = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([name]) => CHARSETS[name]);
        if (!sets.length) sets.push(CHARSETS.lower);
        const size = Math.min(Math.max(Number(length) || 20, Math.max(8, sets.length)), 128);
        const all = sets.join('');
        const chars = sets.map(set => set[randomIndex(set.length)]);
        while (chars.length < size) chars.push(all[randomIndex(all.length)]);
        for (let i = chars.length - 1; i > 0; i -= 1) {
            const j = randomIndex(i + 1);
            [chars[i], chars[j]] = [chars[j], chars[i]];
        }
        return chars.join('');
    }

    /** Rough strength 0-4 from length and character variety, with a Hungarian label. */
    function strength(password) {
        const text = String(password || '');
        if (!text) return { score: 0, label: '' };
        let pool = 0;
        if (/[a-z]/.test(text)) pool += 26;
        if (/[A-Z]/.test(text)) pool += 26;
        if (/\d/.test(text)) pool += 10;
        if (/[^a-zA-Z0-9]/.test(text)) pool += 20;
        const unique = new Set(text).size;
        const bits = Math.log2(Math.max(pool, 2)) * Math.min(text.length, unique * 2);
        const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
        return { score, label: ['Nagyon gyenge', 'Gyenge', 'Közepes', 'Erős', 'Nagyon erős'][score] };
    }

    return {
        KDF, ITERATIONS, RECOVERY_ITERATIONS, VaultError,
        createVault, unlock, changePassword, newRecoveryKey,
        encryptSecret, decryptSecret,
        formatRecoveryKey, normalizeRecoveryKey, isRecoveryKey,
        generatePassword, strength, toBase64, fromBase64
    };
});
