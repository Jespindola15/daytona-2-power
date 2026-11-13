# Daytona USA 2 — Autocarga

La página solicita `data/dayto2pe.zip` automáticamente al abrirse. No pide ISO ni selección manual.

## Publicación
Subir **el contenido de la carpeta `daytona-2-power/`** al directorio raíz del hosting (Netlify, Cloudflare Pages o servidor estático). El sitio debe servir `data/dayto2pe.zip` como archivo binario, sin redirigirlo a index.html. El ZIP del proyecto incluye la ROM suministrada por el usuario; publicar estos datos en un sitio público requiere los derechos o permisos correspondientes.

## Verificación
Abrir la página, comprobar que la barra textual de descarga avance y que aparezca el canvas. Si hay error HTTP, verificar `data/dayto2pe.zip` y la pestaña Network. Si la ROM está ausente, aparece selector manual como alternativa.

## Límites
No se ha probado la emulación completa en Chrome en este entorno. Esta modificación automatiza la descarga, **no** agrega online ni mejora FPS. El audio del navegador puede requerir un clic para activarse por restricciones de autoplay.
