# Entrega 2026-09-16 · Bunny (HTTP 400), licencias permanentes y panel Estudiantes

## 1. Diagnóstico del caso de Octavio

**Identificación (base de datos de producción, solo lectura):**
- Productor `18021b94-f6be-4709-91cb-790fa68018ea` (nombre visible en el panel: "duramx 21 dias"). Correo no reproducido aquí.
- Curso `53aeed8e-973e-48f9-8557-4d516cdeaf61` "duramxn 21 xxx" → biblioteca Bunny **755206** (creada 2026-09-16 22:51 UTC).
- Módulos `4420ebaf…` "piwsada dw nuvca" y `96c78c3b…` "aumenta 5 cm": guardados **sin** `bunny_collection_id`.
- Operación de subida `a26e32f9…` (título "rerdsr", 25,6 MB): estado `reserved`, `error_code=BUNNY_HTTP_ERROR`, sin `video_id` → el archivo nunca llegó a Bunny.

**Causa comprobada (no hipótesis).** El código desplegado coincidía con el repositorio (md5 idénticos). Reproduciendo desde el VPS las mismas llamadas que hace `lib/stream-service.js`:

| Petición | Resultado |
|---|---|
| GET `/videolibrary/755206` | 200 · `EnableDRM:true`, `PlayerTokenAuthenticationEnabled:true` |
| GET `/storagezone/1911851` | 200 · `Region:"DE"`, `ReplicationRegions:[]` (solo Fráncfort, correcto) |
| GET `/pullzone/6631135` | 200 · `ZoneSecurityEnabled:false` |
| **POST `/videolibrary/755206` `{EnableTokenAuthentication:true, EnableTokenIPVerification:false}`** | **400 `VideoLibrary.TokenAuthAndDrmConflict` — "Cannot have Token Authentication and Basic DRM enabled at the same time"** |

`ensureCourseLibrary` activaba MediaCage Basic DRM en cada biblioteca nueva (correcto, es la protección que se quiere) y después exigía el token del CDN, que Bunny prohíbe junto con el DRM básico. Como esa verificación se ejecuta en **cada** `ensureCourseLibrary`, fallaban también la creación de colecciones de módulo y toda subida, aunque la biblioteca estuviera bien. `createTransport` reducía la respuesta a "Bunny respondió HTTP 400", por eso el panel no podía decir más. La biblioteca "prueba" (749820), que sí reproduce, tiene exactamente esa configuración: DRM básico activo y pull zone sin token.

**Dato no disponible:** los logs de PM2 no registraban el detalle del proveedor (ahora sí, ver §2).

**Estado final de Octavio (verificado remotamente tras la reparación):** biblioteca 755206 confirmada (DRM básico activo, Fráncfort sin réplicas, hostname `vz-5afa1806-fa3.b-cdn.net` y clave de firma guardadas en `courses`); colecciones creadas y confirmadas en Bunny y en `modules.bunny_collection_id`:
- "aumenta 5 cm" → `dda99099-a953-4f9d-a2c9-1deb9ff3f973`
- "piwsada dw nuvca" → `284e23a9-1ca1-4ea0-9a8c-ecbabc9ba367`

El archivo `recuperado_5min.mp4` ya no está en el servidor (se borra tras cada intento). Octavio debe volver a seleccionarlo y pulsar **Subir clase** (o "Reintentar envío" en la subida guardada): la operación reutiliza su identificador y no crea duplicados.

## 2. Corrección del flujo Bunny (`lib/stream-service.js`)

