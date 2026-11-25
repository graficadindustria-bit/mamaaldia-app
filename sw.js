const C='mamaaldia-v49';
const F=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-maskable-512.png','./apple-touch-icon.png','./favicon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))))});
self.addEventListener('notificationclick',e=>{e.notification.close();const s=(e.notification.data&&e.notification.data.s)||'';
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{if(l.length){l[0].postMessage({aviso:s});return l[0].focus()}return self.clients.openWindow('./index.html'+(s?'?aviso='+encodeURIComponent(s):''))}))});
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={b:e.data&&e.data.text()}}
 e.waitUntil(self.registration.showNotification(d.t||'Mamá al Día',{body:d.b||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||undefined,renotify:true,requireInteraction:true,silent:false,vibrate:[300,120,300,120,300],data:{s:d.s||''},actions:[{action:'oir',title:'🔊 Escuchar a Lía'}]}))});
