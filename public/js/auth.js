const authConfig = window.CloudMark && window.CloudMark.config ? window.CloudMark.config : {};
let isRegisterMode = false;
let loadedAppConfig = { sessionDays: 30, verificationMinutes: 30, requireEmailVerification: true };
let teamsFeatureEnabled = true;

/** Shows/hides Team-related menu items based on the admin-controlled teamsEnabled setting. */
function applyTeamsFeatureVisibility() {
    document.querySelectorAll('.team-feature').forEach(el => {
        el.style.display = teamsFeatureEnabled ? '' : 'none';
    });
}

/** Switches the authentication modal between login and registration. */
function toggleAuthMode(event) {
    event.preventDefault(); isRegisterMode = !isRegisterMode;
    document.getElementById('emailGroup').style.display = isRegisterMode ? 'flex' : 'none';
    document.getElementById('authModalTitle').innerHTML = isRegisterMode ? '<i class="fa-solid fa-user-plus"></i> Regisztráció' : '<i class="fa-solid fa-user-lock"></i> Bejelentkezés';
    document.getElementById('authSubmitBtn').textContent = isRegisterMode ? 'Regisztráció és Aktiválás' : 'Bejelentkezés';
    document.getElementById('authToggleText').textContent = isRegisterMode ? 'Már van fiókod?' : 'Még nincs fiókod?';
    document.getElementById('authToggleLink').textContent = isRegisterMode ? 'Bejelentkezés' : 'Regisztráció';
}

/** Stores the local session and refreshes user-dependent UI. */
function buildVerificationFallbackMessage(result) {
    const fallbackUrl = result && result.verificationUrl ? result.verificationUrl : null;
    if (!fallbackUrl) return 'A megerősítő e-mail nem érkezett meg. Ellenőrizd a Spam mappát, vagy kérj új megerősítő linket.';
    return `A megerősítő e-mail nem érkezett meg. A linket itt tudod megnyitni: <a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer">Megerősítés</a>.`;
}

async function loginUser(username, password) {
    try {
        currentUser = await api.login(username, password);
    } catch (err) {
        if (err.message === 'Előbb erősítsd meg az e-mail címedet.') {
            const resend = confirm('A felhasználó még nincs megerősítve. Újraküldjem a megerősítő e-mailt?');
            if (resend) {
                try {
                    const resendResult = await api.resendVerification(username);
                    const message = resendResult.emailSent
                        ? 'Az új megerősítő e-mailt sikeresen elküldtük.'
                        : buildVerificationFallbackMessage(resendResult);
                    showNotification(message, resendResult.emailSent ? 'success' : 'info', 10000);
                } catch (resendError) {
                    showNotification(resendError.message || 'Az e-mail újraküldése nem sikerült.', 'error');
                }
            }
            return;
        }
        showNotification(err.message || 'A bejelentkezés nem sikerült.', 'error');
        return;
    }
    closeModal('authModal');
    activeCategoryFilter = 'All';
    await loadUserSettings();
    await loadCategoriesFromServer();
    await loadBookmarksFromServer();
    updateUserUI(); renderCategories(); renderBookmarks(); showNotification('Sikeres bejelentkezés.', 'success');
}

/** Clears the local session and restores the public view. */
async function logoutUser() {
    try { await api.logout(); } catch (err) { console.warn('Logout failed:', err); }
    currentUser = null;
    activeCategoryFilter = 'All';
    await loadCategoriesFromServer(); await loadBookmarksFromServer();
    updateUserUI(); renderCategories(); renderBookmarks(); showNotification('Sikeresen kijelentkeztél.', 'success');
}

/** Shows/hides elements that only make sense for logged-in users (management tools, bulk actions, state filters). */
function updateAuthOnlyVisibility() {
    const visible = !!currentUser;
    document.querySelectorAll('.auth-only').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
}

