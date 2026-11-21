/* Pace service worker — network-first shell so updates land immediately,
   cache only as the offline fallback. */
const CACHE = "pace-v12";
const SHELL = [
  "/", "/index.html", "/styles.css", "/app.js",
  "/firebase-config.js", "/manifest.webmanifest",
  "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch Firebase or CDN traffic — let the network own it.
  if (url.origin !== self.location.origin) return;

  // Always revalidate against the origin. Without this, a stale HTTP-cache entry
  // (Firebase's default max-age) can pin the app to an old build for an hour.
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(r => r || caches.match("/index.html")))
  );
});
