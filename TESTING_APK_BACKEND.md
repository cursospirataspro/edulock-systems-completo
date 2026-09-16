<!-- TESTING_APK_BACKEND.md -->

# 🧪 Testing APK + Backend Integrado

## 📋 Resumen de Cambios

### Backend (Node.js)
✅ Tabla `watermark_logs` para rastreo forense
✅ Columnas device_info en `students` (13 campos)
✅ Endpoint POST /api/auth/login-email (email+password)
✅ Endpoint POST /api/watermark/log mejorado (guarda 8 campos)
✅ Endpoints actualizados para capturar 13 campos device

### APK (Android)
✅ PlayerActivity (reproducción HLS + watermarking)
✅ CatalogActivity (lista de videos)
✅ VideoAdapter (thumbnails con Glide)
✅ DeviceChangeDetector (anti-fraude)
✅ Captura de 13 campos device info

---

## 🚀 Plan de Testing (Paso a Paso)

### FASE 1: Verificar Backend Está Listo

#### 1.1 Reiniciar servidor Node.js

```bash
# Si está corriendo localmente
npm start

# Si está en Heroku
heroku restart -a tu_app_name

# Esperar 30 segundos para que levante
```

#### 1.2 Verificar logs del servidor

```bash
# Buscar este mensaje:
# [db-pg] Schema listo (watermark_logs + device_info agregadas)
```

**Si no ves el mensaje:**
```
→ Revisar DATABASE_URL
→ Revisar conexión a PostgreSQL
→ Ver si hay errores de schema
```

#### 1.3 Verificar tablas en PostgreSQL

```bash
# Conectar a la BD
psql -U usuario -d reproductor_cursos -h localhost

# Ver si existe watermark_logs
\d watermark_logs
# Debe retornar tabla con 17 columnas

# Ver columnas nuevas en students
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'students' 
ORDER BY ordinal_position;

# Debe incluir: password_hash, device_serial, os_version, etc.
```

---

### FASE 2: Testing Manual del Backend

#### 2.1 Test POST /api/auth/login-email

```bash
# 1. Crear usuario en BD (si no existe)
#    INSERT INTO students (id, email, student_id, name, active, approval_status, password_hash)
#    VALUES ('user_1', 'test@mail.com', 'A12345', 'Test User', 1, 'approved', 'hash_bcrypt_aqui');

# 2. Hacer login
curl -X POST http://localhost:3000/api/auth/login-email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@mail.com",
    "password": "password123",
    "deviceId": "dev_test_001",
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
    "fcmToken": "eEpzMldhVkQ..._firebase_token"
  }'

# Esperado:
# { "token": "eyJhbGc...", "status": "approved", "email": "test@mail.com" }
```

#### 2.2 Verificar que se guardó device info en students

```bash
SELECT device_id, device_model, os_version, cpu_cores, android_id 
FROM students 
WHERE email = 'test@mail.com';

# Debe retornar los 13 campos guardados
```

#### 2.3 Test POST /api/watermark/log

```bash
# 1. Obtener mediaToken del response anterior (si no lo tienes, generar uno)
# 2. Hacer la llamada

curl -X POST http://localhost:3000/api/watermark/log \
  -H "Content-Type: application/json" \
  -d '{
    "mediaToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "videoId": "video_001",
    "deviceId": "dev_test_001",
    "timestamp": "2026-05-28T14:30:00Z",
    "deviceModel": "Samsung Galaxy A10",
    "buildFingerprint": "samsung/a10/a10:13:TP1A.220624.014:1234567:user/release-keys",
    "osVersion": "13",
    "cpuCores": "8",
    "androidId": "a1b2c3d4e5f6g7h8",
    "deviceSerial": "RA8T10BX0ZP",
    "brand": "samsung",
    "manufacturer": "Samsung",
    "watchedPercentage": 50
  }'

# Esperado:
# { "success": true, "message": "Watermark logged successfully" }
```

#### 2.4 Verificar que se guardó en watermark_logs

```bash
SELECT * FROM watermark_logs 
WHERE video_id = 'video_001' 
ORDER BY created_at DESC 
LIMIT 1;

# Debe retornar registro con:
# - video_id: video_001
# - device_id: dev_test_001
# - device_model: Samsung Galaxy A10
# - os_version: 13
# - android_id: a1b2c3d4e5f6g7h8
# - timestamp: 2026-05-28T14:30:00Z
```

---

### FASE 3: Compilar APK

#### 3.1 Preparar Android Studio

```bash
cd d:\descargas\proyectos hunter 2\reproductor-cursos-master\player-apk-android

# Actualizar build.gradle con URL del servidor (si es necesario)
# Ver archivo: app/build.gradle o app/src/main/res/values/strings.xml
```

#### 3.2 Compilar debug

```bash
./gradlew assembleDebug

# Resultado: app-debug.apk en app/build/outputs/apk/debug/
```

**Si hay errores de compilación:**
```
→ Verificar Java version: java -version (debe ser 11+)
→ Verificar Gradle version: gradle --version
→ Hacer: ./gradlew clean build
```

---

### FASE 4: Instalar en Emulador/Dispositivo

#### 4.1 Iniciar Android Emulator

```bash
# Listar emuladores
emulator -list-avds

# Iniciar uno
emulator -avd Pixel_4_API_30 &

# Esperar a que cargue (1-2 minutos)
```

#### 4.2 Instalar APK

```bash
adb install -r app-debug.apk

# Verificar instalación
adb shell pm list packages | grep edulock
```

#### 4.3 Abrir app

