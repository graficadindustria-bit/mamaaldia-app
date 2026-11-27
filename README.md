# Mamá al Día (versión de prueba)

App web instalable (PWA) para mamás: escribe o dicta como te salga y la asistente Lía lo ordena en agenda, medicamentos, menú semanal, compras, gastos y lugares.

- Sin servidor: los datos se guardan solo en el celular de cada persona.
- Se publica en Vercel como sitio estático (sin configuración).

## Lía con IA

`api/lia.js` es una función de Vercel que conecta a Lía con Gemini. Necesita la variable de entorno `GEMINI_API_KEY` en el proyecto de Vercel. Sin la variable o sin código de acceso, la app usa la Lía básica (reglas en el navegador).

## Avisos con la app cerrada
Reloj: cron-job.org cada minuto llama a /api/avisos?tick=1. Guarda los avisos en Upstash Redis (KV_REST_API_URL/TOKEN); sin Redis usa Blob cada 5 min.

## Planes (Gratis y Pro)
- Prueba de 40 días: cada celular nuevo recibe solo un código `MD-T...` (todo como Pro, 40 mensajes al día) una sola vez. Al vencer pasa a Gratis.
- Gratis: sin código. Lía con IA de prueba: 10 mensajes de texto por semana por celular (tope total por día). Se cuenta en Redis si está conectado.
- Pro: códigos `MD-P...` que llevan su fecha de vencimiento y una firma. Se crean desde la app (Ajustes › Crear código Pro) con el código de creador. La firma usa `PRO_SECRETO` o, si no existe, una clave derivada de `GEMINI_API_KEY` (si se cambia esa clave, los códigos Pro dejan de valer).
- Número de WhatsApp para pagar: constante `WA_PRO` en index.html.

## Voz del recorrido guiado
Los pasos con `a:N` usan `guia/N.mp3`. Los demás piden su voz a `/api/lia` (modo `guia_voz`): el servidor la crea una sola vez con la voz de Lía y la guarda en Vercel Blob (`guia-voz/`). Solo acepta textos cuya huella está en `api/_guia.js`. Si cambias un texto del recorrido, regenera esa lista con el script de node que lee `const TOUR=[...]` de index.html.

## Encuesta de planes (base de contactos)
- A los 14 días de la prueba de 40 días, la app le muestra a la mamá (una vez) una encuesta corta: qué usa, si pagaría el plan Pro, cómo pagaría, si quiere que le avisen cuando la app esté en Play Store, y su celular.
- Si toca "Más tarde", vuelve a aparecer a los 3 días (máximo 3 veces).
- Las respuestas se guardan en Redis (`mad:encuesta`, una por celular). Solo el código de creador las ve en Ajustes › "Ver respuestas de la encuesta", con botón para descargarlas para Excel.
