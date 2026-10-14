// Service worker for the admin "app" (admin.html added to the home screen).
// Its only job is push notifications: show them even when the admin is
// closed, and open the right chat when one is tapped. It has no fetch
// handler, so it never touches how the public site loads.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
    event.waitUntil((async () => {
        // Notifications of chats someone (on this or another phone) already read.
        if (Array.isArray(data.unreadConversationIds)) {
            const unread = new Set(data.unreadConversationIds);
            const shown = await self.registration.getNotifications();
            shown.forEach((n) => { if (n.tag && n.tag !== data.tag && !unread.has(n.tag)) n.close(); });
        }
        await self.registration.showNotification(data.title || 'Piel Spa', {
            body: data.body || 'Nuevo mensaje',
            tag: data.tag || undefined,          // one notification per chat, updated in place
            renotify: !!data.tag,
            icon: '/images/icon-192.png',
            badge: '/images/icon-192.png',
            data: { url: data.url || '/admin.html#mensajes', conversationId: data.conversationId || null },
        });
        // Number on the home-screen icon: unread messages across all chats.
        if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
            try { data.badge > 0 ? await self.navigator.setAppBadge(data.badge) : await self.navigator.clearAppBadge(); } catch (_) {}
        }
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const { url, conversationId } = event.notification.data || {};
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const admin = windows.find((w) => new URL(w.url).pathname.endsWith('/admin.html'));
        if (admin) {
            await admin.focus();
            admin.postMessage({ type: 'open-chat', conversationId });
            return;
        }
        await self.clients.openWindow(url || '/admin.html#mensajes');
    })());
});
