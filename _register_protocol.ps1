# _register_protocol.ps1
# Registra el protocolo cdp:// en Windows apuntando al reproductor local (modo dev).
# Ejecutar UNA vez despues de instalar dependencias.
# No requiere permisos de administrador (escribe en HKCU).

param(
    [string]$PlayerPath = "",
    [string]$AppDir     = $PSScriptRoot
)

$AppName   = "Edulock Systems Player"
$Protocol  = "cdp"

# Detectar electron.exe en node_modules
if (-not $PlayerPath) {
    $candidates = @(
        (Join-Path $AppDir "player-app\node_modules\.bin\electron.cmd"),
        (Join-Path $AppDir "player-app\node_modules\electron\dist\electron.exe"),
        (Join-Path $AppDir "node_modules\.bin\electron.cmd"),
        (Join-Path $AppDir "node_modules\electron\dist\electron.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $PlayerPath = $c; break }
    }
}

if (-not $PlayerPath -or -not (Test-Path $PlayerPath)) {
    Write-Host "ERROR: No se encontro electron.exe. Especifica la ruta con -PlayerPath." -ForegroundColor Red
    Write-Host "  Uso: .\\_register_protocol.ps1 -PlayerPath 'C:\\ruta\\electron.exe'"
    exit 1
}

# Resolver ruta absoluta del main.js del player
$MainJs = (Resolve-Path (Join-Path $AppDir "player-app\main.js")).Path

# Comando que Windows ejecutara al abrir cdp://
# electron.exe "<path_to_main.js>" "%1"
$Command = "`"$PlayerPath`" `"$MainJs`" `"%1`""

Write-Host ""
Write-Host "Registrando protocolo cdp:// ..." -ForegroundColor Cyan
Write-Host "  App   : $AppName"
Write-Host "  Exec  : $PlayerPath"
Write-Host "  Cmd   : $Command"
Write-Host ""

# Crear claves en HKCU\Software\Classes\cdp
$base = "HKCU:\Software\Classes\$Protocol"

New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name "(Default)"    -Value "URL:$AppName"
Set-ItemProperty -Path $base -Name "URL Protocol" -Value ""

# Descripcion amigable (la que muestra Chrome en el dialogo)
New-Item -Path "$base\Application" -Force | Out-Null
Set-ItemProperty -Path "$base\Application" -Name "ApplicationName"        -Value $AppName
Set-ItemProperty -Path "$base\Application" -Name "ApplicationDescription" -Value "Reproductor seguro de cursos Edulock Systems"
Set-ItemProperty -Path "$base\Application" -Name "ApplicationIcon"        -Value "$PlayerPath,0"

New-Item -Path "$base\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$base\DefaultIcon" -Name "(Default)" -Value "$PlayerPath,0"

New-Item -Path "$base\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$base\shell\open\command" -Name "(Default)" -Value $Command

Write-Host "Protocolo cdp:// registrado correctamente." -ForegroundColor Green
Write-Host ""
Write-Host "Ahora cuando hagas clic en un link cdp:// Chrome preguntara:" -ForegroundColor Yellow
Write-Host "  'Abrir $AppName'" -ForegroundColor Yellow
Write-Host ""
Write-Host "NOTA: Reinicia Chrome para que detecte el nuevo registro." -ForegroundColor DarkYellow
