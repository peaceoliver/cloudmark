const config = window.CloudMark && window.CloudMark.config ? window.CloudMark.config : {};
let isRegisterMode = false;

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
async function loginUser(username, password) {
    try {
        currentUser = await api.login(username, password);
    } catch (err) {
        if (err.message === 'Előbb erősítsd meg az e-mail címedet.') {
            const resend = confirm('A felhasználó még nincs megerősítve. Újraküldjem a megerősítő e-mailt?');
            if (resend) {
                try {
                    const resendResult = await api.resendVerification(username);
                    showNotification(
                        resendResult.emailSent
                            ? 'Az új megerősítő e-mailt sikeresen elküldtük.'
                            : 'Fejlesztői módban nincs SMTP-küldés. A megerősítő link a szerver naplójában található.',
                        resendResult.emailSent ? 'success' : 'info'
                    );
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
    await loadUserSettings();
    await loadCategoriesFromServer();
    await loadBookmarksFromServer();
    updateUserUI(); renderCategories(); renderBookmarks(); showNotification('Sikeres bejelentkezés.', 'success');
}

/** Clears the local session and restores the public view. */
async function logoutUser() {
    try { await api.logout(); } catch (err) { console.warn('Logout failed:', err); }
    currentUser = null;
    await loadCategoriesFromServer(); await loadBookmarksFromServer();
    updateUserUI(); renderCategories(); renderBookmarks(); showNotification('Sikeresen kijelentkeztél.', 'success');
}

/** Renders the current login state in the navigation area. */
function updateUserUI() {
    const area = document.getElementById('userStateArea');
    if (!currentUser) { area.innerHTML = '<button class="btn btn-primary" onclick="openModal(\'authModal\')"><i class="fa-solid fa-user"></i> Bejelentkezés / Regisztráció</button>'; return; }
    const admin = currentUser.isSuperuser ? '<button class="btn btn-admin" onclick="openAdminConfig()"><i class="fa-solid fa-sliders"></i> Rendszerbeállítások (Admin)</button>' : '';
    const statusClass = currentUser.isSuperuser ? 'status-admin' : 'status-verified';
    const statusIcon = currentUser.isSuperuser ? 'fa-crown' : 'fa-check-circle';
    area.innerHTML = `<div style="display:flex; align-items:center; gap:0.75rem;">${admin}<button class="btn-icon" onclick="openUserSettings()" title="Felhasználói beállítások"><i class="fa-solid fa-user-gear"></i></button><span class="status-badge ${statusClass}"><i class="fa-solid ${statusIcon}"></i> ${currentUser.username}</span><button class="btn btn-danger" onclick="logoutUser()"> <i class="fa-solid fa-right-from-bracket"></i> Kilépés</button></div>`;
}

/** Opens the user settings modal with database values and local fallbacks. */
async function openUserSettings() {
    const settings = await api.getUserSettings().catch(() => ({}));
    const titleValue = settings.fetchMetadataTitle ?? settings.fetchMetadata ?? localStorage.getItem(config.storageKeys.fetchMetadataTitle) ?? 'true';
    const imageValue = settings.fetchMetadataImage ?? settings.fetchMetadata ?? localStorage.getItem(config.storageKeys.fetchMetadataImage) ?? 'true';
    document.getElementById('userThemeSetting').value = settings.theme || localStorage.getItem(config.storageKeys.theme) || 'dark';
    document.getElementById('userViewSetting').value = settings.viewMode || localStorage.getItem(config.storageKeys.viewMode) || 'grid';
    document.getElementById('userSortSetting').value = settings.sortMode || localStorage.getItem(config.storageKeys.sortMode) || 'newest';
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

/** Loads saved admin settings into the configuration modal. */
async function openAdminConfig() {
    try {
        const smtp = await api.getSmtpConfig();
        document.getElementById('cfgEmailSender').value = smtp.from || '';
        document.getElementById('cfgEmailPassword').value = '';
        document.getElementById('cfgEmailPassword').placeholder = smtp.passwordConfigured ? 'Mentett jelszó, üresen hagyva változatlan marad' : 'SMTP jelszó';
        document.getElementById('cfgSmtpServer').value = smtp.host || '';
        document.getElementById('cfgSmtpPort').value = smtp.port || 587;
        openModal('adminConfigModal');
    } catch (err) {
        showNotification(err.message || 'Az SMTP beállítások nem tölthetők be.', 'error');
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
            const message = registration.emailSent
                ? 'A megerősítő e-mailt sikeresen elküldtük. Ellenőrizd a beérkező leveleket és a Spam mappát is.'
                : 'A felhasználó létrejött, de fejlesztői módban nincs SMTP-küldés. A megerősítő link a szerver naplójában található.';
            showNotification(message, registration.emailSent ? 'success' : 'info', 10000);
            return;
        }
        await loginUser(username, password);
    } catch (err) {
        showNotification(err.message || 'A hitelesítés nem sikerült.', 'error');
    }
});

document.getElementById('adminConfigForm').addEventListener('submit', async event => {
    event.preventDefault();
    const settings = {
        from: document.getElementById('cfgEmailSender').value.trim(),
        user: document.getElementById('cfgEmailSender').value.trim(),
        password: document.getElementById('cfgEmailPassword').value,
        host: document.getElementById('cfgSmtpServer').value.trim(),
        port: Number(document.getElementById('cfgSmtpPort').value),
        secure: Number(document.getElementById('cfgSmtpPort').value) === 465
    };
    try {
        await api.saveSmtpConfig(settings);
        closeModal('adminConfigModal');
        showNotification('SMTP beállítások sikeresen elmentve.', 'success');
    } catch (err) {
        showNotification(err.message || 'Az SMTP beállítások mentése nem sikerült.', 'error');
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
        localStorage.setItem(config.storageKeys.theme, theme);
        localStorage.setItem(config.storageKeys.viewMode, viewMode);
        localStorage.setItem(config.storageKeys.sortMode, sortMode);
        localStorage.setItem(config.storageKeys.fetchMetadataTitle, metadataTitleSetting);
        localStorage.setItem(config.storageKeys.fetchMetadataImage, metadataImageSetting);
        localStorage.setItem(config.storageKeys.fetchMetadata, combinedMetadataSetting);
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
window.openUserSettings = openUserSettings;
