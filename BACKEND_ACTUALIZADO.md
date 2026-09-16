<!-- BACKEND_ACTUALIZADO.md -->

# ✅ BACKEND ACTUALIZADO - TODO COMPLETO

## 🎯 Cambios Realizados

El backend (server.js + database-pg.js) ha sido actualizado para soportar **13 campos de dispositivo** enviados por el APK.

---

## 📦 Cambios por Archivo

### 1️⃣ **database-pg.js**

#### ✅ NUEVA TABLA: `watermark_logs`
```sql
CREATE TABLE watermark_logs (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             TEXT NOT NULL,
    video_id            TEXT NOT NULL,
    media_token         TEXT,
    device_id           TEXT NOT NULL,
    device_model        TEXT,
    build_fingerprint   TEXT,
    os_version          TEXT,
    cpu_cores           TEXT,
    android_id          TEXT,
    device_serial       TEXT,
    brand               TEXT,
    manufacturer        TEXT,
    timestamp           TEXT NOT NULL,
    watched_percentage  INTEGER,
    ip_address          TEXT,
    user_agent          TEXT,
    created_at          TEXT
);
```
**Índices agregados:** user_id, video_id, device_id, timestamp

#### ✅ NUEVAS COLUMNAS en `students`:
- `password_hash` - Para login con email+password
- `device_serial`
- `os_version`
- `os_version_code`
- `cpu_cores`
- `total_ram`
- `android_id`
- `build_fingerprint`
- `brand`
- `manufacturer`
- `fcm_token`

#### ✅ NUEVAS COLUMNAS en `registration_requests`:
- `device_serial`
- `os_version`
- `os_version_code`
- `cpu_cores`
- `total_ram`
- `android_id`
- `build_fingerprint`
- `brand`
- `manufacturer`
- `fcm_token`

---

### 2️⃣ **server.js**

#### ✅ NEW ENDPOINT: `POST /api/auth/login-email`

**Propósito:** Login para APK con email + password + 13 campos device

**Request Body:**
```json
{
  "email": "usuario@mail.com",
  "password": "xxxxx",
  "deviceId": "dev_abc123xyz",
  "deviceModel": "Samsung Galaxy A10",
  "deviceSerial": "RA8T10BX0ZP",
  "osVersion": "13",
  "osVersionCode": "33",
  "cpuCores": "8",
  "totalRam": "4096",
  "androidId": "a1b2c3d4e5f6g7h8",
  "buildFingerprint": "samsung/a10/a10:13:TP1A.220624.014:1234567:user/release-keys",
  "brand": "samsung",
  "manufacturer": "Samsung",
  "fcmToken": "firebase_token_xyz"
}
```

**Response (Success):**
```json
{
  "token": "eyJhbGc...",
  "expiresIn": "7d",
  "status": "approved",
  "email": "usuario@mail.com"
}
```

**Response (Error):**
```json
{ "error": "Email o contraseña incorrecto" }
{ "error": "Cuenta pending. Esperando aprobación del administrador." }
```

#### ✅ UPDATED ENDPOINT: `POST /api/watermark/log`

**Nuevo:** Ahora guarda los 8 campos de dispositivo en tabla watermark_logs

**Request Body:**
```json
{
  "mediaToken": "eyJhbGc...",
  "videoId": "video_123",
  "deviceId": "dev_abc123xyz",
  "timestamp": "2026-05-28T10:15:00Z",
  "deviceModel": "Samsung Galaxy A10",
  "buildFingerprint": "samsung/a10/...",
  "osVersion": "13",
  "cpuCores": "8",
  "androidId": "a1b2c3d4e5f6g7h8",
  "deviceSerial": "RA8T10BX0ZP",
  "brand": "samsung",
  "manufacturer": "Samsung",
  "watchedPercentage": 45
}
```

**Guardado en BD:**
```sql
INSERT INTO watermark_logs (
  user_id, video_id, media_token, device_id, device_model, build_fingerprint,
  os_version, cpu_cores, android_id, device_serial, brand, manufacturer,
  timestamp, watched_percentage, ip_address, user_agent
) VALUES (...)
```

#### ✅ UPDATED ENDPOINT: `POST /api/auth/register-request`

**Ahora acepta 13 campos device:**
```json
{
  "email": "usuario@mail.com",
  "name": "Juan Pérez",
  "deviceId": "dev_abc123xyz",
  "deviceModel": "Samsung Galaxy A10",
  "deviceSerial": "RA8T10BX0ZP",
  "osVersion": "13",
  "osVersionCode": "33",
  "cpuCores": "8",
  "totalRam": "4096",
  "androidId": "a1b2c3d4e5f6g7h8",
  "buildFingerprint": "samsung/a10/...",
  "brand": "samsung",
  "manufacturer": "Samsung",
  "fcmToken": "firebase_token_xyz"
}
```

