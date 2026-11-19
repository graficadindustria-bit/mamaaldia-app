// Función de Vercel: Lía con IA (Gemini). La clave vive solo en la variable GEMINI_API_KEY.
// La app manda el mensaje (texto o nota de voz) y recibe una respuesta cálida y frases ordenadas
// que el organizador de la app convierte en agenda, medicamentos, compras y gastos.
const crypto = require('crypto');
const CODIGOS = {
  'c6b231b8ad5fef167852607732839f6c21cc8acfbb4f19f3a41c0bcada16b171': 'creador',
  '78749e367ce2622016ecc1c0bc93fb828b548b56922e9bfd234dfe26e2581b71': 'creador',
  '09b692077df14e2b305f17ace152ee937fb2f896e5a0b99851026e3baa4ae4a5': 'invitada',
  '49dd5f1bc4e5f936780a642662ab1b71c74ebce2748281852fd84e0670f96e19': 'invitada',
  'ce6e24ba4269783e209fcfcb1f6b516b02acf72537b6c5018c630403731d19fc': 'invitada',
  '661d490dda8d316a78fdb0b0c7782f6d3b84d1e2145cbac143b7ad1d02e993c4': 'invitada'
};
const LIMITE = { creador: 300, invitada: 80 }; // mensajes por día (mejor esfuerzo)
const usos = {};
const MODELOS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
let catalogo = null, catalogoT = 0;
async function modelos(key) {
  if (catalogo && Date.now() - catalogoT < 6 * 3600e3) return catalogo;
  let nombres = [];
  try {
    const r = await fetch(API + '?pageSize=1000', { headers: { 'x-goog-api-key': key } });
    if (r.ok) { const j = await r.json(); nombres = (j.models || []).filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0).map(m => m.name.replace(/^models\//, '')); }
  } catch (e) {}
  const ver = n => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
  const texto = nombres.filter(n => /flash/.test(n) && !/tts|image|live|audio|embed|thinking|exp|vision|native/.test(n))
    .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (/preview/.test(a) - /preview/.test(b)) || ver(b) - ver(a)).slice(0, 4);
  const tts = nombres.filter(n => /tts/.test(n)).sort((a, b) => (/flash/.test(b) - /flash/.test(a)) || ver(b) - ver(a));
  catalogo = { texto: [...new Set(MODELOS.concat(texto))], tts: [...new Set(tts.concat(['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts']))], todos: nombres };
  catalogoT = Date.now();
  return catalogo;
}
async function pedir(lista, cuerpo, key) {
  let r, mejor = null;
  for (let n = 0; n < lista.length; n++) {
    r = await fetch(API + '/' + lista[n] + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: cuerpo });
    if (r.ok) return r;
    if (r.status !== 404 && !mejor) mejor = r.clone();
    if ([400, 404, 429, 500, 503].indexOf(r.status) < 0) break;
  }
  return mejor || r;
}
const VOZ = process.env.LIA_VOZ || 'Sulafat';

