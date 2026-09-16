@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Campus Digital Player — Compilador

cls
echo.
echo  ==========================================
echo   Campus Digital Player  ^|  Compilador
echo  ==========================================
echo.

:: ── Verificar Node.js ─────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js no esta instalado.
    echo.
    echo  Descargalo desde: https://nodejs.org
    echo  Instala la version LTS y vuelve a ejecutar este script.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo  [OK] Node.js !NODE_VER! detectado
echo.

:: ── Verificar que estamos en el directorio correcto ───────────────────────────
if not exist "package.json" (
    echo  [ERROR] No se encontro package.json
    echo  Asegurate de ejecutar este script desde la carpeta player-app\
    echo.
    pause
    exit /b 1
)

:: ── Paso 1: Instalar dependencias ─────────────────────────────────────────────
echo  [1/3] Instalando dependencias de Node.js...
echo        (esto puede tardar varios minutos la primera vez)
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Fallo al instalar dependencias.
    echo  Revisa tu conexion a Internet e intenta de nuevo.
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Dependencias instaladas
echo.

:: ── Paso 2: Generar iconos ────────────────────────────────────────────────────
echo  [2/3] Generando iconos de la aplicacion...
node scripts\create-icon.js
echo.
echo  [OK] Iconos listos
echo.

:: ── Paso 3: Compilar ──────────────────────────────────────────────────────────
echo  [3/3] Compilando ejecutable para Windows x64...
echo        (esto puede tardar 2-5 minutos)
echo.
call npm run build:win
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Fallo la compilacion.
    echo.
    echo  Posibles causas:
    echo    - Falta el archivo assets\icon.ico
    echo    - El antivirus bloqueo el proceso de empaquetado
    echo    - Sin espacio en disco
    echo.
    pause
    exit /b 1
)

:: ── Resultado ─────────────────────────────────────────────────────────────────
echo.
echo  ==========================================
echo   Compilacion completada exitosamente!
echo  ==========================================
echo.
echo  Archivos generados en la carpeta dist\:
echo.

if exist "dist\" (
    for %%f in (dist\*.exe) do (
        echo    %%f
    )
)

echo.
echo  Para distribuir el programa:
echo    - Instalador: CampusDigitalPlayer-*-Setup.exe  (crea accesos directos)
echo    - Portable  : CampusDigitalPlayer-*-Portable.exe  (sin instalacion)
echo.
echo  El protocolo cdp:// queda registrado automaticamente al instalar.
echo.

:: Abrir la carpeta dist\ en el Explorador de Windows
if exist "dist\" (
    start "" explorer dist\
)

pause
