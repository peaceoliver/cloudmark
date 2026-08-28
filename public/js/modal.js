/** Opens a modal by adding its active state class. */
function openModal(id) {
    const element = document.getElementById(id);
    if (element) element.classList.add('active');
}

/** Closes a modal by removing its active state class. */
function closeModal(id) {
    const element = document.getElementById(id);
    if (element) element.classList.remove('active');
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', event => {
        if (event.target === overlay) overlay.classList.remove('active');
    });
});

window.openModal = openModal;
window.closeModal = closeModal;
