/*
 * Fiókok nézet (jelszókezelő): hol, milyen felhasználónévvel vagy fiókkal regisztráltál, és az otthoni eszközök
 * belépési adatai. Az adat a /api/items végpontokról jön (type = account). A jelszó és a titkos megjegyzés a
 * böngészőben titkosítódik a mesterjelszóból származó kulccsal (vault.js), a szerver csak titkosított adatot kap.
 * A feloldott széfkulcs csak ennek a modulnak a memóriájában él, és tétlenség után magától törlődik.
 */
(function () {
    const accountApi = window.CloudMark.api;
    const vault = window.CloudMark.vault;
    const accountCsv = window.CloudMark.accountCsv;
    const searchQuery = window.CloudMark.searchQuery;
    const prefs = window.CloudMark.prefs;
    const live = () => window.CloudMark.live;
    const COPY_FEEDBACK_MS = 1500;
    const CLIPBOARD_CLEAR_MS = 30000;
    const MIN_MASTER_LENGTH = 10;

    // A routes/items.js LOGIN_METHODS listájával egyezik.
    const LOGIN_METHODS = {
        password: { label: 'Saját jelszóval', short: 'Jelszó', icon: 'fa-solid fa-key' },
        google: { label: 'Google-fiókkal', short: 'Google', icon: 'fa-brands fa-google' },
        github: { label: 'GitHub-fiókkal', short: 'GitHub', icon: 'fa-brands fa-github' },
        microsoft: { label: 'Microsoft-fiókkal', short: 'Microsoft', icon: 'fa-brands fa-microsoft' },
        apple: { label: 'Apple ID-val', short: 'Apple', icon: 'fa-brands fa-apple' },
        facebook: { label: 'Facebook-fiókkal', short: 'Facebook', icon: 'fa-brands fa-facebook' },
        sso: { label: 'Egyszeri belépéssel (SSO)', short: 'SSO', icon: 'fa-solid fa-right-to-bracket' },
        ssh: { label: 'SSH kulccsal', short: 'SSH', icon: 'fa-solid fa-terminal' },
        other: { label: 'Egyéb módon', short: 'Egyéb', icon: 'fa-solid fa-circle-question' }
    };
    const SSO_METHODS = ['google', 'github', 'microsoft', 'apple', 'facebook', 'sso'];

    const state = {
        items: [],
        categories: [],
        loaded: false,
        loading: null,
        query: '',
        category: 'all',
        filter: 'active',
        sort: prefs.get('accountSort'),
        view: prefs.get('accountView'),
        // Megjelenített jelszavak (id → jelszó), zároláskor törlődnek.
        revealed: new Map()
    };
    // A széf: GET /api/vault válasza, és feloldás után a kulcs + a szerver felé igazoló token.
    const safe = { info: null, key: null, authToken: null, lastActivity: 0, timer: null };

    const grid = document.getElementById('accountGrid');
    const categoriesBar = document.getElementById('accountCategoriesBar');
    const searchInput = document.getElementById('accountSearch');
    const searchClear = document.getElementById('accountSearchClear');
    const sortSelect = document.getElementById('accountSortSelect');
    const viewSwitcher = document.getElementById('accountViewSwitcher');
    const moreButton = document.getElementById('accountMoreBtn');
    const moreMenu = document.getElementById('accountMoreMenu');
    const lockButton = document.getElementById('vaultLockBtn');
    const banner = document.getElementById('vaultBanner');
    if (!grid || !vault) return;

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    async function writeClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) throw new Error('copy failed');
    }

    let clipboardTimer = null;

    /** Copies a secret and empties the clipboard after 30 seconds (when the browser allows it). */
    async function copySecret(text) {
        await writeClipboard(text);
        clearTimeout(clipboardTimer);
        clipboardTimer = setTimeout(() => { writeClipboard('').catch(() => {}); }, CLIPBOARD_CLEAR_MS);
    }

    function flashCopied(button) {
        const icon = button?.querySelector('i');
        if (!icon) return;
        clearTimeout(button._copyTimer);
        if (!button.dataset.iconClass) button.dataset.iconClass = icon.className;
        icon.className = 'fa-solid fa-check copy-ok';
        button._copyTimer = setTimeout(() => { icon.className = button.dataset.iconClass; }, COPY_FEEDBACK_MS);
    }

    function downloadText(text, name, type) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type }));
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    /** A clickable address: http(s) as given, a bare host or IP gets http:// (home devices rarely have https). */
    function hrefOf(url) {
        const text = String(url || '').trim();
        if (!text || /\s/.test(text)) return null;
        // Csak port (pl. 8096): nem tudni, melyik gépen, ezért nem lesz belőle link.
        if (/^:?\d{1,5}$/.test(text)) return null;
        if (/^https?:\/\//i.test(text)) return text;
        if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[\w.-]+:\d+/.test(text)) return null;
        return `http://${text}`;
    }

    const extraOf = item => item.extra || {};
    const methodOf = item => (LOGIN_METHODS[extraOf(item).loginMethod] ? extraOf(item).loginMethod : 'password');

    // ---------- széf: feloldás, zárolás ----------

    const isUnlocked = () => Boolean(safe.key);
    const vaultExists = () => Boolean(safe.info?.exists);

    async function loadVaultInfo() {
        safe.info = await accountApi.getVault();
        return safe.info;
    }

    function autoLockMinutes() {
        const value = prefs.get('vaultAutoLock');
        return value === 'never' ? null : Number(value);
    }

    function touch() {
        if (isUnlocked()) safe.lastActivity = Date.now();
    }

    function setUnlocked(opened) {
        safe.key = opened.key;
        safe.authToken = opened.authToken;
        safe.lastActivity = Date.now();
        clearInterval(safe.timer);
        safe.timer = setInterval(() => {
            const minutes = autoLockMinutes();
            if (minutes && Date.now() - safe.lastActivity > minutes * 60000) lock('Tétlenség miatt a széf zárolva.');
        }, 15000);
        refreshVaultUi();
        onUnlockedInEditor();
    }

    /** Forgets the key and every decrypted value on screen. */
    function lock(message) {
        const wasUnlocked = isUnlocked();
        safe.key = null;
        safe.authToken = null;
        clearInterval(safe.timer);
        safe.timer = null;
        state.revealed.clear();
        refreshVaultUi();
        lockEditorSecrets();
        if (state.loaded) renderGrid();
        if (message && wasUnlocked) notify(message, 'info');
    }

    ['pointerdown', 'keydown'].forEach(name => document.addEventListener(name, touch, { capture: true, passive: true }));

    function refreshVaultUi() {
        const unlocked = isUnlocked();
        lockButton.innerHTML = `<i class="fa-solid ${unlocked ? 'fa-lock-open' : 'fa-lock'}"></i>`;
        lockButton.classList.toggle('is-unlocked', unlocked);
        const label = unlocked ? 'Széf feloldva – kattints a zároláshoz' : (vaultExists() ? 'Széf zárolva – kattints a feloldáshoz' : 'Széf létrehozása');
        lockButton.title = label;
        lockButton.setAttribute('aria-label', label);
        if (!state.loaded || unlocked) { banner.hidden = true; banner.innerHTML = ''; return; }
        banner.hidden = false;
        banner.innerHTML = vaultExists()
            ? `<i class="fa-solid fa-lock"></i><span>A széf zárolva. A nevek, címek és felhasználónevek látszanak, a jelszavakhoz oldd fel a mesterjelszóval.</span>
               <button type="button" class="btn btn-primary" data-vault-action="unlock"><i class="fa-solid fa-lock-open"></i> Feloldás</button>`
            : `<i class="fa-solid fa-shield-halved"></i><span>A jelszavak tárolásához hozz létre egy széfet mesterjelszóval. A jelszavak a böngésződben titkosítódnak, a szerver sosem látja őket.</span>
               <button type="button" class="btn btn-primary" data-vault-action="create"><i class="fa-solid fa-vault"></i> Széf létrehozása</button>`;
    }

    banner.addEventListener('click', event => {
        const button = event.target.closest('[data-vault-action]');
        if (button) ensureUnlocked();
    });

    lockButton.addEventListener('click', () => {
        if (isUnlocked()) lock();
        else ensureUnlocked();
    });

    // ---------- széf ablak (létrehozás, feloldás, helyreállítás, csere, törlés) ----------

    const vaultModal = document.getElementById('vaultModal');
    const vaultTitle = document.getElementById('vaultModalTitle');
    const vaultBody = document.getElementById('vaultModalBody');
    let dialog = null;

    // A modal az overlayre kattintva vagy Esc-re is bezárul: a várakozó hívás ilyenkor „mégse” választ kap.
    new MutationObserver(() => {
        if (!vaultModal.classList.contains('active') && dialog) {
            const pending = dialog;
            dialog = null;
            pending.resolve(null);
        }
    }).observe(vaultModal, { attributes: true, attributeFilter: ['class'] });

    function finishDialog(result) {
        const pending = dialog;
        dialog = null;
        closeModal('vaultModal');
        pending?.resolve(result);
    }

    function passwordField(id, label, autocomplete = 'off', extra = '') {
        return `<div class="form-control">
            <label for="${id}">${esc(label)}</label>
            <input type="password" id="${id}" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off" ${extra}>
        </div>`;
    }

    const formButtons = submit => `
        <div class="vault-actions">
            <button type="button" class="btn btn-secondary" data-vault-cancel>Mégse</button>
            <button type="submit" class="btn btn-primary">${submit}</button>
        </div>`;

    function newPasswordFields(label = 'Mesterjelszó') {
        return `${passwordField('vaultNewPassword', label, 'new-password', `minlength="${MIN_MASTER_LENGTH}" required`)}
            <div class="password-strength" id="vaultStrength" aria-live="polite"></div>
            ${passwordField('vaultNewPassword2', `${label} ismét`, 'new-password', 'required')}`;
    }

    /** Checks the two new master password fields; returns the password or null (with an inline error). */
    function readNewPassword(form) {
        const first = form.querySelector('#vaultNewPassword').value;
        const second = form.querySelector('#vaultNewPassword2').value;
        if (first.length < MIN_MASTER_LENGTH) return showFormError(form, `A mesterjelszó legalább ${MIN_MASTER_LENGTH} karakter legyen (jobb egy hosszabb mondat).`);
        if (first !== second) return showFormError(form, 'A két mesterjelszó nem egyezik.');
        return first;
    }

    function showFormError(form, message) {
        const box = form.querySelector('.vault-error');
        box.textContent = message;
        box.hidden = false;
        return null;
    }

    function renderStrength(input, box) {
        const result = vault.strength(input.value);
        box.dataset.score = String(result.score);
        box.innerHTML = input.value ? `<span class="strength-bar"><span style="width:${(result.score + 1) * 20}%"></span></span> ${esc(result.label)}` : '';
    }

    /**
     * Opens the vault window in one mode and resolves with its result (null when closed).
     * Modes: create, unlock, recover, change, new-recovery, delete, ask (password for an import / export).
     */
    function openVaultDialog(mode, options = {}) {
        if (dialog) dialog.resolve(null);
        return new Promise(resolve => {
            dialog = { resolve, mode };
            renderDialog(mode, options);
            openModal('vaultModal');
            setTimeout(() => vaultBody.querySelector('input:not([type=checkbox])')?.focus(), 50);
        });
    }

    function renderDialog(mode, options) {
        const titles = {
            create: 'Széf létrehozása', unlock: 'Széf feloldása', recover: 'Elfelejtett mesterjelszó', change: 'Mesterjelszó módosítása',
            'new-recovery': 'Új helyreállító kulcs', delete: 'Széf törlése', ask: options.title || 'Mesterjelszó', 'show-key': 'Helyreállító kulcs'
        };
        vaultTitle.textContent = titles[mode] || 'Széf';
        let html = '';
        if (mode === 'create') {
            html = `<p>A fiókjaid jelszavai a böngésződben titkosítódnak ezzel a <strong>mesterjelszóval</strong>. A CloudMark szervere sem a mesterjelszót, sem a jelszavaidat nem látja.</p>
                <p class="vault-warning"><i class="fa-solid fa-triangle-exclamation"></i> A mesterjelszót senki nem tudja visszaállítani. Kapsz helyette egy helyreállító kulcsot: ha mindkettő elveszik, a jelszavak is elvesznek.</p>
                ${newPasswordFields()}
                <small class="settings-hint">Ne a CloudMark belépési jelszavadat add meg. Jó választás egy hosszú mondat, pl. „kék bicikli a pincében 2019”.</small>`;
        } else if (mode === 'unlock') {
            html = `${passwordField('vaultPassword', 'Mesterjelszó', 'off', 'required')}
                <button type="button" class="ai-link vault-link" data-vault-go="recover">Elfelejtettem a mesterjelszót</button>`;
        } else if (mode === 'recover') {
            html = safe.info?.recovery
                ? `<p>Add meg a széf létrehozásakor kapott helyreállító kulcsot, és válassz új mesterjelszót. A jelszavaid megmaradnak.</p>
                    <div class="form-control">
                        <label for="vaultRecoveryKey">Helyreállító kulcs</label>
                        <input type="text" id="vaultRecoveryKey" class="vault-key-input" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required>
                    </div>
                    ${newPasswordFields('Új mesterjelszó')}`
                : `<p>Ehhez a széfhez nem tartozik helyreállító kulcs. Mesterjelszó nélkül a jelszavak nem nyithatók ki.</p>
                    <p>Ha nem jut eszedbe, a széfet törölheted: a fiókok (nevek, címek, felhasználónevek) megmaradnak, csak a jelszavak és a titkos megjegyzések vesznek el.</p>`;
        } else if (mode === 'change') {
            html = `${passwordField('vaultPassword', 'Jelenlegi mesterjelszó', 'off', 'required')}
                ${newPasswordFields('Új mesterjelszó')}
                <small class="settings-hint">A helyreállító kulcsod érvényes marad.</small>`;
        } else if (mode === 'new-recovery') {
            html = `<p>Új helyreállító kulcsot kapsz, a régi ezután nem működik. A mesterjelszó nem változik.</p>
                ${passwordField('vaultPassword', 'Mesterjelszó', 'off', 'required')}`;
        } else if (mode === 'delete') {
            html = `<p class="vault-warning"><i class="fa-solid fa-triangle-exclamation"></i> A széf törlésével <strong>minden elmentett jelszó és titkos megjegyzés véglegesen elvész</strong>. A fiókok (név, cím, felhasználónév, megjegyzés) megmaradnak. Ezután új széfet hozhatsz létre.</p>
                ${passwordField('vaultLoginPassword', 'A CloudMark belépési jelszavad', 'current-password', 'required')}
                <div class="form-control">
                    <label for="vaultDeleteConfirm">Írd be: TÖRLÉS</label>
                    <input type="text" id="vaultDeleteConfirm" autocomplete="off" required>
                </div>`;
        } else if (mode === 'ask') {
            html = `${options.text ? `<p>${esc(options.text)}</p>` : ''}${passwordField('vaultPassword', options.label || 'Mesterjelszó', 'off', 'required')}`;
        } else if (mode === 'show-key') {
            html = `<p>Ez a <strong>helyreállító kulcsod</strong>. Ha elfelejted a mesterjelszót, ezzel adhatsz újat. Csak most látod: írd le, vagy mentsd el biztonságos helyre (ne ide a CloudMarkba).</p>
                <div class="vault-recovery-key" id="vaultRecoveryShow">${esc(options.recoveryKey)}</div>
                <div class="vault-key-actions">
                    <button type="button" class="btn btn-secondary" data-vault-key="copy"><i class="fa-regular fa-copy"></i> Másolás</button>
                    <button type="button" class="btn btn-secondary" data-vault-key="download"><i class="fa-solid fa-download"></i> Letöltés (.txt)</button>
                </div>
                <label class="vault-confirm"><input type="checkbox" id="vaultKeySaved"> Elmentettem vagy leírtam a helyreállító kulcsot</label>`;
        }
        const submitLabels = {
            create: '<i class="fa-solid fa-vault"></i> Létrehozás', unlock: '<i class="fa-solid fa-lock-open"></i> Feloldás',
            recover: '<i class="fa-solid fa-key"></i> Új mesterjelszó', change: '<i class="fa-solid fa-floppy-disk"></i> Mentés',
            'new-recovery': '<i class="fa-solid fa-rotate"></i> Új kulcs', delete: '<i class="fa-solid fa-trash"></i> Széf törlése',
            ask: '<i class="fa-solid fa-check"></i> Tovább', 'show-key': '<i class="fa-solid fa-check"></i> Kész'
        };
        const deleteLink = mode === 'recover' && !safe.info?.recovery;
        vaultBody.innerHTML = `<form class="modal-form vault-form" data-mode="${mode}" autocomplete="off" novalidate>
            ${html}
            <p class="vault-error" role="alert" hidden></p>
            ${deleteLink
                ? `<div class="vault-actions"><button type="button" class="btn btn-secondary" data-vault-cancel>Mégse</button><button type="button" class="btn btn-danger" data-vault-go="delete"><i class="fa-solid fa-trash"></i> Széf törlése…</button></div>`
                : formButtons(submitLabels[mode])}
        </form>`;
        const form = vaultBody.querySelector('form');
        if (mode === 'show-key') {
            const done = form.querySelector('button[type=submit]');
            done.disabled = true;
            form.querySelector('[data-vault-cancel]').hidden = true;
            form.querySelector('#vaultKeySaved').addEventListener('change', event => { done.disabled = !event.target.checked; });
        }
        const strengthInput = form.querySelector('#vaultNewPassword');
        if (strengthInput) strengthInput.addEventListener('input', () => renderStrength(strengthInput, form.querySelector('#vaultStrength')));
        form.addEventListener('submit', event => {
            event.preventDefault();
            submitDialog(mode, form, options);
        });
    }

    vaultBody.addEventListener('click', async event => {
        if (event.target.closest('[data-vault-cancel]')) { finishDialog(null); return; }
        const go = event.target.closest('[data-vault-go]');
        if (go) {
            const pending = dialog;
            dialog = null;
            const result = await openVaultDialog(go.dataset.vaultGo);
            pending?.resolve(go.dataset.vaultGo === 'delete' ? null : result);
            return;
        }
        const keyButton = event.target.closest('[data-vault-key]');
        if (keyButton) {
            const key = document.getElementById('vaultRecoveryShow').textContent.trim();
            if (keyButton.dataset.vaultKey === 'copy') {
                try { await writeClipboard(key); flashCopied(keyButton); } catch (err) { notify('A másolás nem sikerült.', 'error'); }
            } else {
                const user = typeof currentUser !== 'undefined' && currentUser ? currentUser.username : '';
                downloadText(`CloudMark – Fiókok széf helyreállító kulcs\r\nFelhasználó: ${user}\r\nKészült: ${new Date().toLocaleString('hu-HU')}\r\n\r\n${key}\r\n\r\nHa elfelejted a mesterjelszót: Fiókok → Feloldás → „Elfelejtettem a mesterjelszót”.\r\nTartsd biztonságos helyen, ne a CloudMarkban.\r\n`,
                    'cloudmark-helyreallito-kulcs.txt', 'text/plain');
            }
        }
    });

    function setBusy(form, busy) {
        const button = form.querySelector('button[type=submit]');
        if (!button) return;
        if (busy) {
            button.dataset.label = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Titkosítás…';
        } else if (button.dataset.label) button.innerHTML = button.dataset.label;
        button.disabled = busy;
        form.querySelectorAll('input').forEach(input => { input.disabled = busy; });
    }

    async function submitDialog(mode, form, options) {
        const value = id => form.querySelector(`#${id}`)?.value || '';
        form.querySelector('.vault-error').hidden = true;
        if (mode === 'show-key') { finishDialog(true); return; }
        if (mode === 'ask') { finishDialog(value('vaultPassword')); return; }
        let password = null;
        if (['create', 'recover', 'change'].includes(mode)) {
            password = readNewPassword(form);
            if (!password) return;
        }
        if (mode === 'delete' && value('vaultDeleteConfirm').trim().toUpperCase() !== 'TÖRLÉS') {
            showFormError(form, 'A megerősítéshez írd be: TÖRLÉS');
            return;
        }
        setBusy(form, true);
        try {
            if (mode === 'create') {
                const created = await vault.createVault(password);
                safe.info = await accountApi.createVault({ ...created.record, authToken: created.authToken });
                setUnlocked(created);
                dialog.resolve(true);
                dialog = { resolve: () => {} };
                renderDialog('show-key', { recoveryKey: created.recoveryKey });
                return;
            }
            if (mode === 'unlock') {
                setUnlocked(await vault.unlock(safe.info, value('vaultPassword')));
                finishDialog(true);
                return;
            }
            if (mode === 'recover' || mode === 'change') {
                const credentials = mode === 'recover' ? { recoveryKey: value('vaultRecoveryKey') } : { password: value('vaultPassword') };
                const changed = await vault.changePassword(safe.info, credentials, password);
                safe.info = await accountApi.updateVault({ ...changed.record, authToken: changed.authToken });
                setUnlocked(changed);
                finishDialog(true);
                notify(mode === 'recover' ? 'Új mesterjelszó beállítva, a széf feloldva.' : 'Mesterjelszó módosítva.', 'success');
                renderSettings();
                return;
            }
            if (mode === 'new-recovery') {
                const renewed = await vault.newRecoveryKey(safe.info, value('vaultPassword'));
                safe.info = await accountApi.updateVault({ ...renewed.record, authToken: renewed.authToken });
                dialog.resolve(true);
                dialog = { resolve: () => {} };
                renderDialog('show-key', { recoveryKey: renewed.recoveryKey });
                renderSettings();
                return;
            }
            if (mode === 'delete') {
                await accountApi.deleteVault(value('vaultLoginPassword'));
                lock();
                safe.info = { exists: false };
                finishDialog(true);
                notify('A széf törölve. Új széfet a Fiókok nézetben hozhatsz létre.', 'success');
                renderSettings();
                if (state.loaded) await load(true);
            }
        } catch (err) {
            setBusy(form, false);
            if (err instanceof vault.VaultError) showFormError(form, mode === 'recover' ? 'Hibás helyreállító kulcs.' : 'Hibás mesterjelszó.');
            else showFormError(form, err.message || 'A művelet nem sikerült.');
        }
    }

    /** Resolves true once the vault is unlocked (creating it first when there is none), false when the user gives up. */
    async function ensureUnlocked() {
        if (isUnlocked()) return true;
        try {
            if (!safe.info) await loadVaultInfo();
        } catch (err) {
            notify(err.message || 'A széf nem tölthető be.', 'error');
            return false;
        }
        const result = await openVaultDialog(vaultExists() ? 'unlock' : 'create');
        return Boolean(result) && isUnlocked();
    }

    // ---------- adatok ----------

    async function load(force = false) {
        if (state.loaded && !force) return;
        if (state.loading && !force) return state.loading;
        if (!state.loaded) grid.innerHTML = '<div class="empty-state">Fiókok betöltése…</div>';
        state.loading = Promise.all([
            accountApi.getItems('account', { all: 'true' }),
            accountApi.getCategoriesOfKind('account'),
            loadVaultInfo()
        ]).then(([items, categories]) => {
            state.items = items;
            state.categories = categories;
            state.loaded = true;
            refreshVaultUi();
            render();
        }).catch(err => {
            grid.innerHTML = `<div class="empty-state">A fiókok betöltése nem sikerült: ${esc(err.message)}</div>`;
        }).finally(() => { state.loading = null; });
        return state.loading;
    }

    function reset() {
        lock();
        safe.info = null;
        state.items = [];
        state.categories = [];
        state.loaded = false;
        state.category = 'all';
        state.query = '';
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        grid.innerHTML = '';
        categoriesBar.innerHTML = '';
        banner.hidden = true;
        if (dialog) finishDialog(null);
        closeEditor();
    }

    function upsertItem(item) {
        const index = state.items.findIndex(existing => String(existing.id) === String(item.id));
        if (index === -1) state.items.unshift(item);
        else state.items[index] = item;
    }

    function findItem(id) {
        return state.items.find(item => String(item.id) === String(id));
    }

    /** The decrypted { password, secretNote } of an account (unlocks the vault first when needed); null when cancelled. */
    async function readSecret(item) {
        if (!item.has_secret) return { password: '', secretNote: '' };
        if (!(await ensureUnlocked())) return null;
        const secret = await accountApi.getItemSecret(item.id);
        try {
            return await vault.decryptSecret(safe.key, secret);
        } catch (err) {
            notify('Ez a jelszó nem nyitható ki ezzel a széffel (pl. egy korábbi, törölt széfből maradt).', 'error');
            return null;
        }
    }

    // ---------- kategóriák ----------

    function sortedCategories() {
        return [...state.categories].sort((a, b) => a.name.localeCompare(b.name, 'hu'));
    }

    function renderCategories() {
        const pool = state.items.filter(item => !item.trashed && !item.archived);
        const chips = [{ key: 'all', label: 'Összes', count: pool.length }];
        const inboxCount = pool.filter(item => item.category_id === null).length;
        if (inboxCount) chips.push({ key: 'inbox', label: 'Inbox', count: inboxCount });
        sortedCategories().forEach(category => chips.push({
            key: String(category.id), label: category.name,
            count: pool.filter(item => String(item.category_id) === String(category.id)).length
        }));
        if (!chips.some(chip => chip.key === state.category)) state.category = 'all';
        categoriesBar.innerHTML = chips.map(chip => `
            <button type="button" class="category-chip ${chip.key === state.category ? 'active' : ''}" data-category="${esc(chip.key)}">
                ${esc(chip.label)} <span class="command-chip-count">${chip.count}</span>
            </button>`).join('');
    }

    function fillCategorySelect(select, selectedId) {
        select.innerHTML = '<option value="">Inbox (nincs kategória)</option>' + sortedCategories()
            .map(category => `<option value="${Number(category.id)}" ${String(category.id) === String(selectedId ?? '') ? 'selected' : ''}>${esc(category.name)}</option>`).join('');
    }

    // ---------- kártyák ----------

    function visibleItems() {
        const query = searchQuery.parse(state.query);
        const list = state.items.filter(item => {
            if (state.filter === 'trash') { if (!item.trashed) return false; }
            else if (item.trashed) return false;
            else if (state.filter === 'archived') { if (!item.archived) return false; }
            else if (item.archived) return false;
            if (state.filter === 'starred' && !item.starred) return false;
            if (state.category === 'inbox' && item.category_id !== null) return false;
            if (/^\d+$/.test(state.category) && String(item.category_id) !== state.category) return false;
            const extra = extraOf(item);
            return searchQuery.matches(query, {
                texts: [item.title, extra.url, extra.username, extra.ssoAccount, LOGIN_METHODS[methodOf(item)].short, item.description, item.category_name, ...item.tags.map(tag => `#${tag}`)],
                tags: item.tags,
                categories: item.category_id === null ? ['inbox'] : [item.category_name || '']
            });
        });
        const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'hu');
        if (state.sort === 'newest') list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        else if (state.sort === 'used') list.sort((a, b) => (b.use_count - a.use_count) || byTitle(a, b));
        else list.sort(byTitle);
        return list;
    }

    function fieldRow(icon, label, valueHtml, actions = '') {
        return `<div class="account-field"><span class="account-field-label" title="${esc(label)}"><i class="${icon}" aria-hidden="true"></i><span class="sr-only">${esc(label)}</span></span>
            <span class="account-field-value">${valueHtml}</span><span class="account-field-actions">${actions}</span></div>`;
    }

    const copyButton = (action, title) => `<button type="button" class="action-btn" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}"><i class="fa-regular fa-copy"></i></button>`;

    function cardHtml(item) {
        const extra = extraOf(item);
        const method = methodOf(item);
        const href = hrefOf(extra.url);
        const rows = [];
        if (extra.url) {
            rows.push(fieldRow('fa-solid fa-globe', 'Cím', href
                ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-action="open">${esc(extra.url)}</a>`
                : esc(extra.url), copyButton('copy-url', 'Cím másolása')));
        }
        if (extra.username) rows.push(fieldRow('fa-solid fa-user', 'Felhasználónév', esc(extra.username), copyButton('copy-username', 'Felhasználónév másolása')));
        if (SSO_METHODS.includes(method) && extra.ssoAccount) {
            rows.push(fieldRow(LOGIN_METHODS[method].icon, LOGIN_METHODS[method].label, esc(extra.ssoAccount), copyButton('copy-sso', 'Fiók másolása')));
        }
        if (item.has_secret) {
            const shown = state.revealed.get(String(item.id));
            rows.push(fieldRow('fa-solid fa-key', 'Jelszó',
                shown !== undefined ? `<code class="account-password">${esc(shown || '(üres)')}</code>` : '<span class="account-dots" aria-label="rejtett jelszó">••••••••••</span>',
                `<button type="button" class="action-btn" data-action="reveal" title="${shown !== undefined ? 'Elrejtés' : 'Megjelenítés'}" aria-label="${shown !== undefined ? 'Jelszó elrejtése' : 'Jelszó megjelenítése'}"><i class="fa-solid ${shown !== undefined ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                 ${copyButton('copy-password', 'Jelszó másolása')}`));
        }
        const stateButtons = item.trashed ? `
            <button type="button" class="action-btn" data-action="restore" title="Visszaállítás"><i class="fa-solid fa-rotate-left"></i></button>
            <button type="button" class="action-btn" data-action="delete" title="Végleges törlés"><i class="fa-solid fa-trash-can"></i></button>` : `
            <button type="button" class="action-btn ${item.starred ? 'is-starred' : ''}" data-action="star" title="${item.starred ? 'Kedvenc eltávolítása' : 'Kedvencnek jelölés'}"><i class="${item.starred ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
            <button type="button" class="action-btn" data-action="edit" title="Szerkesztés"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="action-btn" data-action="archive" title="${item.archived ? 'Vissza az archívumból' : 'Archiválás'}"><i class="fa-solid ${item.archived ? 'fa-box-open' : 'fa-box-archive'}"></i></button>
            <button type="button" class="action-btn" data-action="trash" title="Kukába"><i class="fa-solid fa-trash"></i></button>`;
        return `
            <article class="card account-card" data-item-id="${Number(item.id)}">
                <div class="account-card-head">
                    <span class="account-icon method-${esc(method)}" title="${esc(LOGIN_METHODS[method].label)}"><i class="${LOGIN_METHODS[method].icon}" aria-hidden="true"></i></span>
                    <div class="account-card-main">
                        <h3 class="card-title">${esc(item.title)}</h3>
                        <div class="card-meta">
                            <span class="card-category">${esc(item.category_name || 'Inbox')}</span>
                            <span class="account-method">${esc(LOGIN_METHODS[method].label)}</span>
                        </div>
                    </div>
                    <div class="command-card-actions">${stateButtons}</div>
                </div>
                ${rows.length ? `<div class="account-fields">${rows.join('')}</div>` : ''}
                ${item.description ? `<p class="command-desc account-desc">${esc(item.description)}</p>` : ''}
                ${item.tags.length ? `<div class="card-tags">${item.tags.map(tag => `#${esc(tag)}`).join(' ')}</div>` : ''}
            </article>`;
    }

    function renderGrid() {
        grid.classList.remove('view-grid', 'view-compact', 'view-list');
        grid.classList.add(`view-${state.view}`);
        prefs.markSwitcher(viewSwitcher, state.view);
        refreshVaultUi();
        const list = visibleItems();
        if (!state.items.length) {
            grid.innerHTML = '<div class="empty-state">Még nincs fiókod. Vegyél fel egyet az „Új fiók” gombbal, vagy importáld a böngésződ jelszavait (⋮ → Import).</div>';
            return;
        }
        if (!list.length) {
            const empty = { trash: 'A kuka üres.', archived: 'Az archívum üres.' }[state.filter] || 'Nincs a keresésnek megfelelő fiók.';
            grid.innerHTML = `<div class="empty-state">${empty}</div>`;
            return;
        }
        grid.innerHTML = list.map(cardHtml).join('');
    }

    function rerenderCard(item) {
        const card = grid.querySelector(`[data-item-id="${Number(item.id)}"]`);
        if (card) card.outerHTML = cardHtml(item);
    }

    function render() {
        renderCategories();
        renderGrid();
    }

    function closeDropdowns() {
        moreMenu.classList.remove('show');
        moreButton.setAttribute('aria-expanded', 'false');
    }

    // ---------- kártya műveletek ----------

    async function changeState(item, patch, message) {
        try {
            upsertItem(await accountApi.setItemState(item.id, patch));
            render();
            if (message) notify(message, 'success');
        } catch (err) {
            notify(err.message || 'A módosítás nem sikerült.', 'error');
        }
    }

    function markUsed(item) {
        accountApi.markItemUsed(item.id).then(result => { item.use_count = result.use_count; }).catch(() => {});
    }

    /** Copies the user name or the password of an account (also used by the Ctrl+K palette). */
    async function copyField(item, field, button) {
        const extra = extraOf(item);
        try {
            if (field === 'password') {
                if (!item.has_secret) { notify('Ennél a fióknál nincs jelszó mentve.', 'info'); return; }
                const secret = await readSecret(item);
                if (!secret) return;
                await copySecret(secret.password);
                notify('Jelszó másolva. 30 másodperc múlva törlöm a vágólapról.', 'success');
            } else {
                const text = { username: extra.username, url: extra.url, sso: extra.ssoAccount }[field] || '';
                if (!text) { notify('Ez a mező üres.', 'info'); return; }
                await writeClipboard(text);
            }
            flashCopied(button);
            markUsed(item);
        } catch (err) {
            notify('A másolás nem sikerült.', 'error');
        }
    }

    grid.addEventListener('click', async event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const card = button.closest('[data-item-id]');
        const item = card && findItem(card.dataset.itemId);
        if (!item) return;
        const action = button.dataset.action;
        if (action === 'open') { markUsed(item); return; }
        event.stopPropagation();
        if (action === 'copy-username') return copyField(item, 'username', button);
        if (action === 'copy-url') return copyField(item, 'url', button);
        if (action === 'copy-sso') return copyField(item, 'sso', button);
        if (action === 'copy-password') return copyField(item, 'password', button);
        if (action === 'reveal') {
            const id = String(item.id);
            if (state.revealed.has(id)) state.revealed.delete(id);
            else {
                const secret = await readSecret(item);
                if (!secret) return;
                state.revealed.set(id, secret.password);
            }
            rerenderCard(item);
            return;
        }
        if (action === 'star') return changeState(item, { starred: !item.starred });
        if (action === 'edit') return openEditor(item);
        if (action === 'archive') return changeState(item, { archived: !item.archived }, item.archived ? 'Fiók visszahozva az archívumból.' : 'Fiók archiválva.');
        if (action === 'trash') return changeState(item, { trashed: true }, 'Fiók a kukába helyezve.');
        if (action === 'restore') return changeState(item, { trashed: false }, 'Fiók visszaállítva.');
        if (action === 'delete') {
            if (!confirm(`Véglegesen törlöd: „${item.title}”? A jelszava is törlődik.`)) return;
            try {
                await accountApi.deleteItemPermanently(item.id);
                state.items = state.items.filter(entry => entry.id !== item.id);
                render();
                notify('Fiók véglegesen törölve.', 'success');
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
        }
    });

    // ---------- eszköztár ----------

    categoriesBar.addEventListener('click', event => {
        const chip = event.target.closest('[data-category]');
        if (!chip) return;
        state.category = chip.dataset.category;
        render();
    });

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        searchClear.hidden = !searchInput.value;
        renderGrid();
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        state.query = '';
        searchClear.hidden = true;
        renderGrid();
        searchInput.focus();
    });

    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        prefs.set('accountSort', state.sort);
        renderGrid();
    });

    viewSwitcher.addEventListener('click', event => {
        const button = event.target.closest('[data-view-mode]');
        if (!button) return;
        state.view = button.dataset.viewMode;
        prefs.set('accountView', state.view);
        renderGrid();
    });
    prefs.markSwitcher(viewSwitcher, state.view);

    document.addEventListener('cloudmark:prefs', () => {
        state.sort = prefs.get('accountSort');
        state.view = prefs.get('accountView');
        sortSelect.value = state.sort;
        if (state.loaded) renderGrid(); else prefs.markSwitcher(viewSwitcher, state.view);
    });

    document.querySelectorAll('[data-account-state]').forEach(button => button.addEventListener('click', () => {
        state.filter = button.dataset.accountState;
        document.querySelectorAll('[data-account-state]').forEach(other => other.classList.toggle('active', other === button));
        renderGrid();
    }));

    moreButton.addEventListener('click', event => {
        event.stopPropagation();
        const open = !moreMenu.classList.contains('show');
        document.querySelectorAll('.cmd-dropdown.show').forEach(menu => menu.classList.remove('show'));
        moreMenu.classList.toggle('show', open);
        moreButton.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('#accountMoreMenu') && !event.target.closest('#accountMoreBtn')) closeDropdowns();
    });
    moreMenu.addEventListener('click', event => {
        const button = event.target.closest('[data-account-menu]');
        if (!button) return;
        closeDropdowns();
        const action = button.dataset.accountMenu;
        if (action === 'categories') openCategoryManager();
        if (action === 'export-json') exportJson();
        if (action === 'export-csv') exportCsv();
        if (action === 'lock') { lock(); notify('Széf zárolva.', 'info'); }
    });

    // ---------- import / export ----------

    async function exportJson() {
        try {
            const data = await accountApi.exportAccounts();
            downloadText(JSON.stringify(data, null, 2), 'cloudmark-fiokok.json', 'application/json');
            notify('Titkosított export letöltve. A jelszavak csak a mesterjelszóval nyithatók ki.', 'success');
        } catch (err) {
            notify(err.message || 'Az exportálás nem sikerült.', 'error');
        }
    }

    /** Unencrypted CSV: asks for the master password again, since the file holds every password in plain text. */
    async function exportCsv() {
        if (!confirm('A CSV fájlban minden jelszó titkosítatlanul lesz. Csak saját gépre mentsd, és importálás után töröld. Folytatod?')) return;
        if (!(await ensureUnlocked())) return;
        const password = await openVaultDialog('ask', { title: 'Titkosítatlan export', text: 'A titkosítatlan exporthoz add meg újra a mesterjelszót.' });
        if (password === null) return;
        try {
            await vault.unlock(safe.info, password);
        } catch (err) {
            notify('Hibás mesterjelszó.', 'error');
            return;
        }
        try {
            const data = await accountApi.exportAccounts();
            const rows = [];
            let failed = 0;
            for (const entry of data.items) {
                let secret = { password: '', secretNote: '' };
                if (entry.secret) {
                    try { secret = await vault.decryptSecret(safe.key, entry.secret); } catch (err) { failed += 1; }
                }
                const extra = entry.extra || {};
                rows.push({
                    title: entry.title, url: extra.url, username: extra.username, password: secret.password, note: entry.description,
                    secretNote: secret.secretNote, loginMethod: extra.loginMethod, ssoAccount: extra.ssoAccount, category: entry.category, tags: entry.tags
                });
            }
            downloadText(accountCsv.accountsToCsv(rows), 'cloudmark-fiokok.csv', 'text/csv');
            notify(failed ? `${rows.length} fiók exportálva, ${failed} jelszó nem volt kinyitható.` : `${rows.length} fiók exportálva.`, failed ? 'error' : 'success');
        } catch (err) {
            notify(err.message || 'Az exportálás nem sikerült.', 'error');
        }
    }

    /** CloudMark JSON export → import rows; secrets are re-encrypted with this vault's key (asking for the export's master password if it differs). */
    async function accountsFromJson(data) {
        const list = Array.isArray(data) ? data : data.items;
        if (!Array.isArray(list)) throw new Error('Ez nem CloudMark fiók export.');
        let foreignKey = null;
        const accounts = [];
        for (const entry of list) {
            let secret = { password: '', secretNote: '' };
            if (entry.secret) {
                try {
                    secret = await vault.decryptSecret(foreignKey || safe.key, entry.secret);
                } catch (err) {
                    if (foreignKey || !data.vault) throw new Error('A fájl jelszavai nem nyithatók ki.');
                    const password = await openVaultDialog('ask', { title: 'Másik széf exportja', text: 'Ez a fájl egy másik (vagy korábbi) széfből készült. Add meg az akkori mesterjelszót.' });
                    if (password === null) return null;
                    foreignKey = (await vault.unlock({ ...data.vault, recovery: null }, password)).key;
                    secret = await vault.decryptSecret(foreignKey, entry.secret);
                }
            }
            const extra = entry.extra || {};
            accounts.push({
                title: entry.title, url: extra.url, username: extra.username, loginMethod: extra.loginMethod, ssoAccount: extra.ssoAccount,
                note: entry.description, category: entry.category, tags: entry.tags || [], starred: entry.starred, archived: entry.archived, ...secret
            });
        }
        return accounts;
    }

    document.getElementById('accountImportInput').addEventListener('change', async event => {
        const file = event.target.files[0];
        event.target.value = '';
        closeDropdowns();
        if (!file) return;
        if (!(await ensureUnlocked())) { notify('Az importhoz a széfnek feloldva kell lennie.', 'info'); return; }
        let accounts;
        let label;
        try {
            const text = await file.text();
            if (/^\s*[[{]/.test(text)) {
                accounts = await accountsFromJson(JSON.parse(text));
                if (!accounts) return;
                label = 'CloudMark export';
            } else {
                const parsed = accountCsv.parseAccounts(text);
                if (!parsed.format) throw new Error('Ismeretlen CSV formátum. Chrome, Edge, Firefox, Bitwarden vagy CloudMark exportot tudok beolvasni.');
                accounts = parsed.accounts;
                label = { chrome: 'Chrome / Edge CSV', firefox: 'Firefox CSV', bitwarden: 'Bitwarden CSV', cloudmark: 'CloudMark CSV' }[parsed.format];
            }
        } catch (err) {
            notify(err.message || 'A fájl nem olvasható.', 'error');
            return;
        }
        if (!accounts.length) { notify('A fájlban nincs importálható fiók.', 'info'); return; }
        if (!confirm(`${accounts.length} fiók importálása (${label}). A jelszavak a böngészőben titkosítódnak. Folytatod?`)) return;
        try {
            const items = [];
            for (const account of accounts) {
                const hasSecret = account.password || account.secretNote;
                items.push({
                    title: account.title,
                    description: account.note || '',
                    category: account.category || null,
                    tags: account.tags || [],
                    starred: Boolean(account.starred),
                    archived: Boolean(account.archived),
                    extra: { url: account.url || '', username: account.username || '', loginMethod: account.loginMethod || 'password', ssoAccount: account.ssoAccount || '' },
                    secret: hasSecret ? await vault.encryptSecret(safe.key, account) : undefined
                });
            }
            const result = await accountApi.importItems('account', items);
            await load(true);
            notify(`${result.imported} fiók importálva. Az eredeti fájlt érdemes törölni.`, 'success');
        } catch (err) {
            notify(err.message || 'Az importálás nem sikerült.', 'error');
        }
    });

    // ---------- szerkesztő ----------

    const editForm = document.getElementById('accountEditForm');
    const modalBox = document.querySelector('#accountEditModal .account-edit-modal');
    const newButton = document.getElementById('accountNewBtn');
    const newPanel = document.getElementById('accountNewPanel');
    const fields = {
        title: document.getElementById('accTitle'),
        url: document.getElementById('accUrl'),
        method: document.getElementById('accLoginMethod'),
        username: document.getElementById('accUsername'),
        sso: document.getElementById('accSsoAccount'),
        password: document.getElementById('accPassword'),
        secretNote: document.getElementById('accSecretNote'),
        description: document.getElementById('accDescription'),
        category: document.getElementById('accCategory')
    };
    const ssoRow = document.getElementById('accSsoRow');
    const passwordRow = document.getElementById('accPasswordRow');
    const secretLocked = document.getElementById('accSecretLocked');
    const strengthBox = document.getElementById('accStrength');
    const generator = document.getElementById('accGenerator');
    let editing = null;
    // A titkos mezők a tárolt titkot mutatják (feloldott széf); `original` a betöltött érték a változás méréséhez.
    let secretState = { loaded: false, original: { password: '', secretNote: '' }, run: 0 };

    function updateMethodRows() {
        const sso = SSO_METHODS.includes(fields.method.value);
        ssoRow.hidden = !sso;
        // Közösségi belépésnél nincs saját jelszó; ha mégis van mentve, a mező látszik.
        passwordRow.hidden = sso && !fields.password.value;
    }

    function setSecretFieldsEnabled(enabled) {
        fields.password.disabled = !enabled;
        fields.secretNote.disabled = !enabled;
        document.getElementById('accGenerateToggle').disabled = !enabled;
        document.getElementById('accPasswordToggle').disabled = !enabled;
        secretLocked.hidden = enabled;
        if (!enabled) generator.hidden = true;
        document.getElementById('accSecretLockedText').textContent = vaultExists()
            ? (editing?.has_secret ? 'A jelszó megtekintéséhez és módosításához oldd fel a széfet.' : 'A jelszó megadásához oldd fel a széfet.')
            : 'A jelszó tárolásához először hozz létre egy széfet mesterjelszóval.';
        document.getElementById('accUnlockBtn').innerHTML = vaultExists()
            ? '<i class="fa-solid fa-lock-open"></i> Feloldás' : '<i class="fa-solid fa-vault"></i> Széf létrehozása';
    }

    function clearSecretFields() {
        fields.password.value = '';
        fields.secretNote.value = '';
        fields.password.type = 'password';
        renderStrength(fields.password, strengthBox);
    }

    /** Loads the stored secret into the form once the vault is unlocked. */
    async function loadSecretIntoForm() {
        const run = ++secretState.run;
        secretState.loaded = false;
        clearSecretFields();
        if (!isUnlocked()) { setSecretFieldsEnabled(false); updateMethodRows(); return; }
        let secret = { password: '', secretNote: '' };
        if (editing?.has_secret) {
            setSecretFieldsEnabled(false);
            secretLocked.hidden = true;
            try {
                secret = await vault.decryptSecret(safe.key, await accountApi.getItemSecret(editing.id));
            } catch (err) {
                if (run !== secretState.run) return;
                setSecretFieldsEnabled(false);
                document.getElementById('accSecretLockedText').textContent = 'A mentett jelszó nem nyitható ki ezzel a széffel. Új jelszót a széf feloldása után adhatsz meg.';
                return;
            }
        }
        if (run !== secretState.run) return;
        fields.password.value = secret.password;
        fields.secretNote.value = secret.secretNote;
        secretState = { loaded: true, original: secret, run };
        setSecretFieldsEnabled(true);
        renderStrength(fields.password, strengthBox);
        updateMethodRows();
    }

    function onUnlockedInEditor() {
        if (!editorOpen()) return;
        loadSecretIntoForm();
    }

    function lockEditorSecrets() {
        if (!editorOpen()) return;
        secretState = { loaded: false, original: { password: '', secretNote: '' }, run: secretState.run + 1 };
        clearSecretFields();
        setSecretFieldsEnabled(false);
    }

    const editorOpen = () => !newPanel.hidden || document.getElementById('accountEditModal').classList.contains('active');

    function closeEditor() {
        live()?.clearConflictBar(editForm);
        resetAi();
        secretState = { loaded: false, original: { password: '', secretNote: '' }, run: secretState.run + 1 };
        clearSecretFields();
        newPanel.hidden = true;
        newButton.setAttribute('aria-expanded', 'false');
        if (editForm.parentElement !== modalBox) modalBox.appendChild(editForm);
        closeModal('accountEditModal');
        editing = null;
    }

    async function openEditor(item, preset = {}) {
        if (!state.loaded) await load();
        live()?.clearConflictBar(editForm);
        editing = item;
        const extra = item ? extraOf(item) : {};
        document.getElementById('accountEditTitle').textContent = item ? 'Fiók szerkesztése' : 'Új fiók';
        fields.title.value = item?.title || preset.title || '';
        fields.url.value = extra.url || '';
        fields.method.value = item ? methodOf(item) : 'password';
        fields.username.value = extra.username || '';
        fields.sso.value = extra.ssoAccount || '';
        fields.description.value = item?.description || '';
        fillCategorySelect(fields.category, item ? item.category_id : (/^\d+$/.test(state.category) ? state.category : ''));
        if (typeof setTagInputValues === 'function') setTagInputValues('accTags', item?.tags || []);
        generator.hidden = true;
        resetAi();
        refreshAiRow();
        loadSecretIntoForm();
        updateMethodRows();
        if (item) {
            newPanel.hidden = true;
            newButton.setAttribute('aria-expanded', 'false');
            modalBox.appendChild(editForm);
            openModal('accountEditModal');
            setTimeout(() => fields.title.focus(), 50);
            return;
        }
        newPanel.appendChild(editForm);
        newPanel.hidden = false;
        newButton.setAttribute('aria-expanded', 'true');
        newPanel.scrollIntoView({ block: 'nearest' });
        fields.title.focus({ preventScroll: true });
    }

    newButton.addEventListener('click', () => {
        if (!newPanel.hidden) closeEditor();
        else openEditor(null);
    });
    document.getElementById('accCancelBtn').addEventListener('click', closeEditor);
    document.getElementById('accUnlockBtn').addEventListener('click', () => ensureUnlocked());
    fields.method.addEventListener('change', updateMethodRows);
    fields.password.addEventListener('input', () => renderStrength(fields.password, strengthBox));

    document.getElementById('accPasswordToggle').addEventListener('click', event => {
        const show = fields.password.type === 'password';
        fields.password.type = show ? 'text' : 'password';
        event.currentTarget.innerHTML = `<i class="fa-solid ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    });

    const genLength = document.getElementById('accGenLength');
    function generate() {
        fields.password.value = vault.generatePassword({
            length: Number(genLength.value),
            upper: document.getElementById('accGenUpper').checked,
            digits: document.getElementById('accGenDigits').checked,
            symbols: document.getElementById('accGenSymbols').checked
        });
        fields.password.type = 'text';
        document.getElementById('accPasswordToggle').innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
        renderStrength(fields.password, strengthBox);
    }
    document.getElementById('accGenerateToggle').addEventListener('click', event => {
        generator.hidden = !generator.hidden;
        event.currentTarget.setAttribute('aria-expanded', String(!generator.hidden));
        if (!generator.hidden && !fields.password.value) generate();
    });
    document.getElementById('accGenerateBtn').addEventListener('click', generate);
    genLength.addEventListener('input', () => {
        document.getElementById('accGenLengthValue').textContent = genLength.value;
        generate();
    });
    ['accGenUpper', 'accGenDigits', 'accGenSymbols'].forEach(id => document.getElementById(id).addEventListener('change', generate));

    editForm.addEventListener('submit', async event => {
        event.preventDefault();
        const title = fields.title.value.trim();
        if (!title) { notify('Add meg a fiók nevét.', 'error'); fields.title.focus(); return; }
        const payload = {
            type: 'account',
            title,
            description: fields.description.value.trim(),
            categoryId: fields.category.value || null,
            tags: typeof getTagInputValues === 'function' ? getTagInputValues('accTags') : [],
            starred: editing ? editing.starred : false,
            pinned: editing ? editing.pinned : false,
            color: editing ? editing.color : null,
            position: editing ? editing.position : null,
            extra: { url: fields.url.value.trim(), username: fields.username.value.trim(), loginMethod: fields.method.value, ssoAccount: SSO_METHODS.includes(fields.method.value) ? fields.sso.value.trim() : '' }
        };
        try {
            // A titok csak akkor megy, ha a széf fel van oldva és változott; üresre törlés = a titok törlése.
            if (secretState.loaded && isUnlocked()) {
                const secret = { password: fields.password.value, secretNote: fields.secretNote.value };
                const changed = secret.password !== secretState.original.password || secret.secretNote !== secretState.original.secretNote;
                if (changed) payload.secret = secret.password || secret.secretNote ? await vault.encryptSecret(safe.key, secret) : null;
            }
            const saved = editing ? await accountApi.updateItem(editing.id, payload) : await accountApi.createItem(payload);
            upsertItem(saved);
            state.revealed.delete(String(saved.id));
            const wasEditing = Boolean(editing);
            closeEditor();
            render();
            notify(wasEditing ? 'Fiók mentve.' : 'Fiók létrehozva.', 'success');
        } catch (err) {
            notify(err.message || 'A mentés nem sikerült.', 'error');
        }
    });

    // ---------- AI kitöltés ----------
    // A névből és a címből javasol nevet, megjegyzést, belépési módot, kategóriát és címkéket.
    // A felhasználónév, a jelszó és a titkos megjegyzés soha nem megy az AI-hoz.

    const ai = window.CloudMark.ai;
    const aiRow = document.getElementById('accAiRow');
    const aiButton = document.getElementById('accAiFillBtn');
    const aiOverwrite = document.getElementById('accAiOverwrite');
    const aiHint = document.getElementById('accAiHint');
    const aiExtras = document.getElementById('accAiExtras');
    const tagBox = editForm.querySelector('[data-tag-input="accTags"]');
    let aiSnapshot = null;
    let aiRun = 0;
    let aiBusy = false;

    function snapshotForm() {
        return {
            title: fields.title.value, description: fields.description.value, method: fields.method.value, categoryId: fields.category.value,
            tags: typeof getTagInputValues === 'function' ? getTagInputValues('accTags') : []
        };
    }

    function restoreForm(snapshot) {
        fields.title.value = snapshot.title;
        fields.description.value = snapshot.description;
        fields.method.value = snapshot.method;
        fields.category.value = snapshot.categoryId;
        if (typeof setTagInputValues === 'function') setTagInputValues('accTags', snapshot.tags);
        updateMethodRows();
    }

    const aiReview = ai ? ai.createReview(document.getElementById('accAiReview'), {
        onAccept: () => { aiSnapshot = null; },
        onUndo: () => {
            if (aiSnapshot) restoreForm(aiSnapshot);
            aiSnapshot = null;
            aiExtras.innerHTML = '';
        }
    }) : null;

    function setAiBusy(busy) {
        aiBusy = busy;
        aiButton.disabled = busy;
        aiButton.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> <span>AI dolgozik…</span>'
            : '<i class="fa-solid fa-wand-magic-sparkles"></i> <span>AI kitöltés</span>';
    }

    function resetAi() {
        aiRun += 1;
        aiReview?.clear();
        aiSnapshot = null;
        aiExtras.innerHTML = '';
        setAiBusy(false);
    }

    function showAiRow(current) {
        const ready = Boolean(current && current.enabled && current.active);
        aiRow.hidden = !(current && current.enabled);
        aiButton.hidden = !ready;
        aiOverwrite.parentElement.hidden = !ready;
        aiHint.innerHTML = ready
            ? `Írd be a nevet vagy a címet. A felhasználónév és a jelszó nem megy az AI-hoz. <span class="ai-fill-provider">${esc(current.active.providerLabel)}</span>`
            : 'Az AI kitöltéshez add meg a saját kulcsodat: <button type="button" class="ai-link" data-open-settings="ai">Beállítások → AI</button>';
    }

    function refreshAiRow() {
        if (ai) ai.status(true).then(showAiRow);
    }
    document.addEventListener('cloudmark:ai', event => showAiRow(event.detail));

    function applySuggestion(suggestion, providerLabel) {
        const snapshot = aiReview.active && aiSnapshot ? aiSnapshot : snapshotForm();
        const overwrite = aiOverwrite.checked;
        const changed = [];
        const setField = (input, value) => {
            if (!value || input.value === value || (!overwrite && input.value.trim())) return;
            input.value = value;
            changed.push(input);
        };
        setField(fields.title, suggestion.title);
        setField(fields.description, suggestion.description);
        // A belépési mód alapból „Saját jelszóval”: ezt üresnek tekintjük.
        if (suggestion.loginMethod && fields.method.value !== suggestion.loginMethod && (overwrite || fields.method.value === 'password')) {
            fields.method.value = suggestion.loginMethod;
            changed.push(fields.method);
            updateMethodRows();
        }
        if (suggestion.categoryId && (overwrite || !fields.category.value) && fields.category.value !== String(suggestion.categoryId)
            && fields.category.querySelector(`option[value="${Number(suggestion.categoryId)}"]`)) {
            fields.category.value = String(suggestion.categoryId);
            changed.push(fields.category);
        }
        const currentTags = typeof getTagInputValues === 'function' ? getTagInputValues('accTags') : [];
        if (suggestion.tags.length && (overwrite || !currentTags.length) && suggestion.tags.join('\n') !== currentTags.join('\n')) {
            setTagInputValues('accTags', suggestion.tags);
            changed.push(tagBox);
        }
        aiExtras.innerHTML = suggestion.newCategory && !fields.category.value
            ? `<div class="ai-extra-card"><span><i class="fa-solid fa-folder-plus"></i> Új kategória javaslat: <strong>${esc(suggestion.newCategory)}</strong></span>
                <button type="button" class="btn btn-secondary" data-ai-extra="category" data-name="${esc(suggestion.newCategory)}">Létrehozom</button></div>` : '';
        if (!changed.length) {
            if (!aiExtras.children.length) notify('Nincs mit kitölteni. Az összes mező újraírásához jelöld be a „Mindent újraír” lehetőséget.', 'info');
            return;
        }
        aiSnapshot = snapshot;
        aiReview.start(changed, `AI javaslat (${providerLabel}). Nézd át, majd fogadd el vagy vond vissza.`);
    }

    async function runAiFill() {
        if (!ai || aiBusy || aiButton.hidden || aiRow.hidden) return;
        // Csak a nem titkos mezők: név, cím, megjegyzés.
        const input = { title: fields.title.value, url: fields.url.value, description: fields.description.value };
        if (!input.title.trim() && !input.url.trim()) {
            notify('Írd be a fiók nevét vagy címét.', 'error');
            fields.title.focus();
            return;
        }
        const run = ++aiRun;
        setAiBusy(true);
        try {
            const result = await ai.fill('account.fill', input);
            if (run !== aiRun) return;
            applySuggestion(result.suggestion, result.providerLabel);
        } catch (err) {
            if (run === aiRun) notify(err.message || 'Az AI kitöltés nem sikerült.', 'error');
        } finally {
            if (run === aiRun) setAiBusy(false);
        }
    }

    aiButton.addEventListener('click', runAiFill);
    editForm.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            runAiFill();
        }
    });

    aiExtras.addEventListener('click', async event => {
        const button = event.target.closest('[data-ai-extra="category"]');
        if (!button) return;
        const name = button.dataset.name;
        button.disabled = true;
        try {
            await accountApi.createCategoryOfKind('account', name);
            await refreshCategories();
            const created = state.categories.find(category => category.name === name);
            fillCategorySelect(fields.category, created ? created.id : '');
            if (aiReview.active) aiReview.mark(fields.category);
            button.closest('.ai-extra-card').remove();
            notify(`„${name}” kategória létrehozva.`, 'success');
        } catch (err) {
            button.disabled = false;
            notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
        }
    });

    // ---------- kategóriák kezelése ----------

    const categoryList = document.getElementById('accountCategoryList');

    function renderCategoryManager() {
        const list = sortedCategories();
        categoryList.innerHTML = list.length ? list.map(category => `
            <div class="command-category-row" data-name="${esc(category.name)}">
                <span class="command-category-name">${esc(category.name)}</span>
                <button type="button" class="btn-icon" data-cat-action="rename" title="Átnevezés"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="btn-icon" data-cat-action="delete" title="Törlés"><i class="fa-solid fa-trash"></i></button>
            </div>`).join('') : '<div class="empty-state">Még nincs fiók kategória.</div>';
    }

    async function openCategoryManager() {
        if (!state.loaded) await load();
        renderCategoryManager();
        openModal('accountCategoryModal');
    }

    async function refreshCategories() {
        state.categories = await accountApi.getCategoriesOfKind('account');
        state.items = await accountApi.getItems('account', { all: 'true' });
        renderCategoryManager();
        render();
    }

    document.getElementById('accountCategoryForm').addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.getElementById('accNewCategoryName');
        try {
            await accountApi.createCategoryOfKind('account', input.value.trim());
            input.value = '';
            await refreshCategories();
        } catch (err) {
            notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
        }
    });

    categoryList.addEventListener('click', async event => {
        const button = event.target.closest('[data-cat-action]');
        if (!button) return;
        const name = button.closest('[data-name]').dataset.name;
        try {
            if (button.dataset.catAction === 'rename') {
                const newName = prompt('Új név:', name);
                if (!newName || !newName.trim() || newName.trim() === name) return;
                await accountApi.renameCategoryOfKind('account', name, newName.trim());
            } else {
                if (!confirm(`Törlöd a(z) „${name}” kategóriát? A benne lévő fiókok az Inboxba kerülnek.`)) return;
                await accountApi.deleteCategoryOfKind('account', name);
            }
            await refreshCategories();
        } catch (err) {
            notify(err.message || 'A művelet nem sikerült.', 'error');
        }
    });

    // ---------- Beállítások → Fiókok ----------

    const settingsBox = document.getElementById('vaultSettings');

    async function renderSettings() {
        if (!settingsBox) return;
        if (!safe.info) {
            settingsBox.innerHTML = '<p class="settings-hint">Betöltés…</p>';
            try { await loadVaultInfo(); } catch (err) { settingsBox.innerHTML = `<p class="settings-hint">${esc(err.message)}</p>`; return; }
        }
        if (!vaultExists()) {
            settingsBox.innerHTML = `<p class="settings-hint">Még nincs széfed. A jelszavak tárolásához hozz létre egyet mesterjelszóval.</p>
                <div class="vault-settings-actions"><button type="button" class="btn btn-primary" data-vault-setting="create"><i class="fa-solid fa-vault"></i> Széf létrehozása</button></div>`;
            return;
        }
        const date = value => (value ? new Date(value).toLocaleDateString('hu-HU') : '–');
        settingsBox.innerHTML = `
            <p class="settings-hint">Széf létrehozva: ${esc(date(safe.info.createdAt))} · utoljára módosítva: ${esc(date(safe.info.updatedAt))} · helyreállító kulcs: ${safe.info.recovery ? 'van' : '<strong>nincs</strong>'} · most: ${isUnlocked() ? 'feloldva' : 'zárolva'}</p>
            <div class="vault-settings-actions">
                <button type="button" class="btn btn-secondary" data-vault-setting="change"><i class="fa-solid fa-key"></i> Mesterjelszó módosítása</button>
                <button type="button" class="btn btn-secondary" data-vault-setting="new-recovery"><i class="fa-solid fa-rotate"></i> Új helyreállító kulcs</button>
                <button type="button" class="btn btn-secondary" data-vault-setting="recover"><i class="fa-solid fa-life-ring"></i> Elfelejtett mesterjelszó</button>
                <button type="button" class="btn btn-danger" data-vault-setting="delete"><i class="fa-solid fa-trash"></i> Széf törlése…</button>
            </div>
            <small class="settings-hint">A mesterjelszót a szerver nem ismeri, ezért senki nem tudja visszaállítani: csak a helyreállító kulccsal adhatsz újat.</small>`;
    }

    settingsBox?.addEventListener('click', async event => {
        const button = event.target.closest('[data-vault-setting]');
        if (!button) return;
        await openVaultDialog(button.dataset.vaultSetting);
        renderSettings();
    });

    // ---------- élő frissítés ----------

    function showRemoteInEditor(item) {
        if (!editing || String(editing.id) !== String(item.id) || !live()?.isNewer(item, editing)) return;
        live().conflictBar(editForm, {
            text: 'Ez a fiók közben máshol módosult.',
            onReload: () => openEditor(findItem(item.id) || item),
            onKeep: () => { editing = { ...(findItem(item.id) || item) }; }
        });
    }

    function dropEditor() {
        closeEditor();
        notify('Ez a fiók közben törlődött.', 'info');
    }

    window.CloudMark.accounts = {
        show: () => load(),
        reset,
        openEditor,
        lock,
        ensureUnlocked,
        renderSettings,
        async openById(id) {
            await load();
            let item = findItem(id);
            if (!item) { await load(true); item = findItem(id); }
            if (item) openEditor(item);
        },
        /** Copies an account's user name or password by id (Ctrl+K palette). */
        async copyById(id, field) {
            await load();
            const item = findItem(id) || await accountApi.getItem(id).catch(() => null);
            if (!item) { notify('A fiók nem található.', 'error'); return; }
            await copyField(item, field, null);
            if (field === 'username' && extraOf(item).username) notify(`Felhasználónév másolva: ${item.title}`, 'success');
        },
        applyRemote(id, item) {
            if (!state.loaded) return;
            const previous = findItem(id);
            if (!item || item.type !== 'account') {
                if (!previous) return;
                state.items = state.items.filter(entry => entry !== previous);
                render();
                if (editing && String(editing.id) === String(id)) dropEditor();
                return;
            }
            upsertItem(item);
            state.revealed.delete(String(id));
            render();
            showRemoteInEditor(item);
        },
        async refreshAll() {
            if (!state.loaded) return;
            try { state.items = await accountApi.getItems('account', { all: 'true' }); } catch (err) { return; }
            render();
            if (!editing?.id) return;
            const current = findItem(editing.id);
            if (current) showRemoteInEditor(current);
            else dropEditor();
        },
        /** The vault changed in another window: a deleted or re-created vault locks this one. */
        async vaultChanged() {
            const before = safe.info;
            try { await loadVaultInfo(); } catch (err) { return; }
            if (!vaultExists() || (before?.createdAt && safe.info.createdAt !== before.createdAt)) {
                lock('A széf máshol megváltozott, ezért zároltam.');
                if (state.loaded) load(true);
            }
            refreshVaultUi();
            renderSettings();
        },
        focusSearch: () => searchInput.focus()
    };
})();
