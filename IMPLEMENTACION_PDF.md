# Implementación del PDF — Edulock Systems

Este documento resume el rebrand a Edulock y la implementación del roadmap del
PDF de factibilidad. **No se tocó ninguna VPS ni servicio remoto**; todo son cambios de
código en esta carpeta (`Edulock Systems - Completo`).

---

## 1. Rebrand + limpieza de credenciales (hecho)

- **Credenciales anteriores eliminadas** de `.env`, `.env.bak`, `.env.example`,
  `_env_backup.json` y de un secreto de BD que estaba en texto plano en `_make_deploy_pdf.js`.
- **`.env` ahora usa identidad Edulock**: dominio `edulocksystemsoficial.dpdns.org`,
  JWT/admin de Edulock, `APP_SECRET` alineado con el reproductor y el APK, Bunny intacto.
- **Rebrand de marca** en 123 archivos: nombres, dominios, package Android
  (`com.edulock.player`, applicationId `edulock.systemsoficial.com`), servicio `edulockvps`,
  logos e iconos (web + APK) reemplazados por los de Edulock.
- **Carpeta renombrada** a `Edulock Systems - Completo`.

### Pendiente que debes completar tú (no se puede desde aquí)
- **`DATABASE_URL`** en `.env` tiene un placeholder: `postgresql://edulock:CHANGE_ME_DB_PASSWORD@localhost:5432/campus_drm`.
  `setup.sh` crea la BD y te da la contraseña real — pégala ahí.
- **Firebase**: todo apunta ya a tu proyecto real `edulock-systems-oficial` (`61528672386`):
  config web corregida en admin/remote-admin/served-admin/auth.html, `google-services.json`
  oficial, y `FIREBASE_PROJECT_ID` en `.env`. El service account anterior fue eliminado.
  **Falta solo** descargar el service account de `edulock-systems-oficial` para activar el push
  (FCM) — ver **FIREBASE_SETUP.md**. El login ya funciona sin él.
- **Build viejo del reproductor**: `player-app/dist/win-unpacked/.../app.asar` es un ejecutable
  ya empaquetado de una compilación anterior y todavía contiene la config Firebase vieja dentro.
  Se regenera al **recompilar** el reproductor (`npm run build:win` en `player-app/`). Puedes
  borrar `player-app/dist/` sin problema; se recrea al construir.
- **Keystore del APK**: `player-apk-android/keystore.jks` sigue siendo el de firma anterior.
  Si quieres firmar el APK como Edulock con una llave nueva, genérala y actualiza `keystore.properties`.

---

## 2. Roadmap del PDF — implementado

### P0 · Seguridad crítica
- **Cierre del bypass de autorización (token `guest`)** — `server.js`
  - Nuevo helper `hasVideoAccess(payload, videoId, courseId)`.
  - `/api/r/:videoId` (manifest): auth obligatoria, sin bypass `guest`, valida acceso por video **o curso**.
  - `/api/b/:videoId` (segmento Bunny): añade validación de acceso al video.
  - `/api/b/:videoId/:segname` (segmento local): **antes no tenía auth**; ahora exige token + acceso.
- **Revocación en tiempo real (licencia/alumno)** — `server.js`
  - Helper `studentAccessRevoked(sub)` con caché de 60s.
  - El **heartbeat** expulsa al reproductor si el alumno fue suspendido/eliminado (≤30s).
  - Suspender a un alumno invalida la caché al instante (`invalidateStudentStatus`).

### P1 · Escalabilidad y endurecimiento
- **Rate-limit de login** (`authRateLimit`) en `/api/auth/login`, `/login-email`, `/admin-login`.
  10 intentos / 15 min por IP+ruta (configurable con `AUTH_RL_MAX`, `AUTH_RL_WINDOW_MS`).
- **nginx** (`nginx.conf`): `proxy_buffering off` en las rutas de media **reales** `~ ^/api/(r|b)/`
  (la antigua `/api/proxy/segment/` ya no existe) → el cifrado en streaming vuelve a funcionar.
- **PM2** (`ecosystem.config.js`): `instances: 1` / `fork` para no romper el estado en memoria.
  Para volver a cluster (`max`), primero mueve `_keyTokens`/rate-limit/caché a Redis.

### P1/P2 · Máquina de estados de licencia
- `db.setLicenseStatus(id, next, by)` con transiciones válidas
  (`free→active`, `active↔suspended`, `active→revoked/expired`, …).
- Endpoint `POST /api/admin/licenses/:id/status` `{ status }`.

### P2 · Lotes de seriales + generación masiva
- Tablas nuevas: `license_lots`; columnas nuevas en `licenses`
  (`lot_id`, `customer_email`, `order_id`, `assigned_at`, `suspended_at`; `student_id` ahora nullable).
- `POST /api/license/generate-bulk` `{ courseId?, quantity, maxDevices?, expiresAt?, notes? }`
  → crea un lote de N seriales **libres** y **devuelve las claves en claro una sola vez** (guárdalas/exporta a CSV).
- `GET /api/license/lots` → resumen por lote (total / libres / usados).
- `GET /api/license/lots/:id/licenses` → licencias del lote (sin la clave en claro).

### P2 · API de ventas automatizada (Hotmart / WooCommerce / etc.)
- Tabla `integration_keys` (API keys con permiso mínimo `claim-license`).
- `POST /api/admin/integration-keys` `{ name }` → crea la API key (se muestra 1 vez).
- `GET /api/admin/integration-keys`, `DELETE /api/admin/integration-keys/:id`.
- `POST /api/integrations/claim-license` (header `x-api-key`) `{ courseId?, customerEmail, orderId? }`
  → asigna atómicamente un serial libre del curso al comprador (vincula al alumno si ya existe).

---

## 3. Roadmap del PDF — NO implementado (requiere infra o decisión)

| Ítem | Por qué queda fuera |
|---|---|
| Redis para estado compartido | Necesita un Redis desplegado. Mientras tanto: `instances: 1`. |
| Entrega directa por URL firmada de Bunny (sin proxy) | Cambio arquitectónico grande; además el proxy actual aporta re-cifrado + marca de agua. El fix de nginx ya elimina el peor efecto. |
| Multi-tenancy de productores | El propio PDF lo marca "solo si vendes la plataforma a terceros". |
| Refresh de token en el APK/reproductor | Requiere tocar y recompilar los clientes; los endpoints de servidor ya lo soportan. |
| **Paneles de admin para lotes / API keys / estados** | Los endpoints funcionan por API; falta cablearlos en `admin.html` (269 KB). Recomendado hacerlo como paso siguiente enfocado y probándolo. |

---

## 4. Verificación

- `node --check server.js` y `node --check database-pg.js`: **OK**.
- Arranque real de prueba (`node server.js`): el servidor carga y escucha sin errores de runtime.
- Migraciones de BD: idempotentes (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) →
  seguras sobre una BD existente; se aplican solas al iniciar.
