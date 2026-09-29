// Presence-only service worker.
//
// This app always shows live, auth-gated data (scans behind the reverse proxy's
// login), so nothing here is cached: no offline mode, no stored responses. The
// only purpose of this file is to satisfy the "has a registered service worker"
// requirement for Android/desktop install prompts. Every request is left to the
// network exactly as if this file didn't exist.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
