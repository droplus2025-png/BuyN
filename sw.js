// Service worker: works offline, and always prefers the NEWEST files when online
// (network first, cache as fallback) so a new publication is picked up automatically.
const CACHE = 'buyn-shell-v32';
const FILES = ['./', 'index.html', 'app.js', 'version.js', 'manifest.webmanifest', 'admin.js', 'auth.js', 'backup.js', 'beep.js', 'calc.js', 'cart.js', 'cash.js', 'errors.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'idb-persist.js', 'index.js', 'invoice-number.js', 'invoice-text.js', 'logo.png', 'memory-store.js', 'money.js', 'parties.js', 'payments.js', 'pc.css', 'permissions.js', 'phone.js', 'post.js', 'print.js', 'products.js', 'purchases.js', 'queries.js', 'quick-detail.js', 'returns.js', 'sales.js', 'settings.js', 'share.js', 'style.css', 'sync-config.js', 'sync-merge.js', 'sync.js', 'ui-admin.js', 'ui-calc.js', 'ui-cash.js', 'ui-core.js', 'ui-debts.js', 'ui-expenses.js', 'ui-external.js', 'ui-home.js', 'ui-invoices.js', 'ui-login.js', 'ui-pc.js', 'ui-productform.js', 'ui-purchase.js', 'ui-returns.js', 'ui-sale.js', 'ui-stock.js', 'viewport.js', 'NotoNaskhArabic-Regular.woff', 'NotoNaskhArabic-Medium.woff', 'NotoNaskhArabic-SemiBold.woff', 'NotoNaskhArabic-Bold.woff'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || caches.match('index.html')))
  );
});
