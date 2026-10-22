// 최소 서비스 워커: 설치 가능 조건 충족 + 접속 실패 시 마지막 화면 표시 (항상 최신 우선)
const CACHE = 'ta-portal-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './splash.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;   // Supabase 등 외부 요청은 건드리지 않음
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)).catch(() => {}); return res; }).catch(() => caches.match(r).then(m => m || caches.match('./index.html'))));
});
