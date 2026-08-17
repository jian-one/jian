const SHELL = 'jian-shell-v4';
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(SHELL);
  const response = await fetch('/');
  const html = await response.clone().text();
  await cache.put('/', response);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
  await cache.addAll(['/manifest.webmanifest', '/app_icon.svg', ...assets]);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  const shells = keys.filter(key => key.startsWith('jian-shell-')).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  const stale = keys.filter(key => (key.startsWith('jian-shell-') && !shells.slice(0, 2).includes(key)) || key.startsWith('jian-sessions-'));
  await Promise.all(stale.map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request; const url = new URL(request.url);
  if (request.mode === 'navigate' && url.origin === location.origin) {
    event.respondWith(fetch(request).then(response => {
      if (!response.ok) throw new Error(`navigation failed: ${response.status}`);
      const copy = response.clone(); caches.open(SHELL).then(cache => cache.put('/', copy)); return response;
    }).catch(() => caches.match('/')));
    return;
  }
  if (request.method === 'GET' && url.origin === location.origin && !url.pathname.startsWith('/api/')) event.respondWith(fetch(request).then(response => {
    const copy = response.clone(); caches.open(SHELL).then(cache => cache.put(request, copy)); return response;
  }).catch(() => caches.match(request)));
});
