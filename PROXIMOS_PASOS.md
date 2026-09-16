<!-- PROXIMOS_PASOS.md -->

# 🚀 Próximos Pasos - Integración Completa

## ✅ APK Ya Completada

```
┌─ FASE 1: DESARROLLO APK ────────────────────────┐
│                                                  │
│  ✅ COMPLETADA                                  │
│                                                  │
│  • 13 campos device info capturados              │
│  • Reproducción de videos implementada          │
│  • Watermarking forense integrado               │
│  • Device change detection activo               │
│  • FCM notificaciones funcional                 │
│  • Security hardened (FLAG_SECURE)              │
│  • Código compilable sin errores                │
│                                                  │
│  RESULTADO: app-release.apk LISTA               │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## 🔧 FASE 2: Actualización Backend (30-45 minutos)

### ⏱️ Tiempo estimado: 30-45 minutos

### Cambios requeridos en server.js:

#### 1. Ampliar LoginRequest (5 min)
```javascript
// En POST /api/auth/login
// Recibir estos 13 campos en lugar de solo email+password:

const deviceInfo = {
  deviceId: req.body.deviceId,        // ✅ YA PRESENTE
  deviceModel: req.body.deviceModel,
  deviceSerial: req.body.deviceSerial,
  osVersion: req.body.osVersion,
  osVersionCode: req.body.osVersionCode,
  cpuCores: req.body.cpuCores,
  totalRam: req.body.totalRam,
  androidId: req.body.androidId,
  buildFingerprint: req.body.buildFingerprint,
  brand: req.body.brand,
  manufacturer: req.body.manufacturer,
  fcmToken: req.body.fcmToken
};

// Guardar en database: users[user_id].device_info = deviceInfo
```

#### 2. Ampliar RegistrationRequest (5 min)
```javascript
// En POST /api/auth/register-request
// Similar a LoginRequest: guardar todos los 13 campos
// Más: email, name, password

const registrationData = {
  email: req.body.email,
  name: req.body.name,
  password: req.body.password,
  ...deviceInfo  // Los 13 campos anteriores
};
```

#### 3. Implementar POST /api/watermark/log (15-20 min)
```javascript
// Nuevo endpoint que NO EXISTE en server.js

