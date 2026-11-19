// A release uses its own asset URLs and cache. Keep v13's separate cache available for rollback.
const release = '14-r7';
const cacheName = 'beamsync-v' + release;
const readyKey = '/__beamsync_package_ready__';
const shells = new Map([['/','/index.html'],['/index.html','/index.html'],['/classic.html','/classic.html']]);
const assets = [
  '/ui.css','/app.css','/app.js','/ui.js','/manifest.webmanifest',
  '/js/core.js','/js/pairing.js','/js/main.js','/js/transfer.js','/js/sha256.js','/js/recovery.js',
  '/js/devices.js','/js/share.js','/js/signal.js','/js/quick-pair.js',
  '/vendor/jsQR.js','/vendor/qrcode.min.js','/icons/apple-touch-icon.png','/icons/icon-192.png','/icons/icon-512.png'
];
const releaseAssets = new Set(assets.map(path => path + '?v=' + release));
const previousAssets = new Map();
for (const previousRelease of ['14-r6','14-r5','14-r4']) {
  for (const asset of assets) previousAssets.set(asset + '?v=' + previousRelease, previousRelease);
}
const packagePaths = [...releaseAssets, '/index.html', '/classic.html'];
const jsTypes = new Set(['text/javascript','application/javascript','application/ecmascript','text/ecmascript','application/x-javascript']);

async function fetchAsset(resource) {
  const response = await fetch(resource, {cache:'reload', credentials:'same-origin', redirect:'error'});
  if (response.status !== 200 || response.redirected) throw Error('Package unavailable');
  const path = resource.split('?')[0];
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let valid = false;
  if (shells.has(path)) {
    const content = await response.clone().text();
    const marker = path === '/classic.html' ? 'v14-classic' : 'v14';
    valid = type === 'text/html' && content.includes('name="beamsync-app" content="'+marker+'"') &&
      content.includes('./js/core.js?v=' + release);
  } else if (path.endsWith('.webmanifest')) {
    // Some static hosts use octet-stream for webmanifest. Require a genuine BeamSync manifest.
    if (['application/manifest+json','application/json','application/octet-stream'].includes(type)) {
      const manifest = await response.clone().json();
      valid = manifest.name === 'BeamSync' && Array.isArray(manifest.icons) && manifest.icons.length > 0 &&
        manifest.icons.every(icon => {
          const target = new URL(icon.src, self.location.origin + '/');
          return target.origin === self.location.origin && releaseAssets.has(target.pathname + target.search);
        });
    }
  } else if (path.endsWith('.png')) {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    valid = type === 'image/png' && [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b);
  } else {
    const content = (await response.clone().text()).trimStart();
    valid = (path.endsWith('.css') ? type === 'text/css' : jsTypes.has(type)) &&
      content.length > 0 && !content.startsWith('<');
  }
  if (!valid) throw Error('Incorrect or incomplete offline asset: ' + path);
  return response;
}

async function complete(cache) {
  if (!(await cache.match(readyKey))) return false;
  return (await Promise.all(packagePaths.map(path => cache.match(path)))).every(Boolean);
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    if (!(await complete(cache))) {
      // The marker is committed last. A failed quota write cannot publish a partially installed release.
      await cache.delete(readyKey);
      try {
        const pack = await Promise.all(packagePaths.map(fetchAsset));
        const writes = await Promise.allSettled(packagePaths.map((path,i) => cache.put(path,pack[i])));
        if (writes.some(x => x.status === 'rejected')) throw Error('Insufficient offline storage');
        await cache.put(readyKey, new Response(release));
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_SHELL') return;
  event.waitUntil((async () => {
    let ok = false;
    try { ok = await complete(await caches.open(cacheName)); } catch { /* Storage unavailable. */ }
    event.source?.postMessage({type:ok ? 'OFFLINE_READY' : 'OFFLINE_CACHE_ERROR',cache:cacheName});
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && shells.has(url.pathname)) {
    event.respondWith((async () => {
      // A live login wall, 4xx, newer release or rollback wins over an offline package.
      try { return await fetch(req); }
      catch {
        try {
          const cache = await caches.open(cacheName);
          if (await complete(cache)) {
            const shell = await cache.match(shells.get(url.pathname));
            if (shell) return shell;
          }
        } catch { /* The browser can evict its cache. */ }
        return new Response('Reopen BeamSync online to prepare offline access.',{status:503});
      }
    })());
    return;
  }
  const key = url.pathname + url.search;
  // Tabs opened before activation can finish loading their own installed packages.
  const previousRelease = previousAssets.get(key);
  if (previousRelease) {
    const previousCacheName = 'beamsync-v' + previousRelease;
    event.respondWith((async () => {
      try {
        if ((await caches.keys()).includes(previousCacheName)) {
          const old = await caches.open(previousCacheName);
          const ready = await old.match(readyKey);
          if (ready && await ready.text() === previousRelease) {
            const hit = await old.match(key);
            if (hit) return hit;
          }
        }
      } catch { /* The browser can evict the previous package. */ }
      return fetch(req);
    })());
    return;
  }
  // An older shell requests unversioned scripts. Let it load its own release from the network.
  if (!releaseAssets.has(key)) return;
  event.respondWith((async () => {
    try {
      const cache = await caches.open(cacheName);
      if (await cache.match(readyKey)) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
    } catch { /* Fetch online if storage is unavailable. */ }
    return fetch(req);
  })());
});
