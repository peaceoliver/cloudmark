/*
 * Megosztás ablak (#shareModal): a tulajdonos e-mail címmel vagy ismerősnek osztja meg az elemet, látja és módosítja,
 * kivel osztotta meg; a címzett látja, ki osztotta meg vele, és kiveheti a listájából. A nézetek a
 * CloudMark.share.open(item, { onChange, onLeft }) hívással nyitják meg, a kártyák jelvényét a badgeHtml() adja.
 */
(function () {
    const shareApi = window.CloudMark.api;
    const modal = document.getElementById('shareModal');
    const body = document.getElementById('shareBody');
    const subtitle = document.getElementById('shareItemTitle');
    if (!modal || !body) return;

    const PERMISSION_LABELS = { view: 'Megtekintheti', edit: 'Szerkesztheti' };
    const TYPE_LABELS = { note: 'jegyzet', task: 'feladat', command: 'parancs' };
    let current = null;

    function esc(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (typeof showNotification === 'function') showNotification(esc(message), type);
    }

    function itemTitle(item) {
        const text = String(item.title || item.body || '').replace(/\s+/g, ' ').trim();
        return text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : `Névtelen ${TYPE_LABELS[item.type] || 'elem'}`;
    }

    /** Whether the signed-in user owns the item (items loaded before sharing existed count as own). */
    function isOwn(item) {
        return !item?.access || item.access === 'owner';
    }

    /** Small card badge: „Megosztotta: anna” for a recipient, „Megosztva: 2” for the owner. */
    function badgeHtml(item) {
        if (!item) return '';
        if (!isOwn(item)) {
            return `<span class="share-badge" title="${esc(`Megosztotta: ${item.shared_by || 'ismeretlen'} · ${item.access === 'edit' ? 'szerkesztheted' : 'csak megtekintheted'}`)}">`
                + `<i class="fa-solid fa-user-group" aria-hidden="true"></i> ${esc(item.shared_by || 'Megosztott')}${item.access === 'view' ? ' <i class="fa-solid fa-eye" aria-label="csak megtekintés"></i>' : ''}</span>`;
        }
        return item.share_count ? `<span class="share-badge is-own" title="Megosztva ${item.share_count} személlyel"><i class="fa-solid fa-user-group" aria-hidden="true"></i> ${Number(item.share_count)}</span>` : '';
    }

    function permissionOptions(selected) {
        return Object.entries(PERMISSION_LABELS).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
    }

    function ownerHtml(shares, contacts) {
        const sharedIds = new Set(shares.map(share => share.username).filter(Boolean));
        const suggestions = contacts.filter(contact => !sharedIds.has(contact.username));
        return `
            <form class="share-form" data-share-form>
                <label for="shareEmail">Kivel osztod meg?</label>
                <div class="share-form-row">
                    <input type="email" id="shareEmail" maxlength="255" placeholder="E-mail cím" autocomplete="email" required>
                    <select id="sharePermission" aria-label="Jogosultság">${permissionOptions('view')}</select>
                    <button type="submit" class="btn btn-primary"><i class="fa-solid fa-paper-plane"></i> Megosztás</button>
                </div>
                ${suggestions.length ? `<div class="share-contacts" aria-label="Ismerősök">
                    <span class="share-contacts-label">Ismerősök:</span>
                    ${suggestions.map(contact => `<button type="button" class="category-chip" data-share-contact="${Number(contact.userId)}"><i class="fa-solid fa-user"></i> ${esc(contact.username)}</button>`).join('')}
                </div>` : ''}
                <p class="share-hint">A címzett a csengőnél fogadja el, utána a saját listájában látja. Ha az e-mail címhez még nincs fiók, a megosztás a regisztrációja után jelenik meg nála.</p>
            </form>
            <div class="section-divider">Megosztva</div>
            <div class="share-list">
                ${shares.length ? shares.map(share => `
                    <div class="share-row" data-share-id="${Number(share.id)}">
                        <span class="share-person">
                            <i class="fa-solid ${share.username ? 'fa-user' : 'fa-envelope'}" aria-hidden="true"></i>
                            <span><strong>${esc(share.username || share.email)}</strong>${share.username ? `<small>${esc(share.email)}</small>` : ''}</span>
                            ${share.status === 'pending' ? '<span class="share-pending">Függőben</span>' : ''}
                        </span>
                        <select data-share-permission aria-label="Jogosultság">${permissionOptions(share.permission)}</select>
                        <button type="button" class="btn-icon" data-share-remove title="Megosztás visszavonása" aria-label="Megosztás visszavonása"><i class="fa-solid fa-xmark"></i></button>
                    </div>`).join('') : '<div class="share-empty">Még senkivel nincs megosztva.</div>'}
            </div>`;
    }

    function recipientHtml(info) {
        return `
            <div class="share-received">
                <p><i class="fa-solid fa-user-group"></i> <strong>${esc(info.sharedBy || 'Valaki')}</strong> osztotta meg veled.
                ${info.access === 'edit' ? 'Szerkesztheted is.' : 'Csak megtekintheted.'}</p>
                ${info.viaParent
                    ? '<p class="share-hint">Ez egy megosztott feladat részfeladata, a szülőfeladattal együtt látod.</p>'
                    : `<p class="share-hint">A kategóriát, a rögzítést és az archívumot magadnak állítod, a tulajdonosnál nem változik. Törölni és továbbosztani csak a tulajdonos tud.</p>
                       <button type="button" class="btn btn-danger" data-share-leave><i class="fa-solid fa-right-from-bracket"></i> Eltávolítás a listámból</button>`}
            </div>`;
    }

    async function render() {
        const item = current.item;
        subtitle.textContent = itemTitle(item);
        body.innerHTML = '<div class="share-empty">Betöltés…</div>';
        try {
            const info = await shareApi.getShares(item.id);
            if (!current || current.item !== item) return;
            current.info = info;
            if (info.access !== 'owner') {
                body.innerHTML = recipientHtml(info);
                return;
            }
            current.contacts = current.contacts || await shareApi.getContacts().catch(() => []);
            body.innerHTML = ownerHtml(info.shares, current.contacts);
        } catch (err) {
            body.innerHTML = `<div class="share-empty">${esc(err.message || 'A megosztások betöltése nem sikerült.')}</div>`;
        }
    }

    /** Re-renders the owner's list after a change and tells the view the new count. */
    function applyShares(shares) {
        current.info.shares = shares;
        current.item.share_count = shares.length;
        body.innerHTML = ownerHtml(shares, current.contacts || []);
        current.onChange?.(current.item);
    }

    async function share(recipient) {
        const permission = body.querySelector('#sharePermission')?.value || 'view';
        const button = body.querySelector('[data-share-form] button[type="submit"]');
        if (button) button.disabled = true;
        try {
            const result = await shareApi.shareItem(current.item.id, recipient, permission);
            applyShares(result.shares);
            notify(result.message || 'Megosztás elküldve.', 'success');
            body.querySelector('#shareEmail')?.focus();
        } catch (err) {
            notify(err.message || 'A megosztás nem sikerült.', 'error');
            if (button) button.disabled = false;
        }
    }

    body.addEventListener('submit', event => {
        if (!event.target.matches('[data-share-form]')) return;
        event.preventDefault();
        const email = body.querySelector('#shareEmail').value.trim();
        if (email) share({ email });
    });

    body.addEventListener('click', async event => {
        const contact = event.target.closest('[data-share-contact]');
        if (contact) { share({ contactUserId: Number(contact.dataset.shareContact) }); return; }
        const remove = event.target.closest('[data-share-remove]');
        if (remove) {
            const row = remove.closest('[data-share-id]');
            if (!confirm('Visszavonod a megosztást? A címzett listájából eltűnik az elem.')) return;
            try {
                applyShares((await shareApi.deleteShare(row.dataset.shareId)).shares);
                notify('Megosztás visszavonva.', 'success');
            } catch (err) {
                notify(err.message || 'A visszavonás nem sikerült.', 'error');
            }
            return;
        }
        if (event.target.closest('[data-share-leave]')) {
            if (!confirm('Kiveszed a listádból? A tulajdonosnál megmarad, és újra megoszthatja veled.')) return;
            try {
                await shareApi.deleteShare(current.info.shareId);
                const { item, onLeft } = current;
                close();
                onLeft?.(item);
                notify('Eltávolítva a listádból.', 'success');
            } catch (err) {
                notify(err.message || 'Nem sikerült.', 'error');
            }
        }
    });

    body.addEventListener('change', async event => {
        const select = event.target.closest('[data-share-permission]');
        if (!select) return;
        try {
            applyShares((await shareApi.updateShare(select.closest('[data-share-id]').dataset.shareId, select.value)).shares);
            notify('Jogosultság módosítva.', 'success');
        } catch (err) {
            notify(err.message || 'A módosítás nem sikerült.', 'error');
        }
    });

    modal.querySelector('[data-share-close]')?.addEventListener('click', () => close());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && current && modal.classList.contains('active')) close();
    });

    function close() {
        current = null;
        closeModal('shareModal');
    }

    /**
     * Opens the window for an item. `onChange(item)` runs when the owner's share count changes,
     * `onLeft(item)` when the recipient removed it from their list.
     */
    function open(item, { onChange, onLeft } = {}) {
        if (!item?.id) return;
        current = { item, onChange, onLeft, info: null, contacts: null };
        openModal('shareModal');
        render();
    }

    /**
     * Removes a shared item from the recipient's list after asking (used by the views' delete buttons).
     * Resolves to true when it was removed.
     */
    async function leave(item) {
        if (!confirm('Ezt az elemet megosztották veled. Kiveszed a listádból? A tulajdonosnál megmarad.')) return false;
        try {
            await shareApi.trashItem(item.id);
            notify('Eltávolítva a listádból.', 'success');
            return true;
        } catch (err) {
            notify(err.message || 'Nem sikerült.', 'error');
            return false;
        }
    }

    window.CloudMark.share = { open, leave, badgeHtml, isOwn };
})();
