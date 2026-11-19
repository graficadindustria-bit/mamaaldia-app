# Mamá al Día (versión de prueba)

App web instalable (PWA) para mamás: escribe o dicta como te salga y la asistente Lía lo ordena en agenda, medicamentos, menú semanal, compras, gastos y lugares.

- Sin servidor: los datos se guardan solo en el celular de cada persona.
- Se publica en Vercel como sitio estático (sin configuración).

## Lía con IA

`api/lia.js` es una función de Vercel que conecta a Lía con Gemini. Necesita la variable de entorno `GEMINI_API_KEY` en el proyecto de Vercel. Sin la variable o sin código de acceso, la app usa la Lía básica (reglas en el navegador).
