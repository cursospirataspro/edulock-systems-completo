# Ruta Widevine L1 con Bunny Stream — PREPARADA (inactiva)

> Estado: **NO activada.** Hoy usas el modelo `.edu` (software) + antidescarga de
> Bunny. Este documento deja lista la ruta para el día que quieras **pagar el DRM
> de Bunny** y bloquear de verdad la captura de frames por memoria.

## Por qué esta ruta (y solo esta) bloquea la captura de frames

En el modelo `.edu` el descifrado es por software → los frames descodificados
existen en la RAM del alumno y un atacante decidido puede capturarlos (es el límite
físico que descubriste en InfoProtector). **Widevine L1** hace el descifrado y la
decodificación **dentro del hardware seguro (GPU/TEE)**: los frames nunca pasan por
la RAM accesible. Es lo único que cierra ese ataque.

## Qué hace falta (cuando decidas activarlo)

1. **Contratar el add-on de DRM en Bunny Stream (MediaCage)** — es de pago.
   Habilita Widevine + PlayReady sobre tus videos de Bunny Stream.
2. **Subir el video a Bunny Stream** (no a Storage): Bunny lo transcodifica y lo
   sirve como HLS/DASH **cifrado CENC** con DRM.
3. **Servidor de licencias**: lo provee Bunny (MediaCage). Tu backend solo emite un
   token de sesión (como ya haces) para autorizar la petición de licencia.
4. **Reproductor**: tu Electron ya usa **castlabs Electron con Widevine CDM**
   integrado — puede reproducir DRM vía EME sin cambios de infraestructura. Falta
   solo apuntarlo al manifiesto CENC + servidor de licencias de Bunny.

## Cómo queda "preparado" en el código

- **Config (inactiva):** una clave de config `bunny_drm_enabled` (por defecto `false`).
  Cuando esté en `true` y haya un `bunny_drm_license_url`, el flujo de reproducción
  puede devolver `sourceType: 'widevine'` en vez de `'edu'`.
- **Reproductor:** el branch de reproducción del renderer ya está dividido por
  `sourceType` (`edu` / `vdocipher` / `bunny`). Añadir un branch `widevine` que use
  EME + el CDM ya presente es directo cuando tengas el manifiesto y el license URL.
- **VdoCipher (referencia):** el proyecto YA reproduce DRM real vía el webview de
  VdoCipher (`startVdoCipher`). Ese patrón (OTP + iframe/EME) es el mismo que usarías
  con Bunny MediaCage — sirve de plantilla.

## Pasos concretos el día que actives

1. Activar MediaCage en el panel de Bunny y anotar el **license URL** y el
   **pull zone** de Stream.
2. Guardar en el panel: `bunny_drm_enabled = true`, `bunny_drm_license_url = ...`.
3. Subir el video premium a **Bunny Stream** (no Storage) → obtienes su playback URL.
4. Registrar ese video con `key_mode: 'widevine'` (en vez de empaquetar `.edu`).
5. Añadir el branch `sourceType === 'widevine'` en `renderer/player.js`:
   cargar el manifiesto CENC con EME apuntando al license URL de Bunny (el CDM de
   castlabs Electron hace el resto). Reusar la lógica de `startVdoCipher` como base.

## Recomendación
- **Contenido normal / económico:** quédate con `.edu` + marca de agua (barato, sin
  dependencia de terceros, ya rastreable). La guía §3 lo recomienda para ese caso.
- **Contenido premium / caro:** activa Widevine L1 (esta ruta). Es el DRM industrial
  y la única forma de bloquear la captura de frames.