```bash
adb shell am start -n com.edulock.player/.ui.SplashActivity

# Ver logs
adb logcat | grep -E "(edulock|[E/])"
```

---

### FASE 5: Testing Flujo Completo en APK

#### 5.1 Login

```
1. Abrir app
2. Ingresa credenciales:
   Email: test@mail.com
   Password: password123
3. Click INGRESAR

Esperado:
✅ Se envían 13 campos device info
✅ Backend retorna JWT token
✅ App navega a CatalogActivity (lista de videos)
```

**Ver en logs:**
```bash
adb logcat | grep "LoginActivity"
# Debe ver: ✅ Login exitoso, Capturando device info, Verificando cambio de dispositivo
```

#### 5.2 Catálogo de Videos

```
1. En CatalogActivity, espera a que cargue lista
2. Verifica que ves videos con thumbnail

Esperado:
✅ RecyclerView muestra videos
✅ Cada video tiene thumbnail, título, descripción
✅ No hay crashes
```

**Ver en logs:**
```bash
adb logcat | grep "CatalogActivity"
# Debe ver: Cargando videos, RecyclerView actualizado
```

#### 5.3 Reproducción de Video

```
1. Click en un video de la lista
2. Debe cargar PlayerActivity
3. Video comienza a reproducir (o muestra buffering)

Esperado:
✅ ExoPlayer inicia
✅ Manifiesto HLS se carga correctamente
✅ POST /api/watermark/log se envía
```

**Ver en logs:**
```bash
adb logcat | grep "PlayerActivity"
# Debe ver: 
#  - Inicializando player
#  - Capturando device fingerprint
#  - Registrando watermark
#  - POST /api/watermark/log sent
```

#### 5.4 Verificar Watermark en Backend

```bash
# En PostgreSQL:
SELECT * FROM watermark_logs 
ORDER BY created_at DESC 
LIMIT 1;

# Debe tener:
# - user_id: del estudiante
# - video_id: del video reproducido
# - device_model: "Samsung Galaxy A10" o emulator
# - os_version: "13" o emulator API
# - android_id: del dispositivo/emulador
# - timestamp: cercano a ahora
```

---

## ✅ Checklist de Verificación

### Backend Listo
- [ ] Servidor Node.js iniciado sin errores
- [ ] PostgreSQL conectado
- [ ] Tablas creadas: watermark_logs, students, registration_requests
- [ ] Columnas device_info presentes en todas las tablas

### Endpoints Funcionales
- [ ] POST /api/auth/login-email retorna JWT ✅
- [ ] Students table se actualiza con 13 campos ✅
- [ ] POST /api/watermark/log retorna success ✅
- [ ] Watermark_logs se llena correctamente ✅

### APK Compilable
- [ ] gradle assemble sin errores ✅
- [ ] app-debug.apk creado ✅
- [ ] Todas las dependencias (RecyclerView, Glide) compiladas ✅

### APK Funcional
- [ ] Login con email+password ✅
- [ ] Catálogo carga videos ✅
- [ ] Reproducción inicia ✅
- [ ] Watermarking se registra ✅
- [ ] No hay crashes ✅

### Rastreo Forense
- [ ] watermark_logs tiene registros ✅
- [ ] Cada registro tiene 13+ campos device ✅
- [ ] Timestamps correctos ✅
- [ ] Puede filtrar por user_id/video_id/device_id ✅

---

## 🐛 Errores Comunes y Soluciones

### Error: "Error en login: Token inválido"
**Causa:** JWT_SECRET no coincide entre APK y backend
**Solución:** Verificar que ambos usan mismo JWT_SECRET

### Error: "Watermark logged successfully" pero no aparece en BD
**Causa:** La transacción no se hizo commit
**Solución:** Verificar que PostgreSQL está en modo auto-commit
```sql
SHOW autocommit;  -- Debe ser ON
```

### Error: "Cambio de dispositivo detectado" en cada login
**Causa:** DeviceChangeDetector está bloqueando
**Solución:** Normal en pruebas - es el sistema funcionando
Limpiar historial: Desinstalar APK y reinstalar

### Error: Video no reproduce (ExoPlayer error)
**Causa:** Manifest URL no valida o CDN no accesible
**Solución:** Verificar que /api/video/{id}/play retorna URL válida

### Error: "DB no disponible"
**Causa:** PostgreSQL no está corriendo o URL incorrecta
**Solución:** 
```bash
psql -U usuario -d reproductor_cursos -h localhost
# Debe conectar exitosamente
```

---

## 📊 Métricas de Éxito

```
✅ ÉXITO si:

1. Backend logs muestran:
   [db-pg] Schema listo (watermark_logs + device_info agregadas)
   [auth/login-email] ✅ Login exitoso: test@mail.com device=dev_xxx
   [watermark] Registrado: user=... video=... device=...

2. PostgreSQL tiene:
   - 50+ registros en watermark_logs
   - Todos los campos device_info completos
   - Timestamps secuenciales

3. APK:
   - Inicia sin crashes
   - Login funciona
   - Catálogo carga
   - Video se reproduce
   - Logs muestran todas las operaciones
```

---

## 🎯 Siguiente Paso

Después de verificar que TODO funciona:

1. **Compilar Release APK:**
   ```bash
   ./gradlew assembleRelease
   # Resultado: app-release.apk
   ```

2. **Subir a Google Play Store** (opcional)

3. **Notificar a usuarios:**
   - Nueva versión de APK disponible
   - Todos los datos están seguros
   - Rastreo forense activo

---

**APK + Backend = Integración 100% Completa** ✨

