<!-- COMPARACION_DATOS_APK_VS_PC.md -->

# Comparación: Información del Dispositivo - APK vs Reproductor PC

## 1. DATOS CAPTURADOS (Lo que recopila cada cliente)

### Android APK - DeviceFingerprintAdvanced.kt
**13 campos capturados al iniciar la app:**

| # | Campo | Valor Ejemplo | Fuente |
|---|-------|---------------|--------|
| 1 | deviceModel | "Samsung Galaxy A10" | Build.MANUFACTURER + Build.MODEL |
| 2 | deviceSerial | "R38M7087CKL" | Build.SERIAL |
| 3 | deviceId | "dev_a1b2c3d4e5f6g7h8" | SHA256(androidId\|buildFingerprint\|serial) |
| 4 | osVersion | "Android 11 (API 30)" | Build.VERSION.RELEASE + Build.VERSION.SDK_INT |
| 5 | osVersionCode | 30 | Build.VERSION.SDK_INT (numeric) |
| 6 | cpuCores | 8 | Runtime.getRuntime().availableProcessors() |
| 7 | totalRam | "4.0 GB" | ActivityManager.MemoryInfo |
| 8 | androidId | "7b2a8d9e4c3f2b1a" | Settings.Secure.ANDROID_ID |
| 9 | buildFingerprint | "samsung/a10/a10:11/RP1A.200720.011/A105FDDU6CTC1:user/release-keys" | Build.FINGERPRINT |
| 10 | brand | "samsung" | Build.BRAND |
| 11 | manufacturer | "Samsung" | Build.MANUFACTURER |
| 12 | hwSerial | (igual a deviceSerial) | Build.SERIAL |
| 13 | captureTime | 1699564203000 | System.currentTimeMillis() |

**Almacenamiento local:** EncryptedSharedPreferences ("edulock_device")

---

### Windows Reproductor - player-app/main.js + watermark-manager.js
**5 campos capturados:**

| # | Campo | Valor Ejemplo | Fuente |
|---|-------|---------------|--------|
| 1 | deviceId | "dev_a1b2c3d4e5f6g7h8" | Registry (MachineGuid) o WMI (UUID) |
| 2 | ip | "192.168.1.100" | req.ip / req.connection.remoteAddress |
| 3 | userAgent | "Mozilla/5.0..." | navigator.userAgent |
| 4 | hostname | "DESKTOP-PS0R0HN" | OS hostname |
| 5 | **NO CAPTURA:** CPU, RAM, SO version, serial, fingerprint | (no disponible) | (no disponible) |

**Almacenamiento local:** Archivo `~/.edulock/device.json`

---

## 2. DATOS ENVIADOS AL BACKEND EN REGISTRO/LOGIN

### Android APK - LoginActivity.kt → POST /api/auth/login
```json
{
  "email": "usuario@ejemplo.com",
  "password": "password123",
  "deviceId": "dev_a1b2c3d4...",
  "deviceModel": "Samsung Galaxy A10",
  "fcmToken": "eNgc0O9d_qE:APA91bGm7x...",
  "deviceSerial": null,
  "osVersion": null
}
```
**⚠️ PROBLEMA:** Se capturan 13 campos pero solo se envían **3-4 campos**

---

### Android APK - LoginActivity.kt → POST /api/auth/register-request
```json
{
  "email": "nuevo@ejemplo.com",
  "name": "Juan Pérez",
  "password": "password123",
  "deviceId": "dev_a1b2c3d4...",
  "deviceModel": "Samsung Galaxy A10",
  "deviceSerial": "R38M7087CKL",
  "osVersion": "Android 11 (API 30)",
  "totalRam": "4.0 GB",
  "fcmToken": "eNgc0O9d_qE:APA91bGm7x..."
}
```
**✅ MEJOR:** En registro envía **7-8 campos**, pero **SIGUE FALTANDO:**
- cpuCores
- buildFingerprint
- brand, manufacturer
- androidId
- osVersionCode

---

### Windows Reproductor - server.js POST /api/auth/login (línea 521)
```json
{
  "email": "usuario@ejemplo.com",
  "studentId": "ID123",
  "deviceFingerprint": "dev_a1b2c3d4..."
}
```
**Backend recibe y valida:**
- deviceFingerprint (deviceId)
- IP del cliente
- Información geográfica (VPN/proxy detection)

---

## 3. DATOS ENVIADOS EN REPRODUCCIÓN DE VIDEO

### Android APK - PlayerActivity.kt (ACTUALMENTE)
```
❌ NO ENVÍA NADA
La APK reproduce videos pero NO registra información del dispositivo en cada reproducción
```

---

### Windows Reproductor - watermark-manager.js logDelivery()
```javascript
await db.logDelivery({
  userId:      user.id,
  videoId:     videoId,
  deviceId:    deviceId,
  ip:          clientIp,
  userAgent:   userAgent,
  deliveredAt: new Date().toISOString()
})
```

