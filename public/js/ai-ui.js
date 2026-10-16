/*
 * AI kitöltés: a Beállítások „AI” füle (saját API kulcsok) és a közös segédek az űrlapok ✨ gombjaihoz
 * (elérhetőség, javaslat kérése, kiemelés + Elfogadom / Visszavonom sáv).
 * Az AI csak gombnyomásra fut, és semmit nem ment: a javaslatot a felhasználó fogadja el, menteni a Mentés gomb ment.
 */
(function () {
    const aiApi = window.CloudMark.api;
    const box = document.getElementById('aiSettings');

    const PROVIDER_HELP = {
        gemini: 'Ingyenes kulcs: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Az ingyenes szinten napi és percenkénti korlát van, és a Google a beküldött szöveget felhasználhatja a termékei fejlesztésére, ezért titkot (jelszót, tokent) ne küldj vele.',
        anthropic: 'Kulcs: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. A Claude.ai előfizetés (Pro / Max) nem tartalmaz API hozzáférést: ehhez külön, feltöltött egyenleg kell. Egy kitöltés a Haiku modellel kb. 0,01 Ft.',
        openai: 'Bármely OpenAI-kompatibilis szolgáltató (OpenAI, OpenRouter, Mistral, Groq …). Add meg a címét, ha nem az OpenAI-t használod, pl. https://openrouter.ai/api/v1.'
    };

    let statusPromise = null;
    const state = { keys: [], models: new Map() };

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    /** { enabled, active: { provider, providerLabel, model } | null }; refreshed when `force` is set. */
    function status(force = false) {
        if (!statusPromise || force) statusPromise = aiApi.getAiStatus().catch(() => ({ enabled: false, active: null }));
        return statusPromise;
    }

    function changed() {
        status(true).then(current => document.dispatchEvent(new CustomEvent('cloudmark:ai', { detail: current })));
    }

    // ---------- Beállítások → AI fül ----------

    function modelOptions(key) {
        const listed = state.models.get(key.id) || [];
        const ids = listed.map(model => model.id);
        const options = ids.includes(key.model) || !key.model ? listed : [{ id: key.model, label: key.model }, ...listed];
        return options.map(model => `<option value="${esc(model.id)}" ${model.id === key.model ? 'selected' : ''}>${esc(model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id)}</option>`).join('');
    }

    function keyRowHtml(key) {
        return `
            <div class="ai-key-row ${key.isActive ? 'is-active' : ''}" data-ai-key="${key.id}">
                <div class="ai-key-head">
                    <strong>${esc(key.providerLabel)}</strong>
                    <span class="ai-key-last4">…${esc(key.last4)}</span>
                    ${key.baseUrl ? `<span class="ai-key-url">${esc(key.baseUrl)}</span>` : ''}
                    ${key.isActive ? '<span class="ai-key-badge">Aktív</span>' : ''}
                </div>
                <div class="ai-key-controls">
                    <select class="ai-key-model" aria-label="Modell">${modelOptions(key)}</select>
                    <button type="button" class="btn btn-secondary" data-ai-action="models" title="Kapcsolat tesztelése és a modellek lekérése"><i class="fa-solid fa-plug-circle-check"></i> Teszt</button>
                    <button type="button" class="btn btn-secondary" data-ai-action="toggle">${key.isActive ? 'Kikapcsolás' : 'Használom ezt'}</button>
                    <button type="button" class="btn-icon" data-ai-action="delete" title="Kulcs törlése" aria-label="Kulcs törlése"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    }

    function render(current) {
        if (!box) return;
        if (!current.enabled) {
            box.innerHTML = '<p class="settings-hint">Az AI funkció a szerveren még nincs bekapcsolva (az üzemeltetőnek be kell állítania az AI_KEY_ENCRYPTION_SECRET változót).</p>';
            return;
        }
        box.innerHTML = `
            <small class="settings-hint">A saját AI kulcsoddal a ✨ AI kitöltés gomb kitölti az űrlap mezőit (első körben az Új parancs űrlapon). Az AI csak gombnyomásra fut, és csak az űrlap mezőit, a kategóriáid és a címkéid nevét kapja meg. A kulcsot a szerver titkosítva tárolja, és soha nem küldi vissza a böngészőbe.</small>
            <div class="ai-key-list">${state.keys.length ? state.keys.map(keyRowHtml).join('') : '<p class="settings-hint">Még nincs mentett kulcs.</p>'}</div>
            <div class="section-divider"><i class="fa-solid fa-plus"></i> Új kulcs</div>
            <div class="form-control">
                <label for="aiNewProvider">Szolgáltató</label>
                <select id="aiNewProvider">
                    <option value="gemini">Gemini (Google, van ingyenes szint)</option>
                    <option value="anthropic">Claude (Anthropic)</option>
                    <option value="openai">OpenAI-kompatibilis</option>
                </select>
            </div>
            <small class="settings-hint" id="aiProviderHelp"></small>
            <div class="form-control" id="aiBaseUrlGroup" hidden>
                <label for="aiNewBaseUrl">Szolgáltató címe</label>
                <input type="url" id="aiNewBaseUrl" placeholder="https://api.openai.com/v1" maxlength="300" autocomplete="off">
            </div>
            <div class="form-control">
                <label for="aiNewKey">API kulcs</label>
                <input type="password" id="aiNewKey" maxlength="500" autocomplete="off" spellcheck="false" placeholder="Illeszd be a kulcsot">
            </div>
            <button type="button" class="btn btn-primary" id="aiSaveKeyBtn"><i class="fa-solid fa-floppy-disk"></i> Kulcs mentése és tesztelése</button>`;
        updateProviderHelp();
    }

    function updateProviderHelp() {
        const provider = document.getElementById('aiNewProvider')?.value || 'gemini';
        const help = document.getElementById('aiProviderHelp');
        if (help) help.innerHTML = PROVIDER_HELP[provider];
        const group = document.getElementById('aiBaseUrlGroup');
        if (group) group.hidden = provider !== 'openai';
    }

    async function loadSettings() {
        if (!box) return;
        const current = await status(true);
        state.keys = current.enabled ? await aiApi.getAiKeys().catch(() => []) : [];
        render(current);
    }

    async function saveKey(button) {
        const provider = document.getElementById('aiNewProvider').value;
        const apiKey = document.getElementById('aiNewKey').value.trim();
        const baseUrl = document.getElementById('aiNewBaseUrl').value.trim();
        if (!apiKey) { notify('Illeszd be az API kulcsot.', 'error'); return; }
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kulcs ellenőrzése…';
        try {
            const result = await aiApi.saveAiKey({ provider, apiKey, baseUrl: provider === 'openai' ? baseUrl : undefined });
            state.models.set(result.key.id, result.models);
            notify(`Kulcs mentve. Modell: ${result.key.model}.`, 'success');
            await loadSettings();
            changed();
        } catch (err) {
            notify(err.message || 'A kulcs mentése nem sikerült.', 'error');
            button.disabled = false;
            button.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Kulcs mentése és tesztelése';
        }
    }

    if (box) {
        box.addEventListener('change', async event => {
            if (event.target.id === 'aiNewProvider') { updateProviderHelp(); return; }
            const select = event.target.closest('.ai-key-model');
            if (!select) return;
            const id = Number(select.closest('[data-ai-key]').dataset.aiKey);
            try {
                await aiApi.updateAiKey(id, { model: select.value });
                const key = state.keys.find(entry => entry.id === id);
                if (key) key.model = select.value;
                notify('Modell mentve.', 'success');
                changed();
            } catch (err) {
                notify(err.message || 'A modell mentése nem sikerült.', 'error');
            }
        });

        box.addEventListener('click', async event => {
            if (event.target.closest('#aiSaveKeyBtn')) { saveKey(event.target.closest('#aiSaveKeyBtn')); return; }
            const button = event.target.closest('[data-ai-action]');
            if (!button) return;
            const id = Number(button.closest('[data-ai-key]').dataset.aiKey);
            const key = state.keys.find(entry => entry.id === id);
            if (!key) return;
            try {
                if (button.dataset.aiAction === 'models') {
                    button.disabled = true;
                    const models = await aiApi.getAiModels(id);
                    state.models.set(id, models);
                    notify(`A kapcsolat rendben, ${models.length} modell érhető el.`, 'success');
                } else if (button.dataset.aiAction === 'toggle') {
                    await aiApi.updateAiKey(id, { isActive: !key.isActive });
                    changed();
                } else if (button.dataset.aiAction === 'delete') {
                    if (!confirm(`Törlöd a(z) ${key.providerLabel} kulcsot (…${key.last4})?`)) return;
                    await aiApi.deleteAiKey(id);
                    state.models.delete(id);
                    changed();
                }
                await loadSettings();
            } catch (err) {
                button.disabled = false;
                notify(err.message || 'A művelet nem sikerült.', 'error');
            }
        });

        // Az Enter a kulcsmezőben ne küldje el a Beállítások űrlapot.
        box.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target.matches('#aiNewKey, #aiNewBaseUrl')) {
                event.preventDefault();
                saveKey(document.getElementById('aiSaveKeyBtn'));
            }
        });
    }

    // ---------- javaslat előnézete az űrlapokon ----------

    /**
     * Marks fields as AI suggestions until the user accepts or undoes them.
     * `restore` puts back the values from before the suggestion.
     */
    function createReview(bar, { onAccept, onUndo }) {
        let marked = [];
        let active = false;

        function clear() {
            marked.forEach(element => element.classList.remove('ai-suggested'));
            marked = [];
            active = false;
            bar.hidden = true;
        }

        bar.addEventListener('click', event => {
            const button = event.target.closest('[data-ai-review]');
            if (!button) return;
            if (button.dataset.aiReview === 'undo') onUndo();
            else onAccept?.();
            clear();
        });

        return {
            start(elements, text) {
                clear();
                marked = elements.filter(Boolean);
                marked.forEach(element => element.classList.add('ai-suggested'));
                bar.querySelector('[data-ai-review-text]').textContent = text;
                bar.hidden = false;
                active = true;
            },
            mark(element) {
                if (!element) return;
                element.classList.add('ai-suggested');
                marked.push(element);
            },
            clear,
            get active() { return active; }
        };
    }

    window.CloudMark = window.CloudMark || {};
    window.CloudMark.ai = {
        status,
        loadSettings,
        createReview,
        fill: (action, input) => aiApi.aiFill(action, input),
        reset() { statusPromise = null; state.keys = []; state.models.clear(); }
    };
})();
