/* Feladatok: magyar gyors-beírás, okos listák, projektek, részletpanel automatikus mentéssel. */
(function () {
    const taskApi = window.CloudMark.api;
    const parser = window.CloudMark.taskParser;
    const listBox = document.getElementById('taskList');
    if (!listBox || !parser) return;

    const AUTOSAVE_MS = 700;
    const TOAST_MS = 6000;
    const TIME_ZONE = (() => {
        try {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return parser.isValidTimeZone(zone) ? zone : parser.DEFAULT_TIME_ZONE;
        } catch (err) {
            return parser.DEFAULT_TIME_ZONE;
        }
    })();
    const PRIORITY_LABELS = { 1: 'P1 · Sürgős', 2: 'P2 · Magas', 3: 'P3 · Közepes', 4: 'P4 · Alacsony' };
    const VIEW_EMPTY = {
        today: 'Mára nincs több feladat. 🎉',
        upcoming: 'A következő 7 napra nincs feladat.',
        inbox: 'A beérkezett feladatok listája üres.',
        all: 'Nincs nyitott feladat. Vegyél fel egyet fent!',
        done: 'Még nincs elvégzett feladat.',
        trash: 'A kuka üres.',
        project: 'Ebben a projektben nincs nyitott feladat.'
    };
    const REMINDER_PRESETS = [
        { value: '0', label: 'Határidőkor' },
        { value: '10', label: '10 perccel előtte' },
        { value: '30', label: '30 perccel előtte' },
        { value: '60', label: '1 órával előtte' },
        { value: '1440', label: '1 nappal előtte' }
    ];

    const state = {
        items: [],
        trash: [],
        projects: [],
        loaded: false,
        loading: null,
        view: 'today',
        project: null,
        query: '',
        selectedId: null,
        timeZoneSaved: false,
        sort: window.CloudMark.prefs.get('taskSort'),
        display: window.CloudMark.prefs.get('taskView')
    };
    const prefs = window.CloudMark.prefs;

    const quickForm = document.getElementById('taskQuickAddForm');
    const quickInput = document.getElementById('taskQuickAdd');
    const quickPreview = document.getElementById('taskQuickPreview');
    const searchInput = document.getElementById('taskSearch');
    const searchClear = document.getElementById('taskSearchClear');
    const viewGroup = document.getElementById('taskViewGroup');
    const projectsBar = document.getElementById('taskProjectsBar');
    const detailBox = document.getElementById('taskDetail');
    const toast = document.getElementById('taskToast');
    const moreButton = document.getElementById('taskMoreBtn');
    const sortSelect = document.getElementById('taskSortSelect');
    const viewSwitcher = document.getElementById('taskViewSwitcher');
    const moreMenu = document.getElementById('taskMoreMenu');
    const importInput = document.getElementById('taskImportInput');

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    // ---------- dátumok ----------

    function today() { return parser.localDate(new Date(), TIME_ZONE); }

    function capitalize(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }

    const dayFormat = new Intl.DateTimeFormat('hu-HU', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' });
    const dayYearFormat = new Intl.DateTimeFormat('hu-HU', { timeZone: TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric' });
    const weekdayFormat = new Intl.DateTimeFormat('hu-HU', { timeZone: TIME_ZONE, weekday: 'long' });
    const longDayFormat = new Intl.DateTimeFormat('hu-HU', { timeZone: TIME_ZONE, month: 'long', day: 'numeric', weekday: 'long' });

    /** Hungarian label for a calendar date: Ma, Holnap, Tegnap, a weekday within a week, or a short date. */
    function dayLabel(dateText) {
        const now = today();
        if (dateText === now) return 'Ma';
        if (dateText === parser.addDays(now, 1)) return 'Holnap';
        if (dateText === parser.addDays(now, -1)) return 'Tegnap';
        const instant = parser.zonedTimeToUtc(dateText, '12:00', TIME_ZONE);
        if (dateText > now && dateText <= parser.addDays(now, 6)) return capitalize(weekdayFormat.format(instant));
        return dateText.slice(0, 4) === now.slice(0, 4) ? dayFormat.format(instant) : dayYearFormat.format(instant);
    }

    function dueParts(item) {
        if (!item.due_at) return null;
        const instant = new Date(item.due_at);
        const date = parser.localDate(instant, TIME_ZONE);
        const time = item.due_all_day ? null : parser.localTime(instant, TIME_ZONE);
        const overdue = item.status !== 'done' && (item.due_all_day ? date < today() : instant < new Date());
        return { date, time, overdue };
    }

    /** Which section of the list a task falls into. */
    function bucketOf(item) {
        const due = dueParts(item);
        if (!due) return 'none';
        if (due.overdue) return 'overdue';
        const now = today();
        if (due.date === now) return 'today';
        if (due.date === parser.addDays(now, 1)) return 'tomorrow';
        if (due.date <= parser.addDays(now, 7)) return 'week';
        return 'later';
    }

    function reminderLabel(reminder) {
        if (reminder.offsetMinutes !== null && reminder.offsetMinutes !== undefined) {
            const preset = REMINDER_PRESETS.find(entry => Number(entry.value) === reminder.offsetMinutes);
            if (preset) return preset.label;
            const minutes = reminder.offsetMinutes;
            if (minutes % 1440 === 0) return `${minutes / 1440} nappal előtte`;
            if (minutes % 60 === 0) return `${minutes / 60} órával előtte`;
            return `${minutes} perccel előtte`;
        }
        const instant = new Date(reminder.remindAt);
        return `${dayLabel(parser.localDate(instant, TIME_ZONE))} ${parser.localTime(instant, TIME_ZONE)}`;
    }

    // ---------- adatok ----------

    function findItem(id) {
        return state.items.find(item => String(item.id) === String(id)) || state.trash.find(item => String(item.id) === String(id));
    }

    function upsert(item) {
        const index = state.items.findIndex(existing => String(existing.id) === String(item.id));
        if (index === -1) state.items.push(item);
        else state.items[index] = item;
    }

    function childrenOf(item) {
        return state.items.filter(child => String(child.parent_item_id) === String(item.id))
            .sort((a, b) => (a.status === 'done') - (b.status === 'done') || compareTasks(a, b));
    }

    function projectName(id) {
        return state.projects.find(project => String(project.id) === String(id))?.name || null;
    }

    async function load(force = false) {
        if (state.loaded && !force) return;
        if (state.loading && !force) return state.loading;
        if (!state.loaded) listBox.innerHTML = '<div class="empty-state">Feladatok betöltése…</div>';
        state.loading = Promise.all([
            taskApi.getItems('task'),
            taskApi.getCategoriesOfKind('task')
        ]).then(([items, projects]) => {
            state.items = items;
            state.projects = projects;
            state.loaded = true;
            render();
            saveTimeZoneOnce();
        }).catch(err => {
            listBox.innerHTML = `<div class="empty-state">A feladatok betöltése nem sikerült: ${esc(err.message)}</div>`;
        }).finally(() => { state.loading = null; });
        return state.loading;
    }

    async function reloadItems() {
        state.items = await taskApi.getItems('task');
        if (state.view === 'trash') state.trash = await taskApi.getItems('task', { trash: 'true' });
        render();
    }

    /** Remembers the browser's time zone on the server, so reminders and digests use the user's local time. */
    async function saveTimeZoneOnce() {
        if (state.timeZoneSaved) return;
        state.timeZoneSaved = true;
        try {
            const settings = await taskApi.getUserSettings();
            if (settings.timezone !== TIME_ZONE) await taskApi.saveUserSetting('timezone', TIME_ZONE);
        } catch (err) { /* not critical */ }
    }

    function reset() {
        state.items = [];
        state.trash = [];
        state.projects = [];
        state.loaded = false;
        state.query = '';
        state.project = null;
        state.selectedId = null;
        state.timeZoneSaved = false;
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.hidden = true;
        quickInput.value = '';
        quickPreview.innerHTML = '';
        listBox.innerHTML = '';
        projectsBar.innerHTML = '';
        closeDetail(false);
        setBadge(null);
    }

    // ---------- jelvény a fülön ----------

    function setBadge(count) {
        const badge = document.getElementById('taskTabBadge');
        if (!badge) return;
        badge.textContent = count ? String(count) : '';
        badge.hidden = !count;
    }

    async function refreshBadge() {
        if (state.loaded) {
            setBadge(state.items.filter(item => matchesView(item, 'today')).length);
            return;
        }
        try {
            const summary = await taskApi.getTaskSummary(TIME_ZONE);
            setBadge(summary.today);
        } catch (err) {
            setBadge(null);
        }
    }

    // ---------- szűrés és rendezés ----------

    function compareTasks(a, b) {
        const dueA = a.due_at ? new Date(a.due_at).getTime() : Infinity;
        const dueB = b.due_at ? new Date(b.due_at).getTime() : Infinity;
        if (dueA !== dueB) return dueA - dueB;
        const priorityA = a.priority || 5, priorityB = b.priority || 5;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return new Date(a.created_at) - new Date(b.created_at);
    }

    /** Order inside each list section, chosen in the sort menu. */
    function compareBySort(a, b) {
        if (state.sort === 'priority') return (a.priority || 5) - (b.priority || 5) || compareTasks(a, b);
        if (state.sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
        if (state.sort === 'abc') return String(a.title || '').localeCompare(String(b.title || ''), 'hu') || compareTasks(a, b);
        return compareTasks(a, b);
    }

    function matchesView(item, view) {
        if (view === 'done') return item.status === 'done';
        if (item.status === 'done') return false;
        if (view === 'today') return ['overdue', 'today'].includes(bucketOf(item));
        if (view === 'upcoming') return ['tomorrow', 'week'].includes(bucketOf(item));
        if (view === 'inbox') return !item.category_id && !item.parent_item_id;
        if (view === 'project') return String(item.category_id) === String(state.project);
        return true;
    }

    function matchesQuery(item, query) {
        return [item.title, item.body, ...item.tags, projectName(item.category_id)].some(value => String(value || '').toLowerCase().includes(query));
    }

    function visibleTasks() {
        const query = state.query.trim().toLowerCase();
        if (state.view === 'trash') return state.trash.filter(item => !query || matchesQuery(item, query));
        if (query) return state.items.filter(item => matchesQuery(item, query));
        return state.items.filter(item => matchesView(item, state.view));
    }

    // ---------- megjelenítés ----------

    function metaHtml(item, { showParent }) {
        const parts = [];
        const due = dueParts(item);
        if (due) {
            parts.push(`<span class="task-due ${due.overdue ? 'is-overdue' : due.date === today() ? 'is-today' : ''}"><i class="fa-regular fa-calendar"></i> ${esc(dayLabel(due.date))}${due.time ? ` ${due.time}` : ''}</span>`);
        }
        if (item.recurrence_rule) parts.push(`<span class="task-meta-item" title="${esc(parser.describeRecurrence(item.recurrence_rule))}"><i class="fa-solid fa-repeat"></i> ${esc(parser.describeRecurrence(item.recurrence_rule))}</span>`);
        if (item.reminders.some(reminder => !reminder.sentAt)) parts.push('<span class="task-meta-item" title="Emlékeztető beállítva"><i class="fa-regular fa-bell"></i></span>');
        if (item.subtask_count) parts.push(`<span class="task-meta-item" title="Részfeladatok"><i class="fa-solid fa-list-check"></i> ${item.subtask_done_count}/${item.subtask_count}</span>`);
        if (item.links.length) parts.push(`<span class="task-meta-item" title="Kapcsolt elemek"><i class="fa-solid fa-link"></i> ${item.links.length}</span>`);
        if (item.body) parts.push('<span class="task-meta-item" title="Van leírása"><i class="fa-regular fa-file-lines"></i></span>');
        if (showParent && item.parent_item_id) {
            const parent = findItem(item.parent_item_id);
            if (parent) parts.push(`<span class="task-meta-item task-parent-hint"><i class="fa-solid fa-turn-up fa-rotate-90"></i> ${esc(parent.title)}</span>`);
        }
        const project = item.category_id && state.view !== 'project' ? projectName(item.category_id) : '';
        if (project) parts.unshift(`<span class="card-category task-project-name">${esc(project)}</span>`);
        const tags = item.tags.length ? `<div class="card-tags task-tags">${item.tags.map(tag => `#${esc(tag)}`).join(' ')}</div>` : '';
        return (parts.length ? `<div class="task-meta">${parts.join('')}</div>` : '') + tags;
    }

    function rowHtml(item, { sub = false, showParent = false } = {}) {
        const trashed = Boolean(item.trashed);
        const done = item.status === 'done';
        const actions = trashed ? `
            <div class="task-row-actions">
                <button type="button" class="note-action" data-action="restore" title="Visszaállítás"><i class="fa-solid fa-rotate-left"></i></button>
                <button type="button" class="note-action" data-action="delete" title="Végleges törlés"><i class="fa-solid fa-trash-can"></i></button>
            </div>` : '';
        return `
            <div class="task-row ${item.priority ? `task-p${item.priority}` : ''} ${done ? 'is-done' : ''} ${sub ? 'is-sub' : ''} ${String(item.id) === String(state.selectedId) ? 'is-selected' : ''} ${item.status === 'doing' ? 'is-doing' : ''}"
                 data-task-id="${Number(item.id)}" tabindex="0" role="listitem">
                <button type="button" class="task-check" data-action="toggle" ${trashed ? 'disabled' : ''}
                        title="${done ? 'Visszanyitás' : 'Kész (szóköz)'}" aria-label="${done ? 'Visszanyitás' : 'Kész'}: ${esc(item.title)}" aria-pressed="${done}">
                    <i class="fa-solid fa-check"></i>
                </button>
                <div class="task-main">
                    <div class="task-title">${esc(item.title)}${item.status === 'doing' ? ' <span class="task-doing-pill">folyamatban</span>' : ''}</div>
                    ${metaHtml(item, { showParent })}
                </div>
                ${actions}
            </div>`;
    }

    /** A top-level row followed by its subtasks (subtasks of a visible parent are always shown under it). */
    function treeHtml(item, visibleIds) {
        const showParent = Boolean(item.parent_item_id) && !visibleIds.has(String(item.parent_item_id));
        const children = state.view === 'trash' || item.parent_item_id ? [] : childrenOf(item);
        return rowHtml(item, { showParent }) + children.map(child => rowHtml(child, { sub: true })).join('');
    }

    function sectionHtml(title, items, visibleIds, extraClass = '') {
        if (!items.length) return '';
        return `<section class="task-section ${extraClass}">
            <h3 class="notes-section-title task-section-title">${esc(title)} <span class="task-section-count">${items.length}</span></h3>
            <div class="task-rows" role="list">${items.map(item => treeHtml(item, visibleIds)).join('')}</div>
        </section>`;
    }

    function renderList() {
        const visible = visibleTasks();
        const visibleIds = new Set(visible.map(item => String(item.id)));
        // A látható szülő alatt megjelenő részfeladatok ne jelenjenek meg külön sorban is.
        listBox.classList.toggle('is-compact', state.display === 'compact');
        prefs.markSwitcher(viewSwitcher, state.display);
        const tops = visible.filter(item => !item.parent_item_id || !visibleIds.has(String(item.parent_item_id)) || state.view === 'trash').sort(compareBySort);
        if (!tops.length) {
            const message = state.query ? 'Nincs a keresésnek megfelelő feladat.' : VIEW_EMPTY[state.view];
            listBox.innerHTML = `<div class="empty-state notes-empty task-empty">${message}</div>`;
            return;
        }
        if (state.view === 'done') {
            const sorted = tops.sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
            const groups = new Map();
            sorted.forEach(item => {
                const key = item.completed_at ? parser.localDate(new Date(item.completed_at), TIME_ZONE) : '';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            });
            listBox.innerHTML = [...groups].map(([date, items]) => sectionHtml(date ? `Elvégezve: ${dayLabel(date)}` : 'Elvégezve', items, visibleIds)).join('');
            return;
        }
        if (state.view === 'trash' || state.query) {
            listBox.innerHTML = sectionHtml(state.view === 'trash' ? 'Kuka' : 'Találatok', tops, visibleIds);
            return;
        }
        if (state.view === 'upcoming') {
            const days = new Map();
            tops.forEach(item => {
                const date = dueParts(item).date;
                if (!days.has(date)) days.set(date, []);
                days.get(date).push(item);
            });
            listBox.innerHTML = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => {
                const instant = parser.zonedTimeToUtc(date, '12:00', TIME_ZONE);
                const label = date === parser.addDays(today(), 1) ? `Holnap · ${longDayFormat.format(instant)}` : capitalize(longDayFormat.format(instant));
                return sectionHtml(label, items, visibleIds);
            }).join('');
            return;
        }
        const buckets = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] };
        tops.forEach(item => buckets[bucketOf(item)].push(item));
        listBox.innerHTML = sectionHtml('Lejárt', buckets.overdue, visibleIds, 'is-overdue')
            + sectionHtml('Ma', buckets.today, visibleIds)
            + sectionHtml('Holnap', buckets.tomorrow, visibleIds)
            + sectionHtml('Következő 7 nap', buckets.week, visibleIds)
            + sectionHtml('Később', buckets.later, visibleIds)
            + sectionHtml('Nincs határidő', buckets.none, visibleIds);
    }

    function renderCounts() {
        ['today', 'upcoming', 'inbox', 'all'].forEach(view => {
            const counter = viewGroup.querySelector(`[data-count="${view}"]`);
            if (!counter) return;
            const count = state.items.filter(item => matchesView(item, view)).length;
            counter.textContent = count ? String(count) : '';
        });
        viewGroup.querySelectorAll('[data-task-view]').forEach(button => {
            button.classList.toggle('active', !state.project && button.dataset.taskView === state.view);
        });
    }

    function renderProjects() {
        const openCounts = new Map();
        state.items.filter(item => item.status !== 'done' && item.category_id).forEach(item => {
            openCounts.set(String(item.category_id), (openCounts.get(String(item.category_id)) || 0) + 1);
        });
        const chips = state.projects.slice().sort((a, b) => a.name.localeCompare(b.name, 'hu')).map(project => `
            <button type="button" class="category-chip ${String(project.id) === String(state.project) ? 'active' : ''}" data-project="${Number(project.id)}">
                <i class="fa-solid fa-folder"></i> ${esc(project.name)}${openCounts.get(String(project.id)) ? ` <span class="task-chip-count">${openCounts.get(String(project.id))}</span>` : ''}
            </button>`);
        chips.push('<button type="button" class="category-chip task-new-project" data-project-new="1" title="Új projekt"><i class="fa-solid fa-plus"></i> Projekt</button>');
        projectsBar.innerHTML = chips.join('');
    }

    function render() {
        if (state.project && !state.projects.some(project => String(project.id) === String(state.project))) {
            state.project = null;
            if (state.view === 'project') state.view = 'today';
        }
        renderCounts();
        renderProjects();
        renderList();
        refreshBadge();
        if (state.selectedId && !findItem(state.selectedId)) closeDetail(false);
    }

    // ---------- gyors-beírás ----------

    function quickParse() {
        return parser.parse(quickInput.value, { timeZone: TIME_ZONE });
    }

    // ---------- gyors-beírás AI-val: kötetlen mondatból cím, határidő, prioritás, címkék, projekt ----------

    const ai = window.CloudMark.ai;
    const quickAiButton = document.getElementById('taskQuickAi');
    let aiEnabled = false;
    // Az AI javaslata addig érvényes, amíg a beírt szöveg nem változik.
    let aiQuick = null;

    function currentAiQuick() {
        return aiQuick && aiQuick.text === quickInput.value ? aiQuick.suggestion : null;
    }

    function renderAiQuickPreview(suggestion) {
        const chips = [];
        if (suggestion.dueDate) chips.push(`<span class="task-chip task-chip-date"><i class="fa-regular fa-calendar"></i> ${esc(dayLabel(suggestion.dueDate))}${suggestion.dueTime ? ` ${esc(suggestion.dueTime)}` : ''}</span>`);
        if (suggestion.priority) chips.push(`<span class="task-chip task-p${suggestion.priority}"><i class="fa-solid fa-flag"></i> P${suggestion.priority}</span>`);
        if (suggestion.categoryName) chips.push(`<span class="task-chip"><i class="fa-solid fa-folder"></i> ${esc(suggestion.categoryName)}</span>`);
        suggestion.tags.forEach(tag => chips.push(`<span class="task-chip">#${esc(tag)}</span>`));
        quickPreview.innerHTML = `<span class="task-chip task-chip-ai"><i class="fa-solid fa-wand-magic-sparkles"></i> AI</span>
            <span class="task-quick-title">${esc(suggestion.title)}</span>${chips.join('')}
            <span class="task-quick-hint">Enter: mentés</span>
            <button type="button" class="ai-link task-quick-ai-dismiss" data-quick-ai="dismiss">Elvetem</button>`;
    }

    async function runQuickAi() {
        if (!ai || !aiEnabled) return;
        const text = quickInput.value.trim();
        if (!text) { notify('Írd be, mit kell csinálni, pl. „jövő kedden fel kéne hívni a könyvelőt, fontos”.', 'info'); quickInput.focus(); return; }
        const sent = quickInput.value;
        const suggestion = await ai.run('task.parse', { text, timeZone: TIME_ZONE }, quickAiButton);
        if (!suggestion || quickInput.value !== sent) return;
        aiQuick = { text: sent, suggestion };
        renderQuickPreview();
        quickInput.focus();
    }

    function showAiButtons(current) {
        aiEnabled = Boolean(current && current.enabled);
        quickAiButton.hidden = !aiEnabled;
        if (state.selectedId && !detailBox.hidden) refreshDetail();
    }

    if (ai) {
        quickAiButton.addEventListener('click', runQuickAi);
        document.addEventListener('cloudmark:ai', event => showAiButtons(event.detail));
        ai.status().then(showAiButtons);
    }

    quickPreview.addEventListener('click', event => {
        if (!event.target.closest('[data-quick-ai="dismiss"]')) return;
        aiQuick = null;
        renderQuickPreview();
        quickInput.focus();
    });

    function renderQuickPreview() {
        const text = quickInput.value.trim();
        if (!text) { aiQuick = null; quickPreview.innerHTML = ''; return; }
        const suggestion = currentAiQuick();
        if (suggestion) { renderAiQuickPreview(suggestion); return; }
        aiQuick = null;
        const parsed = quickParse();
        const chips = [];
        if (parsed.dueDate) chips.push(`<span class="task-chip task-chip-date"><i class="fa-regular fa-calendar"></i> ${esc(dayLabel(parsed.dueDate))}${parsed.dueTime ? ` ${parsed.dueTime}` : ''}</span>`);
        if (parsed.recurrenceRule) chips.push(`<span class="task-chip"><i class="fa-solid fa-repeat"></i> ${esc(parser.describeRecurrence(parsed.recurrenceRule))}</span>`);
        if (parsed.priority) chips.push(`<span class="task-chip task-p${parsed.priority}"><i class="fa-solid fa-flag"></i> P${parsed.priority}</span>`);
        if (parsed.project) {
            const exists = state.projects.some(project => project.name.toLowerCase() === parsed.project.toLowerCase());
            chips.push(`<span class="task-chip"><i class="fa-solid fa-folder"></i> ${esc(parsed.project)}${exists ? '' : ' (új projekt)'}</span>`);
        }
        parsed.tags.forEach(tag => chips.push(`<span class="task-chip">#${esc(tag)}</span>`));
        parsed.reminders.forEach(minutes => chips.push(`<span class="task-chip"><i class="fa-regular fa-bell"></i> ${esc(reminderLabel({ offsetMinutes: minutes }))}</span>`));
        quickPreview.innerHTML = chips.length
            ? `<span class="task-quick-title">${esc(parsed.title || '(nincs cím)')}</span>${chips.join('')}`
            : '<span class="task-quick-hint">Tipp: „holnap 9-kor”, „minden hétfőn”, „!1”, „#címke”, „@Projekt”, „^30” (emlékeztető)</span>';
    }

    async function ensureProject(name) {
        const existing = state.projects.find(project => project.name.toLowerCase() === name.toLowerCase());
        if (existing) return existing.id;
        state.projects = await taskApi.createCategoryOfKind('task', name);
        return state.projects.find(project => project.name.toLowerCase() === name.toLowerCase())?.id ?? null;
    }

    /** The AI suggestion in the shape of quickParse(), so quickAdd saves it the same way. */
    function parsedFromAi(suggestion) {
        return {
            title: suggestion.title,
            dueAt: suggestion.dueDate ? parser.zonedTimeToUtc(suggestion.dueDate, suggestion.dueTime || '00:00', TIME_ZONE).toISOString() : null,
            dueAllDay: Boolean(suggestion.dueDate) && !suggestion.dueTime,
            priority: suggestion.priority,
            tags: suggestion.tags,
            project: null,
            categoryId: suggestion.categoryId,
            recurrenceRule: null,
            reminders: []
        };
    }

    async function quickAdd() {
        const text = quickInput.value.trim();
        if (!text) return;
        const suggestion = currentAiQuick();
        const parsed = suggestion ? parsedFromAi(suggestion) : quickParse();
        if (!parsed.title) { notify('Adj címet a feladatnak.', 'error'); return; }
        let dueAt = parsed.dueAt;
        let dueAllDay = parsed.dueAllDay;
        // A Ma nézetben dátum nélkül felvett feladat mára kerül, ahogy várnád.
        if (!dueAt && state.view === 'today' && !state.project) {
            dueAt = parser.zonedTimeToUtc(today(), '00:00', TIME_ZONE).toISOString();
            dueAllDay = true;
        }
        quickInput.disabled = true;
        try {
            const categoryId = parsed.project ? await ensureProject(parsed.project) : (parsed.categoryId ?? state.project);
            const created = await taskApi.createItem({
                type: 'task',
                title: parsed.title,
                categoryId: categoryId ?? null,
                tags: parsed.tags,
                priority: parsed.priority,
                dueAt,
                dueAllDay,
                recurrenceRule: parsed.recurrenceRule,
                reminders: parsed.reminders.map(offsetMinutes => ({ offsetMinutes })),
                fragments: []
            });
            upsert(created);
            quickInput.value = '';
            aiQuick = null;
            renderQuickPreview();
            render();
            notify(`Feladat hozzáadva: ${created.title}`, 'success');
        } catch (err) {
            notify(err.message || 'A feladat mentése nem sikerült.', 'error');
        } finally {
            quickInput.disabled = false;
            quickInput.focus();
        }
    }

    quickInput.addEventListener('input', renderQuickPreview);
    quickInput.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            runQuickAi();
        }
    });
    quickForm.addEventListener('submit', event => { event.preventDefault(); quickAdd(); });

    // ---------- kipipálás, visszavonás ----------

    let toastTimer = null;
    let undoAction = null;

    function showToast(message, undo) {
        clearTimeout(toastTimer);
        undoAction = undo;
        toast.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" class="task-toast-undo" data-toast="undo">Visszavonás</button>' : ''}
            <button type="button" class="task-toast-close" data-toast="close" aria-label="Bezárás">&times;</button>`;
        toast.hidden = false;
        toastTimer = setTimeout(hideToast, TOAST_MS);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        toast.hidden = true;
        undoAction = null;
    }

    toast.addEventListener('click', async event => {
        const button = event.target.closest('[data-toast]');
        if (!button) return;
        const action = undoAction;
        hideToast();
        if (button.dataset.toast === 'undo' && action) {
            try { await action(); } catch (err) { notify(err.message || 'A visszavonás nem sikerült.', 'error'); }
        }
    });

    async function toggleComplete(item) {
        if (item.status === 'done') {
            try {
                upsert(await taskApi.uncompleteTask(item.id));
                await reloadItems();
                refreshDetail();
            } catch (err) {
                notify(err.message || 'A módosítás nem sikerült.', 'error');
            }
            return;
        }
        const row = listBox.querySelector(`[data-task-id="${Number(item.id)}"]`);
        if (row) row.classList.add('is-completing');
        try {
            await new Promise(resolve => setTimeout(resolve, 280));
            const result = await taskApi.completeTask(item.id, TIME_ZONE);
            await reloadItems();
            refreshDetail();
            const message = result.recurring
                ? `Kész · következő: ${dayLabel(parser.localDate(new Date(result.item.due_at), TIME_ZONE))}`
                : `Kész: ${item.title}`;
            showToast(message, async () => {
                await taskApi.uncompleteTask(item.id, result.recurring ? result.previousDueAt : null);
                await reloadItems();
                refreshDetail();
            });
        } catch (err) {
            if (row) row.classList.remove('is-completing');
            notify(err.message || 'A feladat lezárása nem sikerült.', 'error');
        }
    }

    // ---------- részletpanel ----------

    let saveTimer = null;
    let savePromise = Promise.resolve();
    let draft = null;

    function draftFrom(item) {
        return {
            id: item.id,
            title: item.title || '',
            body: item.body || '',
            categoryId: item.category_id ?? null,
            tags: item.tags || [],
            priority: item.priority ?? null,
            status: item.status || 'todo',
            dueAt: item.due_at || null,
            dueAllDay: item.due_all_day !== false,
            recurrenceRule: item.recurrence_rule || null,
            parentItemId: item.parent_item_id ?? null,
            reminders: (item.reminders || []).map(reminder => (reminder.offsetMinutes !== null && reminder.offsetMinutes !== undefined
                ? { offsetMinutes: reminder.offsetMinutes } : { remindAt: reminder.remindAt })),
            links: (item.links || []).map(link => ({ targetType: link.targetType, targetId: link.targetId })),
            pinned: Boolean(item.pinned),
            starred: Boolean(item.starred),
            position: item.position ?? null,
            extra: item.extra || {}
        };
    }

    function payloadOf(value) {
        const { id, ...fields } = value;
        return { type: 'task', ...fields, fragments: [] };
    }

    function repeatOptions(rule, dueDate) {
        const weekday = dueDate ? ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${dueDate}T12:00:00Z`).getUTCDay()] : 'MO';
        const monthDay = dueDate ? Number(dueDate.slice(8, 10)) : 1;
        const options = [
            ['', 'Nem ismétlődik'],
            ['FREQ=DAILY', 'Minden nap'],
            ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Minden hétköznap'],
            [`FREQ=WEEKLY;BYDAY=${weekday}`, capitalize(parser.describeRecurrence(`FREQ=WEEKLY;BYDAY=${weekday}`))],
            ['FREQ=WEEKLY;INTERVAL=2', 'Kéthetente'],
            [`FREQ=MONTHLY;BYMONTHDAY=${monthDay}`, `Havonta, ${monthDay}-én`],
            ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Havonta, az utolsó napon'],
            ['FREQ=YEARLY', 'Évente']
        ];
        if (rule && !options.some(([value]) => value === rule)) options.push([rule, capitalize(parser.describeRecurrence(rule)) || rule]);
        return options.map(([value, label]) => `<option value="${esc(value)}" ${value === (rule || '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
    }

    function linkIcon(link) {
        if (link.targetType === 'bookmark') return 'fa-bookmark';
        return { note: 'fa-note-sticky', command: 'fa-terminal', task: 'fa-list-check' }[link.itemType] || 'fa-link';
    }

    function detailHtml(item) {
        const due = dueParts(item);
        const isSub = Boolean(item.parent_item_id);
        const parent = isSub ? findItem(item.parent_item_id) : null;
        const trashed = Boolean(item.trashed);
        const children = isSub ? [] : childrenOf(item);
        const projectOptions = ['<option value="">Beérkezett (nincs projekt)</option>']
            .concat(state.projects.slice().sort((a, b) => a.name.localeCompare(b.name, 'hu'))
                .map(project => `<option value="${Number(project.id)}" ${String(project.id) === String(item.category_id) ? 'selected' : ''}>${esc(project.name)}</option>`)).join('');
        return `
            <div class="task-detail-head">
                <button type="button" class="task-check ${item.priority ? `task-p${item.priority}` : ''}" data-detail="toggle" aria-pressed="${item.status === 'done'}" ${trashed ? 'disabled' : ''}
                        title="${item.status === 'done' ? 'Visszanyitás' : 'Kész'}"><i class="fa-solid fa-check"></i></button>
                <textarea class="task-detail-title" data-field="title" rows="1" maxlength="300" aria-label="Cím" ${trashed ? 'disabled' : ''}>${esc(item.title)}</textarea>
                <button type="button" class="note-action" data-detail="close" title="Bezárás (Esc)" aria-label="Bezárás"><i class="fa-solid fa-xmark"></i></button>
            </div>
            ${parent ? `<button type="button" class="task-detail-parent" data-open-task="${Number(parent.id)}"><i class="fa-solid fa-turn-up fa-rotate-90"></i> ${esc(parent.title)}</button>` : ''}
            <textarea class="task-detail-body" data-field="body" rows="3" maxlength="100000" placeholder="Leírás, megjegyzés…" aria-label="Leírás" ${trashed ? 'disabled' : ''}>${esc(item.body || '')}</textarea>
            ${aiEnabled && !trashed ? `<div class="task-ai-tools">
                <button type="button" class="btn btn-secondary ai-fill-btn" data-detail="ai-fill" title="Címkék, projekt és prioritás javaslata a cím és a leírás alapján"><i class="fa-solid fa-wand-magic-sparkles"></i> AI: címkék, projekt</button>
            </div>
            <div class="task-ai-slot" data-ai-slot="fill"></div>` : ''}
            <div class="task-detail-grid">
                <label class="task-field"><span>Határidő</span>
                    <input type="date" data-field="dueDate" value="${due ? due.date : ''}" ${trashed ? 'disabled' : ''}>
                </label>
                <label class="task-field"><span>Időpont</span>
                    <input type="time" data-field="dueTime" value="${due?.time || ''}" ${!due || trashed ? 'disabled' : ''}>
                </label>
                <div class="task-quick-dates">
                    <button type="button" class="btn btn-secondary" data-detail="due-today">Ma</button>
                    <button type="button" class="btn btn-secondary" data-detail="due-tomorrow">Holnap</button>
                    <button type="button" class="btn btn-secondary" data-detail="due-nextweek">Jövő hét</button>
                    <button type="button" class="btn btn-secondary" data-detail="due-clear" ${due ? '' : 'disabled'}>Nincs</button>
                </div>
                <label class="task-field"><span>Ismétlődés</span>
                    <select data-field="recurrenceRule" ${!due || trashed ? 'disabled' : ''}>${repeatOptions(item.recurrence_rule, due?.date)}</select>
                </label>
                <label class="task-field"><span>Prioritás</span>
                    <select data-field="priority" ${trashed ? 'disabled' : ''}>
                        <option value="">Nincs</option>
                        ${[1, 2, 3, 4].map(level => `<option value="${level}" ${item.priority === level ? 'selected' : ''}>${PRIORITY_LABELS[level]}</option>`).join('')}
                    </select>
                </label>
                <label class="task-field"><span>Projekt</span>
                    <select data-field="categoryId" ${trashed ? 'disabled' : ''}>${projectOptions}</select>
                </label>
                <label class="task-field"><span>Állapot</span>
                    <select data-field="status" ${trashed ? 'disabled' : ''}>
                        <option value="todo" ${item.status === 'todo' ? 'selected' : ''}>Teendő</option>
                        <option value="doing" ${item.status === 'doing' ? 'selected' : ''}>Folyamatban</option>
                        <option value="done" ${item.status === 'done' ? 'selected' : ''}>Kész</option>
                    </select>
                </label>
                <label class="task-field task-field-wide"><span>Címkék</span>
                    <input type="text" data-field="tags" value="${esc(item.tags.join(', '))}" placeholder="vesszővel elválasztva" ${trashed ? 'disabled' : ''}>
                </label>
            </div>

            <section class="task-detail-section">
                <h4><i class="fa-regular fa-bell"></i> Emlékeztetők</h4>
                <div class="task-detail-list">
                    ${item.reminders.length ? item.reminders.map((reminder, index) => `
                        <div class="task-detail-pill ${reminder.sentAt ? 'is-sent' : ''}">
                            <span>${esc(reminderLabel(reminder))}${reminder.sentAt ? ' · elküldve' : ''}</span>
                            <button type="button" class="note-action" data-detail="remove-reminder" data-index="${index}" title="Emlékeztető törlése" aria-label="Emlékeztető törlése"><i class="fa-solid fa-xmark"></i></button>
                        </div>`).join('') : '<div class="task-detail-empty">Nincs emlékeztető.</div>'}
                </div>
                ${trashed ? '' : `<div class="task-detail-add">
                    <select data-detail-input="reminder" aria-label="Új emlékeztető">
                        <option value="">Emlékeztető hozzáadása…</option>
                        ${REMINDER_PRESETS.map(preset => `<option value="${preset.value}" ${due ? '' : 'disabled'}>${preset.label}</option>`).join('')}
                        <option value="custom">Egyedi időpont…</option>
                    </select>
                    <input type="datetime-local" data-detail-input="reminder-at" hidden aria-label="Emlékeztető időpontja">
                    ${item.status === 'done' ? '' : '<button type="button" class="btn btn-secondary task-snooze" data-detail="snooze" title="Egyszeri emlékeztető 10 perc múlva"><i class="fa-regular fa-clock"></i> Szundi 10 perc</button>'}
                </div>
                <p class="task-detail-note">Az emlékeztető a csengő ikonnál, a telefonodon (ha bekapcsoltad) és e-mailben érkezik. Bekapcsolni a Beállítások / Általános fülön lehet.</p>`}
            </section>

            ${isSub ? '' : `<section class="task-detail-section">
                <h4><i class="fa-solid fa-list-check"></i> Részfeladatok ${children.length ? `<span class="task-section-count">${children.filter(child => child.status === 'done').length}/${children.length}</span>` : ''}
                    ${aiEnabled && !trashed ? '<button type="button" class="ai-link task-ai-split" data-detail="ai-subtasks" title="Részfeladatok javaslata"><i class="fa-solid fa-wand-magic-sparkles"></i> Bontsd lépésekre</button>' : ''}</h4>
                <div class="task-ai-slot" data-ai-slot="subtasks"></div>
                <div class="task-detail-subtasks">
                    ${children.map(child => `
                        <div class="task-subtask ${child.status === 'done' ? 'is-done' : ''}" data-task-id="${Number(child.id)}">
                            <button type="button" class="task-check task-check-small" data-detail="toggle-sub" aria-pressed="${child.status === 'done'}" title="${child.status === 'done' ? 'Visszanyitás' : 'Kész'}"><i class="fa-solid fa-check"></i></button>
                            <button type="button" class="task-subtask-title" data-open-task="${Number(child.id)}">${esc(child.title)}</button>
                        </div>`).join('')}
                </div>
                ${trashed ? '' : '<input type="text" class="task-detail-input" data-detail-input="subtask" maxlength="300" placeholder="+ Részfeladat hozzáadása (Enter)" aria-label="Új részfeladat">'}
            </section>`}

            <section class="task-detail-section">
                <h4><i class="fa-solid fa-link"></i> Kapcsolt elemek</h4>
                <div class="task-detail-list">
                    ${item.links.length ? item.links.map((link, index) => `
                        <div class="task-detail-pill task-link">
                            <button type="button" class="task-link-open" data-detail="open-link" data-index="${index}">
                                <i class="fa-solid ${linkIcon(link)}"></i> ${esc(link.title || 'Névtelen')}
                            </button>
                            ${trashed ? '' : `<button type="button" class="note-action" data-detail="remove-link" data-index="${index}" title="Kapcsolat törlése" aria-label="Kapcsolat törlése"><i class="fa-solid fa-xmark"></i></button>`}
                        </div>`).join('') : '<div class="task-detail-empty">Nincs kapcsolt jegyzet, parancs vagy könyvjelző.</div>'}
                </div>
                ${trashed ? '' : `<div class="task-link-search">
                    <input type="search" class="task-detail-input" data-detail-input="link" placeholder="Jegyzet, parancs vagy könyvjelző keresése…" aria-label="Kapcsolat keresése" autocomplete="off">
                    <div class="task-link-results" hidden></div>
                </div>`}
            </section>

            <div class="task-detail-foot">
                <span class="note-editor-status" aria-live="polite"></span>
                ${trashed
                    ? '<button type="button" class="btn btn-secondary" data-detail="restore"><i class="fa-solid fa-rotate-left"></i> Visszaállítás</button>'
                    : '<button type="button" class="btn btn-danger" data-detail="trash"><i class="fa-solid fa-trash"></i> Törlés</button>'}
            </div>`;
    }

    function setStatus(text) {
        const status = detailBox.querySelector('.note-editor-status');
        if (status) status.textContent = text;
    }

    function openDetail(id) {
        const item = findItem(id);
        if (!item) return;
        if (draft && String(draft.id) !== String(id)) flushSave();
        state.selectedId = item.id;
        draft = draftFrom(item);
        detailBox.innerHTML = detailHtml(item);
        detailBox.hidden = false;
        document.getElementById('tasksView').classList.add('has-detail');
        listBox.querySelectorAll('.task-row').forEach(row => row.classList.toggle('is-selected', row.dataset.taskId === String(item.id)));
        autoGrow(detailBox.querySelector('.task-detail-title'));
    }

    /** Re-renders the open panel from the latest saved copy, keeping the panel's scroll position. */
    function refreshDetail() {
        if (!state.selectedId || detailBox.hidden) return;
        const item = findItem(state.selectedId);
        if (!item) { closeDetail(false); return; }
        const scroll = detailBox.scrollTop;
        draft = draftFrom(item);
        detailBox.innerHTML = detailHtml(item);
        detailBox.scrollTop = scroll;
        autoGrow(detailBox.querySelector('.task-detail-title'));
    }

    function closeDetail(save = true) {
        if (save) flushSave();
        state.selectedId = null;
        draft = null;
        detailBox.hidden = true;
        detailBox.innerHTML = '';
        document.getElementById('tasksView')?.classList.remove('has-detail');
        listBox.querySelectorAll('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
    }

    function autoGrow(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
    }

    /** Reads the panel's form fields into the draft. */
    function readFields() {
        if (!draft) return;
        const field = name => detailBox.querySelector(`[data-field="${name}"]`);
        draft.title = field('title').value.replace(/\s+/g, ' ').trim();
        draft.body = field('body').value;
        draft.tags = field('tags').value.split(',').map(tag => tag.trim()).filter(Boolean);
        draft.priority = field('priority').value ? Number(field('priority').value) : null;
        draft.categoryId = field('categoryId').value ? Number(field('categoryId').value) : null;
        draft.status = field('status').value;
        const date = field('dueDate').value;
        const time = field('dueTime').value;
        draft.dueAt = date ? parser.zonedTimeToUtc(date, time || '00:00', TIME_ZONE).toISOString() : null;
        draft.dueAllDay = !time;
        draft.recurrenceRule = date ? (field('recurrenceRule').value || null) : null;
        if (!draft.dueAt) draft.reminders = draft.reminders.filter(reminder => reminder.offsetMinutes === undefined);
    }

    function queueSave() {
        clearTimeout(saveTimer);
        setStatus('Mentés…');
        saveTimer = setTimeout(() => flushSave(), AUTOSAVE_MS);
    }

    /** Saves the draft; `rerender` refreshes the panel afterwards (for changes that alter its structure). */
    function flushSave({ rerender = false } = {}) {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (!draft) return savePromise;
        if (detailBox.querySelector('[data-field="title"]')) readFields();
        const snapshot = { ...draft };
        if (!snapshot.title) { setStatus('A cím nem lehet üres'); return savePromise; }
        savePromise = savePromise.then(() => taskApi.updateItem(snapshot.id, payloadOf(snapshot))).then(saved => {
            upsert(saved);
            renderCounts();
            renderProjects();
            renderList();
            refreshBadge();
            if (String(state.selectedId) === String(saved.id)) {
                if (rerender) refreshDetail();
                else setStatus('Mentve');
            }
        }).catch(err => {
            setStatus('');
            notify(err.message || 'A feladat mentése nem sikerült.', 'error');
            if (rerender) refreshDetail();
        });
        return savePromise;
    }

    function setDueDate(dateText) {
        const dateInput = detailBox.querySelector('[data-field="dueDate"]');
        const timeInput = detailBox.querySelector('[data-field="dueTime"]');
        dateInput.value = dateText || '';
        if (!dateText) timeInput.value = '';
        flushSave({ rerender: true });
    }

    async function addSubtask(input) {
        const title = input.value.trim();
        if (!title || !draft) return;
        input.disabled = true;
        try {
            const created = await taskApi.createItem({ type: 'task', title, parentItemId: draft.id, categoryId: draft.categoryId, fragments: [] });
            upsert(created);
            state.items = await taskApi.getItems('task');
            render();
            refreshDetail();
            detailBox.querySelector('[data-detail-input="subtask"]')?.focus();
        } catch (err) {
            notify(err.message || 'A részfeladat mentése nem sikerült.', 'error');
            input.disabled = false;
        }
    }

    let linkSearchTimer = null;
    async function searchLinks(input) {
        const results = input.parentElement.querySelector('.task-link-results');
        const query = input.value.trim().toLowerCase();
        if (query.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        try {
            // Ugyanaz a közös kereső, mint a Ctrl+K ablaké.
            const found = await taskApi.search(query, { limit: 8 });
            if (input.value.trim().toLowerCase() !== query) return;
            const linked = new Set(draft.links.map(link => `${link.targetType}:${link.targetId}`));
            const matches = found
                .filter(result => !(result.kind === 'task' && String(result.id) === String(draft.id)))
                .map(result => result.kind === 'bookmark'
                    ? { targetType: 'bookmark', targetId: result.id, title: result.title, url: result.url }
                    : { targetType: 'item', targetId: result.id, itemType: result.kind, title: result.title })
                .filter(match => !linked.has(`${match.targetType}:${match.targetId}`)).slice(0, 12);
            results.innerHTML = matches.length ? matches.map((match, index) => `
                <button type="button" class="task-link-result" data-result="${index}">
                    <i class="fa-solid ${linkIcon(match)}"></i> <span>${esc(match.title)}</span>
                    <small>${match.targetType === 'bookmark' ? 'könyvjelző' : { note: 'jegyzet', command: 'parancs', task: 'feladat' }[match.itemType]}</small>
                </button>`).join('') : '<div class="task-detail-empty">Nincs találat.</div>';
            results.hidden = false;
            results._matches = matches;
        } catch (err) {
            results.innerHTML = `<div class="task-detail-empty">${esc(err.message)}</div>`;
            results.hidden = false;
        }
    }

    async function openLink(link) {
        if (link.targetType === 'bookmark') {
            if (link.url && /^https?:\/\//i.test(link.url)) window.open(link.url, '_blank', 'noopener');
            return;
        }
        if (link.itemType === 'task') { openDetail(link.targetId); return; }
        const views = window.CloudMark.views;
        if (link.itemType === 'note') {
            views?.showView('notes');
            window.CloudMark.notes?.openById?.(link.targetId);
        } else if (link.itemType === 'command') {
            views?.showView('commands');
            window.CloudMark.commands?.openById?.(link.targetId);
        }
    }

    // ---------- AI a részletes panelben: javaslatkártya, semmi nem változik Elfogadom előtt ----------

    function showAiCard(slotName, card) {
        const slot = detailBox.querySelector(`[data-ai-slot="${slotName}"]`);
        if (!slot) return;
        slot.innerHTML = '';
        slot.appendChild(card);
    }

    async function aiFillDetail(item, button) {
        readFields();
        const taskId = item.id;
        const suggestion = await ai.run('task.fill', { title: draft.title, body: draft.body }, button);
        if (!suggestion || String(state.selectedId) !== String(taskId)) return;
        const rows = [];
        const newTags = suggestion.tags.filter(tag => !draft.tags.some(existing => existing.toLowerCase() === tag.toLowerCase()));
        if (newTags.length) rows.push({ key: 'tags', html: `Címkék: ${newTags.map(tag => `<strong>#${esc(tag)}</strong>`).join(' ')}` });
        if (suggestion.categoryId && suggestion.categoryId !== draft.categoryId) {
            rows.push({ key: 'project', html: `Projekt: <strong>${esc(suggestion.categoryName)}</strong>`, checked: !draft.categoryId });
        }
        if (suggestion.priority && suggestion.priority !== draft.priority) {
            rows.push({ key: 'priority', html: `Prioritás: <strong>${esc(PRIORITY_LABELS[suggestion.priority])}</strong>`, checked: !draft.priority });
        }
        if (!rows.length) { notify('Az AI nem talált új címkét, projektet vagy prioritást.', 'info'); return; }
        showAiCard('fill', ai.suggestionCard({
            title: `AI javaslat (${suggestion.providerLabel})`,
            rows,
            onAccept: async keys => {
                if (String(state.selectedId) !== String(taskId)) return;
                const field = name => detailBox.querySelector(`[data-field="${name}"]`);
                if (keys.includes('tags')) field('tags').value = [...draft.tags, ...newTags].join(', ');
                if (keys.includes('project')) field('categoryId').value = String(suggestion.categoryId);
                if (keys.includes('priority')) field('priority').value = String(suggestion.priority);
                await flushSave({ rerender: true });
            }
        }));
    }

    async function aiSplitDetail(item, button) {
        readFields();
        const taskId = item.id;
        const existing = childrenOf(item).map(child => child.title);
        const suggestion = await ai.run('task.subtasks', { title: draft.title, body: draft.body, subtasks: existing }, button);
        if (!suggestion || String(state.selectedId) !== String(taskId)) return;
        if (!suggestion.subtasks.length) { notify('Az AI nem javasolt új lépést.', 'info'); return; }
        showAiCard('subtasks', ai.suggestionCard({
            title: `Javasolt lépések (${suggestion.providerLabel})`,
            rows: suggestion.subtasks.map((title, index) => ({ key: index, html: esc(title) })),
            acceptLabel: 'Részfeladatok létrehozása',
            onAccept: async keys => {
                const parent = findItem(taskId);
                if (!parent) return;
                for (const index of keys) {
                    upsert(await taskApi.createItem({ type: 'task', title: suggestion.subtasks[index], parentItemId: parent.id, categoryId: parent.category_id ?? null, fragments: [] }));
                }
                state.items = await taskApi.getItems('task');
                render();
                refreshDetail();
                notify(`${keys.length} részfeladat létrehozva.`, 'success');
            }
        }));
    }

    detailBox.addEventListener('input', event => {
        if (event.target.matches('[data-field="title"]')) autoGrow(event.target);
        if (event.target.matches('[data-field="title"], [data-field="body"], [data-field="tags"]')) queueSave();
        if (event.target.matches('[data-detail-input="link"]')) {
            clearTimeout(linkSearchTimer);
            linkSearchTimer = setTimeout(() => searchLinks(event.target), 200);
        }
    });

    detailBox.addEventListener('change', event => {
        const target = event.target;
        if (target.matches('[data-field="dueDate"], [data-field="dueTime"], [data-field="recurrenceRule"], [data-field="priority"], [data-field="categoryId"], [data-field="status"]')) {
            flushSave({ rerender: true });
            return;
        }
        if (target.matches('[data-detail-input="reminder"]')) {
            const value = target.value;
            if (value === 'custom') {
                const picker = detailBox.querySelector('[data-detail-input="reminder-at"]');
                picker.hidden = false;
                picker.focus();
                return;
            }
            if (value !== '') {
                draft.reminders.push({ offsetMinutes: Number(value) });
                flushSave({ rerender: true });
            }
            return;
        }
        if (target.matches('[data-detail-input="reminder-at"]') && target.value) {
            const [date, time] = target.value.split('T');
            draft.reminders.push({ remindAt: parser.zonedTimeToUtc(date, time, TIME_ZONE).toISOString() });
            flushSave({ rerender: true });
        }
    });

    detailBox.addEventListener('keydown', event => {
        if (event.target.matches('[data-detail-input="subtask"]') && event.key === 'Enter') {
            event.preventDefault();
            addSubtask(event.target);
        }
        if (event.target.matches('[data-field="title"]') && event.key === 'Enter') {
            event.preventDefault();
            event.target.blur();
            flushSave();
        }
    });

    detailBox.addEventListener('click', async event => {
        const opener = event.target.closest('[data-open-task]');
        if (opener) { flushSave(); openDetail(opener.dataset.openTask); return; }
        const result = event.target.closest('[data-result]');
        if (result) {
            const match = result.parentElement._matches?.[Number(result.dataset.result)];
            if (match) {
                draft.links.push({ targetType: match.targetType, targetId: match.targetId });
                flushSave({ rerender: true });
            }
            return;
        }
        const button = event.target.closest('[data-detail]');
        if (!button) return;
        const action = button.dataset.detail;
        const item = findItem(state.selectedId);
        if (!item) return;
        if (action === 'close') { closeDetail(); return; }
        if (action === 'ai-fill') { aiFillDetail(item, button); return; }
        if (action === 'ai-subtasks') { aiSplitDetail(item, button); return; }
        if (action === 'toggle') { await flushSave(); toggleComplete(findItem(item.id)); return; }
        if (action === 'toggle-sub') {
            const child = findItem(button.closest('[data-task-id]').dataset.taskId);
            if (child) toggleComplete(child);
            return;
        }
        if (action === 'due-today') { setDueDate(today()); return; }
        if (action === 'due-tomorrow') { setDueDate(parser.addDays(today(), 1)); return; }
        if (action === 'due-nextweek') {
            const now = today();
            const weekday = new Date(`${now}T12:00:00Z`).getUTCDay();
            setDueDate(parser.addDays(now, 7 - ((weekday + 6) % 7)));
            return;
        }
        if (action === 'due-clear') { setDueDate(''); return; }
        if (action === 'snooze') {
            button.disabled = true;
            try {
                await taskApi.snoozeTask(item.id);
                notify('Rendben, 10 perc múlva újra szólok.', 'success');
            } catch (err) {
                notify(err.message || 'A szundi nem sikerült.', 'error');
            } finally {
                button.disabled = false;
            }
            return;
        }
        if (action === 'remove-reminder') {
            draft.reminders.splice(Number(button.dataset.index), 1);
            flushSave({ rerender: true });
            return;
        }
        if (action === 'remove-link') {
            draft.links.splice(Number(button.dataset.index), 1);
            flushSave({ rerender: true });
            return;
        }
        if (action === 'open-link') { openLink(item.links[Number(button.dataset.index)]); return; }
        if (action === 'trash') {
            await flushSave();
            try {
                await taskApi.trashItem(item.id);
                closeDetail(false);
                await reloadItems();
                showToast(`Kukába helyezve: ${item.title}`, async () => {
                    await taskApi.setItemState(item.id, { trashed: false });
                    await reloadItems();
                });
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
            return;
        }
        if (action === 'restore') {
            try {
                await taskApi.setItemState(item.id, { trashed: false });
                state.trash = state.trash.filter(entry => String(entry.id) !== String(item.id));
                closeDetail(false);
                await reloadItems();
            } catch (err) {
                notify(err.message || 'A visszaállítás nem sikerült.', 'error');
            }
        }
    });

    // ---------- lista események ----------

    listBox.addEventListener('click', async event => {
        const row = event.target.closest('[data-task-id]');
        if (!row) return;
        const item = findItem(row.dataset.taskId);
        if (!item) return;
        const button = event.target.closest('[data-action]');
        if (!button) { openDetail(item.id); return; }
        const action = button.dataset.action;
        if (action === 'toggle') { toggleComplete(item); return; }
        if (action === 'restore') {
            try {
                await taskApi.setItemState(item.id, { trashed: false });
                await reloadItems();
                notify('Feladat visszaállítva.', 'success');
            } catch (err) {
                notify(err.message || 'A visszaállítás nem sikerült.', 'error');
            }
            return;
        }
        if (action === 'delete') {
            if (!confirm('Véglegesen törlöd ezt a feladatot és a részfeladatait?')) return;
            try {
                await taskApi.deleteItemPermanently(item.id);
                if (String(state.selectedId) === String(item.id)) closeDetail(false);
                await reloadItems();
            } catch (err) {
                notify(err.message || 'A törlés nem sikerült.', 'error');
            }
        }
    });

    listBox.addEventListener('keydown', async event => {
        const row = event.target.closest('.task-row');
        if (!row || event.target !== row) return;
        const item = findItem(row.dataset.taskId);
        if (!item) return;
        const rows = Array.from(listBox.querySelectorAll('.task-row'));
        const index = rows.indexOf(row);
        if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); rows[index + 1]?.focus(); }
        else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); rows[index - 1]?.focus(); }
        else if (event.key === 'Enter') { event.preventDefault(); openDetail(item.id); }
        else if ((event.key === ' ' || event.key === 'x') && !item.trashed) { event.preventDefault(); toggleComplete(item); }
        else if (event.key === 't' && !item.trashed && item.status !== 'done') {
            event.preventDefault();
            try {
                const value = draftFrom(item);
                value.dueAt = parser.zonedTimeToUtc(today(), item.due_at && !item.due_all_day ? parser.localTime(new Date(item.due_at), TIME_ZONE) : '00:00', TIME_ZONE).toISOString();
                upsert(await taskApi.updateItem(item.id, payloadOf(value)));
                render();
                refreshDetail();
                listBox.querySelector(`[data-task-id="${Number(item.id)}"]`)?.focus();
                notify('Áthelyezve mára.', 'success');
            } catch (err) {
                notify(err.message || 'A módosítás nem sikerült.', 'error');
            }
        }
    });

    // ---------- eszköztár ----------

    async function setView(view) {
        await flushSave();
        state.view = view;
        state.project = null;
        if (view === 'trash') {
            listBox.innerHTML = '<div class="empty-state">Kuka betöltése…</div>';
            try { state.trash = await taskApi.getItems('task', { trash: 'true' }); }
            catch (err) { notify(err.message || 'A kuka betöltése nem sikerült.', 'error'); }
        }
        closeDetail(false);
        render();
    }

    viewGroup.addEventListener('click', event => {
        const button = event.target.closest('[data-task-view]');
        if (button) setView(button.dataset.taskView);
    });

    async function createProject() {
        const name = prompt('Új projekt neve:');
        if (!name || !name.trim()) return;
        try {
            const id = await ensureProject(name.trim());
            state.project = id;
            state.view = 'project';
            render();
        } catch (err) {
            notify(err.message || 'A projekt létrehozása nem sikerült.', 'error');
        }
    }

    projectsBar.addEventListener('click', event => {
        if (event.target.closest('[data-project-new]')) { createProject(); return; }
        const chip = event.target.closest('[data-project]');
        if (!chip) return;
        flushSave();
        if (String(state.project) === chip.dataset.project) { state.project = null; state.view = 'all'; }
        else { state.project = chip.dataset.project; state.view = 'project'; }
        closeDetail(false);
        render();
    });

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        searchClear.hidden = !searchInput.value;
        renderList();
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        state.query = '';
        searchClear.hidden = true;
        renderList();
        searchInput.focus();
    });

    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        prefs.set('taskSort', state.sort);
        renderList();
    });

    viewSwitcher.addEventListener('click', event => {
        const button = event.target.closest('[data-view-mode]');
        if (!button) return;
        state.display = button.dataset.viewMode;
        prefs.set('taskView', state.display);
        renderList();
    });
    prefs.markSwitcher(viewSwitcher, state.display);

    document.addEventListener('cloudmark:prefs', () => {
        state.sort = prefs.get('taskSort');
        state.display = prefs.get('taskView');
        sortSelect.value = state.sort;
        if (state.loaded) renderList(); else prefs.markSwitcher(viewSwitcher, state.display);
    });

    moreButton.addEventListener('click', event => {
        event.stopPropagation();
        const open = !moreMenu.classList.contains('show');
        moreMenu.classList.toggle('show', open);
        moreButton.setAttribute('aria-expanded', String(open));
        const current = state.projects.find(project => String(project.id) === String(state.project));
        moreMenu.querySelectorAll('[data-needs-project]').forEach(item => { item.hidden = !current; });
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('#taskMoreMenu') && !event.target.closest('#taskMoreBtn')) {
            moreMenu.classList.remove('show');
            moreButton.setAttribute('aria-expanded', 'false');
        }
        if (!event.target.closest('.task-link-search')) detailBox.querySelectorAll('.task-link-results').forEach(box => { box.hidden = true; });
    });

    moreMenu.addEventListener('click', async event => {
        const item = event.target.closest('[data-task-menu]');
        if (!item) return;
        moreMenu.classList.remove('show');
        const action = item.dataset.taskMenu;
        const current = state.projects.find(project => String(project.id) === String(state.project));
        try {
            if (action === 'new-project') await createProject();
            if (action === 'rename-project' && current) {
                const name = prompt('A projekt új neve:', current.name);
                if (!name || !name.trim() || name.trim() === current.name) return;
                state.projects = await taskApi.renameCategoryOfKind('task', current.name, name.trim()).then(() => taskApi.getCategoriesOfKind('task'));
                await reloadItems();
            }
            if (action === 'delete-project' && current) {
                if (!confirm(`Törlöd a(z) „${current.name}” projektet? A feladatai a Beérkezettek közé kerülnek.`)) return;
                await taskApi.deleteCategoryOfKind('task', current.name);
                state.projects = await taskApi.getCategoriesOfKind('task');
                state.project = null;
                state.view = 'inbox';
                await reloadItems();
            }
            if (action === 'export-json') download(await taskApi.exportItems('task', 'json', { tz: TIME_ZONE }), 'cloudmark-feladatok.json');
            if (action === 'export-md') download(await taskApi.exportItems('task', 'md', { tz: TIME_ZONE }), 'cloudmark-feladatok.md');
        } catch (err) {
            notify(err.message || 'A művelet nem sikerült.', 'error');
        }
    });

    importInput.addEventListener('change', async () => {
        const file = importInput.files[0];
        importInput.value = '';
        moreMenu.classList.remove('show');
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const items = Array.isArray(data) ? data : data.items;
            if (!Array.isArray(items)) throw new Error('A fájlban nincs feladatlista.');
            const result = await taskApi.importItems('task', items);
            state.projects = await taskApi.getCategoriesOfKind('task');
            await reloadItems();
            notify(`${result.imported} feladat importálva.`, 'success');
        } catch (err) {
            notify(err.message || 'Az importálás nem sikerült.', 'error');
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || detailBox.hidden) return;
        if (document.querySelector('.modal-overlay.active')) return;
        if (window.CloudMark.views?.active !== 'tasks') return;
        closeDetail();
    });

    window.CloudMark.tasks = {
        show: () => load(),
        reset,
        refreshBadge,
        /** Reloads the list if it was already loaded (after tasks were created elsewhere, e.g. from a note). */
        reload: () => (state.loaded ? reloadItems() : Promise.resolve()),
        focusQuickAdd: () => quickInput.focus(),
        /** Adds a task from free text the same way as the quick-add bar (used by the Ctrl+K palette). */
        async addFromText(text) {
            await load();
            quickInput.value = text;
            renderQuickPreview();
            await quickAdd();
        },
        /** Opens a task's detail panel by id (used by the bell and by links). */
        async openById(id) {
            await load();
            if (findItem(id)) {
                if (state.view !== 'all' && !state.project) await setView('all');
                openDetail(id);
            }
        }
    };
})();