- **DRM básico + token del CDN:** con `EnableDRM:true` ya no se solicita `EnableTokenAuthentication` (Bunny lo rechaza). Las bibliotecas históricas sin DRM conservan la exigencia de token. Nunca se envían Widevine/FairPlay (de pago), `ResetToken` ni `ReplicationRegions` en actualizaciones.
- **DRM obligatorio en bibliotecas gestionadas:** si una biblioteca creada por la plataforma no confirma `EnableDRM:true`, la etapa falla (`BUNNY_DRM_UNCONFIRMED`) en lugar de continuar sin protección.
- **Etapas trazadas:** `library-create`, `library-verify`, `library-protect`, `storage-verify`, `cdn-verify`, `collection-verify`, `collection-create`, `local-file`, `video-create`, `video-collection`, `player-key`, `video-transfer`, `video-status`. Cada error lleva `stage`; el transporte conserva `httpStatus` y `provider {errorKey, field, message}` de Bunny (solo esas tres cadenas cortas, nunca cuerpos ni claves).
- **Registro seguro:** `[stream/upload-failed] {operationId, courseId, moduleId, state, code, stage, status, errorKey, message}` en el log del servidor; el mismo detalle se guarda en `stream_operations.error_detail` (nueva columna) y se devuelve al panel como `stage`, `stageLabel`, `providerErrorKey`, `providerMessage`, `action`.
- **Rechazo confirmado ≠ respuesta perdida:** un 4xx explícito devuelve el recurso a `reserved` y propaga la causa original (reintentable tras corregir); solo red/timeout/5xx quedan como `PROVISION_UNCERTAIN`. Un recurso `unknown` se vuelve a buscar en la lista de Bunny en cada intento y solo tras 15 minutos sin aparecer se permite crear otro.
- **Colección verificada, no solo guardada:** antes de subir se hace GET de la colección guardada en la biblioteca del curso; si Bunny devuelve 404 se limpia y se reconcilia/crea (`db.clearStreamResource`). Tras crear el video se confirma `collectionId`; si no coincide se mueve con POST al video.
- **Reparación explícita:** `POST /api/producer/courses/:courseId/modules/:moduleId/collection` (y `/api/stream/courses/…` para admin). En el formulario de subida, el módulo elegido muestra "Colección confirmada" o "aún no tiene colección · Preparar colección".
- **Frontend (controlador compartido en `productor.html` y `admin.html`, idéntico):** etapas Preparando biblioteca/colección → Transfiriendo a Bunny (porcentaje real del servidor, consultado cada 3 s durante la petición) → Procesando → Listo/Error. Un fallo muestra etapa, motivo de Bunny y acción. "Continuar seguimiento" no reenvía; "Reintentar envío" solo aparece en subidas fallidas reintentables y exige seleccionar el mismo archivo (nombre y tamaño).

**Solo Fráncfort:** la creación sigue enviando `ReplicationRegions: []` y se relee la zona de almacenamiento (`Region DE`, `ReplicationRegions []`) antes de aceptar la biblioteca; ninguna biblioteca existente tiene réplicas (listado verificado: 749820, 751285, 751286, 755206, 755267 con `ReplicationRegions:[""]` = ninguna).

## 3. Licencias de curso sin vencimiento

- Servidor: `POST /api/producer/license/generate-bulk`, `POST /api/license/generate` y `POST /api/license/generate-bulk` responden `400 LICENSE_EXPIRY_UNSUPPORTED` si llega `expiresAt` o `durationDays`; `createProducerLotAtomic`, `createLicense`, `createFreeLicense` y `regenerateLicense` insertan `expires_at NULL` y no propagan `duration_days`.
- Verificaciones retiradas: `/api/license/activate`, `claimAndActivateLicenseAtomic`, `activateDeviceAtomic`, `claimFreeLicense`, `lib/access-policy.js` (video y PDF), `lib/activation-validator.js`, `lib/player-handshake.js`. `first_activated_at` se conserva como dato histórico.
- Se mantienen los plazos técnicos: sesiones, tokens de lanzamiento, URLs firmadas y `activations.expires_at` (arrendamiento de la activación).
- Panel productor: desaparecen "Vencimiento (opcional)", "Días desde primera activación", "Usa duración o fecha fija", la columna Vencimiento y el filtro "Vencidas". Panel admin: fila "Fecha expiración" y textos asociados.
- Migración reversible `migrations/20260916_licencias_permanentes.up.sql` / `.down.sql`: copia `expires_at`/`duration_days` a `licenses_expiry_backup_20260916` y los pone a NULL. Ejecutada en producción: **0 filas afectadas** (ninguna licencia tenía vencimiento). Estados históricos `expired`: 0.

## 4. Licencias y lotes (vista compacta)

