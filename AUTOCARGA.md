# Daytona USA 2 Power Edition — autocarga restaurada

Al abrir la página por HTTP(S), `app.js` descarga automáticamente `data/dayto2pe.zip`, muestra progreso y lo entrega al núcleo del emulador. No es necesario seleccionar la ROM ni pulsar JUGAR. Se mantiene el selector manual como respaldo si falla la descarga.

Publicá el **contenido** de `daytona-2-power/` en la raíz del hosting, conservando `data/dayto2pe.zip`, `data/Games.xml`, `core/` y `worker.js`. El servidor debe entregar el ZIP real (no una página HTML de fallback). No abrir con `file://`.

La carga automática no garantiza que la emulación funcione correctamente; probar una carrera completa en Chrome. Para publicar la ROM, necesitás contar con autorización para distribuirla.
