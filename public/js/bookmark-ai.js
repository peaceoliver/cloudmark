/*
 * AI kitöltés a könyvjelző űrlapokon (Új könyvjelző és Szerkesztés): az URL-ből és az oldal címéből,
 * leírásából javasol címet, leírást, címkéket és kategóriát. Csak gombnyomásra fut, és csak javasol:
 * a mezők kiemelve kapják az értéket, a Visszavonom visszaállítja őket, menteni a Mentés gomb ment.
 */
(function () {
    const ai = window.CloudMark.ai;
    if (!ai) return;
    const esc = ai.esc;

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    function setup(prefix, formId) {
        const form = document.getElementById(formId);
        const row = document.getElementById(`${prefix}AiRow`);
        if (!form || !row) return null;
        const button = document.getElementById(`${prefix}AiFillBtn`);
        const overwrite = document.getElementById(`${prefix}AiOverwrite`);
        const hint = document.getElementById(`${prefix}AiHint`);
        const extras = document.getElementById(`${prefix}AiExtras`);
        const title = document.getElementById(`${prefix}Title`);
        const url = document.getElementById(`${prefix}Url`);
        const description = document.getElementById(`${prefix}Description`);
        const category = document.getElementById(`${prefix}Category`);
        const tagsId = `${prefix}Tags`;
        const tagBox = form.querySelector(`[data-tag-input="${tagsId}"]`);
        let snapshot = null;
        let runId = 0;

        const snapshotForm = () => ({ title: title.value, description: description.value, category: category.value, tags: getTagInputValues(tagsId) });
        const restoreForm = saved => {
            title.value = saved.title;
            description.value = saved.description;
            category.value = saved.category;
            setTagInputValues(tagsId, saved.tags);
        };

        const review = ai.createReview(document.getElementById(`${prefix}AiReview`), {
            onAccept: () => { snapshot = null; },
            onUndo: () => {
                if (snapshot) restoreForm(snapshot);
                snapshot = null;
                extras.innerHTML = '';
            }
        });

        function reset() {
            runId += 1;
            review.clear();
            snapshot = null;
            extras.innerHTML = '';
        }

        function showRow(current) {
            const ready = Boolean(current && current.enabled && current.active);
            row.hidden = !(current && current.enabled);
            button.hidden = !ready;
            overwrite.parentElement.hidden = !ready;
            hint.innerHTML = ready
                ? `Írd be az URL-t, az AI kitölti a többit. <span class="ai-fill-provider">${esc(current.active.providerLabel)}</span>`
                : 'Az AI kitöltéshez add meg a saját kulcsodat: <button type="button" class="ai-link" data-open-settings="ai">Beállítások → AI</button>';
        }

        // Az első (alapértelmezett) vagy az Inbox kategória „üresnek” számít: ezt az AI felülírhatja.
        const categoryIsDefault = () => category.selectedIndex <= 0 || /^inbox$/i.test(category.value);

        function apply(suggestion) {
            const saved = review.active && snapshot ? snapshot : snapshotForm();
            const force = overwrite.checked;
            const changed = [];
            const setField = (input, value) => {
                if (!value || input.value === value || (!force && input.value.trim())) return;
                input.value = value;
                changed.push(input);
            };
            setField(title, suggestion.title);
            setField(description, suggestion.description);
            if (suggestion.categoryName && (force || categoryIsDefault()) && category.value !== suggestion.categoryName
                && Array.from(category.options).some(option => option.value === suggestion.categoryName)) {
                category.value = suggestion.categoryName;
                changed.push(category);
            }
            const tags = getTagInputValues(tagsId);
            if (suggestion.tags.length && (force || !tags.length) && suggestion.tags.join('\n') !== tags.join('\n')) {
                setTagInputValues(tagsId, suggestion.tags);
                changed.push(tagBox);
            }
            extras.innerHTML = suggestion.newCategory && (force || categoryIsDefault())
                ? `<div class="ai-extra-card"><span><i class="fa-solid fa-folder-plus"></i> Új kategória javaslat: <strong>${esc(suggestion.newCategory)}</strong></span>
                    <button type="button" class="btn btn-secondary" data-ai-extra="category" data-name="${esc(suggestion.newCategory)}">Létrehozom</button></div>`
                : '';
            if (!changed.length) {
                if (!extras.children.length) notify('Nincs mit kitölteni. Az összes mező újraírásához jelöld be a „Mindent újraír” lehetőséget.', 'info');
                return;
            }
            snapshot = saved;
            review.start(changed, `AI javaslat (${suggestion.providerLabel}). Nézd át, írd át, ha kell, majd fogadd el vagy vond vissza.`);
        }

        async function runFill() {
            if (button.hidden || row.hidden) return;
            if (!/^https?:\/\/\S+$/i.test(url.value.trim())) {
                notify('Írd be előbb a könyvjelző URL-jét (https://…).', 'error');
                url.focus();
                return;
            }
            const run = ++runId;
            const suggestion = await ai.run('bookmark.fill', { url: url.value.trim(), title: title.value, description: description.value }, button);
            if (suggestion && run === runId) apply(suggestion);
        }

        button.addEventListener('click', runFill);
        form.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                runFill();
            }
        });
        // Mentéskor a javaslat elfogadottnak számít.
        form.addEventListener('submit', reset);

        extras.addEventListener('click', async event => {
            const create = event.target.closest('[data-ai-extra="category"]');
            if (!create) return;
            const name = create.dataset.name;
            create.disabled = true;
            try {
                await api.createCategory(name, null);
                await loadCategoriesFromServer();
                if (typeof renderCategories === 'function') renderCategories();
                populateCategorySelect('bmCategory');
                populateCategorySelect('editBmCategory');
                populateCategorySelect(category.id, name);
                if (review.active) review.mark(category);
                create.closest('.ai-extra-card').remove();
                notify(`„${name}” kategória létrehozva.`, 'success');
            } catch (err) {
                create.disabled = false;
                notify(err.message || 'A kategória létrehozása nem sikerült.', 'error');
            }
        });

        return { reset, showRow };
    }

    const forms = [setup('bm', 'bookmarkForm'), setup('editBm', 'editBookmarkForm')].filter(Boolean);
    const showRows = current => forms.forEach(entry => entry.showRow(current));
    document.addEventListener('cloudmark:ai', event => showRows(event.detail));
    ai.status().then(showRows);

    // A szerkesztő ablak minden megnyitáskor tiszta lappal indul.
    const openEdit = window.openEditModal;
    if (typeof openEdit === 'function') {
        window.openEditModal = id => {
            forms[1]?.reset();
            openEdit(id);
        };
    }

    window.CloudMark.bookmarkAi = { reset: () => forms.forEach(entry => entry.reset()), refresh: () => ai.status(true).then(showRows) };
})();
