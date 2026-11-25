// Lugares recomendados por las mamás (comunidad). Guarda en Vercel Blob (tienda privada).
// GET  /api/lugares?ciudad=Santa%20Cruz      -> lista de lugares
// GET  /api/lugares?foto=ID                   -> foto del lugar
// POST {codigo, lugar:{...}, foto?:base64}    -> agrega un lugar
// POST {codigo, modo:'reportar', id}          -> reporta un lugar (se oculta con 3 reportes)
// POST {codigo, modo:'borrar', id}            -> borra (solo creador)
const crypto = require('crypto');
const { put, get } = require('@vercel/blob');
const { tipoDe } = require('./_codigos');
const INDICE = 'lugares/indice.json';
const TIPOS = ['parque', 'restaurante', 'medico', 'especialista', 'otro'];

async function leer() {
  try {
    const r = await get(INDICE, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return [];
    const txt = await new Response(r.stream).text();
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
async function guardar(lista) {
  await put(INDICE, JSON.stringify(lista), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60 });
}
const txt = (x, n) => String(x || '').replace(/[<>]/g, '').trim().slice(0, n);

module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return res.status(503).json({ error: 'sin-tienda' });
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.foto) {
        const id = String(q.foto).replace(/[^a-z0-9]/gi, '');
        const r = await get('fotos/' + id + '.jpg', { access: 'private' });
        if (!r || r.statusCode !== 200) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
        return res.status(200).end(buf);
      }
      res.setHeader('Cache-Control', 'no-store');
      const ciudad = txt(q.ciudad, 40).toLowerCase();
      let l = (await leer()).filter(x => (x.reportes || 0) < 3);
      if (ciudad) l = l.filter(x => (x.ciudad || '').toLowerCase() === ciudad);
      return res.status(200).json({ lugares: l.sort((a, b) => b.ts - a.ts).slice(0, 200).map(({ reportes, reportaron, ...x }) => x) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const cod = tipoDe(b.codigo);
    if (!cod || cod.tipo === 'vencido') return res.status(401).json({ error: 'codigo' });
    const tipo = cod.tipo, h = cod.h;
    const lista = await leer();
    if (b.modo === 'reportar' || b.modo === 'borrar') {
      const x = lista.find(l => l.id === b.id);
      if (!x) return res.status(404).json({ error: 'no-existe' });
      if (b.modo === 'borrar') {
        if (tipo !== 'creador' && x.autor !== h.slice(0, 12)) return res.status(403).json({ error: 'permiso' });
        lista.splice(lista.indexOf(x), 1);
      } else {
        x.reportaron = x.reportaron || [];
        if (x.reportaron.indexOf(h.slice(0, 12)) < 0) { x.reportaron.push(h.slice(0, 12)); x.reportes = x.reportaron.length; }
      }
      await guardar(lista);
      return res.status(200).json({ ok: true });
    }
    const l = b.lugar || {};
    const nombre = txt(l.nombre, 80);
    if (!nombre) return res.status(400).json({ error: 'nombre' });
    const hoy = lista.filter(x => x.autor === h.slice(0, 12) && Date.now() - x.ts < 864e5).length;
    if (hoy >= 20) return res.status(429).json({ error: 'limite' });
    const id = crypto.randomBytes(8).toString('hex');
    let foto = false;
    if (typeof b.foto === 'string' && b.foto.length > 100 && b.foto.length < 2500000) {
      await put('fotos/' + id + '.jpg', Buffer.from(b.foto, 'base64'), { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false });
      foto = true;
    }
    const maps = /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(l.maps || '') ? txt(l.maps, 300) : '';
    const nuevo = {
      id, ts: Date.now(), nombre,
      tipo: TIPOS.indexOf(l.tipo) >= 0 ? l.tipo : 'otro',
      ciudad: txt(l.ciudad, 40), zona: txt(l.zona, 80), edad: txt(l.edad, 40), nota: txt(l.nota, 300),
      maps, foto, por: txt(l.por, 30) || 'Una mamá', autor: h.slice(0, 12)
    };
    lista.push(nuevo);
    await guardar(lista);
    return res.status(200).json({ ok: true, lugar: nuevo });
  } catch (e) {
    return res.status(502).json({ error: 'tienda', detalle: String(e && e.message).slice(0, 160) });
  }
};
