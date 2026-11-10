// Keeper service worker: makes the app installable, keeps the shell available offline,
// and shows reminder notifications. API calls are never cached (always fresh, never stale data).
const CACHE = 'shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/keeper', '/favicon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  // Hashed build assets never change: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone()
            if (res.ok) caches.open(CACHE).then((c) => c.put(request, copy))
            return res
          }),
      ),
    )
    return
  }
  // Pages: network-first, fall back to the cached app shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/keeper')))
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).pathname.startsWith('/keeper'))
      return open ? open.focus() : self.clients.openWindow('/keeper')
    }),
  )
})
