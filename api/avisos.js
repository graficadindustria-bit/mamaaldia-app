// Avisos con la app cerrada (notificaciones push). Guarda en Vercel Blob (tienda privada).
// GET  /api/avisos?clave=1            -> clave pública para suscribirse
// POST {codigo?, modo:'sync', sub, avisos:[{id,at,t,b}]}  -> guarda los próximos avisos de este teléfono
// POST {modo:'quitar', endpoint}       -> deja de enviar a este teléfono
// GET  /api/avisos?tick=1              -> lo llama un reloj cada ~10 min: envía los avisos que ya tocan
const crypto = require('crypto');
const { put, get } = require('@vercel/blob');
const webpush = require('web-push');
const TODO = 'avisos/todo.json', CONF = 'avisos/vapid.json';

async function leerJSON(ruta, def) {
  try {
    const r = await get(ruta, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return def;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) { return def; }
}
const guardarJSON = (ruta, o) => put(ruta, JSON.stringify(o), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60 });

let vapid = null;
async function claves() {
  if (vapid) return vapid;
  let v = await leerJSON(CONF, null);
  if (!v || !v.publicKey) { v = webpush.generateVAPIDKeys(); await guardarJSON(CONF, v); }
  webpush.setVapidDetails('https://mamaaldia-app.vercel.app', v.publicKey, v.privateKey);
  return (vapid = v);
}
const clave = ep => crypto.createHash('sha256').update(String(ep)).digest('hex').slice(0, 24);
const txt = (x, n) => String(x || '').replace(/[<>]/g, '').trim().slice(0, n);

module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return res.status(503).json({ error: 'sin-tienda' });
  try {
    const v = await claves();
    const q = req.query || {};
    if (req.method === 'GET' && q.clave) return res.status(200).json({ clave: v.publicKey });

    if (req.method === 'GET' && q.tick) {
      const todo = await leerJSON(TODO, { tel: {} });
      const now = Date.now();
      let cambio = false, enviados = 0;
      for (const [k, d] of Object.entries(todo.tel || {})) {
        if (!d || !d.sub) { delete todo.tel[k]; cambio = true; continue; }
        if (now - (d.visto || 0) > 30 * 864e5) { delete todo.tel[k]; cambio = true; continue; } // teléfono sin abrir la app en 30 días
        for (const a of d.avisos || []) {
          if (a.env || a.at > now + 60000 || a.at < now - 3 * 36e5) continue;
          try {
            await webpush.sendNotification(d.sub, JSON.stringify({ t: a.t, b: a.b, tag: a.id }), { TTL: 3600, urgency: 'high' });
            enviados++;
          } catch (e) {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) { delete todo.tel[k]; cambio = true; break; }
          }
          a.env = 1; cambio = true;
        }
        if (todo.tel[k]) todo.tel[k].avisos = (todo.tel[k].avisos || []).filter(a => a.at > now - 6 * 36e5);
      }
      if (cambio) await guardarJSON(TODO, todo);
      return res.status(200).json({ ok: true, enviados, telefonos: Object.keys(todo.tel || {}).length });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

    if (b.modo === 'quitar') {
      const todo = await leerJSON(TODO, { tel: {} });
      const k = clave(b.endpoint);
      if (todo.tel && todo.tel[k]) { delete todo.tel[k]; await guardarJSON(TODO, todo); }
      return res.status(200).json({ ok: true });
    }

    if (b.modo === 'sync') {
      const s = b.sub;
      if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: 'sub' });
      const now = Date.now();
      const avisos = (Array.isArray(b.avisos) ? b.avisos : []).filter(a => a && +a.at > now - 36e5 && +a.at < now + 9 * 864e5).slice(0, 120)
        .map(a => ({ id: txt(a.id, 80), at: +a.at, t: txt(a.t, 80) || 'Mamá al Día', b: txt(a.b, 160) }));
      const todo = await leerJSON(TODO, { tel: {} });
      todo.tel = todo.tel || {};
      const k = clave(s.endpoint);
      const antes = todo.tel[k];
      const env = new Set(((antes && antes.avisos) || []).filter(a => a.env).map(a => a.id));
      avisos.forEach(a => { if (env.has(a.id)) a.env = 1; });
      if (!antes && Object.keys(todo.tel).length >= 300) return res.status(429).json({ error: 'lleno' });
      todo.tel[k] = { sub: { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } }, avisos, visto: now };
      await guardarJSON(TODO, todo);
      return res.status(200).json({ ok: true, guardados: avisos.length });
    }

    if (b.modo === 'prueba') {
      const s = b.sub;
      if (!s || !s.endpoint) return res.status(400).json({ error: 'sub' });
      await webpush.sendNotification(s, JSON.stringify({ t: 'Mamá al Día', b: 'Así te llegarán los avisos, aunque la app esté cerrada 🌷', tag: 'prueba' }), { TTL: 600 });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'modo' });
  } catch (e) { return res.status(500).json({ error: 'avisos', detalle: String(e && e.message).slice(0, 120) }); }
};
