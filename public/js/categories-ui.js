/** Category data is kept as objects; the name-only fallback keeps old API responses usable. */
function categoryName(category) { return typeof category === 'string' ? category : category.name; }
function categoryId(category) { return typeof category === 'string' ? category : category.id; }
function categoryTree() {
    const result = [], byParent = new Map();
    categories.forEach(category => {
        const parent = category.parent_id == null ? null : String(category.parent_id);
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(category);
    });
    function visit(parent, depth) {
        (byParent.get(parent) || []).forEach(category => {
            result.push({ category, depth });
            visit(String(categoryId(category)), depth + 1);
        });
    }
    visit(null, 0);
    return result;
}

function initAccordions() {
    document.querySelectorAll('.accordion-trigger').forEach(trigger => {
        const target = document.getElementById(trigger.dataset.target);
        if (!target) return;
        const storageKey = trigger.dataset.storageKey ? `cloudmark.accordion.${trigger.dataset.storageKey}` : null;
        const readState = () => {
            if (storageKey && sessionStorage.getItem(storageKey) !== null) {
                return sessionStorage.getItem(storageKey) === 'true';
            }
            return trigger.getAttribute('aria-expanded') === 'true';
        };
        const persistState = expanded => {
            if (storageKey) {
                sessionStorage.setItem(storageKey, String(expanded));
            }
        };
        const syncState = expanded => {
            trigger.setAttribute('aria-expanded', String(expanded));
            target.classList.toggle('is-collapsed', !expanded);
            persistState(expanded);
        };
        const initialExpanded = readState();
        syncState(initialExpanded);
        trigger.addEventListener('click', () => {
            const nextExpanded = trigger.getAttribute('aria-expanded') !== 'true';
            syncState(nextExpanded);
        });
    });
}

function renderCategories() {
    const container = document.getElementById('categoriesBar');
    const select = document.getElementById('bmCategory');
    const names = categories.map(categoryName);
    const visible = !currentUser && names.includes('MAIN') ? categories.filter(c => categoryName(c) === 'MAIN') : categories;
    if (!currentUser && names.includes('MAIN') && activeCategoryFilter !== 'MAIN') activeCategoryFilter = 'MAIN';
    else if (!currentUser && !names.includes('MAIN') && activeCategoryFilter === 'MAIN') activeCategoryFilter = 'All';
    if (container) {
        container.innerHTML = `<button class="category-chip ${activeCategoryFilter === 'All' ? 'active' : ''}" onclick="filterCategory('All')">Összes</button>`;
        categoryTree().filter(({ category }) => visible.includes(category)).forEach(({ category, depth }) => {
            const name = categoryName(category);
            const button = document.createElement('button');
            button.className = `category-chip ${activeCategoryFilter === name ? 'active' : ''}`;
            button.style.marginLeft = `${depth * 0.8}rem`;
            button.innerHTML = `<i class="fa-solid fa-folder"></i> ${name}`;
            button.onclick = () => filterCategory(name);
            container.appendChild(button);
        });
    }
    if (select) populateCategorySelect('bmCategory');
    if (typeof populateBulkCategorySelect === 'function') populateBulkCategorySelect();
    const manageButton = document.getElementById('manageCategoriesBtn');
    if (manageButton) {
        manageButton.style.display = currentUser ? '' : 'none';
        manageButton.onclick = () => { openModal('categoryModal'); renderManageCategoriesList(); };
    }
    renderCategoryTreeView();
}

function renderCategoryTreeView() {
    const container = document.getElementById('categoryTreeView');
    if (!container) return;
    container.innerHTML = '';
    const treeItems = categoryTree();
    if (!treeItems.length) {
        container.innerHTML = '<div class="empty-state">Nincsenek kategóriák.</div>';
        return;
    }
    treeItems.forEach(({ category, depth }) => {
        const name = categoryName(category);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `category-tree-node ${activeCategoryFilter === name ? 'active' : ''}`;
        button.style.paddingLeft = `${depth * 1.1 + 0.5}rem`;
        button.innerHTML = `
            <span class="category-tree-label">
                <span class="category-tree-arrow">${depth > 0 ? '▸' : '•'}</span>
                <i class="fa-solid fa-folder"></i>
                <span>${name}</span>
            </span>
        `;
        button.onclick = () => { filterCategory(name); };
        container.appendChild(button);
    });
}

