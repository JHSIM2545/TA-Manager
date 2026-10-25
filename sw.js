// 최소 서비스 워커: 설치 가능 조건 충족 + 접속 실패 시 마지막 화면 표시 (항상 최신 우선)
const CACHE = 'ta-portal-v2';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './splash.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;   // Supabase 등 외부 요청은 건드리지 않음
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)).catch(() => {}); return res; }).catch(() => caches.match(r).then(m => m || caches.match('./index.html'))));
});

// ---- 푸시 알림 ----
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const vis = cs.find(c => c.visibilityState === 'visible');
    if (vis) { vis.postMessage({ type: 'push-refresh', lead: d.lead || '' }); return; }   // 앱을 보고 있으면 팝업 대신 화면만 새로고침
    return self.registration.showNotification(d.title || 'TA 관리 포털', { body: d.body || '', tag: d.tag || 'ta', icon: './icon-192.png', badge: './icon-192.png', data: { lead: d.lead || '' } });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.length) { cs[0].postMessage({ type: 'push-open', lead: (e.notification.data || {}).lead || '' }); return cs[0].focus(); }
    return self.clients.openWindow('./');
  }));
});
