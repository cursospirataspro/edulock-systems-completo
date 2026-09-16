# =============================================================================
#  bajar-de-vps.ps1  —  Trae el codigo de la VPS a tu carpeta local
#
#  Uso:
#     powershell -ExecutionPolicy Bypass -File .\bajar-de-vps.ps1
#
#  Cuando usarlo: cuando editaste algo DIRECTO en la VPS y quieres que tu
#  carpeta local quede igual (para no perder esos cambios en el proximo deploy).
#
#  Que hace:
#    1. Respalda tu codigo local actual (por si acaso) en %TEMP%.
#    2. La VPS empaqueta su codigo fuente (sin node_modules ni .env).
#    3. Lo baja y lo extrae sobre tu carpeta local (local pasa a ser = VPS).
#    4. Actualiza la huella para que el siguiente  .\deploy.ps1  no se queje.
#
#  NO borra tu .env local ni toca node_modules. No borra archivos que existan
#  en local pero no en la VPS (solo agrega/reemplaza).
# =============================================================================

$ErrorActionPreference = "Stop"

$VPS_IP   = "185.47.128.35"
$VPS_USER = "root"
$VPS_APP  = "/opt/reproductor"

$PROJECT  = $PSScriptRoot
$MANIFEST = Join-Path $PROJECT ".deploy-manifest.json"
$SSHOPT   = @("-o","StrictHostKeyChecking=accept-new")
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$BACKUP   = Join-Path $env:TEMP "edulock-local-backup-$stamp.tar.gz"
$PULLED   = Join-Path $env:TEMP "edulock-vps-src.tar.gz"

function Say($t,$c="Cyan"){ Write-Host $t -ForegroundColor $c }

$SRC_RE = '\.(js|html|css|sh|json|conf)$'
function Is-Source($fullpath){
    if ($fullpath -notmatch $SRC_RE) { return $false }
    if ($fullpath -match '\.deploy-manifest\.json$') { return $false }
    if ($fullpath -match '\\node_modules\\') { return $false }
    if ($fullpath -match '\\dist\\')         { return $false }
    if ($fullpath -match '\\build\\')         { return $false }
    if ($fullpath -match '\\\.git\\')         { return $false }
    return $true
}
function Get-LocalHashes {
    $map = @{}
    Get-ChildItem -Recurse -File -LiteralPath $PROJECT | ForEach-Object {
        if (Is-Source $_.FullName) {
            $rel = $_.FullName.Substring($PROJECT.Length).TrimStart('\','/').Replace('\','/')
            $map[$rel] = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower()
        }
    }
    return $map
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Write-Host "ERROR: falta 'tar'." -ForegroundColor Red; exit 1 }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Write-Host "ERROR: falta 'ssh'." -ForegroundColor Red; exit 1 }

# 1) Respaldo del codigo local actual
Say "==> [1/4] Respaldo de tu codigo local en $BACKUP ..."
Push-Location $PROJECT
try {
    tar --exclude=".git" --exclude="node_modules" --exclude="*/node_modules/*" `
        --exclude="dist" --exclude="*/dist/*" --exclude="build" --exclude="*/build/*" `
        -czf $BACKUP .
} finally { Pop-Location }
Say "    Respaldo hecho." "Green"

# 2) La VPS empaqueta su codigo fuente
Say "==> [2/4] La VPS empaqueta su codigo..."
$rcmd = "cd $VPS_APP && tar czf /root/edulock-vps-src.tar.gz --exclude=node_modules --exclude='player-app/node_modules' --exclude='player-app/dist' --exclude='*/build' --exclude=.git --exclude=.env . && echo OK-VPS-TAR"
& ssh @SSHOPT "$VPS_USER@$VPS_IP" $rcmd
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR empaquetando en la VPS." -ForegroundColor Red; exit 1 }

# 3) Bajar y extraer sobre local
Say "==> [3/4] Bajando y aplicando a tu carpeta local..."
if (Test-Path $PULLED) { Remove-Item $PULLED -Force }
& scp @SSHOPT "$VPS_USER@${VPS_IP}:/root/edulock-vps-src.tar.gz" $PULLED
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR al bajar (scp)." -ForegroundColor Red; exit 1 }
tar xzf $PULLED -C $PROJECT
Say "    Tu carpeta local ahora coincide con la VPS." "Green"

# 4) Actualizar la huella para el guardian del deploy
Say "==> [4/4] Actualizando huella..."
try {
    $local = Get-LocalHashes
    ($local | ConvertTo-Json -Depth 3) | Set-Content -Encoding UTF8 -LiteralPath $MANIFEST
    Say "    Huella actualizada ($($local.Count) archivos)." "Green"
} catch { Say "    (No se pudo actualizar la huella: $($_.Exception.Message))" "DarkGray" }

Say "==> LISTO. Revisa los archivos y cuando quieras corre  .\deploy.ps1" "Green"
Say "    (Si algo salio mal, tu respaldo local esta en: $BACKUP)" "DarkGray"