function filterCategory(category) { activeCategoryFilter = category; renderCategories(); renderBookmarks(); }

function renderManageCategoriesList() {
    const container = document.getElementById('manageCategoriesList');
    if (!container) return;
    const parentSelect = document.getElementById('newCatParent');
    if (parentSelect) {
        parentSelect.innerHTML = '<option value="">Nincs szülőkategória (gyökér)</option>';
        categoryTree().forEach(({ category, depth }) => parentSelect.append(new Option(`${'— '.repeat(depth)}${categoryName(category)}`, categoryId(category))));
    }
    container.innerHTML = '';
    categoryTree().forEach(({ category, depth }) => {
        const name = categoryName(category);
        const row = document.createElement('div');
        row.style.cssText = `display:flex; margin-left:${depth * 1.25}rem; justify-content:space-between; align-items:center; background:var(--bg-input); padding:0.5rem 0.75rem; border-radius:8px; border:1px solid var(--border-color);`;
        row.innerHTML = `<span style="font-weight:600"><i class="fa-solid fa-folder"></i> ${name}</span>`;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex; gap:0.4rem;';
        if (name !== 'Inbox') {
            actions.innerHTML = '<button class="action-btn" title="Átnevezés"><i class="fa-solid fa-pen"></i></button><button class="action-btn" title="Törlés"><i class="fa-solid fa-trash"></i></button>';
            actions.children[0].onclick = () => renameCategory(name);
            actions.children[1].onclick = () => deleteCategory(name);
        } else actions.innerHTML = '<span style="font-size:0.75rem; color:var(--text-secondary)">Alapértelmezett</span>';
        row.appendChild(actions); container.appendChild(row);
    });
}

async function renameCategory(oldName) {
    const newName = prompt(`Add meg a(z) "${oldName}" kategória új nevét:`, oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    if (categories.some(category => categoryName(category) === newName.trim())) { showNotification('Ez a kategória már létezik.', 'error'); return; }
    try { await api.renameCategory(oldName, newName.trim()); await loadCategoriesFromServer(); await loadBookmarksFromServer(); renderCategories(); renderManageCategoriesList(); renderBookmarks(); showNotification('A kategória átnevezve.', 'success'); }
    catch (err) { showNotification('Nem sikerült átnevezni a kategóriát.', 'error'); }
}

async function deleteCategory(category) {
    const name = categoryName(category);
    if (!confirm(`Biztosan törölni akarod a(z) "${name}" kategóriát? A könyvjelzők az Inboxba kerülnek.`)) return;
    try { await api.deleteCategory(name); if (activeCategoryFilter === name) activeCategoryFilter = 'All'; await loadCategoriesFromServer(); await loadBookmarksFromServer(); renderCategories(); renderManageCategoriesList(); renderBookmarks(); showNotification('A kategória törölve.', 'success'); }
    catch (err) { showNotification('Nem sikerült törölni a kategóriát.', 'error'); }
}

async function createNewCategory() {
    const input = document.getElementById('newCatName');
    const parent = document.getElementById('newCatParent');
    const name = input.value.trim();
    if (!name) return;
    if (categories.some(category => categoryName(category) === name)) { showNotification('Ez a kategória már létezik.', 'error'); return; }
    try { await api.createCategory(name, parent && parent.value ? Number(parent.value) : null); await loadCategoriesFromServer(); renderCategories(); populateCategorySelect('bmCategory', name); populateCategorySelect('editBmCategory', name); renderManageCategoriesList(); input.value = ''; if (parent) parent.value = ''; showNotification('A kategória létrehozva.', 'success'); }
    catch (err) { showNotification('Nem sikerült elmenteni az új kategóriát.', 'error'); }
}

window.filterCategory = filterCategory;
window.createNewCategory = createNewCategory;
initAccordions();
