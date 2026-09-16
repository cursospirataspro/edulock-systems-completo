@echo off
REM ============================================================================
REM EDULOCK Player - Setup Rápido para Android Studio
REM ============================================================================
REM Script para configurar rápidamente el proyecto en Windows

echo.
echo ============================================================================
echo EDULOCK Player - Configuración Rápida para Android
echo ============================================================================
echo.

REM Detectar si Gradle está disponible
where gradlew >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: gradlew no encontrado. Asegúrate de estar en el directorio correcto.
    pause
    exit /b 1
)

echo [1/5] Limpiando builds anteriores...
call gradlew clean
if %errorlevel% neq 0 (
    echo ERROR: Fallo al limpiar build
    pause
    exit /b 1
)

echo [2/5] Descargando dependencias...
call gradlew --refresh-dependencies
if %errorlevel% neq 0 (
    echo ERROR: Fallo al descargar dependencias
    pause
    exit /b 1
)

echo [3/5] Compilando para Debug...
call gradlew assembleDebug
if %errorlevel% neq 0 (
    echo ERROR: Fallo al compilar Debug APK
    pause
    exit /b 1
)

echo [4/5] Generando APK...
if exist "app\build\outputs\apk\debug\app-debug.apk" (
    echo [OK] app-debug.apk generado correctamente
) else (
    echo ERROR: APK no se generó
    pause
    exit /b 1
)

echo [5/5] Listo para usar en Android Studio
echo.
echo ============================================================================
echo EDULOCK Player - Configuración completada
echo ============================================================================
echo.
echo APK Debug: app\build\outputs\apk\debug\app-debug.apk
echo.
echo PASOS SIGUIENTES:
echo  1. Abre el proyecto en Android Studio
echo  2. Conecta tu dispositivo Android
echo  3. Haz clic en "Run" o presiona Shift+F10
echo.
echo Para más detalles, ver README.md
echo.
pause
