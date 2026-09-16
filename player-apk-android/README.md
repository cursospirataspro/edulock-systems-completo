# EDULOCK Player - APK Android

Reproductor de cursos seguro para Android con:
- ✅ Autenticación JWT
- ✅ HLS con protección DRM (Widevine/ClearKey)
- ✅ Bloqueo de capturas de pantalla
- ✅ Bloqueo de grabación de pantalla
- ✅ Marca de agua forense
- ✅ Cifrado de datos locales

## Requisitos Previos

1. **Android Studio** (versión 2023.1 o superior)
   - Descargar desde: https://developer.android.com/studio

2. **Android SDK**
   - Android 13+ (API 34)
   - Android 6.0+ (API 24) como mínimo

3. **Java Development Kit (JDK)**
   - JDK 11 o superior

4. **Servidor EDULOCK**
   - Node.js server ejecutándose en `http://localhost:3000`

## Instalación en Android Studio

### Opción 1: Importar Proyecto (Recomendado)

1. Abre **Android Studio**
2. Ve a **File > Open**
3. Navega a: `d:\descargas\proyectos hunter 2\reproductor-cursos-master\player-apk-android`
4. Haz clic en **Open**
5. Espera a que Gradle sincronice las dependencias

### Opción 2: Crear desde Terminal

```bash
# Navegar a la carpeta del proyecto
cd d:\descargas\proyectos hunter 2\reproductor-cursos-master\player-apk-android

# Sincronizar con Gradle
./gradlew clean build
```

## Configuración

### 1. Editar URL del Servidor

Abre `app.properties` y cambia:

```properties
API_BASE_URL=http://tu-servidor:3000/
```

### 2. Configurar para Producción (APK Release)

#### Crear Keystore (Primera vez)

```bash
keytool -genkey -v -keystore keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias edulock
```

Responde las preguntas:
- Contraseña: `[Tu contraseña segura]`
- Nombre: EDULOCK
- Organización: EDULOCK
- Ciudad: [Tu ciudad]
- País: [Tu país]

#### Configurar en build.gradle

Abre `app/build.gradle` y añade (dentro del bloque `android`):

```gradle
signingConfigs {
    release {
        storeFile file("../keystore.jks")
        storePassword System.getenv("KEYSTORE_PASSWORD") ?: "tu-password"
        keyAlias "edulock"
        keyPassword System.getenv("KEYSTORE_PASSWORD") ?: "tu-password"
    }
}

buildTypes {
    release {
        signingConfig signingConfigs.release
        // ... resto de configuración
    }
}
```

## Compilación

### Compilar APK Debug (Para Pruebas)

En Android Studio:
1. **Build > Build Bundle(s) / APK(s) > Build APK(s)**
2. El APK se genera en: `app/build/outputs/apk/debug/app-debug.apk`

### Compilar APK Release (Producción)

En Android Studio:
1. **Build > Build Bundle(s) / APK(s) > Build APK(s)**
2. Selecciona **Release**
3. El APK se genera en: `app/build/outputs/apk/release/app-release.apk`

O desde Terminal:

```bash
./gradlew assembleDebug     # Debug APK
./gradlew assembleRelease   # Release APK (requiere keystore)
./gradlew bundleRelease     # Bundle para Google Play
```

## Instalar en Dispositivo

### Desde Android Studio

1. Conecta tu dispositivo Android via USB
2. En Android Studio: **Run > Run 'app'**
3. Selecciona el dispositivo
4. Android Studio instala y ejecuta automáticamente

### Desde Terminal (Debug)

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Desde Terminal (Release)

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

## Estructura del Proyecto

