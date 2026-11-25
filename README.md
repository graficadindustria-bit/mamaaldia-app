# Mamá al Día (versión de prueba)

App web instalable (PWA) para mamás: escribe o dicta como te salga y la asistente Lía lo ordena en agenda, medicamentos, menú semanal, compras, gastos y lugares.

- Sin servidor: los datos se guardan solo en el celular de cada persona.
- Se publica en Vercel como sitio estático (sin configuración).

## Lía con IA

`api/lia.js` es una función de Vercel que conecta a Lía con Gemini. Necesita la variable de entorno `GEMINI_API_KEY` en el proyecto de Vercel. Sin la variable o sin código de acceso, la app usa la Lía básica (reglas en el navegador).

## Avisos con la app cerrada
Reloj: cron-job.org cada minuto llama a /api/avisos?tick=1. Guarda los avisos en Upstash Redis (KV_REST_API_URL/TOKEN); sin Redis usa Blob cada 5 min.

## Planes (Gratis y Pro)
- Gratis: sin código. Lía con IA de prueba: 10 mensajes de texto por semana por celular (tope total por día). Se cuenta en Redis si está conectado.
- Pro: códigos `MD-P...` que llevan su fecha de vencimiento y una firma. Se crean desde la app (Ajustes › Crear código Pro) con el código de creador. La firma usa `PRO_SECRETO` o, si no existe, una clave derivada de `GEMINI_API_KEY` (si se cambia esa clave, los códigos Pro dejan de valer).
- Número de WhatsApp para pagar: constante `WA_PRO` en index.html.
