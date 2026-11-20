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

// Redis (Upstash, gratis hasta 500 mil operaciones al mes): si está conectado, el reloj de cada minuto lo usa
// en vez de Blob, que en el plan gratuito tiene pocas lecturas al mes.
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmds) {
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
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

    if (req.method === 'GET' && q.estado && RURL) {
      const { CODIGOS } = require('./_codigos');
      const h = crypto.createHash('sha256').update(String(q.estado).trim().toUpperCase()).digest('hex');
      if (CODIGOS[h] !== 'creador') return res.status(401).json({ error: 'codigo' });
      const [n, prox, tel, ult] = await redis([['ZCARD', 'av'], ['ZRANGE', 'av', 0, 7, 'WITHSCORES'], ['HLEN', 'tel'], ['GET', 'ultimo_tick']]);
      const lista = []; for (let i = 0; i < (prox || []).length; i += 2) { try { const a = JSON.parse(prox[i]); lista.push(new Date(+prox[i + 1]).toISOString() + ' ' + a.t + ' | ' + a.b); } catch (e) {} }
      return res.status(200).json({ ahora: new Date().toISOString(), avisos: n, telefonos: tel, ultimo_tick: ult, proximos: lista });
    }
    if (req.method === 'GET' && q.tick && RURL) {
      const now = Date.now();
      const [due] = await redis([['ZRANGEBYSCORE', 'av', now - 3 * 36e5, now + 60000], ['SET', 'ultimo_tick', new Date(now).toISOString()]]);
      let enviados = 0;
      if (due && due.length) {
        const ks = [...new Set(due.map(m => { try { return JSON.parse(m).k; } catch (e) { return ''; } }))];
        const subs = await redis(ks.map(k => ['HGET', 'tel', k]));
        const mapa = {}; ks.forEach((k, i) => { try { mapa[k] = JSON.parse(subs[i]); } catch (e) {} });
        const quitar = [];
        for (const m of due) {
          let a; try { a = JSON.parse(m); } catch (e) { quitar.push(['ZREM', 'av', m]); continue; }
          const d = mapa[a.k];
          if (d && d.sub) {
            try { await webpush.sendNotification(d.sub, JSON.stringify({ t: a.t, b: a.b, s: a.s, tag: a.id }), { TTL: 3600, urgency: 'high' }); enviados++; }
            catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) quitar.push(['HDEL', 'tel', a.k]); }
          }
          quitar.push(['ZREM', 'av', m], ['SADD', 'env:' + a.k, a.id], ['EXPIRE', 'env:' + a.k, 86400]);
        }
        await redis(quitar);
      }
      if (now % 36e5 < 120000) await redis([['ZREMRANGEBYSCORE', 'av', 0, now - 6 * 36e5]]);
      return res.status(200).json({ ok: true, enviados, redis: true });
    }

    if (req.method === 'GET' && q.tick) {
      if (new Date().getUTCMinutes() % 5 && !q.forzar) return res.status(200).json({ ok: true, espera: true }); // sin Redis: solo cada 5 min para no gastar lecturas
      const todo = await leerJSON(TODO, { tel: {} });
      const now = Date.now();
      let cambio = false, enviados = 0;
      for (const [k, d] of Object.entries(todo.tel || {})) {
        if (!d || !d.sub) { delete todo.tel[k]; cambio = true; continue; }
        if (now - (d.visto || 0) > 30 * 864e5) { delete todo.tel[k]; cambio = true; continue; } // teléfono sin abrir la app en 30 días
        for (const a of d.avisos || []) {
          if (a.env || a.at > now + 60000 || a.at < now - 3 * 36e5) continue;
          try {
            await webpush.sendNotification(d.sub, JSON.stringify({ t: a.t, b: a.b, s: a.s, tag: a.id }), { TTL: 3600, urgency: 'high' });
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

    if (b.modo === 'quitar' && RURL) {
      const k = clave(b.endpoint);
      const [viejos] = await redis([['GET', 'avk:' + k]]);
      let prev = []; try { prev = JSON.parse(viejos || '[]'); } catch (e) {}
      await redis([['HDEL', 'tel', k], ['DEL', 'avk:' + k]].concat(prev.length ? [['ZREM', 'av'].concat(prev)] : []));
      return res.status(200).json({ ok: true });
    }
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
        .map(a => ({ id: txt(a.id, 80), at: +a.at, t: txt(a.t, 80) || 'Mamá al Día', b: txt(a.b, 160), s: txt(a.s, 300) }));
      const k = clave(s.endpoint);
      if (RURL) {
        const sub = { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
        const [viejos, ya] = await redis([['GET', 'avk:' + k], ['SMEMBERS', 'env:' + k]]);
        let prev = []; try { prev = JSON.parse(viejos || '[]'); } catch (e) {}
        const enviados = new Set(ya || []);
        const lista = avisos.filter(a => a.at > now - 60000 && !enviados.has(a.id));
        const nuevos = lista.map(a => JSON.stringify(Object.assign({ k }, a)));
        const cmds = [['HSET', 'tel', k, JSON.stringify({ sub, visto: now })]];
        if (prev.length) cmds.push(['ZREM', 'av'].concat(prev));
        if (nuevos.length) cmds.push(['ZADD', 'av'].concat(...nuevos.map((m, i) => [lista[i].at, m])));
        cmds.push(['SET', 'avk:' + k, JSON.stringify(nuevos), 'EX', 10 * 86400]);
        await redis(cmds);
        return res.status(200).json({ ok: true, guardados: nuevos.length, redis: true });
      }
      const todo = await leerJSON(TODO, { tel: {} });
      todo.tel = todo.tel || {};
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
      await webpush.sendNotification(s, JSON.stringify({ t: 'Mamá al Día', b: 'Así te llegarán los avisos, aunque la app esté cerrada 🌷', s: 'Hola, así te llegarán mis avisos. Toca el aviso y te lo digo en voz alta.', tag: 'prueba' }), { TTL: 600 });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'modo' });
  } catch (e) { return res.status(500).json({ error: 'avisos', detalle: String(e && e.message).slice(0, 120) }); }
};
