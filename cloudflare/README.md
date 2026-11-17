# Salas online de Daytona USA 2 (Cloudflare)

Cada jugador corre su propia cabina en el navegador. Esta sala hace de **cable de red del arcade**:
en cada cuadro recibe la memoria de comunicación de cada cabina y le reparte a cada una la de las demás,
en el mismo orden que el cable original. El juego es el que sincroniza la carrera (2 a 8 cabinas).

## Publicar
Desde la raíz del repo (la primera vez: `npx wrangler login`):

    npm run deploy

Wrangler muestra la dirección (por ejemplo `https://daytona2-salas.TU-SUBDOMINIO.workers.dev`).
Ponela en `config.js` (`window.D2_SALAS_URL`) y subí el sitio a Netlify.

## Probar en tu PC
    npm run dev:salas        -> http://localhost:8787
