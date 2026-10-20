// 手机页面秒开：先直接用上次缓存的页面（不等网络），同时在后台取新版本存起来，下次打开就是新的。
// 中转程序升级后，页面发现版本变了会主动刷新缓存并重新加载一次（见 app.js 的 checkShell）。
const CACHE = 'cr-shell-v10';
const SHELL = ['./', 'theme.js', 'style.css', 'app.js', 'e2e.js', 'vendor/nacl-fast.min.js', 'vendor/marked.js', 'vendor/purify.js', 'icon.png', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/ws') || url.pathname.endsWith('/healthz') || url.pathname.includes('/pair/')) return;
  // 打开页面（含扫码带的 #p=…）都对应同一个缓存的首页
  const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : url.origin + url.pathname;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(key);
    const net = fetch(req).then((r) => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || Response.error();
  }));
});
