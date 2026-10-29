// Re-check this site's own files on every load, so an update shows on the next visit
// instead of after GitHub Pages' 10-minute cache (and pages never mix old and new modules).
// Unchanged files come back as cheap 304s. Map and terrain tiles (other origins) are untouched.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })));
});