/** Renders the current login state in the navigation area. */
function updateUserUI() {
    const area = document.getElementById('userStateArea');
    updateAuthOnlyVisibility();
    if (!currentUser) { area.innerHTML = '<button class="btn btn-primary" onclick="openModal(\'authModal\')"><i class="fa-solid fa-user"></i> Bejelentkezés / Regisztráció</button>'; return; }
    const admin = currentUser.isSuperuser
        ? '<div style="display:flex; align-items:center; gap:0.5rem;"><button class="btn btn-admin" onclick="openAdminPanel()"><i class="fa-solid fa-shield-halved"></i> Admin panel</button><button class="btn btn-secondary" onclick="openAdminConfig()"><i class="fa-solid fa-sliders"></i> Beállítások</button></div>'
        : '';
    const statusClass = currentUser.isSuperuser ? 'status-admin' : 'status-verified';
    const statusIcon = currentUser.isSuperuser ? 'fa-crown' : 'fa-check-circle';
    area.innerHTML = `<div style="display:flex; align-items:center; gap:0.5rem;">${admin}<span class="status-badge ${statusClass}"><i class="fa-solid ${statusIcon}"></i> ${currentUser.username}</span><button class="btn-icon logout-btn" onclick="logoutUser()" title="Kilépés"><i class="fa-solid fa-right-from-bracket"></i></button></div>`;
    applyTeamsFeatureVisibility();
}

