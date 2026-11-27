// Códigos de acceso (hash SHA-256). Compartido por las funciones.
const CODIGOS = {
  '15663b794ec496a1fa34dd7d7a7156148d42d1ba09c6eb009e26a6c3c778b2bd': 'creador',
  'c6b231b8ad5fef167852607732839f6c21cc8acfbb4f19f3a41c0bcada16b171': 'creador',
  '78749e367ce2622016ecc1c0bc93fb828b548b56922e9bfd234dfe26e2581b71': 'creador',
  '09b692077df14e2b305f17ace152ee937fb2f896e5a0b99851026e3baa4ae4a5': 'invitada',
  '49dd5f1bc4e5f936780a642662ab1b71c74ebce2748281852fd84e0670f96e19': 'invitada',
  'ce6e24ba4269783e209fcfcb1f6b516b02acf72537b6c5018c630403731d19fc': 'invitada',
  '661d490dda8d316a78fdb0b0c7782f6d3b84d1e2145cbac143b7ad1d02e993c4': 'invitada'
};

// Códigos Pro: llevan dentro su fecha de vencimiento y una firma, así no hay que guardarlos en ningún lado.
// Forma: MD-P + vencimiento (días desde 1970, base 36, 4 letras) + 3 letras al azar + firma de 6.
// La firma usa PRO_SECRETO, o si no existe, una clave derivada de GEMINI_API_KEY (si se cambia esa clave, los códigos Pro dejan de valer).
const crypto = require('crypto');
const norm = c => String(c || '').toUpperCase().replace(/\s+/g, '');
const hashDe = c => crypto.createHash('sha256').update(norm(c)).digest('hex');
function secreto() {
  const s = process.env.PRO_SECRETO || (process.env.GEMINI_API_KEY ? 'mad-pro|' + process.env.GEMINI_API_KEY : '');
  return s ? crypto.createHash('sha256').update(s).digest() : null;
}
const AZ = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para no confundir con 1 y 0
function firma(cuerpo, clase) {
  const k = secreto(); if (!k) return '';
  const d = crypto.createHmac('sha256', k).update((clase === 'T' ? 'prueba:' : 'pro:') + cuerpo).digest();
  let o = ''; for (let i = 0; i < 6; i++) o += AZ[d[i] % AZ.length]; return o;
}
const ymd = dias => new Date(dias * 86400000).toISOString().slice(0, 10);
// clase 'P' = Pro pagado; clase 'T' = prueba completa de 40 días (se entrega sola a cada celular nuevo)
function crearPro(dias, clase) {
  clase = clase === 'T' ? 'T' : 'P';
  const vence = Math.floor(Date.now() / 86400000) + Math.max(1, Math.min(800, Math.round(dias)));
  const v = vence.toString(36).toUpperCase().padStart(4, '0');
  let r = ''; const b = crypto.randomBytes(3); for (let i = 0; i < 3; i++) r += AZ[b[i] % AZ.length];
  const f = firma(v + r, clase); if (!f) return null;
  return { codigo: 'MD-' + clase + v + r + f, vence: ymd(vence) };
}
// Devuelve { tipo, vence?, h } o null si el código no vale. tipo: creador | invitada | pro | vencido
function tipoDe(codigo) {
  const c = norm(codigo), h = hashDe(c);
  if (CODIGOS[h]) return { tipo: CODIGOS[h], h };
  const m = /^MD-([PT])([0-9A-Z]{4})([0-9A-Z]{3})([0-9A-Z]{6})$/.exec(c);
  if (!m) return null;
  const f = firma(m[2] + m[3], m[1]);
  if (!f || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(m[4]))) return null;
  const vence = parseInt(m[2], 36), prueba = m[1] === 'T';
  if (Math.floor(Date.now() / 86400000) > vence) return { tipo: 'vencido', prueba, vence: ymd(vence), h };
  return { tipo: prueba ? 'prueba' : 'pro', vence: ymd(vence), h };
}
module.exports = { CODIGOS, tipoDe, crearPro, hashDe };
