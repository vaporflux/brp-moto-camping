/* Offline for a parking lot with no bars.
 *
 * The whole planner is one self-contained index.html -- data, styles, Leaflet, all of it --
 * so "works offline" mostly means "make sure the page itself is on the device". That is
 * what the precache is.
 *
 * Map TILES are deliberately NOT precached. There are millions of them, the Parkway
 * corridor alone would be hundreds of megabytes, and OpenStreetMap's tile policy forbids
 * bulk downloading. Instead tiles are cached as they are viewed, so a corridor the rider
 * has already looked at stays visible with no signal, and one they have not shows empty
 * squares over a working map. Panning around the route at home is what fills it.
 *
 * The API routes are never cached: a stale Google answer about whether a campground is
 * open is worse than an honest failure.
 */
const VERSION = 'brp-v6-safearea';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;
const TILE_LIMIT = 1200;              // ~15-25 MB, enough for a planned corridor

const PRECACHE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/favicon.svg', '/favicon.ico',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Individually, so one 404 cannot fail the whole install and leave the app with no
    // offline copy at all.
    await Promise.all(PRECACHE.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  // Oldest first: Cache Storage preserves insertion order, so the front of the list is the
  // least recently added.
  for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await c.delete(k);
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never serve a stale answer about whether somewhere is open or reachable.
  if (url.pathname.startsWith('/api/')) return;

  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) { await c.put(request, res.clone()); trimTiles(); }
        return res;
      } catch (err) {
        // No signal and this square was never viewed. An empty tile beats a broken map.
        return new Response('', { status: 504, statusText: 'offline, tile not cached' });
      }
    })());
    return;
  }

  if (request.mode === 'navigate' || url.origin === self.location.origin) {
    // Network first, so a deploy is picked up as soon as there is signal, falling back to
    // the cached copy the moment there is not.
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res.ok) (await caches.open(SHELL)).put(request, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(request) || await caches.match('/index.html');
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