async function renderTeamManager() {
    try {
        const teams = await api.getTeams();
        const list = document.getElementById('teamManagerList');
        const selects = document.querySelectorAll('[data-team-manager-select]');

        const memberships = teams.length
            ? await Promise.all(teams.map(async team => {
                try {
                    return { id: team.id, members: await api.getTeamMembers(team.id) };
                } catch (err) {
                    return { id: team.id, members: [] };
                }
            }))
            : [];

        const memberMap = new Map(memberships.map(item => [item.id, item.members]));

        list.innerHTML = teams.length
            ? teams.map(team => {
                const members = memberMap.get(team.id) || [];
                const memberMarkup = members.length
                    ? members.map(member => `
                        <div class="team-member-row" style="display:flex; align-items:center; justify-content:space-between; gap:0.75rem; padding:0.5rem 0; border-top:1px solid var(--border-color);">
                            <div>
                                <strong>${member.username}</strong>
                                <div style="font-size:0.75rem; color:var(--text-secondary);">${member.user_id === team.owner_user_id ? 'Tulajdonos' : (member.role === 'team_admin' ? 'Csapat admin' : 'Tag')}</div>
                            </div>
                            <div style="display:flex; align-items:center; gap:0.5rem;">
                                ${member.user_id === team.owner_user_id ? '' : `
                                    <select onchange="changeTeamMemberRole(${team.id}, ${member.user_id}, this.value)">
                                        <option value="member" ${member.role === 'member' ? 'selected' : ''}>Tag</option>
                                        <option value="team_admin" ${member.role === 'team_admin' ? 'selected' : ''}>Csapat admin</option>
                                    </select>
                                    <button type="button" class="btn btn-danger" onclick="removeTeamMember(${team.id}, ${member.user_id})">Eltávolítás</button>
                                `}
                            </div>
                        </div>
                    `).join('')
                    : '<div class="empty-state" style="padding:0.5rem 0;">Nincs tag a csapatban.</div>';
                const isOwner = Number(team.owner_user_id) === Number(currentUser?.id);
                const isMember = members.some(member => Number(member.user_id) === Number(currentUser?.id));
                const transferableMembers = members.filter(member => Number(member.user_id) !== Number(currentUser?.id));
                let ownerActions = '';
                if (isOwner) {
                    ownerActions = `
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color);">
                            ${transferableMembers.length
                                ? `
                                    <select id="transfer-owner-${team.id}" style="min-width: 160px;">
                                        ${transferableMembers.map(member => `<option value="${member.user_id}">${member.username}</option>`).join('')}
                                    </select>
                                    <button type="button" class="btn btn-secondary" onclick="transferTeamOwnership(${team.id}, document.getElementById('transfer-owner-${team.id}').value)">Tulajdonos átadása</button>
                                `
                                : '<span style="font-size:0.8rem; color:var(--text-secondary);">Nincs más tag, akinek átadható a csapat.</span>'}
                            <button type="button" class="btn btn-danger" onclick="deleteTeam(${team.id})">Csapat törlése</button>
                        </div>
                    `;
                } else if (isMember) {
                    ownerActions = `
                        <div style="display:flex; justify-content:flex-end; margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color);">
                            <button type="button" class="btn btn-danger" onclick="leaveTeam(${team.id})">Kilépés a csapatból</button>
                        </div>
                    `;
                } else if (currentUser?.isSuperuser) {
                    ownerActions = `
                        <div style="display:flex; justify-content:flex-end; margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color);">
                            <button type="button" class="btn btn-danger" onclick="deleteTeam(${team.id})">Csapat törlése (admin)</button>
                        </div>
                    `;
                }

                const roleBadge = isOwner
                    ? '<span class="status-badge status-admin">Tulajdonos</span>'
                    : isMember
                        ? '<span class="status-badge status-verified">Tag</span>'
                        : '<span class="status-badge" style="background: rgba(148,163,184,0.15); color: var(--text-secondary);">Nem tagja</span>';

                return `
                    <div class="admin-team-item" style="display:block; border:1px solid var(--border-color); border-radius:12px; padding:0.85rem 1rem;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.75rem; margin-bottom:0.5rem;">
                            <div>
                                <strong>${team.name}</strong><br>
                                <small style="color: var(--text-secondary);">Tulajdonos: ${team.owner_username || 'ismeretlen'} · ${members.length} tag</small>
                            </div>
                            ${roleBadge}
                        </div>
                        <div style="display:flex; flex-direction:column; gap:0.25rem;">${memberMarkup}</div>
                        ${ownerActions}
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">Még nincs csapatod. Hozz létre egyet lentebb.</div>';

        selects.forEach(select => {
            const currentValue = select.value;
            select.innerHTML = teams.length
                ? teams.map(team => `<option value="${team.id}">${team.name}</option>`).join('')
                : '<option value="">Nincs team</option>';
            if (teams.some(team => String(team.id) === String(currentValue))) select.value = currentValue;
        });
    } catch (err) {
        showNotification(err.message || 'A team adatok betöltése sikertelen.', 'error');
    }
}

async function transferTeamOwnership(teamId, userId) {
    if (!teamId || !userId) {
        showNotification('Válassz ki egy másik tagot a tulajdonjog átadásához.', 'error');
        return;
    }
    if (!confirm('Átadod a csapat tulajdonjogát a kiválasztott felhasználónak?')) return;
    try {
        await api.transferTeamOwnership(teamId, Number(userId));
        await loadCurrentUser();
        await renderTeamManager();
        updateUserUI();
        showNotification('A csapat tulajdonjoga sikeresen átadva.', 'success');
    } catch (err) {
        showNotification(err.message || 'A tulajdonjog átadása nem sikerült.', 'error');
    }
}

async function leaveTeam(teamId) {
    if (!teamId) return;
    if (!confirm('Biztosan ki szeretnél lépni ebből a csapatból?')) return;
    try {
        await api.leaveTeam(teamId);
        await loadCurrentUser();
        await renderTeamManager();
        updateUserUI();
        showNotification('Sikeresen kiléptél a csapatból.', 'success');
    } catch (err) {
        showNotification(err.message || 'A csapatból való kilépés nem sikerült.', 'error');
    }
}

async function deleteTeam(teamId) {
    if (!teamId) return;
    if (!confirm('Véglegesen törlöd ezt a csapatot? Minden tagja elveszti a hozzáférését.')) return;
    try {
        await api.deleteTeam(teamId);
        await loadCurrentUser();
        await renderTeamManager();
        updateUserUI();
        showNotification('A csapat törölve.', 'success');
    } catch (err) {
        showNotification(err.message || 'A csapat törlése nem sikerült.', 'error');
    }
}

async function changeTeamMemberRole(teamId, userId, role) {
    if (!teamId || !userId) return;
    try {
        await api.updateTeamMemberRole(teamId, userId, role);
        await renderTeamManager();
        showNotification('A csapattag szerepe frissítve.', 'success');
    } catch (err) {
        showNotification(err.message || 'A szerep frissítése nem sikerült.', 'error');
    }
}

async function removeTeamMember(teamId, userId) {
    if (!teamId || !userId) return;
    if (!confirm('El távolítod ezt a felhasználót a csapatból?')) return;
    try {
        await api.removeTeamMember(teamId, userId);
        await renderTeamManager();
        showNotification('A felhasználó eltávolítva a csapatból.', 'success');
    } catch (err) {
        showNotification(err.message || 'A tag eltávolítása nem sikerült.', 'error');
    }
}

async function openTeamManager() {
    await renderTeamManager();
    openModal('teamManagerModal');
}

async function renderAdminPanel() {
    try {
        const [auditEvents, users] = await Promise.all([api.getAuditEvents(), api.getUsers()]);
        const auditTable = document.getElementById('adminAuditEventsBody');
        const usersBody = document.getElementById('adminUsersBody');

        usersBody.innerHTML = users.length
            ? users.map(user => `
                <tr>
                    <td style="padding: 0.6rem 0.75rem;">${user.username}${user.role === 'admin' ? ' <i class="fa-solid fa-crown" title="Admin" style="color: var(--warning);"></i>' : ''}</td>
                    <td style="padding: 0.6rem 0.75rem;">${user.email || '-'}</td>
                    <td style="padding: 0.6rem 0.75rem;">${user.created_at ? new Date(user.created_at).toLocaleDateString('hu-HU') : '-'}</td>
                    <td style="padding: 0.6rem 0.75rem;"><span class="status-badge ${user.is_verified ? 'status-verified' : ''}" style="${user.is_verified ? '' : 'background: rgba(148,163,184,0.15); color: var(--text-secondary);'}">${user.is_verified ? 'Igen' : 'Nem'}</span></td>
                    <td style="padding: 0.6rem 0.75rem;"><span class="status-badge ${user.is_active ? 'status-verified' : 'status-admin'}">${user.is_active ? 'Aktív' : 'Felfüggesztve'}</span></td>
                    <td style="padding: 0.6rem 0.75rem; display:flex; gap:0.4rem; flex-wrap:wrap;">
                        ${!user.is_verified ? `<button type="button" class="btn btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.8rem;" onclick="setUserVerified(${user.id}, true)"><i class="fa-solid fa-check"></i> Aktiválás</button>` : ''}
                        ${user.role !== 'admin' ? (user.is_active
                            ? `<button type="button" class="btn btn-danger" style="padding:0.3rem 0.6rem; font-size:0.8rem;" onclick="setUserActive(${user.id}, false)"><i class="fa-solid fa-ban"></i> Deaktiválás</button>`
                            : `<button type="button" class="btn btn-secondary" style="padding:0.3rem 0.6rem; font-size:0.8rem;" onclick="setUserActive(${user.id}, true)"><i class="fa-solid fa-rotate-left"></i> Visszaállítás</button>`)
                            : ''}
                    </td>
                </tr>
            `).join('')
            : '<tr><td colspan="6" style="padding: 0.75rem;">Nincs regisztrált felhasználó.</td></tr>';

        auditTable.innerHTML = auditEvents.length
            ? auditEvents.slice(0, 25).map(event => `
                <tr>
                    <td>${event.action || '-'}</td>
                    <td>${event.actor_username || event.user_id || '-'}</td>
                    <td>${event.entity_type || '-'}</td>
                    <td>${event.created_at ? new Date(event.created_at).toLocaleString('hu-HU') : '-'}</td>
                    <td>${(event.details && typeof event.details === 'object') ? JSON.stringify(event.details).slice(0, 120) : (event.details || '-')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="5">Nincs audit event.</td></tr>';
    } catch (err) {
        showNotification(err.message || 'Az admin panel betöltése sikertelen.', 'error');
    }
}

async function openAdminPanel() {
    if (!currentUser || !currentUser.isSuperuser) {
        showNotification('Admin jogosultság szükséges a panel megnyitásához.', 'error');
        return;
    }
    await renderAdminPanel();
    openModal('adminPanelModal');
}

/** Manually verifies/activates a registered user from the admin panel. */
async function setUserVerified(userId, isVerified) {
    try {
        await api.updateUserStatus(userId, { isVerified });
        showNotification('A felhasználó állapota frissítve.', 'success');
        await renderAdminPanel();
    } catch (err) {
        showNotification(err.message || 'A művelet nem sikerült.', 'error');
    }
}

/** Activates or suspends a registered user's account from the admin panel. */
async function setUserActive(userId, isActive) {
    if (!isActive && !confirm('Biztosan felfüggeszted ezt a felhasználót? Ki fog jelentkezni minden eszközön.')) return;
    try {
        await api.updateUserStatus(userId, { isActive });
        showNotification('A felhasználó állapota frissítve.', 'success');
        await renderAdminPanel();
    } catch (err) {
        showNotification(err.message || 'A művelet nem sikerült.', 'error');
    }
}

/** Opens the user settings modal with database values and local fallbacks. */
async function openUserSettings() {
    const settings = await api.getUserSettings().catch(() => ({}));
    const titleValue = settings.fetchMetadataTitle ?? settings.fetchMetadata ?? localStorage.getItem(authConfig.storageKeys.fetchMetadataTitle) ?? 'true';
    const imageValue = settings.fetchMetadataImage ?? settings.fetchMetadata ?? localStorage.getItem(authConfig.storageKeys.fetchMetadataImage) ?? 'true';
    document.getElementById('userThemeSetting').value = settings.theme || localStorage.getItem(authConfig.storageKeys.theme) || 'dark';
    document.getElementById('userViewSetting').value = settings.viewMode || localStorage.getItem(authConfig.storageKeys.viewMode) || 'grid';
    document.getElementById('userSortSetting').value = settings.sortMode || localStorage.getItem(authConfig.storageKeys.sortMode) || 'newest';
    document.getElementById('userMetadataTitleSetting').value = String(titleValue) === 'false' ? 'false' : 'true';
    document.getElementById('userMetadataImageSetting').value = String(imageValue) === 'false' ? 'false' : 'true';
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmNewPassword').value = '';
    openModal('userSettingsModal');
}

/** Completes the simulated email activation flow. */
function confirmEmailActivation() {
    if (!document.getElementById('verifyCode').value) return;
    closeModal('verifyModal');
}

/** Shows/hides the SMTP vs. API-key fields based on the selected email provider. */
function updateEmailProviderFields() {
    const provider = document.getElementById('cfgEmailProvider').value;
    const isApi = provider === 'resend' || provider === 'sendgrid';
    document.getElementById('cfgApiKeyGroup').style.display = isApi ? '' : 'none';
    document.getElementById('cfgSmtpGroup').style.display = isApi ? 'none' : '';
}

/** Loads saved admin settings into the configuration modal. */
async function openAdminConfig() {
    try {
        const [smtp, appConfig] = await Promise.all([api.getSmtpConfig(), api.getAppConfig()]);
        document.getElementById('cfgEmailProvider').value = smtp.provider || 'smtp';
        document.getElementById('cfgEmailSender').value = smtp.from || '';
        document.getElementById('cfgEmailPassword').value = '';
        document.getElementById('cfgEmailPassword').placeholder = smtp.passwordConfigured ? 'Mentett jelszó, üresen hagyva változatlan marad' : 'SMTP jelszó';
        document.getElementById('cfgSmtpServer').value = smtp.host || '';
        document.getElementById('cfgSmtpPort').value = smtp.port || 587;
        document.getElementById('cfgEmailApiKey').value = '';
        document.getElementById('cfgEmailApiKey').placeholder = smtp.apiKeyConfigured ? 'Mentett API kulcs, üresen hagyva változatlan marad' : 'API kulcs';
        document.getElementById('cfgRequireVerification').checked = appConfig.requireEmailVerification !== false;
        document.getElementById('cfgTeamsEnabled').checked = appConfig.teamsEnabled !== false;
        document.getElementById('cfgBookmarksPerPage').value = appConfig.bookmarksPerPage || 60;
        loadedAppConfig = appConfig;
        updateEmailProviderFields();
        openModal('adminConfigModal');
    } catch (err) {
        showNotification(err.message || 'Az e-mail beállítások nem tölthetők be.', 'error');
    }
}

/** Reads the admin config form into a settings object matching the currently selected provider. */
function readEmailConfigForm() {
    const provider = document.getElementById('cfgEmailProvider').value;
    const from = document.getElementById('cfgEmailSender').value.trim();
    if (provider === 'resend' || provider === 'sendgrid') {
        return {
            provider,
            from,
            user: from,
            apiKey: document.getElementById('cfgEmailApiKey').value,
            to: from
        };
    }
    return {
        provider: 'smtp',
        from,
        user: from,
        password: document.getElementById('cfgEmailPassword').value,
        host: document.getElementById('cfgSmtpServer').value.trim(),
        port: Number(document.getElementById('cfgSmtpPort').value),
        secure: Number(document.getElementById('cfgSmtpPort').value) === 465,
        to: from
    };
}

async function testSmtpConnection() {
    try {
        const settings = readEmailConfigForm();
        const isApi = settings.provider === 'resend' || settings.provider === 'sendgrid';
        if (isApi) {
            if (!settings.from) {
                showNotification('A teszt küldéshez töltsd ki a küldő e-mail címet.', 'error');
                return;
            }
        } else if (!settings.from || !settings.user || !settings.host || !settings.port) {
            showNotification('A teszt küldéshez töltsd ki a küldő címet, SMTP szervert és portot.', 'error');
            return;
        }
        const result = await api.smtpTest(settings);
        showNotification(`Teszt e-mail sikeresen elküldve erre a címre: ${result.to}`, 'success');
    } catch (err) {
        showNotification(err.message || 'A teszt e-mail küldése nem sikerült.', 'error');
    }
}

document.getElementById('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const username = document.getElementById('authUsername').value.trim();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    try {
        if (isRegisterMode) {
            const registration = await api.register(username, email, password);
            closeModal('authModal');
            if (registration.verificationRequired === false) {
                showNotification('A regisztráció sikeres. Most már bejelentkezhetsz.', 'success');
                return;
            }
            const message = registration.emailSent
                ? 'A megerősítő e-mailt sikeresen elküldtük. Ellenőrizd a beérkező leveleket és a Spam mappát is.'
                : buildVerificationFallbackMessage(registration);
            showNotification(message, registration.emailSent ? 'success' : 'info', 10000);
            return;
        }
        await loginUser(username, password);
    } catch (err) {
        showNotification(err.message || 'A hitelesítés nem sikerült.', 'error');
    }
});

document.getElementById('smtpTestBtn').addEventListener('click', testSmtpConnection);
document.getElementById('cfgEmailProvider').addEventListener('change', updateEmailProviderFields);

document.getElementById('adminConfigForm').addEventListener('submit', async event => {
    event.preventDefault();
    const settings = readEmailConfigForm();
    const requireEmailVerification = document.getElementById('cfgRequireVerification').checked;
    const teamsEnabled = document.getElementById('cfgTeamsEnabled').checked;
    const bookmarksPerPage = Number(document.getElementById('cfgBookmarksPerPage').value);
    if (!Number.isInteger(bookmarksPerPage) || bookmarksPerPage < 5 || bookmarksPerPage > 500) {
        showNotification('A lapozáshoz megadott érték 5 és 500 között kell legyen.', 'error');
        return;
    }
    try {
        await api.saveSmtpConfig(settings);
        await api.saveAppConfig({
            sessionDays: loadedAppConfig.sessionDays || 30,
            verificationMinutes: loadedAppConfig.verificationMinutes || 30,
            requireEmailVerification,
            teamsEnabled,
            bookmarksPerPage
        });
        teamsFeatureEnabled = teamsEnabled;
        applyTeamsFeatureVisibility();
        bookmarksPerPageSetting = bookmarksPerPage;
        currentBookmarkPage = 1;
        renderBookmarks();
        closeModal('adminConfigModal');
        showNotification('E-mail beállítások sikeresen elmentve.', 'success');
    } catch (err) {
        showNotification(err.message || 'Az e-mail beállítások mentése nem sikerült.', 'error');
    }
});

document.getElementById('teamManagerCreateForm').addEventListener('submit', async event => {
    event.preventDefault();
    const teamName = document.getElementById('teamManagerName').value.trim();
    if (!teamName) {
        showNotification('A csapat neve kötelező.', 'error');
        return;
    }
    try {
        await api.createTeam(teamName);
        document.getElementById('teamManagerName').value = '';
        await renderTeamManager();
        showNotification('A csapat létrehozva.', 'success');
    } catch (err) {
        showNotification(err.message || 'A csapat létrehozása nem sikerült.', 'error');
    }
});

document.getElementById('teamManagerMemberForm').addEventListener('submit', async event => {
    event.preventDefault();
    const teamId = document.getElementById('teamManagerSelect').value;
    const username = document.getElementById('teamManagerUsername').value.trim();
    const role = document.getElementById('teamManagerRole').value;
    if (!teamId || !username) {
        showNotification('Válassz ki egy csapatot és adj meg felhasználónevet.', 'error');
        return;
    }
    try {
        await api.addTeamMember(Number(teamId), username, role);
        document.getElementById('teamManagerUsername').value = '';
        await renderTeamManager();
        showNotification('A felhasználó hozzáadva a csapathoz.', 'success');
    } catch (err) {
        showNotification(err.message || 'A felhasználó hozzáadása nem sikerült.', 'error');
    }
});

document.getElementById('adminBackupExportBtn').addEventListener('click', async () => {
    try {
        const blob = await api.exportBackup();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'cloudmark-backup.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showNotification('A biztonsági mentés letöltve.', 'success');
    } catch (err) {
        showNotification(err.message || 'A mentés letöltése nem sikerült.', 'error');
    }
});

document.getElementById('adminBackupImportInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        await api.importBackup(payload);
        event.target.value = '';
        await renderAdminPanel();
        showNotification('A mentés importálva.', 'success');
    } catch (err) {
        showNotification(err.message || 'A mentés importálása nem sikerült.', 'error');
    }
});

