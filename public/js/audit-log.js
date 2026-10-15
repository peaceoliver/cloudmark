const auditApi = window.CloudMark.api;
const auditConfig = window.CloudMark.config;

/** Hungarian labels for the audit actions the server records; unknown actions fall back to their raw key. */
const AUDIT_ACTION_LABELS = {
    login: 'Bejelentkezés',
    user_registered: 'Regisztráció',
    admin_user_status_updated: 'Felhasználó státusz módosítva',
    team_created: 'Csapat létrehozva',
    team_left: 'Csapat elhagyva',
    team_deleted: 'Csapat törölve',
    team_member_updated: 'Csapattag hozzáadva/módosítva',
    team_member_role_changed: 'Csapattag szerepköre módosítva',
    team_member_removed: 'Csapattag eltávolítva',
    team_owner_transferred: 'Csapat tulajdonjog átadva',
    bookmark_created: 'Könyvjelző létrehozva',
    bookmark_updated: 'Könyvjelző módosítva',
    bookmark_trashed: 'Könyvjelző kukába helyezve',
    bookmark_state_updated: 'Könyvjelző állapota módosítva',
    bookmark_deleted_permanent: 'Könyvjelző véglegesen törölve',
    backup_exported: 'Biztonsági mentés exportálva',
    backup_imported: 'Biztonsági mentés importálva'
};

const AUDIT_ENTITY_LABELS = {
    user: 'Felhasználó',
    team: 'Csapat',
    team_member: 'Csapattag',
    bookmark: 'Könyvjelző',
    backup: 'Mentés'
};

const auditState = { page: 1, pageSize: 50, totalPages: 1, filters: {} };

/** Escapes text before it is placed into innerHTML. */
function escapeAuditHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function auditActionLabel(action) {
    if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
    if (action && action.startsWith('bookmark_bulk_')) return `Tömeges művelet (${action.slice('bookmark_bulk_'.length)})`;
    return action || '-';
}

function auditEntityLabel(entityType) {
    return AUDIT_ENTITY_LABELS[entityType] || entityType || '-';
}

/** Applies the theme the main app saved, so this page matches it. */
function applyAuditTheme() {
    const saved = localStorage.getItem(auditConfig.storageKeys.theme) ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', saved);
}

/** Reads page, page size and filters from the address bar so a filtered view can be bookmarked or shared. */
function readAuditStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    auditState.page = Math.max(1, parseInt(params.get('page'), 10) || 1);
    const size = parseInt(params.get('pageSize'), 10);
    if ([25, 50, 100].includes(size)) auditState.pageSize = size;
    auditState.filters = {};
    ['q', 'user', 'action', 'entityType', 'from', 'to'].forEach(key => {
        if (params.get(key)) auditState.filters[key] = params.get(key);
    });
}

