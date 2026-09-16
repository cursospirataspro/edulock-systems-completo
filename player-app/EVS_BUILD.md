> **Documento de un corte anterior.** La compilación vigente y sus comprobaciones se registran en [AUDITORIA_LANZAMIENTO.md](<C:/Users/KENDOR GARCIA/Documents/New project/output/edulock-handoff/AUDITORIA_LANZAMIENTO.md>). Se conserva el cuerpo histórico; sus resultados de firma, rutas y hashes no sustituyen la evidencia específica de los artefactos actuales.

# Firma Windows con Castlabs EVS

El proyecto usa Electron de Castlabs 42.0.0+wvcus y electron-builder 26.15.3. El hook de Electron Fuses aplica los ocho valores admitidos por EVS; el empaquetador incorpora el hash ASAR en el recurso Windows. `scripts/sign-evs.js` se ejecuta en `afterSign`: después de los cambios al ejecutable y de una posible firma Authenticode, antes de empaquetar NSIS/portable.

El hook ejecuta `evs-vmp --no-ask sign-pkg --streaming` y `verify-pkg` sobre el directorio del paquete. Cualquier fallo detiene la creación de instaladores. No se fuerza una firma nueva si la existente ya es válida. `EVS_VMP_EXECUTABLE` permite indicar la ruta al cliente instalado; sin esa variable se busca `evs-vmp` en PATH.

La cuenta EVS debe estar autenticada en el equipo. Introducir contraseñas y códigos en la consola del cliente, nunca en código, argumentos de compilación, informes o repositorios. EVS 1.3.2 está instalado. La recuperación autorizada del 12 de septiembre terminó correctamente y el paquete obtuvo firma streaming válida, verificada con 1404 días restantes.

Antes de firmar, `scripts/verify-windows-package.js` verifica los ocho fuses, el hash ASAR embebido, la coincidencia del código empaquetado con la fuente y la ausencia de carpetas de pruebas o builds previos. El test de alteración sobre una copia desechable produjo el rechazo real `Integrity check failed for asar archive`.

Para Windows se usa firma streaming: Castlabs documenta que ECS 42 ya no admite licencias Widevine persistentes del CDM de navegador. El formato propio `.edu` es independiente y no debe presentarse como una licencia Widevine persistente.

EVS es firma Widevine/VMP; no sustituye Authenticode ni la firma APK de Android. La verificación EVS tampoco sustituye una prueba de reproducción de contenido DRM y licencia reales.

Referencia: https://github.com/castlabs/electron-releases/wiki/EVS
