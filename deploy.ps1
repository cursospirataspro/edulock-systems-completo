# =============================================================================
#  deploy.ps1  —  Auto-deploy de Edulock Systems a tu VPS
#
#  Uso (desde PowerShell, en la carpeta del proyecto):
#     powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
#  Qué hace, solo:
#    1. Empaqueta el proyecto (sin node_modules, dist, .env, etc.)
#    2. Lo sube a la VPS
#    3. Extrae + respalda lo viejo + despliega + npm install + pm2 restart + nginx
#
#  Te pedirá la clave del VPS (2 veces si NO tienes llave SSH; 0 veces si sí).
#  Para dejarlo SIN clave: corre una vez  .\configurar-llave-ssh.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

# --- Config (ya con los datos de tu VPS) ---
$VPS_IP   = "185.47.128.35"
$VPS_USER = "root"

$PROJECT  = $PSScriptRoot
$TARBALL  = Join-Path $env:TEMP "edulock-deploy.tar.gz"
$SSHOPT   = "-o", "StrictHostKeyChecking=accept-new"

function Say($t,$c="Cyan"){ Write-Host $t -ForegroundColor $c }

# --- 0) Comprobaciones ---
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: no encuentro 'tar'. Necesitas Windows 10/11 (trae tar)." -ForegroundColor Red; exit 1
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: no encuentro 'ssh'. Instala OpenSSH Client (Windows: Configuracion > Aplicaciones > Caracteristicas opcionales)." -ForegroundColor Red; exit 1
}
$hasKey = (Test-Path "$HOME\.ssh\id_ed25519") -or (Test-Path "$HOME\.ssh\id_rsa")

Say "==> [1/3] Empaquetando el proyecto..."
Push-Location $PROJECT
try {
    if (Test-Path $TARBALL) { Remove-Item $TARBALL -Force }
    tar `
      --exclude=".git" --exclude="*/.git/*" `
      --exclude="node_modules" --exclude="*/node_modules/*" `
      --exclude="dist" --exclude="*/dist/*" `
      --exclude="build" --exclude="*/build/*" `
      --exclude=".env" `
      --exclude="*.exe" --exclude="*.dll" --exclude="*.asar" --exclude="*.pak" --exclude="*.node" `
      -czf $TARBALL .
} finally { Pop-Location }
$size = [math]::Round((Get-Item $TARBALL).Length/1MB,2)
Say "    Paquete: $size MB" "Green"

if ($hasKey) { Say "    (Tienes llave SSH: no deberia pedirte clave.)" "DarkGray" }
else         { Say "    (Sin llave SSH: te pedira la clave del VPS 2 veces.)" "DarkGray" }

Say "==> [2/3] Subiendo a la VPS..."
& scp @SSHOPT $TARBALL "$VPS_USER@${VPS_IP}:/root/edulock-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR al subir (scp)." -ForegroundColor Red; exit 1 }

Say "==> [3/3] Desplegando en la VPS..."
$remote = @'
set -e
mkdir -p /root/edulock-new
rm -rf /root/edulock-new/*
tar xzf /root/edulock-deploy.tar.gz -C /root/edulock-new
cd /root/edulock-new
chmod +x _redeploy_vps.sh 2>/dev/null || true
bash _redeploy_vps.sh
'@
& ssh @SSHOPT "$VPS_USER@$VPS_IP" $remote
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR en el despliegue remoto." -ForegroundColor Red; exit 1 }

Say "==> LISTO. Deploy completado." "Green"
Say "    Comprueba:  https://edulocksystemsoficial.dpdns.org/api/health" "Green"