**⚠️ CRÍTICO:** El backend recibe:
- mediaToken (verificado en POST /api/watermark/log)
- deviceId (si está en JWT)
- IP (del cliente)
- User-Agent

**Pero NO almacena esta información** - Solo verifica que el mediaToken sea válido y responde `{ ok: true }`

---

## 4. RESUMEN: BRECHA DE DATOS

### ✅ Datos que AMBOS capturan
- deviceId (identificador único del dispositivo)
- Información de modelo/OS

### 🟡 Datos que SOLO captura APK (pero NO envía)
- CPU cores
- Build fingerprint
- Brand, manufacturer
- OS version code
- Android ID
- Total RAM (captura pero solo envía en registro, NO en login)

### 🟡 Datos que SOLO captura PC (pero NO siempre envía)
- IP del cliente
- User Agent
- Hostname

### ❌ Brecha en reproducción de video
**APK:** No envía datos en cada play
**PC:** Envía deviceId, IP, userAgent en cada play (pero backend solo registra mediaToken)

---

## 5. SOLUCIÓN RECOMENDADA

### Para alcanzar PARIDAD COMPLETA (APK = PC):

**Paso 1: Actualizar RegistrationRequest & LoginRequest**
```kotlin
data class LoginRequest(
    val email: String,
    val password: String,
    val deviceId: String,
    val deviceModel: String,
    val fcmToken: String,
    val deviceSerial: String?,
    val osVersion: String?,
    val cpuCores: Int?,           // AGREGAR
    val totalRam: String?,        // AGREGAR (no solo en registro)
    val buildFingerprint: String? // AGREGAR
)
```

**Paso 2: Actualizar LoginActivity.kt - performLogin()**
```kotlin
val request = LoginRequest(
    email = email,
    password = password,
    deviceId = deviceInfo.deviceId,
    deviceModel = deviceInfo.deviceModel,
    deviceSerial = deviceInfo.deviceSerial,        // AGREGAR
    osVersion = deviceInfo.osVersion,              // AGREGAR
    cpuCores = deviceInfo.cpuCores,                // AGREGAR
    totalRam = deviceInfo.totalRam,                // AGREGAR
    buildFingerprint = deviceInfo.buildFingerprint, // AGREGAR
    fcmToken = fcmToken
)
```

**Paso 3: Actualizar PlayerActivity.kt**
Crear nueva función `logPlaybackStart()` que llama a POST /api/watermark/log con info completa:
```kotlin
WatermarkLogRequest(
    mediaToken = mediaToken,
    videoId = videoId,
    deviceId = deviceInfo.deviceId,
    timestamp = System.currentTimeMillis(),
    deviceModel = deviceInfo.deviceModel,        // AGREGAR
    buildFingerprint = deviceInfo.buildFingerprint // AGREGAR
)
```

**Paso 4: Actualizar server.js POST /api/auth/login (línea 521)**
```javascript
const { email, password, deviceId, deviceModel, cpuCores, totalRam, buildFingerprint } = req.body;
// Guardar en base de datos con todos los campos
```

**Paso 5: Actualizar server.js POST /api/watermark/log (línea 2601)**
```javascript
app.post('/api/watermark/log', async (req, res) => {
    const { mediaToken, videoId, deviceId, deviceModel, buildFingerprint, timestamp } = req.body || {};
    // Verificar mediaToken
    // Guardar en base de datos: { userId, videoId, deviceId, deviceModel, ip, timestamp }
    res.json({ ok: true });
});
```

---

## 6. PREGUNTAS CLAVE PARA EL USUARIO

**¿Quieres implementar COMPLETA PARIDAD?** (APK = PC en captura y transmisión)

**Opción A (Rápida - 30min):**
- APK envía todos los 13 campos en login/registro
- Backend guarda en base de datos
- Video playback sigue sin logging (como está ahora)

**Opción B (Completa - 2h):**
- APK envía todos los 13 campos EN CADA API CALL
- Backend almacena INFO DEL DISPOSITIVO en cada reproducción
- Auditoría completa: quién, cuándo, desde qué dispositivo, viendo qué

**Opción C (Máxima seguridad - 3h):**
- Opción B +
- Detección de cambios de dispositivo (no permitir login desde otro)
- Detección de múltiples sesiones simultáneas
- Blacklist de dispositivos sospechosos

---

## CONCLUSIÓN

**Respuesta a: "¿toda la información que el apk recopila lo envia a la pagina de render asi como lo hace el programa de pc?"**

**NO:** 
- ✅ APK **CAPTURA** toda la información (13 campos)
- 🟡 APK **ENVÍA** solo parte (7-8 en registro, 3-4 en login, 0 en reproducción)
- ❌ Backend **ALMACENA** solo el mediaToken, no la info del dispositivo

**Para lograr PARIDAD TOTAL (exactamente igual que PC):**
- Necesitas actualizar APK para enviar todos los campos
- Necesitas actualizar backend para recibir y almacenar esos datos
- Necesitas crear endpoint de auditoría en reproducción de videos