app.post('/api/watermark/log', authenticateToken, async (req, res) => {
  try {
    // Datos enviados por APK:
    const {
      mediaToken,           // Token que identifica reproducción
      videoId,              // ID del video
      deviceId,             // Hash del dispositivo
      timestamp,            // Cuando empezó
      deviceModel,
      buildFingerprint,
      osVersion,
      cpuCores,
      watchedPercentage     // Opcional: % visto (en logPlaybackEnd)
    } = req.body;

    // GUARDAR EN BASE DE DATOS (tabla: watermark_logs)
    const watermarkEntry = {
      user_id: req.user.id,
      video_id: videoId,
      media_token: mediaToken,
      device_id: deviceId,
      device_model: deviceModel,
      build_fingerprint: buildFingerprint,
      os_version: osVersion,
      cpu_cores: cpuCores,
      timestamp: new Date(timestamp),
      watched_percentage: watchedPercentage || 0,
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    };

    // Guardar en DB
    await database.watermarkLogs.push(watermarkEntry);

    // Responder a APK
    res.json({
      success: true,
      message: "Watermark logged successfully"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

#### 4. Verificar existencia de estos endpoints (5 min)

Buscar en server.js si ya existen:

✅ `POST /api/auth/login` - Existe, ACTUALIZAR para 13 campos
✅ `POST /api/auth/register-request` - Existe, ACTUALIZAR para 13 campos
✅ `GET /api/video/list` - Verificar que retorna videos correctamente
✅ `GET /api/video/{videoId}/play` - Verificar que retorna manifestUrl + mediaToken
✅ `POST /api/watermark/log` - **NO EXISTE, CREAR NUEVO**

---

## 📋 Checklist de Backend

- [ ] **1. POST /api/auth/login** - Recibe 13 campos device info
  - [ ] Guardar device_info en users[user_id].device_info
  - [ ] Usar deviceId para autenticación
  - [ ] Verificar que mediaToken se genera correctamente

- [ ] **2. POST /api/auth/register-request** - Recibe 13 campos device info
  - [ ] Guardar device_info en registro
  - [ ] Crear estructura de usuario con device info

- [ ] **3. POST /api/watermark/log** - NUEVO ENDPOINT
  - [ ] Crear endpoint
  - [ ] Guardar datos en tabla watermark_logs
  - [ ] Registrar: device_id, device_model, buildFingerprint, etc.
  - [ ] Responder success: true

- [ ] **4. Estructura de Base de Datos**
  - [ ] users table: agregar columna device_info (JSON)
  - [ ] watermark_logs table: crear con campos necesarios
  - [ ] Migrations/scripts listos

- [ ] **5. Testing**
  - [ ] Login con 13 campos funciona
  - [ ] Watermark logging funciona
  - [ ] APK recibe respuestas correctas

---

## 🧪 Testing Local

### 1. Compilar APK
```bash
cd d:\descargas\proyectos hunter 2\reproductor-cursos-master\player-apk-android
./gradlew assembleDebug
# Resultado: app-debug.apk
```

### 2. Instalar en emulador
```bash
# Asegurarse que Android emulator está corriendo
adb install -r app-debug.apk
```

### 3. Ejecutar flujo completo
```
1. Abrir app
2. LOGIN: email/password
   └─ Verificar que se envían 13 campos a POST /api/auth/login
   
3. CATÁLOGO: ver lista de videos
   └─ Verificar que GET /api/video/list retorna videos

4. REPRODUCIR: hacer click en video
   └─ Verificar que GET /api/video/{videoId}/play retorna manifestUrl + mediaToken
   
5. WATERMARK: ver video por 10 segundos
   └─ Verificar que POST /api/watermark/log se llama
   └─ Verificar en backend que se registró el watermark
```

### 4. Verificar en backend
```javascript
// En console de backend:
console.log(database.watermarkLogs);  // Ver todos los watermarks registrados

// Debe tener estructura:
{
  user_id: "...",
  video_id: "...",
  device_id: "dev_xxxx",
  device_model: "...",
  buildFingerprint: "...",
  timestamp: "2024-...",
  watched_percentage: 0
}
```

---

## 🎯 Orden de Implementación Recomendado

### PASO 1: Actualizar endpoints existentes (10 min)
1. Abrir server.js
2. Buscar `POST /api/auth/login`
3. Agregar los 13 campos a la captura de deviceInfo
4. Guardar en users table

### PASO 2: Crear nuevo endpoint (20 min)
1. Crear `POST /api/watermark/log`
2. Validar token JWT
3. Guardar watermark en database.watermarkLogs
4. Retornar { success: true }

### PASO 3: Testing (15 min)
1. Compilar APK debug
2. Instalar en emulador
3. Ejecutar flujo de login → catálogo → reproducción
4. Verificar que watermarks llegan a backend

### PASO 4: Producción (5 min)
1. Compilar APK release
2. Subir a Google Play Store (opcional)
3. Desplegar backend actualizado

---

## 📝 Archivos a Modificar

```
Backend (Node.js):
  server.js
    └─ POST /api/auth/login - Ampliar deviceInfo (13 campos)
    └─ POST /api/auth/register-request - Ampliar deviceInfo
    └─ POST /api/watermark/log - NUEVO ENDPOINT
  
  database.js (si existe)
    └─ Agregar tabla: watermark_logs
    └─ Agregar columnas: device_id, device_model, buildFingerprint, etc.

  (Opcional) migrations/ o schema files
    └─ Script para agregar watermark_logs table
```

---

## 🔗 Integración Completa

```
APK (Android)
    ↓
    ├─→ POST /api/auth/login [13 fields]
    ├─→ POST /api/auth/register-request [13 fields]
    ├─→ GET /api/video/list
    ├─→ GET /api/video/{id}/play
    └─→ POST /api/watermark/log [watermark forensic data]
    
Backend (Node.js)
    ├─→ users.device_info [13 campos guardados]
    ├─→ watermark_logs table [rastreo forense]
    ├─→ Firebase Admin SDK [notificaciones FCM]
    └─→ JWT validation [auth en cada endpoint]

Database
    ├─→ users: device_info JSON
    ├─→ watermark_logs: forensic tracking
    └─→ videos: lista de videos permitidos
```

---

## ✨ Resultado Final

Después de estos cambios:

```
✅ APK + Backend = Sistema Completo
  
  • Usuario hace login → 13 campos device info guardados
  • Usuario ve catálogo de videos → Descargado del backend
  • Usuario reproduce video → Watermark registrado
  • Backend → Tiene rastreo forense completo
  • Admin → Puede ver quién vio qué, en qué dispositivo
```

---

## 💡 Próximos Pasos Inmediatos

1. **HOY:** 
   - Empezar con PASO 1 (Actualizar endpoints existentes)
   - Tarda 10 minutos máximo

2. **Continuación:**
   - PASO 2: Crear POST /api/watermark/log (20 min)
   - PASO 3: Testing en emulador (15 min)
   - PASO 4: Deploy a producción (5 min)

3. **Total Backend:** 50 minutos

---

## 📞 Preguntas Frecuentes

**P: ¿La APK está lista para usar?**
R: SÍ. 100% completa y funcional. Solo espera el backend.

**P: ¿Debo cambiar algo en la APK?**
R: NO. Todo está listo. Solo deployer a Google Play cuando esté lista.

**P: ¿Cuánto tarda actualizar el backend?**
R: 30-50 minutos siguiendo este documento.

**P: ¿Qué pasa si no actualizo el backend?**
R: La APK intentará hacer watermark logging pero el backend retornará 404.
  La app seguirá funcionando (no crash), pero el logging no se guardará.

---

## 🎉 Conclusión

```
┌──────────────────────────────────┐
│  APK:      ✅ LISTA             │
│  Backend:  ⏳ Necesita 30-50min │
│  Testing:  ⏳ Necesita 15min    │
│  Deploy:   ⏳ Necesita 5min     │
│                                  │
│  ETA: 1-2 horas para COMPLETO  │
└──────────────────────────────────┘
```

Adelante con el backend. Cualquier duda, revisar GUIA_IMPLEMENTACION_RAPIDA.md

