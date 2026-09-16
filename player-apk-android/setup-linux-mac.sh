#!/bin/bash
# ============================================================================
# EDULOCK Player - Setup Rápido para Android Studio (Linux/Mac)
# ============================================================================

echo ""
echo "============================================================================"
echo "EDULOCK Player - Configuración Rápida para Android"
echo "============================================================================"
echo ""

# Detectar si Gradle está disponible
if ! command -v ./gradlew &> /dev/null; then
    echo "ERROR: gradlew no encontrado. Asegúrate de estar en el directorio correcto."
    exit 1
fi

echo "[1/5] Limpiando builds anteriores..."
./gradlew clean
if [ $? -ne 0 ]; then
    echo "ERROR: Fallo al limpiar build"
    exit 1
fi

echo "[2/5] Descargando dependencias..."
./gradlew --refresh-dependencies
if [ $? -ne 0 ]; then
    echo "ERROR: Fallo al descargar dependencias"
    exit 1
fi

echo "[3/5] Compilando para Debug..."
./gradlew assembleDebug
if [ $? -ne 0 ]; then
    echo "ERROR: Fallo al compilar Debug APK"
    exit 1
fi

echo "[4/5] Generando APK..."
if [ -f "app/build/outputs/apk/debug/app-debug.apk" ]; then
    echo "[OK] app-debug.apk generado correctamente"
else
    echo "ERROR: APK no se generó"
    exit 1
fi

echo "[5/5] Listo para usar en Android Studio"
echo ""
echo "============================================================================"
echo "EDULOCK Player - Configuración completada"
echo "============================================================================"
echo ""
echo "APK Debug: app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "PASOS SIGUIENTES:"
echo " 1. Abre el proyecto en Android Studio"
echo " 2. Conecta tu dispositivo Android"
echo " 3. Haz clic en 'Run' o presiona Shift+F10"
echo ""
echo "Para más detalles, ver README.md"
echo ""