- Generación: curso, cantidad y nombre del lote. Dispositivos por licencia en solo lectura ("lo define el administrador"); el servidor rechaza con `403 DEVICE_LIMIT_ADMIN_ONLY` cualquier valor distinto al del productor. La cantidad propuesta nunca supera el cupo restante y se actualiza tras generar; la cuota se valida en la transacción (`FOR UPDATE`).
- Listado: pestañas **Disponibles / En uso / Todas** con contadores del servidor (misma definición SQL para lista, contadores, lotes y exportación), filtro por lote, búsqueda por clave completa/nombre/correo, paginación. Fila: **clave completa** (monoespaciada) · distintivo · lote/curso · **Copiar** (confirmación visual) · **Administrar**.
- Definiciones (`availabilityOf` / `AVAILABILITY_SQL` en `lib/producer-licenses.js`): `available` (libre, sin reserva), `reserved` (libre con correo reservado), `in_use` (reclamada por una cuenta; cerrar sesión o tener cero activaciones no la libera), `suspended`, `revoked` (nunca se ofrecen como utilizables; visibles en Todas y en su filtro).
- Lote seleccionado: "Copiar disponibles" (`GET /lots/:id/serials?scope=available`), "Descargar CSV (disponibles|todas)" (`export.csv?scope=`), editar, mover. Claves históricas sin cifrado se marcan "Clave histórica no recuperable" y solo se recuperan con Reemplazar clave (explícito).
- Las claves se sirven descifradas del almacén cifrado existente (`producer_license_serials`) en la misma consulta de la página, con `Cache-Control: no-store`, solo al productor propietario; ningún serial va a URLs ni a registros.

## 5. Administrar licencia

Solo lectura: clave completa, disponibilidad, curso, lote, creada, asignada, dispositivos activos/límite (admin). Sin vencimiento, teléfono, referencia ni notas. Acciones: Copiar, Abrir ficha del estudiante (si está asignada), Suspender/Reactivar, Reemplazar clave, Revocar, Enviar acceso (correo/manual), Ver dispositivos. Una clave libre admite "Reservar para (correo)" sin crear alumnos. `PATCH /licenses/:id` solo acepta `customerEmail` en claves libres; `maxDevices` → 403, `expiresAt`/`durationDays` → 400, resto → `FIELD_NOT_EDITABLE`.

## 6. Estudiantes (sustituye a Compradores)

- Navegación, títulos y alias `#compradores → #estudiantes`. Rutas `/customers` retiradas; `producer_customer_profiles` se conserva en la base de datos sin uso.
- `GET /api/producer/workspace/students` y `/students/:id` se construyen desde `licenses.student_id` (relación alumno-licencia-curso-productor), nunca desde `students.producer_id`. Una fila por cuenta; búsqueda, filtro por curso, paginación; el proyecto activo filtra.
- Ficha: identidad (nombre, correo, relación con el productor, último acceso); cursos y licencias solo de este productor con clave completa, lote, fechas y estado; dispositivos por licencia con límite de solo lectura; acciones por licencia (suspender/reactivar, revocar, reemplazar, enviar acceso) y por activación (liberar, bloquear, desbloquear), cada una con confirmación y alcance explícito.
- Aislamiento: `listLicenses`, `getStudent`, `activationAction` y `activation-validator` ya no dependen de `students.producer_id`; un alumno con licencias de varios productores queda visible y operable solo dentro de cada uno. Cubierto por el test "real students appear automatically… isolated per producer".

## 7. Cambios por archivo

