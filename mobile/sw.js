// 只为了能「添加到主屏幕」：页面优先走网络，断网时才用缓存的壳子
const CACHE = 'cr-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'vendor/nacl-fast.min.js', 'vendor/marked.js', 'vendor/purify.js', 'icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.endsWith('/ws')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