const SYS = `Eres Lía, la asistente de la app "Mamá al Día" para mamás de Bolivia con hijos pequeños.
Hablas en español de Bolivia, tuteas, eres cálida, breve y práctica, como una amiga organizada. Nunca juzgas.

Recibirás un JSON con: "hoy" (fecha y día de la semana), "hora", "mama", "peque" (nombre y edad), "contexto" (medicamentos activos, pagos fijos, productos que duran) y "historial" (últimos mensajes). Además recibirás el mensaje de la mamá como texto o como nota de voz (audio).

Tu trabajo:
1. Entender todo lo que dijo, aunque venga desordenado, con muletillas o varias cosas juntas.
2. Todo lo que va a la AGENDA (citas, clases, actividades, rutinas, cumpleaños, compromisos) ponlo en "eventos", aunque ella diga "recuérdame" o "ayúdame a recordar":
   {"titulo":"Natación de Alya","tipo":"clase","dias":["lunes","miercoles","viernes"],"hora":"10:00","hora_fin":"12:00","para":"peque"}
   {"titulo":"Control con la pediatra","tipo":"salud","fecha":"2026-11-27","hora":"10:00","para":"peque"}
   - "tipo": salud (médico, vacuna, terapia), clase (natación, kínder, talleres), familia (cumpleaños, visitas, paseos), mama (cosas de ella: trabajo, gimnasio, trámites).
   - Si se repite cada semana usa "dias" (en minúsculas, sin tildes) y no pongas "fecha". Si es una vez usa "fecha" (AAAA-MM-DD) calculada desde "hoy".
   - "hora" y "hora_fin" en 24 h HH:MM ("de 10 a 12 del mediodía" = 10:00 a 12:00). Si no dijo hora, omítela.
   Las tareas sueltas (pagar, llamar, comprar algo puntual, trámites) van en "pendientes": {"texto":"Pagar la luz","fecha":"2026-11-20","hora":"09:00"} (fecha y hora solo si las dijo).
   Lo demás sepáralo en "frases": oraciones cortas y claras, una por cosa, con este formato para que la app las ordene:
   - Medicamentos (solo si ella dio el nombre y la frecuencia, nunca inventes dosis): "Paracetamol 5 ml cada 6 horas por 3 días" ; si ya se lo dio: "Le di paracetamol 5 ml cada 6 horas"
   - Terminar un medicamento: "Terminó el paracetamol" ; si ya se sanó: "Ya está sana"
   - Fiebre o síntomas: "Fiebre 38,5 grados" o "Tiene tos"
   - Compras hechas: "Compré verduras, pollo y leche Bs 120"
   - Cosas por comprar: "Hay que comprar pañales y leche"
   - Gastos: "Pagué el internet Bs 150" o "Gasté Bs 80 en farmacia"
   - Pagos fijos: "Pre kínder Bs 1800 cada mes el día 5"
   - Tope de gasto: "Tope de comida Bs 1200 al mes"
   - Productos que duran: "La crema de Sofi dura 2 meses, cuesta Bs 330"
   - Gustos de comida: "No le gustó el brócoli" o "Le encantó la sopa de quinua"
   - Lugares: "Guarda lugar: parque Urbano con juegos para bebés"
   - Resumen: si pide cómo va, su semana o cuánto gastó, pon la frase "¿Cómo voy esta semana?"
   - Algo para recordar sin fecha ni categoría: "Nota: ..."
   Convierte "mañana", "el viernes", "la otra semana" en fecha exacta "el D de mes" usando "hoy". Horas en formato 24 h "a las HH:MM". Montos como "Bs N".
   Si solo conversa, pregunta algo o pide un consejo, deja "frases" vacío.
3. Escribir "respuesta": máximo 45 palabras, cálida y natural, para leerse en voz alta. Si guardaste cosas, confírmalo en una frase sin repetir todo (la app muestra el detalle). Si pregunta algo (ideas de comida, rutinas, juegos, organización), responde con ideas concretas y breves.
4. Si es nota de voz, pon en "transcripcion" lo que dijo, limpio y sin muletillas.

Salud: eres guía general, no médica. No diagnosticas ni indicas dosis. Con fiebre de 39 °C o más, dificultad para respirar, decaimiento fuerte, deshidratación o un bebé menor de 3 meses con fiebre, dile con calma que llame al pediatra o vaya a emergencias. Si la mamá se nota agotada o triste, respóndele con cariño y recuérdale que pedir ayuda está bien.
No inventes datos que ella no dio. No pidas datos personales.

Nunca pongas una cita, clase o pendiente en "frases" ni como nota: van en "eventos" o "pendientes".

Responde SOLO con JSON: {"respuesta":"...","eventos":[],"pendientes":[],"frases":[],"transcripcion":"..."}`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const h = crypto.createHash('sha256').update(String(b.codigo || '').toUpperCase().replace(/\s+/g, '')).digest('hex');
  const tipo = CODIGOS[h];
  if (!tipo) return res.status(401).json({ error: 'codigo' });
  if (b.modo === 'probar') return res.status(200).json({ ok: true, tipo, ia: !!process.env.GEMINI_API_KEY });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'sin-clave' });
  const cat = await modelos(key);
  if (b.modo === 'diag') return res.status(200).json({ texto: cat.texto, tts: cat.tts, total: cat.todos.length });
  if (b.modo === 'voz') {
    const frase = String(b.texto || '').slice(0, 500);
    if (!frase) return res.status(400).json({ error: 'vacio' });
    try {
      const r = await pedir(cat.tts, JSON.stringify({
        contents: [{ parts: [{ text: 'Dilo en español latinoamericano con voz femenina suave, cálida y melodiosa, sonriendo, con calma, como una amiga cariñosa: ' + frase }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOZ } } } }
      }), key);
      if (!r || !r.ok) return res.status(502).json({ error: 'voz', estado: r && r.status });
      const j = await r.json();
      const part = ((((j.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData);
      if (!part) return res.status(502).json({ error: 'voz-vacia' });
      const rate = +((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || 24000);
      return res.status(200).json({ audio: part.inlineData.data, mime: part.inlineData.mimeType, rate });
    } catch (e) { return res.status(502).json({ error: 'red' }); }
  }

  const texto = typeof b.texto === 'string' ? b.texto.slice(0, 4000) : '';
  const audio = typeof b.audio === 'string' ? b.audio : '';
  const mime = /^audio\/[a-z0-9.+-]+$/i.test(b.mime || '') ? String(b.mime).split(';')[0] : 'audio/webm';
  if (!texto && !audio) return res.status(400).json({ error: 'vacio' });
  if (audio.length > 4000000) return res.status(413).json({ error: 'audio-largo' });
  const ctx = JSON.stringify(b.ctx || {}).slice(0, 6000);

  const dia = new Date().toISOString().slice(0, 10), k = dia + h;
  usos[k] = (usos[k] || 0) + 1;
  if (usos[k] > LIMITE[tipo]) return res.status(429).json({ error: 'limite' });

  const parts = [{ text: 'Datos: ' + ctx }];
  if (audio) parts.push({ text: 'Mensaje de la mamá (nota de voz):' }, { inlineData: { mimeType: mime, data: audio } });
  else parts.push({ text: 'Mensaje de la mamá: ' + texto });

  try {
    const cuerpo = JSON.stringify({
      systemInstruction: { parts: [{ text: SYS }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 2000, responseMimeType: 'application/json' }
    });
    let r = await pedir(cat.texto, cuerpo, key);
    if (!r.ok) {
      let d = '';
      try { const e = await r.json(); d = (e.error && (e.error.message || e.error.status)) || ''; } catch (x) {}
      return res.status(502).json({ error: 'ia', estado: r.status, detalle: String(d).slice(0, 200) });
    }
    const j = await r.json();
    const out = (((j.candidates || [])[0] || {}).content || {}).parts;
    let t = out ? out.map(p => p.text || '').join('') : '';
    t = t.replace(/^```(?:json)?\s*|\s*```$/g, '');
    let o;
    try { o = JSON.parse(t); } catch (e) { o = { respuesta: t.slice(0, 400), frases: [] }; }
    const frases = Array.isArray(o.frases) ? o.frases.filter(x => typeof x === 'string' && x.trim()).slice(0, 15) : [];
    const lista = x => Array.isArray(x) ? x.filter(e => e && typeof e === 'object').slice(0, 12) : [];
    res.status(200).json({
      respuesta: String(o.respuesta || '').slice(0, 600),
      eventos: lista(o.eventos),
      pendientes: lista(o.pendientes),
      frases,
      transcripcion: String(o.transcripcion || '').slice(0, 4000),
      restantes: LIMITE[tipo] - usos[k]
    });
  } catch (e) { res.status(502).json({ error: 'red', detalle: String(e && e.message).slice(0, 120) }); }
};
