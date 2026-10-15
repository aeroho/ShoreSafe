// Offline support. Three rules:
//  1. The app's own files: try the network (3 s), fall back to the saved copy. Always fresh when online.
//  2. /api/ requests are never touched here. The app keeps its own on-device copy of your data.
//  3. Map tiles you've looked at are kept, so that part of the map still shows offline.

const SHELL = 'shoresafe-shell-v1';
const TILES = 'shoresafe-tiles-v1';
const MAX_TILES = 500;
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

const SHELL_FILES = [
  '/', '/index.html', '/css/styles.css', '/manifest.webmanifest',
  '/js/theme-init.js', '/js/main.js', '/js/util.js', '/js/icons.js', '/js/api.js', '/js/store.js',
  '/js/state.js', '/js/data.js', '/js/tilemap.js',
  '/js/views/auth.js', '/js/views/profile-form.js', '/js/views/home.js', '/js/views/alerts.js',
  '/js/views/checklist.js', '/js/views/supplies.js', '/js/views/drains.js', '/js/views/account.js',
  '/icons/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shoresafe-') && k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function appFile(request) {
  const cache = await caches.open(SHELL);
  const key = request.mode === 'navigate' ? '/index.html' : request;
  try {
    const res = await withTimeout(fetch(request), 3000);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    const saved = await cache.match(key);
    return saved || new Response('You are offline and this page is not saved yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function tile(request) {
  const cache = await caches.open(TILES);
  const saved = await cache.match(request);
  if (saved) return saved;
  try {
    const res = await fetch(request);
    if (res.ok && res.type !== 'opaque') {
      cache.put(request, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return Response.error();
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i += 1) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    event.respondWith(appFile(req));
  } else if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tile(req));
  }
});