#### ✅ UPDATED ENDPOINT: `POST /api/auth/firebase-login`

**Ahora captura 13 campos device:**
- Actualizó tabla students con todos los campos
- Mantiene compatibilidad con Firebase
- Guarda device info en cada login

---

## 📊 Flujo Completo: APK → Backend

### 🔐 1. REGISTRO (POST /api/auth/register-request)

```
APK
  ↓
  Captura 13 campos device
  ↓
POST /api/auth/register-request {
  email, name, deviceId, deviceModel, deviceSerial,
  osVersion, osVersionCode, cpuCores, totalRam,
  androidId, buildFingerprint, brand, manufacturer, fcmToken
}
  ↓
Backend
  ↓
  Crea entrada en registration_requests (pendiente)
  ↓
  Response: { status: "pending", requestId: "xxx" }
  ↓
Admin aprueba en dashboard
  ↓
Backend crea estudiante en tabla students con todos los 13 campos
```

### 🔑 2. LOGIN (POST /api/auth/login-email)

```
APK
  ↓
  Ingresa email + password
  ↓
POST /api/auth/login-email {
  email, password, deviceId, deviceModel, ...13 campos...
}
  ↓
Backend
  ↓
  Busca estudiante por email
  Verifica password (hash)
  Guarda 13 campos en tabla students
  Genera JWT token
  ↓
Response: { token: "...", status: "approved", email: "..." }
  ↓
APK navega a CatalogActivity
```

### 📹 3. REPRODUCCIÓN (POST /api/watermark/log)

```
APK
  ↓
  PlayerActivity inicia video
  ↓
POST /api/watermark/log {
  mediaToken, videoId, deviceId, timestamp,
  deviceModel, buildFingerprint, osVersion, cpuCores,
  androidId, deviceSerial, brand, manufacturer, watchedPercentage
}
  ↓
Backend
  ↓
  Verifica mediaToken (JWT válido)
  Extrae user_id del token
  Guarda en tabla watermark_logs (8 campos device)
  ↓
Response: { success: true }
  ↓
APK continúa reproduciendo
```

---

## 🗄️ Estructura Base de Datos

### Tabla: `watermark_logs` (NUEVA)
```
id                  → BIGSERIAL PK
user_id             → TEXT (FK students)
video_id            → TEXT
media_token         → TEXT
device_id           → TEXT (indexed)
device_model        → TEXT
build_fingerprint   → TEXT
os_version          → TEXT
cpu_cores           → TEXT
android_id          → TEXT
device_serial       → TEXT
brand               → TEXT
manufacturer        → TEXT
timestamp           → TEXT (indexed)
watched_percentage  → INTEGER
ip_address          → TEXT
user_agent          → TEXT
created_at          → TEXT (indexed)
```

### Tabla: `students` (ACTUALIZADA)
```
Nuevas columnas:
- password_hash     → TEXT (para email+password login)
- device_serial     → TEXT
- os_version        → TEXT
- os_version_code   → TEXT
- cpu_cores         → TEXT
- total_ram         → TEXT
- android_id        → TEXT
- build_fingerprint → TEXT
- brand             → TEXT
- manufacturer      → TEXT
- fcm_token         → TEXT
```

### Tabla: `registration_requests` (ACTUALIZADA)
```
Nuevas columnas (mismas que students):
- device_serial, os_version, os_version_code, cpu_cores, total_ram,
  android_id, build_fingerprint, brand, manufacturer, fcm_token
```

---

## 🚀 Cómo Probar Localmente

### 1️⃣ Verificar que la BD tiene las nuevas tablas/columnas

```bash
# Conectar a PostgreSQL
psql -U usuario -d tu_db -h localhost

# Ver tabla watermark_logs
\d watermark_logs

# Ver nuevas columnas en students
\d students

# Ver nuevas columnas en registration_requests
\d registration_requests
```

### 2️⃣ Probar POST /api/auth/login-email

```bash
curl -X POST http://localhost:3000/api/auth/login-email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@mail.com",
    "password": "password123",
    "deviceId": "dev_test123",
    "deviceModel": "Samsung A10",
    "deviceSerial": "ABC123",
    "osVersion": "13",
    "osVersionCode": "33",
    "cpuCores": "8",
    "totalRam": "4096",
    "androidId": "xyz123",
    "buildFingerprint": "samsung/a10/...",
    "brand": "samsung",
    "manufacturer": "Samsung",
    "fcmToken": "token123"
  }'
```

