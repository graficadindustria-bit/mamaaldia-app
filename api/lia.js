// Función de Vercel: Lía con IA (Gemini). La clave vive solo en la variable GEMINI_API_KEY.
// La app manda el mensaje (texto o nota de voz) y recibe una respuesta cálida y frases ordenadas
// que el organizador de la app convierte en agenda, medicamentos, compras y gastos.
const crypto = require('crypto');
const { tipoDe, crearPro } = require('./_codigos');
const { GUIA_VOCES } = require('./_guia');
// Voces del recorrido guiado: se crean una sola vez con la voz de Lía y quedan guardadas (Vercel Blob) para todas las mamás.
let blob = null; try { blob = require('@vercel/blob'); } catch (e) {}
const hayBlob = () => blob && (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
async function guiaLeer(h) {
  if (!hayBlob()) return null;
  try { const r = await blob.get('guia-voz/' + h + '.json', { access: 'private', useCache: false }); if (!r || r.statusCode !== 200) return null; return JSON.parse(await new Response(r.stream).text()); } catch (e) { return null; }
}
async function guiaGuardar(h, o) {
  if (!hayBlob()) return;
  try { await blob.put('guia-voz/' + h + '.json', JSON.stringify(o), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false }); } catch (e) {}
}
const guiaMemo = {};
const LIMITE = { creador: 300, invitada: 80, pro: 60, prueba: 40 }; // mensajes por día (mejor esfuerzo)
const PRUEBA_SEMANA = 10, PRUEBA_TOTAL_DIA = 400, DIAS_PRUEBA = 40, PRUEBAS_NUEVAS_DIA = 300; // plan Gratis: 10 mensajes con IA por semana y por celular; tope total por día
// Contador: en Redis (Upstash) si está conectado; si no, en memoria (mejor esfuerzo).
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const memo = {};
async function contar(clave, segundos) {
  if (RURL && RTOK) {
    try {
      const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify([['INCR', clave], ['EXPIRE', clave, String(segundos)]]), signal: AbortSignal.timeout(3000) });
      if (r.ok) return +(await r.json())[0].result;
    } catch (e) {}
  }
  return (memo[clave] = (memo[clave] || 0) + 1);
}
const semana = () => { const d = new Date(Date.now() - 4 * 3600000); const l = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7)); return l.toISOString().slice(0, 10); };
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
  const lite = nombres.filter(n => /flash-lite/.test(n) && !/tts|image|live|audio|embed|thinking|exp|vision|native/.test(n))
    .sort((a, b) => (/preview/.test(a) - /preview/.test(b)) || ver(b) - ver(a)).slice(0, 2);
  catalogo = { rapido: [...new Set(MODELOS.concat(texto).slice(0, 4).concat(lite, ['gemini-flash-lite-latest']))], texto: [...new Set(MODELOS.concat(texto))], tts: [...new Set(tts.concat(['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts']))], todos: nombres };
  catalogoT = Date.now();
  return catalogo;
}
// Respuestas rápidas: le pedimos al modelo que "piense" lo mínimo (si el modelo no lo acepta, se reintenta sin esto).
function conRapidez(cuerpo, modelo) {
  // medido en producción (20-nov-2026): con esto responden en ~1 s; con otros valores tardan o dan error
  const tc = { 'gemini-3-flash-preview': { thinkingLevel: 'minimal' }, 'gemini-3.1-flash-lite-preview': { thinkingBudget: 0 } }[modelo] || null;
  if (!tc) return null;
  return JSON.stringify(Object.assign({}, cuerpo, { generationConfig: Object.assign({}, cuerpo.generationConfig, { thinkingConfig: tc }) }));
}
// Pide al modelo más rápido; si en unos segundos no contesta, lanza el siguiente en paralelo y se queda con el primero que responda.
// Google a veces está saturado (503) o sin cupo (429): así la mamá no espera a que uno falle para probar otro.
const RAPIDOS = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.5-flash-lite'];
function pedirYa(lista, cuerpo, key, paso, maxMs) {
  return new Promise(resolve => {
    let fin = false, vivos = 0, i = 0, ultimo = null, timer = null;
    const ctls = [];
    const lanzar = () => {
      if (fin || i >= lista.length) return;
      const m = lista[i++], ctl = new AbortController(); ctls.push(ctl); vivos++;
      const t = setTimeout(() => ctl.abort(), Math.max(3000, Math.min(maxMs, (limiteT || Date.now() + 55000) - Date.now() - 2000)));
      const rap = conRapidez(cuerpo, m);
      fetch(API + '/' + m + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: rap || JSON.stringify(cuerpo), signal: ctl.signal })
        .then(r => { if (r.ok && !fin) { fin = true; clearTimeout(timer); pedir.ultimo = m; ctls.forEach(c => c !== ctl && c.abort()); resolve(r); } else { ultimo = r; } })
        .catch(() => {})
        .finally(() => { clearTimeout(t); vivos--; if (!fin) { if (i < lista.length) { clearTimeout(timer); lanzar(); timer = setTimeout(lanzar, paso); } else if (!vivos) { fin = true; resolve(ultimo || { ok: false, status: 504, json: async () => ({}) }); } } });
    };
    lanzar(); timer = setTimeout(function seguir() { lanzar(); if (!fin && i < lista.length) timer = setTimeout(seguir, paso); }, paso);
  });
}
let limiteT = 0; // hora en que la función debe responder sí o sí (Vercel corta a los 60 s)
async function pedir(lista, cuerpo, key, maxMs) {
  let r, mejor = null;
  for (let n = 0; n < lista.length; n++) {
    const queda = (limiteT || Date.now() + 55000) - Date.now();
    if (queda < 4000) break;
    try {
      const ir = c => fetch(API + '/' + lista[n] + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: c, signal: AbortSignal.timeout(Math.min(maxMs || 30000, (limiteT || Date.now() + 55000) - Date.now() - 2000)) });
      const rapido = typeof cuerpo === 'string' ? null : conRapidez(cuerpo, lista[n]);
      if (rapido) { r = await ir(rapido); if (r.status === 400) r = await ir(JSON.stringify(cuerpo)); }
      else r = await ir(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
    } catch (e) { r = { ok: false, status: 504, clone() { return this; }, json: async () => ({ error: { message: 'tiempo' } }) }; if (!mejor) mejor = r; continue; }
    if (r.ok) { pedir.ultimo = lista[n]; return r; }
    if (r.status !== 404 && !mejor) mejor = r.clone();
    if ([400, 404, 429, 500, 503].indexOf(r.status) < 0) break;
  }
  return mejor || r;
}
const VOZ = process.env.LIA_VOZ || 'Despina';
const ESTILOS = { serena: 'Di con voz cálida, serena y profesional, con acento latinoamericano neutro: ', corto: 'Di con voz cálida y serena, en español latinoamericano: ', calma: 'Read aloud in Latin American Spanish with a neutral Bolivian accent (never Spain or Galician accent: pronounce c and z like s, use seseo), in a calm, warm, soothing and professional tone, at a natural pace: ' };
const ESTILO = process.env.LIA_ESTILO || ''; // sin instrucción de tono: a veces la voz la leía en voz alta
const VOCES = ['Sulafat', 'Vindemiatrix', 'Achernar', 'Despina', 'Gacrux', 'Erinome', 'Aoede', 'Callirrhoe', 'Kore', 'Leda', 'Autonoe'];
// Consultas de salud (dolor, fiebre, remedios) a veces las bloquea el filtro por defecto: se deja solo el bloqueo de lo muy grave.
const SEGURIDAD = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));
const GUIA = `Eres Lía, guía cálida de la app "Mamá al Día" para mamás de Bolivia. Una mamá te consulta algo sobre su hijo o hija, que puede tener de 0 a 18 años (o sobre ella). Adapta todo a la edad que viene en los datos y, si tiene una condición o cuidado especial (autismo, síndrome de Down, TDAH, asma, diabetes u otra), tenla en cuenta con respeto, sin etiquetar, y menciona cuándo conviene avisar también a su especialista o terapeuta. Tu misión: darle paz, tranquilidad y una guía clara y correcta, y ser un puente hacia el pediatra, nunca reemplazarlo.
Tú solo orientas sobre la salud de los hijos (y de la mamá en el embarazo, el posparto o la lactancia). Si la consulta es sobre la salud de otro adulto (la pareja, un abuelo u otra persona), no des la guía: responde solo, con calidez y en 2 o 3 frases, que Lía está pensada para acompañar la salud y la organización de los hijos, que para esa consulta lo mejor es acudir a su médico (o a emergencias si es fuerte o no mejora), y que con gusto le ayudas con lo de sus hijos.
Busca en internet información de fuentes confiables (Asociación Americana de Pediatría/HealthyChildren.org, OMS, UNICEF, Mayo Clinic, MedlinePlus, sociedades de pediatría) y básate en ella. Si hay una foto, obsérvala con cuidado y describe lo que ves sin afirmar un diagnóstico.
Quien consulta puede ser mamá, papá u otra persona que cuida: si en los datos "rol" es "papa", háblale como a un papá; si no se sabe, usa palabras sin género. Escribe en español de Bolivia, tuteando (o de usted si en los datos viene "trato":"usted"), con cariño y frases cortas. Nunca recomiendes collares de ámbar, miel a menores de 1 año, benzocaína ni jarabes para la tos en menores de 2 años. Máximo 230 palabras. Usa exactamente este formato (sin #, sin tablas):
Una o dos frases para calmarla y validar lo que siente.
**Lo que puede ser:** 2 o 3 causas comunes y en general leves, con palabras simples (son posibilidades, no un diagnóstico).
**Qué puedes hacer ahora:**
- 3 o 4 cuidados seguros en casa
**Ve a emergencias de inmediato si:**
- las señales de alarma concretas para este caso
**Llévalo al pediatra:** cuándo (hoy, en 24-48 h, o si no mejora en X días).
**Para tu consulta:** qué anotar o fotografiar para mostrarle al pediatra.
Cierra con una frase de ánimo.
No indiques medicamentos con dosis ni recetes antibióticos o cremas con corticoides; si un medicamento podría ayudar, di que lo consulte con el pediatra. Si el peque es menor de 3 meses con fiebre, o hay dificultad para respirar, labios morados, decaimiento fuerte, manchas que no desaparecen al presionar, convulsión o deshidratación: lo primero es ir a emergencias.`;
async function guia(cat, key, ctx, consulta, img, buscar) {
  const parts = [{ text: 'Datos de la familia: ' + ctx }, { text: 'Consulta: ' + consulta }];
  if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
  const base = { systemInstruction: { parts: [{ text: GUIA }] }, contents: [{ role: 'user', parts }], safetySettings: SEGURIDAD, generationConfig: { temperature: 0.4, maxOutputTokens: 2500 } };
  let r = buscar ? await pedirYa(['gemini-3-flash-preview'].concat(cat.texto.slice(0, 2)), Object.assign({ tools: [{ google_search: {} }] }, base), key, 9000, 25000) : null;
  if (!r || !r.ok) r = await pedirYa(RAPIDOS, base, key, 3500, 15000);
  if (!r || !r.ok) return null;
  const j = await r.json();
  const c = (j.candidates || [])[0] || {};
  const texto = ((c.content || {}).parts || []).map(p => p.text || '').join('').trim();
  const vistos = {};
  const fuentes = (((c.groundingMetadata || {}).groundingChunks) || []).map(g => g.web).filter(w => w && w.uri && !vistos[w.title] && (vistos[w.title] = 1)).slice(0, 4).map(w => ({ titulo: String(w.title || 'Fuente').slice(0, 80), url: w.uri }));
  return texto ? { texto: texto.slice(0, 2500), fuentes } : null;
}

