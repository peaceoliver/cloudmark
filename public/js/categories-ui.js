/** Renders category filters and the bookmark category select. */
function renderCategories() {
    const container = document.getElementById('categoriesBar');
    const select = document.getElementById('bmCategory');
    const visible = !currentUser && categories.includes('MAIN') ? ['MAIN'] : categories;
    if (!currentUser && categories.includes('MAIN') && activeCategoryFilter !== 'MAIN') {
        activeCategoryFilter = 'MAIN';
    } else if (!currentUser && !categories.includes('MAIN') && activeCategoryFilter === 'MAIN') {
        activeCategoryFilter = 'All';
    }
    container.innerHTML = `<button class="category-chip ${activeCategoryFilter === 'All' ? 'active' : ''}" onclick="filterCategory('All')">Összes</button>`;
    if (select) select.innerHTML = '';
    const manageButton = document.getElementById('manageCategoriesBtn');
    if (manageButton) {
        manageButton.style.display = currentUser ? '' : 'none';
        manageButton.onclick = () => { openModal('categoryModal'); renderManageCategoriesList(); };
    }
    visible.forEach(category => {
        if (select) select.append(new Option(category, category));
        const button = document.createElement('button');
        button.className = `category-chip ${activeCategoryFilter === category ? 'active' : ''}`;
        button.innerHTML = `<i class="fa-solid fa-folder"></i> ${category}`;
        button.onclick = () => filterCategory(category);
        container.appendChild(button);
    });
}

/** Selects a category filter and refreshes the bookmark view. */
function filterCategory(category) {
    activeCategoryFilter = category;
    renderCategories();
    renderBookmarks();
}

/** Renders category management actions inside the category modal. */
function renderManageCategoriesList() {
    const container = document.getElementById('manageCategoriesList');
    if (!container) return;
    container.innerHTML = '';
    categories.forEach(category => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:0.5rem 0.75rem; border-radius:8px; border:1px solid var(--border-color);';
        row.innerHTML = `<span style="font-weight:600">${category}</span>`;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex; gap:0.4rem;';
        if (category !== 'Inbox') {
            actions.innerHTML = '<button class="action-btn" title="Átnevezés"><i class="fa-solid fa-pen"></i></button><button class="action-btn" title="Törlés"><i class="fa-solid fa-trash"></i></button>';
            actions.children[0].onclick = () => renameCategory(category);
            actions.children[1].onclick = () => deleteCategory(category);
        } else actions.innerHTML = '<span style="font-size:0.75rem; color:var(--text-secondary)">Alapértelmezett</span>';
        row.appendChild(actions); container.appendChild(row);
    });
}

/** Renames a category through the API and refreshes dependent views. */
async function renameCategory(oldName) {
    const newName = prompt(`Add meg a(z) "${oldName}" kategória új nevét:`, oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    if (categories.includes(newName.trim())) { showNotification('Ez a kategória már létezik.', 'error'); return; }
    try { await api.renameCategory(oldName, newName.trim()); await loadCategoriesFromServer(); await loadBookmarksFromServer(); renderCategories(); renderManageCategoriesList(); renderBookmarks(); showNotification('A kategória átnevezve.', 'success'); }
    catch (err) { showNotification('Nem sikerült átnevezni a kategóriát.', 'error'); }
}

/** Deletes a category through the API and refreshes dependent views. */
async function deleteCategory(category) {
    if (!confirm(`Biztosan törölni akarod a(z) "${category}" kategóriát?`)) return;
    try { await api.deleteCategory(category); if (activeCategoryFilter === category) activeCategoryFilter = 'All'; await loadCategoriesFromServer(); await loadBookmarksFromServer(); renderCategories(); renderManageCategoriesList(); renderBookmarks(); showNotification('A kategória törölve.', 'success'); }
    catch (err) { showNotification('Nem sikerült törölni a kategóriát.', 'error'); }
}

/** Creates a category from the category modal form. */
async function createNewCategory() {
    const input = document.getElementById('newCatName');
    const name = input.value.trim();
    if (!name) return;
    if (categories.includes(name)) { showNotification('Ez a kategória már létezik.', 'error'); return; }
    try { await api.createCategory(name); await loadCategoriesFromServer(); renderCategories(); populateCategorySelect('bmCategory', name); populateCategorySelect('editBmCategory', name); closeModal('categoryModal'); input.value = ''; showNotification('A kategória létrehozva.', 'success'); }
    catch (err) { showNotification('Nem sikerült elmenteni az új kategóriát.', 'error'); }
}

window.filterCategory = filterCategory;
window.createNewCategory = createNewCategory;
