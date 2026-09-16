<!-- ACTUALIZACION_BACKEND_PARA_PARIDAD_APK.md -->

# Actualización del Backend para Recibir Datos Completos de APK

## 🎯 Objetivo
Que el backend (`server.js`) reciba y almacene TODOS los 13 campos de información del dispositivo que la APK captura, exactamente como lo hace el reproductor de PC.

---

## 1. CAMBIOS EN database-pg.js

### Agregar columna `device_info` a tabla `registration_requests`

```sql
-- Ejecutar en PostgreSQL:
ALTER TABLE registration_requests
ADD COLUMN device_info JSONB DEFAULT '{}';

-- Ejemplo de estructura JSON:
{
  "deviceModel": "Samsung Galaxy A10",
  "deviceSerial": "R38M7087CKL",
  "deviceId": "dev_a1b2c3d4e5f6g7h8",
  "osVersion": "Android 11 (API 30)",
  "osVersionCode": 30,
  "cpuCores": 8,
  "totalRam": "4.0 GB",
  "androidId": "7b2a8d9e4c3f2b1a",
  "buildFingerprint": "samsung/a10/a10:11/...",
  "brand": "samsung",
  "manufacturer": "Samsung",
  "hwSerial": "R38M7087CKL",
  "captureTime": 1699564203000
}
```

### Agregar columna `device_info` a tabla `users`

```sql
ALTER TABLE users
ADD COLUMN device_info JSONB DEFAULT '{}';
ADD COLUMN last_login_device JSONB DEFAULT '{}';
```

### Agregar columna `device_info` a tabla `audit_log` (para video playback)

```sql
ALTER TABLE audit_log
ADD COLUMN device_info JSONB DEFAULT '{}';

-- device_info en audit_log contendrá:
{
  "deviceId": "dev_a1b2c3d4...",
  "deviceModel": "Samsung Galaxy A10",
  "osVersion": "Android 11",
  "cpuCores": 8,
  "buildFingerprint": "samsung/a10/...",
  "timestamp": 1699564203000
}
```

---

## 2. CAMBIOS EN server.js

### ACTUALIZAR: POST /api/auth/register-request (línea ~1700)

**Antes:**
```javascript
app.post('/api/auth/register-request', async (req, res) => {
    const { email, name, password, deviceId, deviceModel, fcmToken } = req.body || {};
    // ... código
});
```

**Después:**
```javascript
app.post('/api/auth/register-request', async (req, res) => {
    const { 
        email, name, password, 
        deviceId, deviceModel, deviceSerial, osVersion, osVersionCode,
        cpuCores, totalRam, androidId, buildFingerprint, brand, manufacturer, fcmToken 
    } = req.body || {};
    
    // Validar email
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Email inválido' });
    }

    try {
        // Construir objeto de info del dispositivo
        const deviceInfo = {
            deviceId,
            deviceModel,
            deviceSerial,
            osVersion,
            osVersionCode,
            cpuCores,
            totalRam,
            androidId,
            buildFingerprint,
            brand,
            manufacturer,
            hwSerial: deviceSerial, // Igual a serial
            captureTime: new Date().toISOString()
        };

        // Guardar solicitud de registro CON info del dispositivo
        const requestId = await db.createRegistrationRequest({
            email,
            name,
            password: hashPassword(password),
            deviceId,
            fcmToken,
            deviceInfo, // ← NUEVO: Guardar objeto completo
            status: 'pending'
        });

        Log.info(`📝 Registro solicitado: ${email} desde ${deviceModel} (ID: ${deviceId})`);
        res.json({ requestId, ok: true });
    } catch (error) {
        Log.error('Error en registro:', error);
        res.status(500).json({ error: 'Error al registrar' });
    }
});
```

---

### ACTUALIZAR: POST /api/auth/login (línea ~521)

