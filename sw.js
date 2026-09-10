/* Waymark service worker — offline support + instant launches.
   Strategies:
   - navigation requests (the app page): network-first, cache fallback → always fresh when online, works offline
   - Supabase REST GETs: network-first with cache fallback + background refresh → offline reads of your data
   - map tiles (openstreetmap): cache-first (immutable per z/x/y) with capped cache size
   - fonts/CDN libraries: stale-while-revalidate
   - all other GETs: network-first fallback to cache
   Mutating requests (POST/PATCH/...) always go straight to the network. */
const VERSION = 'waymark-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const TILE_CACHE = `${VERSION}-tiles`;

const SHELL_ASSETS = [
  'index.html',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Work+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache individually so one flaky CDN download can't break installation
      await Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload', credentials: 'omit' }))
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))
      );
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch (e) {}
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function safePut(cache, request, response) {
  try { await cache.put(request, response); } catch (e) { /* opaque/broken responses can't be stored — ignore */ }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) {
    await safePut(cache, request, res.clone());
    if (maxEntries) trimCache(cacheName, maxEntries);
  }
  return res;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await cache.delete(keys[0]);
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) await safePut(cache, request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const fetchPromise = fetch(request)
    .then(async (res) => {
      if (res && (res.ok || res.type === 'opaque')) await safePut(cache, request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return hit || (await fetchPromise) || Response.error();
}

function isSupabaseData(url) {
  return (
    url.hostname.endsWith('.supabase.co') &&
    url.pathname.startsWith('/rest/v1/') &&
    (url.searchParams.get('select') || url.pathname.includes('/hikes'))
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // App page: network-first so updates land immediately, cache fallback for offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse;
          if (preload) {
            const cache = await caches.open(SHELL_CACHE);
            await safePut(cache, 'index.html', preload.clone());
            return preload;
          }
          const res = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          await safePut(cache, 'index.html', res.clone());
          return res;
        } catch (err) {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('index.html')) ||
            (await cache.match(request)) ||
            new Response('Offline', { status: 503, statusText: 'Offline' })
          );
        }
      })()
    );
    return;
  }

  // Supabase reads: network-first with cache fallback (offline access to your hikes).
  if (isSupabaseData(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        try {
          const res = await fetch(request);
          if (res.ok) await safePut(cache, request, res.clone());
          return res;
        } catch (err) {
          const hit = await cache.match(request, { ignoreSearch: false, ignoreVary: true });
          if (hit) {
            // refresh in the background once connectivity returns
            fetch(request)
              .then(async (res) => { if (res.ok) await safePut(cache, request, res.clone()); })
              .catch(() => {});
            return hit;
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      })()
    );
    return;
  }

  // Map tiles: cache-first, they are immutable per coordinate.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(request, TILE_CACHE, 600));
    return;
  }

  // Fonts & CDN libraries: stale-while-revalidate.
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'unpkg.com'
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Same-origin static files: network-first with cache fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      networkFirst(request, SHELL_CACHE).catch(
        () => new Response('Offline', { status: 503, statusText: 'Offline' })
      )
    );
  }
});