document.getElementById('userSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmation = document.getElementById('confirmNewPassword').value;
    const theme = document.getElementById('userThemeSetting').value;
    const viewMode = document.getElementById('userViewSetting').value;
    const sortMode = document.getElementById('userSortSetting').value;
    const metadataTitleSetting = document.getElementById('userMetadataTitleSetting').value;
    const metadataImageSetting = document.getElementById('userMetadataImageSetting').value;
    const combinedMetadataSetting = metadataTitleSetting === 'false' && metadataImageSetting === 'false' ? 'false' : 'true';
    if (newPassword && currentPassword.length < 4) {
        showNotification('Jelszócseréhez add meg a jelenlegi jelszavadat.', 'error');
        return;
    }
    if (newPassword && newPassword !== confirmation) {
        showNotification('Az új jelszavak nem egyeznek.', 'error');
        return;
    }
    try {
        if (newPassword) await api.changePassword(currentPassword, newPassword);
        await Promise.all([
            api.saveUserSetting('theme', theme),
            api.saveUserSetting('viewMode', viewMode),
            api.saveUserSetting('sortMode', sortMode),
            api.saveUserSetting('fetchMetadataTitle', metadataTitleSetting),
            api.saveUserSetting('fetchMetadataImage', metadataImageSetting),
            api.saveUserSetting('fetchMetadata', combinedMetadataSetting)
        ]);
        localStorage.setItem(authConfig.storageKeys.theme, theme);
        localStorage.setItem(authConfig.storageKeys.viewMode, viewMode);
        localStorage.setItem(authConfig.storageKeys.sortMode, sortMode);
        localStorage.setItem(authConfig.storageKeys.fetchMetadataTitle, metadataTitleSetting);
        localStorage.setItem(authConfig.storageKeys.fetchMetadataImage, metadataImageSetting);
        localStorage.setItem(authConfig.storageKeys.fetchMetadata, combinedMetadataSetting);
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeIcon(theme);
        currentSortMode = sortMode;
        setBookmarkView(viewMode);
        renderBookmarks();
        closeModal('userSettingsModal');
        showNotification('A beállítások és a jelszó sikeresen elmentve.', 'success');
    } catch (err) {
        showNotification(err.message || 'A beállítások mentése nem sikerült.', 'error');
    }
});

window.toggleAuthMode = toggleAuthMode; window.confirmEmailActivation = confirmEmailActivation;
window.loginUser = loginUser; window.logoutUser = logoutUser; window.openAdminConfig = openAdminConfig;
window.openAdminPanel = openAdminPanel; window.openTeamManager = openTeamManager; window.changeTeamMemberRole = changeTeamMemberRole; window.removeTeamMember = removeTeamMember; window.transferTeamOwnership = transferTeamOwnership; window.leaveTeam = leaveTeam; window.deleteTeam = deleteTeam; window.openUserSettings = openUserSettings;
window.setUserVerified = setUserVerified; window.setUserActive = setUserActive;