**Antes:**
```javascript
app.post('/api/auth/login', async (req, res) => {
    const { email, studentId, deviceFingerprint } = req.body || {};
    // Verificar dispositivo...
});
```

**Después:**
```javascript
app.post('/api/auth/login', async (req, res) => {
    const { 
        email, 
        password,
        deviceId, deviceModel, deviceSerial, osVersion, osVersionCode,
        cpuCores, totalRam, androidId, buildFingerprint, brand, manufacturer,
        fcmToken 
    } = req.body || {};
    
    if (!email || !password) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    try {
        // Buscar usuario
        const user = await db.findUserByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        // Verificar contraseña
        if (!comparePassword(password, user.password)) {
            return res.status(401).json({ error: 'Contraseña incorrecta' });
        }

        // Construir objeto de info del dispositivo
        const deviceInfo = {
            deviceId,
            deviceModel,
            deviceSerial,
            osVersion,
            osVersionCode,
            cpuCores,
            totalRam,
            androidId,
            buildFingerprint,
            brand,
            manufacturer,
            captureTime: new Date().toISOString()
        };

        // Guardar/actualizar info del dispositivo del usuario
        await db.updateUserDeviceInfo(user.id, deviceInfo);

        // Crear JWT con info del dispositivo
        const token = jwt.sign(
            {
                sub: user.id,
                email: user.email,
                deviceId: deviceId,
                deviceModel: deviceModel,
                allowedVideos: user.allowedVideos || [],
            },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        // Guardar FCM token si viene
        if (fcmToken) {
            await db.updateUserFcmToken(user.id, fcmToken);
        }

        Log.info(`✅ Login: ${email} desde ${deviceModel} (CPU: ${cpuCores}, RAM: ${totalRam})`);
        res.json({ token });
    } catch (error) {
        Log.error('Error en login:', error);
        res.status(500).json({ error: 'Error en autenticación' });
    }
});
```

---

### ACTUALIZAR: POST /api/watermark/log (línea ~2601)

**Antes:**
```javascript
app.post('/api/watermark/log', async (req, res) => {
    const { mediaToken } = req.body || {};
    if (!mediaToken) return res.status(400).json({ error: 'mediaToken requerido' });
    try {
        jwt.verify(mediaToken, JWT_SECRET);
        res.json({ ok: true });
    } catch {
        res.status(401).json({ error: 'Token inválido' });
    }
});
```

**Después:**
```javascript
app.post('/api/watermark/log', async (req, res) => {
    const { 
        mediaToken, videoId, deviceId, timestamp,
        deviceModel, buildFingerprint, osVersion, cpuCores
    } = req.body || {};
    
    if (!mediaToken) return res.status(400).json({ error: 'mediaToken requerido' });

    try {
        // Verificar mediaToken
        const decoded = jwt.verify(mediaToken, JWT_SECRET);
        const userId = decoded.sub;
        const clientIp = req.ip || req.connection?.remoteAddress || '';

        // Construir objeto de auditoría
        const deviceInfo = {
            deviceId,
            deviceModel,
            osVersion,
            cpuCores,
            buildFingerprint,
            captureTime: new Date().toISOString()
        };

        // Registrar reproducción en auditoría
        await db.logPlayback({
            userId,
            videoId,
            mediaToken,
            deviceInfo,
            ip: clientIp,
            userAgent: req.headers['user-agent'],
            timestamp: new Date().toISOString()
        });

        Log.info(`▶️ Reproducción: User ${userId}, Video ${videoId}, Device ${deviceId} (${deviceModel})`);
        res.json({ ok: true });
    } catch (error) {
        Log.error('Error en watermark log:', error);
        res.status(401).json({ error: 'Token inválido' });
    }
});
```

---

## 3. CAMBIOS EN database.js (o database-pg.js)

### Agregar funciones nuevas para manejar device_info