| Archivo | Cambio |
|---|---|
| `lib/stream-service.js` | Etapas, detalle del proveedor, DRM/token, verificación de colección, reparación, `operationResult` con acción |
| `database-pg.js` | `stream_operations.error_detail`, `clearStreamResource`, licencias permanentes en lotes/claim/activación/regeneración |
| `lib/producer-licenses.js` | Disponibilidad, contadores, claves completas, `/students`, `/students/:id`, `/lots/:id/serials`, exportación por alcance, edición restringida |
| `lib/producer-business.js` | Resumen: Estudiantes desde licencias |
| `lib/access-policy.js`, `lib/activation-validator.js`, `lib/player-handshake.js` | Sin caducidad de licencia; validador sin `students.producer_id` |
| `server.js` | Rutas de generación sin vencimiento y límite solo admin, `streamError` con etapa/proveedor, ruta de reparación de colección, `/api/producer/me` con `id` |
| `productor.html` | Licencias compacta, Estudiantes, formulario simplificado, jobs con reintento, estado de colección, controlador compartido |
| `admin.html` | Controlador compartido, sin fila/textos de expiración |
| `public/js/producer-workspace.js`, `public/css/producer-workspace.css` | Nueva UI |
| `migrations/20260916_licencias_permanentes.*.sql` | Migración reversible |
| `test/*` | Tests actualizados y nuevos; `test/frontend-fixture.cjs` con datos sintéticos para revisar el panel |
| `tools/*.js` | Diagnóstico de biblioteca Bunny (solo lectura), reparación de colecciones de un curso y prueba de reproducción, todos para ejecutar en el VPS con `NODE_PATH=/opt/reproductor/node_modules` |

## 8. Pruebas

Comandos y entorno:
- Local (Windows, Node 24): `node --test $(ls test/*.test.js | grep -v postgres)` → **395 pasan, 4 fallan de forma preexistente y ajena** (motor PDF sin módulos en `pdf-runtime/` local: 3; verificación de correo en `account-auth`: 1; ambos módulos sin cambios).
- VPS, base `edulock_qa_20260912` (desechable, Postgres real): `node --test test/*postgres*.test.js test/postgres-integration.test.js …` → **128 pasan, 0 fallan** tras las actualizaciones.
- Prueba real con Bunny (API desplegada, productor sintético, clip de 3 s con audio generado con ffmpeg): curso → biblioteca 755267 (DE, sin réplicas, DRM básico); módulo → colección `6b014823…`; subida → `processing` → **`ready` en ~10 s**; el video en Bunny reporta `collectionId` = colección del módulo; catálogo `ready` con clave HLS; portada pública `200`; lista HLS accesible desde el pull zone con Referer (403 sin Referer, por `BlockNoneReferrer`). Las filas sintéticas se eliminaron después; la biblioteca **755267** permanece en Bunny (1 video de 43 KB) y se borra manualmente desde el panel de Bunny si se desea.
- Reproducción de extremo a extremo contra el servidor desplegado (`tools/vps-prueba-reproduccion.js`, alumno y licencia sintéticos creados y borrados por el propio script): login del alumno, activación (`expiresAt: null`), enlace permanente desde la portada pública, `resolve-perm` con marca de agua, lista HLS maestra y de calidad vía proxy, clave de descifrado, primer segmento (517 KB), avance de reproducción registrado, validación de la activación, re-login sin liberar la licencia, y límite de dispositivos (segundo equipo entra, tercero `DEVICE_LIMIT_EXCEEDED`) → **13/13 pasos correctos**. El video de demostración del curso "prueba" no trae pista de audio en su origen; el clip QA con tono de audio subido por la nueva ruta quedó procesado en Bunny con `CODECS="avc1.64000d,mp4a.40.2"` (audio presente).
- Lo único no ejecutado con un humano es escuchar el audio en el reproductor de escritorio; el flujo que el reproductor sigue (activación → resolve-perm → lista → clave → segmentos → progreso) es exactamente el que se validó.
- Revisión de interfaz en el fixture (`node test/frontend-fixture.cjs` → http://127.0.0.1:49310/productor): pestañas y contadores, claves completas, diálogo Administrar sin campos retirados, Estudiantes y ficha, y anchura móvil sin desplazamiento horizontal.

## 9. Despliegue

- Respaldos previos: `/root/backups/reproductor-code-2026-09-16-pre-licencias-estudiantes.tgz` y `/root/backups/campus_drm-2026-09-16-pre-licencias-estudiantes.dump`.
- Desplegado en `/opt/reproductor`, migración aplicada, `pm2 restart reproductor`, servicio `online`.
- Reversión: restaurar el tgz y ejecutar `migrations/20260916_licencias_permanentes.down.sql`.
