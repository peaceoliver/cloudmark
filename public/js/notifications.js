const notificationTimers = new WeakMap();

/** Shows a dismissible in-page notification instead of a browser alert. */
function showNotification(message, type = 'info', duration = 5000) {
    const container = document.getElementById('notificationArea');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
    notification.innerHTML = `<span>${message}</span><button type="button" class="notification-close" aria-label="Értesítés bezárása">&times;</button>`;
    notification.querySelector('.notification-close').addEventListener('click', () => removeNotification(notification));
    container.appendChild(notification);

    const timer = setTimeout(() => removeNotification(notification), duration);
    notificationTimers.set(notification, timer);
}

/** Removes an in-page notification with its active transition. */
function removeNotification(notification) {
    clearTimeout(notificationTimers.get(notification));
    notification.classList.add('notification-leaving');
    notification.addEventListener('transitionend', () => notification.remove(), { once: true });
    setTimeout(() => notification.remove(), 250);
}

window.showNotification = showNotification;