const SYS = `Eres Lía, la asistente de la app "Mamá al Día" para mamás de Bolivia con hijos de 0 a 18 años (bebés, niños y adolescentes).
Hablas en español de Bolivia, tuteas, eres cálida, breve y práctica, como una amiga organizada. Nunca juzgas.

Recibirás un JSON con: "hoy" (fecha y día de la semana), "hora", "mama", "peque" (nombre, edad y condición o cuidado especial si la hay), "contexto" (medicamentos activos, pagos fijos, productos que duran) y "historial" (últimos mensajes). Además recibirás el mensaje de la mamá como texto o como nota de voz (audio).

Tu trabajo:
1. Entender todo lo que dijo, aunque venga desordenado, con muletillas o varias cosas juntas.
2. Todo lo que va a la AGENDA (citas, clases, actividades, rutinas, cumpleaños, compromisos) ponlo en "eventos", aunque ella diga "recuérdame" o "ayúdame a recordar":
   {"titulo":"Natación de Alya","tipo":"clase","dias":["lunes","miercoles","viernes"],"hora":"10:00","hora_fin":"12:00","para":"peque"}
   {"titulo":"Control con la pediatra","tipo":"salud","fecha":"2026-11-27","hora":"10:00","para":"peque"}
   - "tipo": salud (médico, vacuna, terapia), clase (natación, kínder, talleres), familia (cumpleaños, visitas, paseos), mama (cosas de ella: trabajo, gimnasio, trámites).
   - Si se repite cada semana usa "dias" (en minúsculas, sin tildes) y no pongas "fecha". Si es una vez usa "fecha" (AAAA-MM-DD) calculada desde "hoy".
   - "hora" y "hora_fin" en 24 h HH:MM ("de 10 a 12 del mediodía" = 10:00 a 12:00). Si no dijo hora, omítela.
   Las tareas sueltas (pagar, llamar, comprar algo puntual, trámites) van en "pendientes": {"texto":"Pagar la luz","fecha":"2026-11-20","hora":"09:00"} (fecha y hora solo si las dijo).
   Precios de productos con el lugar donde compró van en "precios": {"producto":"tomate","precio":8,"unidad":"kilo","lugar":"La Ramada"} (unidad: kilo, unidad, litro, libra, docena o paquete).
   Lo demás sepáralo en "frases": oraciones cortas y claras, una por cosa, con este formato para que la app las ordene:
   - Medicamentos (solo si ella dio el nombre y la frecuencia, nunca inventes dosis): "Paracetamol 5 ml cada 6 horas por 3 días" ; si dijo a qué hora empieza, agrégalo: "Amoxicilina 5 ml cada 8 horas por 7 días desde las 14:00" ; si ya se lo dio: "Le di paracetamol 5 ml cada 6 horas"
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
3. Si pide consejo de crianza, conducta, escuela, bullying, emociones, sueño, alimentación, rutinas, juegos o desarrollo (sin síntomas de enfermedad), respóndele tú misma en "respuesta" (hasta 130 palabras): una frase de empatía y luego 3 a 5 ideas concretas en líneas que empiecen con "- ", adaptadas a la edad; si hay señales de riesgo, sugiere hablar con la escuela, la psicóloga o el pediatra. Ahí "consulta" va false.
   Solo si es de SALUD física (síntomas, fiebre, piel, golpes, enfermedad, medicamentos) o manda una foto de algo que le preocupa, pon "consulta": true y en "tema" resume en una línea qué consulta (por ejemplo "sarpullido rojo en el brazo izquierdo de niña de 3 años"). Otra app preparará la guía completa; tú solo pon en "respuesta" una frase breve y cariñosa.
   Si manda una foto, descríbela con cuidado en "tema".
4. Escribir "respuesta": máximo 45 palabras (salvo los consejos del punto 3), cálida y natural, para leerse en voz alta. Si guardaste cosas, confírmalo en una frase sin repetir todo (la app muestra el detalle). Si pregunta algo (ideas de comida, rutinas, juegos, organización), responde con ideas concretas y breves.
5. Si es nota de voz, pon en "transcripcion" lo que dijo, limpio y sin muletillas.
6. MENÚ POR DÍAS: si pide un menú, minuta o plan de comidas (para la semana, 15 días, 20 días, un mes o los días que diga) para un hijo, arma "menu":
   {"para":"Alya","desde":"AAAA-MM-DD","dias":[["desayuno","media mañana","almuerzo","merienda","cena"], ...]}
   - Un elemento en "dias" por cada día pedido, en orden. "semana" = 7, "quincena" = 15, "un mes" = 30; máximo 31. Si no dice cuántos días, 7.
   - "desde" es hoy, salvo que diga otra fecha ("la próxima semana" = el próximo lunes).
   - Usa los datos de "hijos": si dice un nombre o una edad ("mi niña de 2 años"), es ese hijo. Si tiene un solo hijo, es ese. Si tiene varios y no queda claro para cuál, NO armes el menú: en "respuesta" pregúntale para cuál, nombrando a sus hijos con su edad, o si lo quiere para todos. Si pide uno para todos, "para":"Toda la familia" y adáptalo al menor.
   - Adáptalo a la edad: menor de 6 meses no lleva menú (solo leche materna o fórmula; explícalo en "respuesta" y no pongas "menu"); de 6 a 11 meses papillas y purés sin sal, sin azúcar y sin miel; de 1 a 2 años trocitos blandos, sin azúcar y con poca sal; niños y adolescentes, porciones de su edad. Respeta "alergias", "no_le_gusta" y su condición (por ejemplo diabetes o celiaquía).
   - Comidas caseras de Bolivia, sencillas, económicas y variadas: no repitas el mismo almuerzo ni la misma cena en una semana. Cada comida en 3 a 9 palabras, sin cantidades.
   - En "respuesta" (máx. 40 palabras) dile para quién y cuántos días es, y que lo ve abajo y en Menú; no escribas el menú en "respuesta". Las comidas del menú no van en "eventos", "pendientes" ni "frases".

Si el peque tiene una condición (autismo, síndrome de Down, TDAH, asma, diabetes u otra), tenla en cuenta con respeto y sin etiquetas, adaptando tus ideas a su edad y necesidades.
Salud: eres guía general, no médica. No diagnosticas ni indicas dosis. Con fiebre de 39 °C o más, dificultad para respirar, decaimiento fuerte, deshidratación o un bebé menor de 3 meses con fiebre, dile con calma que llame al pediatra o vaya a emergencias. Si la mamá se nota agotada o triste, respóndele con cariño y recuérdale que pedir ayuda está bien.
Lía está pensada solo para la gestión de los hijos y la organización de la familia alrededor de ellos (agenda, salud de los hijos, comidas, compras, gastos, crianza) y para la mamá en el embarazo, el posparto o la lactancia. Si preguntan algo fuera de eso (por ejemplo la salud de la pareja o de otro adulto, o temas que no tienen que ver con los hijos ni con el hogar), "consulta" va false y en "respuesta" dile con calidez, en 1 o 2 frases, que tú acompañas en todo lo de sus hijos y la organización familiar, que para eso lo mejor es consultar a quien corresponde (por ejemplo su médico, o emergencias si es fuerte o no mejora) y que con gusto le ayudas con lo de sus hijos. No suenes a error ni a falla: nada de "no puedo escucharte", "tengo problemas" ni "no pude procesar".
Nota de voz: escúchala con atención aunque tenga ruido, se oiga bajito o hable rápido, y responde a lo que dijo. Nunca respondas "no puedo escucharte" ni que no oyes. Solo si el audio está realmente en silencio o no se entiende ninguna palabra, pon "no_entendi": true, "respuesta" vacía y "transcripcion" vacía.
Si en el historial hay mensajes de Lía diciendo que no pudo escuchar, ignóralos y no los repitas.
Entiende a la mamá aunque hable de forma general, incompleta o con palabras de Bolivia ("mi wawa", "la nena", "el pequeño", "pasado mañana", "el finde", "a las 4 de la tarde"). Deduce lo más probable con el historial y los datos (si tiene un solo hijo, es ese). Si pide algo vago ("ayúdame con la comida de la semana", "organízame el día"), propón algo concreto en vez de pedirle que sea más específica. Solo pregunta si falta algo imprescindible (por ejemplo la hora de una cita), y aun así guarda lo que ya se puede guardar.
No inventes datos que ella no dio. No pidas datos personales.

Nunca pongas una cita, clase o pendiente en "frases" ni como nota: van en "eventos" o "pendientes".
Guarda solo lo que la mamá dijo que pasó o que quiere anotar. Las ideas o rutinas que TÚ sugieres (menús, horarios, juegos) van solo en "respuesta", nunca en "eventos", "pendientes" ni "frases", salvo que ella pida agendarlas.
Si registras "precios", no agregues además una frase de compra o gasto con esos mismos productos (se contaría dos veces), salvo que ella diga cuánto pagó en total.
Quien usa la app puede ser mamá, papá u otra persona que cuida. El JSON trae "rol" ("mama", "papa", "otro" o vacío). Si es "papa", háblale como a un papá ("un papá muy atento"); si es "mama", como a una mamá; si es "otro" o viene vacío, usa palabras sin género (por ejemplo "lo estás haciendo muy bien" en vez de "eres una mamá atenta"). No adivines el género por el nombre.
Trato: si en el historial ella pidió que la trates de usted, o el JSON trae "trato":"usted", háblale de usted siempre (señora + nombre), sin volver a tutear.
Si solo deja indicado un medicamento que ya le recetaron (nombre, dosis y frecuencia), guárdalo en "frases" y confirma en una frase; eso NO es consulta ("consulta": false). Consulta es cuando describe síntomas, pregunta si algo es grave o manda foto.
Seguridad infantil, nunca lo recomiendes: collares o pulseras de ámbar o dentición (riesgo de asfixia), miel a menores de 1 año, geles con benzocaína, almohadas o protectores en la cuna de bebés, andadores, jarabes para la tos en menores de 2 años. Si ella lo menciona, explícale con cariño por qué no y da una alternativa segura.
Si pide una dieta vegana o vegetariana para un bebé o niño pequeño, ayúdala con respeto y recuérdale en una frase controlar hierro y vitamina B12 con su pediatra.
No recomiendes médicos, clínicas ni negocios con nombre propio como "el mejor"; sugiere qué buscar (pediatra con buenas referencias, cerca de su zona) y que puede usar la búsqueda de lugares de la app.
Si pregunta cuánto cuesta la app o sus planes: toda mamá nueva tiene 40 días de prueba completa (todo lo del plan Pro, gratis). Después, el plan Gratis cuesta Bs 0 y trae agenda, remedios con avisos, menú, compras, gastos, precios y lugares, más 10 mensajes por semana con Lía con IA para probar. El plan Pro cuesta Bs 29 al mes o Bs 249 al año y trae Lía con IA (notas de voz, fotos, menú según la edad de cada hijo). Las primeras 100 mamás (Mamás fundadoras) pagan Bs 19 al mes. Dile que lo ve todo en Ajustes, en «Planes». No inventes otros precios.
Escribe para que cualquier mamá entienda, con palabras simples; si ella escribe sin tildes o con faltas, no la corrijas.
Usa la frase "¿Cómo voy esta semana?" solo si pregunta por sus gastos o su semana, y no la repitas dentro de "respuesta".

Responde SOLO con JSON: {"respuesta":"...","no_entendi":false,"consulta":false,"tema":"","eventos":[],"pendientes":[],"precios":[],"frases":[],"menu":null,"transcripcion":"..."}`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  limiteT = Date.now() + 56000;
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  // Voz de un paso del recorrido guiado (sin código: solo textos del recorrido, que se crean una vez y se guardan)
  let guiaH = '';
  if (b.modo === 'guia_voz') {
    const t = String(b.texto || '');
    guiaH = crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);
    if (!GUIA_VOCES.includes(guiaH)) return res.status(404).json({ error: 'no-es-del-recorrido' });
    const ya = guiaMemo[guiaH] || await guiaLeer(guiaH);
    if (ya && ya.audio) { guiaMemo[guiaH] = ya; return res.status(200).json(ya); }
    b.modo = 'voz'; b.texto = t; b.codigo = '';
  }
  let cod = b.codigo ? tipoDe(b.codigo) : null;
  if (guiaH) cod = { tipo: 'guia', h: guiaH };
  const disp = /^[a-z0-9]{12,40}$/i.test(String(b.dispositivo || '')) ? String(b.dispositivo) : '';
  // Prueba completa de 40 días: se entrega una vez por celular (y hasta PRUEBAS_NUEVAS_DIA por día en total)
  if (b.modo === 'prueba_40' && !b.codigo) {
    if (!disp) return res.status(400).json({ error: 'dispositivo' });
    const dh = crypto.createHash('sha256').update('disp:' + disp).digest('hex').slice(0, 24);
    if (await contar('mad:prueba40:' + dh, 400 * 86400) > 1) return res.status(409).json({ error: 'ya-usada' });
    if (await contar('mad:prueba40-dia:' + new Date().toISOString().slice(0, 10), 2 * 86400) > PRUEBAS_NUEVAS_DIA) return res.status(429).json({ error: 'limite' });
    const n = crearPro(DIAS_PRUEBA, 'T');
    if (!n) return res.status(503).json({ error: 'sin-clave' });
    return res.status(200).json(n);
  }
  if (!b.codigo && disp && !b.modo && !b.audio && !b.imagen) cod = { tipo: 'gratis', h: crypto.createHash('sha256').update('disp:' + disp).digest('hex') };
  if (!cod) return res.status(401).json({ error: 'codigo' });
  if (cod.tipo === 'vencido') return res.status(401).json({ error: 'vencido', prueba: !!cod.prueba, vence: cod.vence });
  const tipo = cod.tipo, h = cod.h;
  if (b.modo === 'probar') return res.status(200).json({ ok: true, tipo, vence: cod.vence || null, ia: !!process.env.GEMINI_API_KEY });
  if (b.modo === 'crear_pro') {
    if (tipo !== 'creador') return res.status(403).json({ error: 'permiso' });
    const dias = { 1: 31, 3: 92, 12: 366 }[+b.meses] || 31;
    const n = crearPro(dias);
    if (!n) return res.status(503).json({ error: 'sin-clave' });
    return res.status(200).json(n);
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'sin-clave' });
  const cat = await modelos(key);
  if (b.modo === 'diag') return res.status(200).json({ texto: cat.texto, tts: cat.tts, total: cat.todos.length });
  if (b.modo === 'medir' && tipo === 'creador') {
    const out = [];
    for (const m of (b.m ? [String(b.m)] : cat.todos.filter(n => /flash/.test(n) && !/tts|image|live|audio|embed/.test(n)).slice(0, 0))) {
      const t0 = Date.now(); let st = 0, d = '', conf = '';
      for (const tc of [null, { thinkingBudget: 0 }, { thinkingLevel: 'low' }, { thinkingLevel: 'minimal' }]) {
        const gc = b.tts ? { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOZ } } } } : { maxOutputTokens: 60 }; if (tc && !b.tts) gc.thinkingConfig = tc; if (b.tts && tc) break;
        const t1 = Date.now();
        try { const r = await fetch(API + '/' + m + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Di hola en una palabra.' }] }], generationConfig: gc }), signal: AbortSignal.timeout(15000) });
          st = r.status; if (!r.ok) { try { const e = await r.json(); d = String((e.error || {}).message || '').slice(0, 80); } catch (x) {} } else d = '';
        } catch (e) { st = 'timeout'; }
        conf += (tc ? JSON.stringify(tc) : 'normal') + '=' + st + ' ' + (Date.now() - t1) + 'ms' + (d ? ' (' + d + ')' : '') + ' | ';
        if (st === 404 || Date.now() - t0 > 40000) break;
      }
      out.push(m + ': ' + conf);
      if (Date.now() - limiteT > -8000) break;
    }
    return res.status(200).json({ out, todos: cat.todos });
  }
  if (b.modo === 'buscar_lugares') {
    const ciudad = String(b.ciudad || 'Santa Cruz').slice(0, 40);
    const que = String(b.texto || 'parques infantiles').slice(0, 120);
    const edad = String(b.edad || '').slice(0, 60);
    const pedido = 'Busca en Google Maps ' + que + ' en ' + ciudad + ', Bolivia' + (edad ? ', buenos para niños de ' + edad : '') +
      '. Dame hasta 8 lugares reales y bien valorados. Para cada uno escribe una línea con este formato exacto: ' +
      '- **Nombre del lugar** | zona o dirección | por qué es bueno para familias con niños (máx. 15 palabras). ' +
      'No inventes lugares. Responde en español, sin introducción ni cierre.';
    const base = { contents: [{ role: 'user', parts: [{ text: pedido }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1500 } };
    try {
      const mods = [...new Set(['gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'].concat(cat.texto))].slice(0, 5);
      let r = await pedirYa(mods, Object.assign({ tools: [{ googleMaps: {} }] }, base), key, 6000, 20000);
      if (!r || !r.ok) r = await pedirYa(mods, Object.assign({ tools: [{ google_search: {} }] }, base), key, 6000, 20000);
      let aprox = false;
      if (!r || !r.ok) { // sin cupo de búsqueda en Maps: lugares muy conocidos de memoria, con enlace de búsqueda para confirmar
        aprox = true;
        const b2 = { contents: [{ role: 'user', parts: [{ text: pedido.replace('Busca en Google Maps ', 'Sin buscar en internet, nombra solo lugares muy conocidos y que existan desde hace años: ') }] }], generationConfig: base.generationConfig };
        r = await pedirYa(RAPIDOS, b2, key, 3500, 15000);
      }
      if (!r || !r.ok) return res.status(502).json({ error: 'ia', estado: r && r.status });
      const j = await r.json();
      const c = (j.candidates || [])[0] || {};
      const texto = ((c.content || {}).parts || []).map(p => p.text || '').join('');
      const chunks = ((c.groundingMetadata || {}).groundingChunks || []).map(g => g.maps).filter(Boolean);
      const lugares = [];
      for (const ln of texto.split('\n')) {
        const m = /^\s*[-*•]\s*\*\*(.+?)\*\*\s*\|?\s*([^|]*)\|?\s*(.*)$/.exec(ln);
        if (!m) continue;
        const nombre = m[1].trim().slice(0, 80);
        const ch = chunks.find(x => x.title && (x.title.toLowerCase().includes(nombre.toLowerCase()) || nombre.toLowerCase().includes(x.title.toLowerCase())));
        lugares.push({ nombre, zona: m[2].trim().slice(0, 100), nota: m[3].trim().slice(0, 160),
          maps: ch && ch.uri ? ch.uri : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(nombre + ', ' + ciudad + ', Bolivia') });
      }
      return res.status(200).json({ lugares: lugares.slice(0, 8), aprox });
    } catch (e) { return res.status(502).json({ error: 'red' }); }
  }
  if (b.modo === 'voz') {
    const frase = String(b.texto || '').slice(0, 1500);
    if (!frase) return res.status(400).json({ error: 'vacio' });
    try {
      const cuerpoVoz = lang => JSON.stringify({
        contents: [{ parts: [{ text: (ESTILOS[b.estilo === undefined ? ESTILO : b.estilo] || '') + frase }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: Object.assign(lang ? { languageCode: lang } : {}, { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOCES.includes(b.voz) ? b.voz : VOZ } } }) }
      });
      const lt = cat.tts.includes(b.ttsModelo) ? [b.ttsModelo] : cat.tts;
      let r = await pedir(lt, cuerpoVoz(b.lang === undefined ? 'es-US' : b.lang), key);
      if (r && r.status === 400) r = await pedir(lt, cuerpoVoz(''), key);
      if (!r || !r.ok) return res.status(502).json({ error: 'voz', estado: r && r.status });
      let j = await r.json();
      let part = ((((j.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData);
      if (!part) return res.status(502).json({ error: 'voz-vacia' });
      // A veces la voz agrega frases que no estaban en el texto: si el audio dura mucho más de lo esperado, se pide otra vez.
      const largo = pt => { const n = Math.floor(String(pt.inlineData.data).length * 3 / 4); return (n - (/wav/.test(pt.inlineData.mimeType || '') ? 44 : 0)) / 48000; };
      const esperado = frase.length / 13 + 1.2;
      if (largo(part) > esperado * 1.35 && Date.now() - limiteT < -15000) {
        const ult = pedir.ultimo;
        const r2 = await pedir([...new Set([ult].concat(lt))], cuerpoVoz(b.lang === undefined ? 'es-US' : b.lang), key, 15000);
        if (r2 && r2.ok) { const j2 = await r2.json(); const p2 = ((((j2.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData); if (p2 && largo(p2) < largo(part)) { part = p2; j = j2; } }
      }
      const rate = +((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || 24000);
      const sal = { audio: part.inlineData.data, mime: part.inlineData.mimeType, rate, modelo: pedir.ultimo };
      if (guiaH) { guiaMemo[guiaH] = sal; await guiaGuardar(guiaH, sal); }
      return res.status(200).json(sal);
    } catch (e) { return res.status(502).json({ error: 'red' }); }
  }

  const texto = typeof b.texto === 'string' ? b.texto.slice(0, 4000) : '';
  const audio = typeof b.audio === 'string' ? b.audio : '';
  const mime = /^audio\/[a-z0-9.+-]+$/i.test(b.mime || '') ? String(b.mime).split(';')[0] : 'audio/webm';
  const img = typeof b.imagen === 'string' && b.imagen.length < 3000000 && /^image\/(jpeg|png|webp)$/.test(b.imgMime || '') ? { data: b.imagen, mime: b.imgMime } : null;
  if (!texto && !audio && !img) return res.status(400).json({ error: 'vacio' });
  if (audio.length > 4000000) return res.status(413).json({ error: 'audio-largo' });
  const ctx = JSON.stringify(b.ctx || {}).slice(0, 6000);

  let restantes;
  if (tipo === 'gratis') {
    if (audio || img) return res.status(401).json({ error: 'codigo' });
    const n = await contar('mad:prueba:' + semana() + ':' + h.slice(0, 24), 8 * 86400);
    if (n > PRUEBA_SEMANA) return res.status(429).json({ error: 'limite-prueba' });
    const total = await contar('mad:prueba-dia:' + new Date().toISOString().slice(0, 10), 2 * 86400);
    if (total > PRUEBA_TOTAL_DIA) return res.status(429).json({ error: 'limite-prueba' });
    restantes = PRUEBA_SEMANA - n;
  } else {
    const dia = new Date().toISOString().slice(0, 10), k = dia + h;
    usos[k] = (usos[k] || 0) + 1;
    if (usos[k] > LIMITE[tipo]) return res.status(429).json({ error: 'limite' });
    restantes = LIMITE[tipo] - usos[k];
  }

  const parts = [{ text: 'Datos: ' + ctx }];
  if (audio) parts.push({ text: 'Mensaje de la mamá (nota de voz):' }, { inlineData: { mimeType: mime, data: audio } });
  else parts.push({ text: 'Mensaje de la mamá: ' + (texto || '(solo mandó una foto)') });
  if (img) parts.push({ text: 'Foto adjunta:' }, { inlineData: { mimeType: img.mime, data: img.data } });

  try {
    const cuerpo = {
      systemInstruction: { parts: [{ text: SYS }] },
      contents: [{ role: 'user', parts }],
      safetySettings: SEGURIDAD,
      generationConfig: { temperature: 0.5, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    };
    const t0 = Date.now();
    const largo = /men[uú]|minuta|plan de comidas/i.test(texto) ? 32000 : audio ? 20000 : 15000; // un menú de muchos días tarda más en escribirse
    let r = await pedirYa([...new Set(RAPIDOS.concat(cat.rapido))], cuerpo, key, 3500, largo);
    if (!r.ok && (r.status === 429 || r.status === 503) && Date.now() - t0 < 30000) { await new Promise(z => setTimeout(z, 2500)); r = await pedirYa([...new Set(cat.rapido.concat(RAPIDOS))], cuerpo, key, 3000, 15000); }
    let tIA = Date.now() - t0, mIA = pedir.ultimo;
    if (!r.ok) {
      let d = '';
      try { const e = await r.json(); d = (e.error && (e.error.message || e.error.status)) || ''; } catch (x) {}
      return res.status(502).json({ error: 'ia', estado: r.status, detalle: String(d).slice(0, 200) });
    }
    const leer = async rr => {
      const j = await rr.json();
      const c = (j.candidates || [])[0] || {};
      let t = ((c.content || {}).parts || []).map(p => p.text || '').join('');
      t = t.replace(/^```(?:json)?\s*|\s*```$/g, '');
      let o = null;
      if (t.trim()) { try { o = JSON.parse(t); } catch (e) { o = { respuesta: t.slice(0, 400), frases: [] }; } }
      return { o, fin: c.finishReason || (j.promptFeedback || {}).blockReason || '' };
    };
    // Lía no entendió el audio (o la respuesta vino vacía o bloqueada): se intenta otra vez con un modelo más completo.
    const NO_OYE = /no (te )?(puedo|pude|logro|logr[eé]|alcanzo) (escuchar|o[ií]r|entender)|no (te )?(escucho|oigo|se escucha|se oye)/i;
    const malo = o => {
      if (!o) return true;
      if (!audio) return false;
      const resp = String(o.respuesta || ''), tr = String(o.transcripcion || '').trim();
      return !!o.no_entendi || (!tr && (!resp.trim() || NO_OYE.test(resp))) || (NO_OYE.test(resp) && resp.length < 140);
    };
    let { o, fin } = await leer(r);
    if (malo(o) && Date.now() - limiteT < -18000) {
      const fuertes = [...new Set(['gemini-3-flash-preview'].concat(cat.texto.filter(m => !/lite/.test(m)), cat.texto))].filter(m => m !== mIA).slice(0, 4);
      const r2 = await pedirYa(fuertes, Object.assign({}, cuerpo, { generationConfig: Object.assign({}, cuerpo.generationConfig, { temperature: 0.3 }) }), key, 6000, 20000);
      if (r2 && r2.ok) { const x = await leer(r2); if (!malo(x.o)) { o = x.o; fin = x.fin; mIA = pedir.ultimo; } else if (!o) { o = x.o; fin = x.fin; } }
      tIA = Date.now() - t0;
    }
    if (malo(o)) {
      if (audio) return res.status(422).json({ error: 'no-entendi', detalle: String(fin).slice(0, 40) });
      if (!o) return res.status(502).json({ error: 'vacia', detalle: String(fin).slice(0, 40) });
    }
    const frases = Array.isArray(o.frases) ? o.frases.filter(x => typeof x === 'string' && x.trim()).slice(0, 15) : [];
    const lista = x => Array.isArray(x) ? x.filter(e => e && typeof e === 'object').slice(0, 12) : [];
    let g = null;
    if (o.consulta || (img && !lista(o.eventos).length && !frases.length)) {
      o.consulta = true;
      const q = [o.tema, o.transcripcion || texto].filter(Boolean).join('. Lo que dijo: ');
      try { g = await guia(cat, key, ctx, q || 'Mira la foto y oriéntame', img, true); } catch (e) {}
    }
    res.status(200).json({
      respuesta: g ? g.texto : String(o.respuesta || '').slice(0, 1500),
      tiempos: { ia: tIA, modelo: mIA, total: Date.now() - t0 },
      guia: !!g,
      fuentes: g ? g.fuentes : [],
      eventos: lista(o.eventos),
      pendientes: lista(o.pendientes),
      precios: lista(o.precios),
      frases,
      menu: o.menu && typeof o.menu === 'object' && Array.isArray(o.menu.dias) && o.menu.dias.length ? { para: String(o.menu.para || '').slice(0, 40), desde: String(o.menu.desde || '').slice(0, 10), dias: o.menu.dias.slice(0, 31).map(d => (Array.isArray(d) ? d : [d && d.desayuno, d && (d.media_manana || d.mm), d && d.almuerzo, d && d.merienda, d && d.cena]).slice(0, 5).map(x => String(x || '').slice(0, 90))) } : null,
      transcripcion: String(o.transcripcion || '').slice(0, 4000),
      restantes, plan: tipo
    });
  } catch (e) { res.status(502).json({ error: 'red', detalle: String(e && e.message).slice(0, 120) }); }
};