### 3️⃣ Probar POST /api/watermark/log

```bash
curl -X POST http://localhost:3000/api/watermark/log \
  -H "Content-Type: application/json" \
  -d '{
    "mediaToken": "eyJhbGc...",
    "videoId": "video_123",
    "deviceId": "dev_test123",
    "timestamp": "2026-05-28T10:15:00Z",
    "deviceModel": "Samsung A10",
    "buildFingerprint": "samsung/a10/...",
    "osVersion": "13",
    "cpuCores": "8",
    "androidId": "xyz123",
    "deviceSerial": "ABC123",
    "brand": "samsung",
    "manufacturer": "Samsung",
    "watchedPercentage": 50
  }'
```

### 4️⃣ Verificar watermark_logs en BD

```bash
SELECT * FROM watermark_logs ORDER BY created_at DESC LIMIT 5;
```

---

## ⚙️ Configuración Necesaria

### Variables de Entorno (si no están ya configuradas)

```env
DATABASE_URL=postgresql://usuario:password@localhost:5432/reproductor_cursos
JWT_SECRET=tu_secreto_jwt
STUDENT_JWT_EXPIRES=7d
JWT_EXPIRES=30d
NODE_ENV=development
```

### Base de Datos

La migración automática ocurre al iniciar el servidor:
1. Crea tabla watermark_logs si no existe
2. Agrega columnas faltantes a students
3. Agrega columnas faltantes a registration_requests

**No necesitas hacer migrations manuales** - PostgreSQL usa `CREATE TABLE IF NOT EXISTS` y `ALTER TABLE IF NOT EXISTS`.

---

## 📊 Verificación Post-Actualización

### ✅ Checklist:

- [x] Tabla watermark_logs creada
- [x] Columnas device_info agregadas a students
- [x] Columnas device_info agregadas a registration_requests
- [x] POST /api/auth/login-email implementado
- [x] POST /api/watermark/log captura 13 campos
- [x] POST /api/auth/register-request captura 13 campos
- [x] POST /api/auth/firebase-login captura 13 campos
- [x] Índices creados en watermark_logs para performance

---

## 🔗 Integración Completa

```
APK (13 campos)
    ↓
    ├─→ POST /api/auth/login-email
    ├─→ POST /api/auth/register-request
    ├─→ POST /api/auth/firebase-login
    └─→ POST /api/watermark/log
    ↓
Backend (server.js)
    ├─→ Verifica credenciales
    ├─→ Guarda 13 campos en students
    ├─→ Guarda 8 campos en watermark_logs
    └─→ Retorna JWT token
    ↓
Database (PostgreSQL)
    ├─→ students (13 campos device)
    ├─→ registration_requests (13 campos)
    └─→ watermark_logs (8 campos + metadata)
    ↓
Admin Dashboard
    └─→ Puede ver watermarks de cada usuario
        por video, dispositivo, timestamp
```

---

## 🎉 Estado Final

```
┌──────────────────────────────────┐
│    Backend + APK Integrados      │
│                                  │
│  ✅ APK: Captura 13 campos       │
│  ✅ Backend: Recibe 13 campos    │
│  ✅ BD: Almacena todo            │
│  ✅ Rastreo: 100% Completo       │
│                                  │
│  LISTO PARA PRODUCCIÓN           │
└──────────────────────────────────┘
```

---

## 📝 Próximos Pasos

1. **Reiniciar servidor Node.js**
   ```bash
   npm restart  # o similar según tu setup
   ```

2. **Verificar logs en console**
   ```
   [db-pg] Schema listo (watermark_logs + device_info agregadas)
   ```

3. **Probar desde APK**
   - Registro → Login → Ver catálogo → Reproducir video
   - Verificar que watermark_logs llena con datos

4. **Monitorear base de datos**
   ```sql
   SELECT COUNT(*) FROM watermark_logs;
   SELECT * FROM watermark_logs ORDER BY timestamp DESC;
   ```

---

## 🐛 Troubleshooting

### Error: "Token inválido" en watermark/log
```
→ Verificar que mediaToken es un JWT válido
→ Verificar que JWT_SECRET es el mismo
```

### Error: "DB no disponible"
```
→ Verificar que DATABASE_URL es correcto
→ Verificar que PostgreSQL está corriendo
→ Ver logs: heroku logs (si está en Heroku)
```

### Columnas no creadas
```
→ El servidor crea automáticamente con ALTER TABLE
→ Si no funciona, ejecutar manualmente:
  ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT;
```

---

**Backend actualizado exitosamente. APK listo para usar.** ✨

