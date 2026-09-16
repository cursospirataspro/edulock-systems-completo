# =============================================================================
#  configurar-llave-ssh.ps1  —  Ejecutar UNA SOLA VEZ
#
#  Crea una llave SSH en tu PC y la instala en el VPS, para que a partir de
#  ahora  .\deploy.ps1  funcione SIN pedirte la clave nunca mas.
#
#  Uso:
#     powershell -ExecutionPolicy Bypass -File .\configurar-llave-ssh.ps1
#
#  Te pedira la clave del VPS UNA vez (para instalar la llave). Despues, cero.
# =============================================================================

$ErrorActionPreference = "Stop"
$VPS_IP   = "185.47.128.35"
$VPS_USER = "root"
$KEY      = "$HOME\.ssh\id_ed25519"
$SSHOPT   = "-o", "StrictHostKeyChecking=accept-new"

function Say($t,$c="Cyan"){ Write-Host $t -ForegroundColor $c }

# 1) Crear la carpeta .ssh si no existe
if (-not (Test-Path "$HOME\.ssh")) { New-Item -ItemType Directory -Path "$HOME\.ssh" | Out-Null }

# 2) Generar la llave (sin passphrase) si no existe
if (-not (Test-Path $KEY)) {
    Say "==> Creando llave SSH nueva..."
    # cmd /c maneja bien el -N "" (passphrase vacia)
    cmd /c "ssh-keygen -t ed25519 -f `"$KEY`" -N `"`" -q"
    if (-not (Test-Path $KEY)) { Write-Host "ERROR: no se creo la llave." -ForegroundColor Red; exit 1 }
    Say "    Llave creada: $KEY" "Green"
} else {
    Say "==> Ya tienes una llave SSH, la reutilizo." "DarkGray"
}

# 3) Instalar la llave publica en el VPS (pide la clave 1 vez)
$pub = (Get-Content "$KEY.pub" -Raw).Trim()
Say "==> Instalando la llave en el VPS (te pedira la clave UNA vez)..."
$remote = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys && echo OK-LLAVE-INSTALADA"
& ssh @SSHOPT "$VPS_USER@$VPS_IP" $remote
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR al instalar la llave." -ForegroundColor Red; exit 1 }

Say "==> LISTO. Ahora corre  .\deploy.ps1  y ya no te pedira la clave." "Green"