```
player-apk-android/
├── app/
│   ├── src/main/
│   │   ├── java/com/edulock/player/
│   │   │   ├── api/              # Clases de API y modelos
│   │   │   ├── security/         # Clases de seguridad
│   │   │   ├── ui/               # Activities y adapters
│   │   │   ├── utils/            # Utilidades
│   │   │   └── EdulockApp.kt    # Application class
│   │   ├── res/
│   │   │   ├── layout/           # XML de layouts
│   │   │   ├── values/           # Colores, strings, estilos
│   │   │   └── mipmap/           # Iconos
│   │   └── AndroidManifest.xml
│   └── build.gradle
├── build.gradle
├── settings.gradle
├── gradle.properties
└── README.md (este archivo)
```

## Arquitectura

### Flujo de Autenticación

1. **SplashActivity** - Verifica si hay sesión guardada
2. **LoginActivity** - Si no hay sesión, pide credenciales
3. **CatalogActivity** - Muestra lista de cursos disponibles
4. **PlayerActivity** - Reproductor de video con protección DRM

### Protecciones de Seguridad

- `FLAG_SECURE`: Bloquea capturas de pantalla y grabación
- `SecurityMonitorService`: Monitoreo continuo de amenazas
- Encriptación local de tokens: `EncryptedSharedPreferences`
- Detección de debuggers y herramientas remotas
- Marca de agua forense en cada reproducción

## Características

### Autenticación
- Login con email/contraseña
- Tokens JWT con expiración
- Sesiones persistentes (encriptadas)
- Logout con limpieza de datos

### Reproducción
- HLS adaptativo
- Protección DRM (Widevine/ClearKey)
- Controles de reproducción completos
- Calidad adaptable según conexión

### Seguridad
- ✅ Anti-screenshot (FLAG_SECURE)
- ✅ Anti-grabación de pantalla
- ✅ Detección de emulador
- ✅ Detección de debugger
- ✅ Cifrado de almacenamiento local
- ✅ Marca de agua forense invisible

### Auditoría
- Log de reproducción
- Marca de agua forense en video filtrado
- Heartbeat de sesión activa
- Identificación de dispositivo único

## Solución de Problemas

### Error: "Failed to resolve: androidx..."

```bash
# Actualizar repositorios
./gradlew build --refresh-dependencies
```

### Error: "Execution failed for task ':app:mergeDebugResources'"

```bash
# Limpiar build
./gradlew clean build
```

### APK no instala

1. Verifica el SDK mínimo: `minSdk 24` (Android 6.0)
2. Intenta: `adb uninstall com.edulock.player` primero
3. Verifica el dispositivo: `adb devices`

### Video no se reproduce

1. Verifica la URL en `app.properties`
2. Asegúrate de que el servidor está ejecutándose
3. Verifica los logs: `adb logcat | grep EDULOCK`

## Generación de APK para Distribución

### Google Play Store

```bash
# Crear bundle
./gradlew bundleRelease

# Archivo generado: app/build/outputs/bundle/release/app-release.aab
```

Luego sube a Google Play Console.

### Distribución Manual

Comparte el archivo:
- **Debug**: `app/build/outputs/apk/debug/app-debug.apk`
- **Release**: `app/build/outputs/apk/release/app-release.apk` (requiere firma)

## Configuración para Producción

### 1. Cambiar URL del Servidor

En `app.properties`:
```properties
API_BASE_URL=https://tu-dominio.com/
```

### 2. Habilitar SSL Pinning (Recomendado)

En `app.properties`:
```properties
ENABLE_SSL_PINNING=true
```

### 3. Deshabilitar Debug Logging

En `app.properties`:
```properties
DEBUG_LOGGING=false
```

### 4. Crear APK Release Firmada

```bash
./gradlew assembleRelease
# El APK se genera en: app/build/outputs/apk/release/app-release.apk
```

## Support

Para soporte técnico:
- Email: soporte@edulock.com
- Documentación: https://docs.edulock.com

---

**Versión**: 1.1.0  
**Última actualización**: 28/05/2026  
**Compatibilidad**: Android 6.0 (API 24) - Android 13+ (API 34)