```javascript
// ════════════════════════════════════════════════════════════════════════════════
// DEVICE INFO MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Guardar información del dispositivo al registrarse
 */
async function createRegistrationRequest(data) {
    const {
        email, name, password, deviceId, fcmToken, deviceInfo, status
    } = data;
    
    const query = `
        INSERT INTO registration_requests 
        (email, name, password_hash, device_id, fcm_token, device_info, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING request_id as requestId
    `;
    
    const result = await pgPool.query(query, [
        email, name, password, deviceId, fcmToken, 
        JSON.stringify(deviceInfo), status
    ]);
    
    return result.rows[0]?.requestId;
}

/**
 * Actualizar información del dispositivo de un usuario
 */
async function updateUserDeviceInfo(userId, deviceInfo) {
    const query = `
        UPDATE users 
        SET device_info = $1, last_login_device = $2, last_login_at = NOW()
        WHERE id = $3
    `;
    
    return await pgPool.query(query, [
        JSON.stringify(deviceInfo),
        JSON.stringify(deviceInfo),
        userId
    ]);
}

/**
 * Actualizar FCM token del usuario
 */
async function updateUserFcmToken(userId, fcmToken) {
    const query = `
        UPDATE users 
        SET fcm_token = $1, fcm_token_updated_at = NOW()
        WHERE id = $2
    `;
    
    return await pgPool.query(query, [fcmToken, userId]);
}

/**
 * Registrar reproducción en auditoría con info del dispositivo
 */
async function logPlayback(data) {
    const {
        userId, videoId, mediaToken, deviceInfo, ip, userAgent, timestamp
    } = data;
    
    const query = `
        INSERT INTO audit_log 
        (user_id, video_id, device_id, device_info, ip, user_agent, action_type, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    
    return await pgPool.query(query, [
        userId,
        videoId,
        deviceInfo?.deviceId || null,
        JSON.stringify(deviceInfo),
        ip,
        userAgent,
        'video_playback',
        timestamp
    ]);
}

/**
 * Obtener histórico de dispositivos de un usuario
 */
async function getUserDeviceHistory(userId) {
    const query = `
        SELECT 
            device_id,
            device_info,
            COUNT(*) as play_count,
            MAX(timestamp) as last_used
        FROM audit_log
        WHERE user_id = $1 AND action_type = 'video_playback'
        GROUP BY device_id, device_info
        ORDER BY last_used DESC
    `;
    
    const result = await pgPool.query(query, [userId]);
    return result.rows;
}

/**
 * Detectar cambios de dispositivo sospechosos
 */
async function detectDeviceChange(userId, newDeviceId, newDeviceInfo) {
    // Obtener último dispositivo usado
    const query = `
        SELECT device_id, device_info 
        FROM users 
        WHERE id = $1
    `;
    
    const result = await pgPool.query(query, [userId]);
    const lastDevice = result.rows[0];
    
    if (lastDevice && lastDevice.device_id !== newDeviceId) {
        // Dispositivo diferente - registrar cambio sospechoso
        await logSuspiciousActivity({
            userId,
            type: 'device_change',
            severity: 'medium',
            description: `Cambio de dispositivo detectado: ${lastDevice.device_id} → ${newDeviceId}`,
            metadata: {
                oldDevice: lastDevice.device_info,
                newDevice: newDeviceInfo,
                timestamp: new Date().toISOString()
            }
        });
        
        return { changed: true, previous: lastDevice };
    }
    
    return { changed: false };
}

module.exports = {
    createRegistrationRequest,
    updateUserDeviceInfo,
    updateUserFcmToken,
    logPlayback,
    getUserDeviceHistory,
    detectDeviceChange,
    // ... funciones existentes
};
```

---

## 4. ACTUALIZAR: database-pg.js - createRegistrationRequest()

```javascript
/**
 * Guardar solicitud de registro (con info del dispositivo)
 */
async createRegistrationRequest(payload) {
    const {
        email, name, passwordHash, deviceId, deviceModel,
        deviceSerial, osVersion, totalRam, cpuCores, buildFingerprint,
        brand, manufacturer, androidId, osVersionCode, fcmToken
    } = payload;
    
    const deviceInfo = {
        deviceModel,
        deviceSerial,
        deviceId,
        osVersion,
        osVersionCode,
        cpuCores,
        totalRam,
        androidId,
        buildFingerprint,
        brand,
        manufacturer,
        hwSerial: deviceSerial,
        captureTime: new Date().toISOString()
    };

    const query = `
        INSERT INTO registration_requests 
        (email, name, password_hash, device_id, device_info, fcm_token, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
        RETURNING id as requestId, email, name
    `;

    const result = await this.pgPool.query(query, [
        email.toLowerCase(),
        name,
        passwordHash,
        deviceId,
        JSON.stringify(deviceInfo),
        fcmToken || null
    ]);

    return result.rows[0];
}
```

---

## 5. SCHEMA SQL - Crear tablas si no existen

```sql
-- Tabla de auditoría (si no existe)
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    video_id VARCHAR(255),
    device_id VARCHAR(255),
    device_info JSONB DEFAULT '{}',
    ip VARCHAR(45),
    user_agent TEXT,
    action_type VARCHAR(50), -- 'video_playback', 'login', 'logout', etc.
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_device_id ON audit_log(device_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON audit_log(action_type);
```

---

## 6. RESUMEN DE CAMBIOS

| Archivo | Línea | Cambio |
|---------|-------|--------|
| database-pg.js | ~150 | ALTER TABLE registration_requests ADD device_info |
| database-pg.js | ~151 | ALTER TABLE users ADD device_info |
| database-pg.js | ~200+ | Agregar nuevas funciones (createRegistrationRequest, updateUserDeviceInfo, etc.) |
| server.js | ~1700 | POST /api/auth/register-request: recibir y guardar todos los campos |
| server.js | ~521 | POST /api/auth/login: recibir todos los campos y guardar deviceInfo |
| server.js | ~2601 | POST /api/watermark/log: recibir y registrar deviceInfo de cada play |

---

## 7. TESTING

Después de aplicar cambios, verificar:

```bash
# 1. Verificar que APK envía todos los campos en login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@test.com",
    "password": "test123",
    "deviceId": "dev_a1b2c3d4",
    "deviceModel": "Samsung Galaxy A10",
    "deviceSerial": "R38M7087CKL",
    "osVersion": "Android 11",
    "osVersionCode": 30,
    "cpuCores": 8,
    "totalRam": "4.0 GB",
    "androidId": "7b2a8d9e4c3f2b1a",
    "buildFingerprint": "samsung/a10/a10:11/...",
    "brand": "samsung",
    "manufacturer": "Samsung",
    "fcmToken": "eNgc0O9d_qE:APA91bGm7x..."
  }'

# 2. Verificar que backend almacena en users.device_info
psql -U postgres -d reproductor-cursos -c "SELECT device_info FROM users WHERE email = 'test@test.com';"

# 3. Verificar que watermark/log registra deviceInfo
curl -X POST http://localhost:3000/api/watermark/log \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -d '{
    "mediaToken": "<JWT_TOKEN>",
    "videoId": "video_uuid",
    "deviceId": "dev_a1b2c3d4",
    "timestamp": 1699564203000,
    "deviceModel": "Samsung Galaxy A10"
  }'

# 4. Verificar auditoría
psql -U postgres -d reproductor-cursos -c "SELECT device_info FROM audit_log WHERE action_type = 'video_playback' LIMIT 1;"
```

---

## ✅ RESULTADO FINAL

**Paridad completa alcanzada:**
- ✅ APK captura 13 campos
- ✅ APK envía 13 campos en login/registro
- ✅ APK envía campos en cada reproducción
- ✅ Backend recibe y almacena en base de datos
- ✅ Auditoría completa: quién, cuándo, desde qué dispositivo, viendo qué