function writeAuditStateToUrl() {
    const params = new URLSearchParams(auditState.filters);
    if (auditState.page > 1) params.set('page', auditState.page);
    if (auditState.pageSize !== 50) params.set('pageSize', auditState.pageSize);
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

function syncAuditFormFromState() {
    const form = document.getElementById('auditFilterForm');
    ['q', 'user', 'action', 'entityType', 'from', 'to'].forEach(key => {
        form.elements[key].value = auditState.filters[key] || '';
    });
    document.getElementById('auditPageSize').value = String(auditState.pageSize);
}

function fillAuditSelect(select, values, labelFn) {
    const current = select.value;
    select.innerHTML = '<option value="">Mind</option>' + values
        .map(value => `<option value="${escapeAuditHtml(value)}">${escapeAuditHtml(labelFn(value))}</option>`)
        .join('');
    select.value = current;
}

function formatAuditDetails(details) {
    if (details === null || details === undefined || details === '') return '';
    return typeof details === 'object' ? JSON.stringify(details) : String(details);
}

function renderAuditRows(items) {
    const body = document.getElementById('auditTableBody');
    if (!items.length) {
        body.innerHTML = '<tr><td colspan="5" class="audit-muted" style="padding: 1rem;">Nincs a szűrésnek megfelelő esemény.</td></tr>';
        return;
    }
    body.innerHTML = items.map(event => {
        const details = formatAuditDetails(event.details);
        const pretty = event.details && typeof event.details === 'object' ? JSON.stringify(event.details, null, 2) : details;
        const actor = event.actor_username || (event.user_id ? `#${event.user_id} (törölt)` : 'Rendszer');
        const entity = auditEntityLabel(event.entity_type) + (event.entity_id ? ` #${event.entity_id}` : '');
        return `
            <tr class="audit-row" data-event-id="${escapeAuditHtml(event.id)}">
                <td style="white-space: nowrap;">${event.created_at ? escapeAuditHtml(new Date(event.created_at).toLocaleString('hu-HU')) : '-'}</td>
                <td>${escapeAuditHtml(actor)}</td>
                <td>${escapeAuditHtml(auditActionLabel(event.action))}<div class="audit-code">${escapeAuditHtml(event.action)}</div></td>
                <td>${escapeAuditHtml(entity)}</td>
                <td><div class="audit-details-preview audit-code">${escapeAuditHtml(details || '-')}</div></td>
            </tr>
            <tr class="audit-details-full" data-details-for="${escapeAuditHtml(event.id)}" hidden>
                <td colspan="5"><pre>${escapeAuditHtml(pretty || 'Nincs további részlet.')}</pre></td>
            </tr>`;
    }).join('');
}

function renderAuditPager(data) {
    const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
    const to = Math.min(data.page * data.pageSize, data.total);
    document.getElementById('auditSummary').textContent = `${data.total} esemény, ebből ${from}–${to} látható`;
    document.getElementById('auditPageInfo').textContent = `${data.page}. oldal / ${data.totalPages}`;
    document.getElementById('auditFirstPage').disabled = data.page <= 1;
    document.getElementById('auditPrevPage').disabled = data.page <= 1;
    document.getElementById('auditNextPage').disabled = data.page >= data.totalPages;
    document.getElementById('auditLastPage').disabled = data.page >= data.totalPages;
}

async function loadAuditPage() {
    document.getElementById('auditSummary').textContent = 'Betöltés…';
    try {
        const data = await auditApi.getAuditLogPage({ ...auditState.filters, page: auditState.page, pageSize: auditState.pageSize });
        // A filter change can shrink the result set below the current page; jump to the last page instead of showing nothing.
        if (data.total && auditState.page > data.totalPages) {
            auditState.page = data.totalPages;
            return loadAuditPage();
        }
        auditState.totalPages = data.totalPages;
        renderAuditRows(data.items);
        renderAuditPager(data);
        writeAuditStateToUrl();
    } catch (err) {
        document.getElementById('auditSummary').textContent = 'Hiba a betöltéskor.';
        showNotification(err.message || 'Az audit log nem tölthető be.', 'error');
    }
}

function goToAuditPage(page) {
    auditState.page = Math.min(Math.max(1, page), auditState.totalPages);
    loadAuditPage();
}

function bindAuditEvents() {
    const form = document.getElementById('auditFilterForm');
    form.addEventListener('submit', event => {
        event.preventDefault();
        const filters = {};
        new FormData(form).forEach((value, key) => {
            const trimmed = String(value).trim();
            if (trimmed) filters[key] = trimmed;
        });
        auditState.filters = filters;
        auditState.page = 1;
        loadAuditPage();
    });
    document.getElementById('auditFilterReset').addEventListener('click', () => {
        form.reset();
        auditState.filters = {};
        auditState.page = 1;
        loadAuditPage();
    });
    ['auditFilterAction', 'auditFilterEntity'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => form.requestSubmit());
    });
    document.getElementById('auditPageSize').addEventListener('change', event => {
        auditState.pageSize = parseInt(event.target.value, 10) || 50;
        auditState.page = 1;
        loadAuditPage();
    });
    document.getElementById('auditFirstPage').addEventListener('click', () => goToAuditPage(1));
    document.getElementById('auditPrevPage').addEventListener('click', () => goToAuditPage(auditState.page - 1));
    document.getElementById('auditNextPage').addEventListener('click', () => goToAuditPage(auditState.page + 1));
    document.getElementById('auditLastPage').addEventListener('click', () => goToAuditPage(auditState.totalPages));
    document.getElementById('auditTableBody').addEventListener('click', event => {
        const row = event.target.closest('tr.audit-row');
        if (!row) return;
        const detailRow = document.querySelector(`tr[data-details-for="${CSS.escape(row.dataset.eventId)}"]`);
        if (detailRow) detailRow.hidden = !detailRow.hidden;
    });
}

async function initAuditLogPage() {
    applyAuditTheme();
    let user = null;
    try {
        user = await auditApi.getCurrentUser();
    } catch (err) {
        user = null;
    }
    if (!user || !user.isSuperuser) {
        document.getElementById('auditForbidden').hidden = false;
        return;
    }
    document.getElementById('auditContent').hidden = false;
    readAuditStateFromUrl();
    bindAuditEvents();
    try {
        const facets = await auditApi.getAuditLogFacets();
        fillAuditSelect(document.getElementById('auditFilterAction'), facets.actions, auditActionLabel);
        fillAuditSelect(document.getElementById('auditFilterEntity'), facets.entityTypes, auditEntityLabel);
    } catch (err) {
        showNotification(err.message || 'A szűrők nem tölthetők be.', 'error');
    }
    syncAuditFormFromState();
    loadAuditPage();
}

initAuditLogPage();
