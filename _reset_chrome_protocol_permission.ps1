# _reset_chrome_protocol_permission.ps1
# Quita la decisión "Permitir siempre" de los protocolos edulock:// y cdp:// para el
# dominio de Edulock en TODOS los perfiles de Google Chrome, para poder volver a
# concederla desde cero. Hace copia de seguridad de cada Preferences antes de tocarlo.
#
# REQUISITO: Chrome debe estar COMPLETAMENTE cerrado (todas las ventanas y el icono
# de la bandeja). Si sigue abierto, Chrome sobrescribe el archivo al cerrar.
#
# Uso: clic derecho > Ejecutar con PowerShell   (o: powershell -File _reset_chrome_protocol_permission.ps1)
#      Añade -Todo para borrar los permisos de TODOS los protocolos (Zoom, WhatsApp, etc.).

param([switch]$Todo, [string]$Dominio = "https://edulocksystemsoficial.dpdns.org")

$userData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
if (Get-Process chrome -ErrorAction SilentlyContinue) {
    Write-Host "Chrome sigue abierto. Ciérralo por completo y vuelve a ejecutar este script." -ForegroundColor Red
    exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$profiles = Get-ChildItem $userData -Directory | Where-Object { Test-Path (Join-Path $_.FullName "Preferences") }
foreach ($p in $profiles) {
    $file = Join-Path $p.FullName "Preferences"
    $raw = Get-Content $file -Raw -Encoding UTF8
    try { $json = $raw | ConvertFrom-Json } catch { Write-Host "$($p.Name): Preferences no legible, se omite" -ForegroundColor Yellow; continue }
    $pairs = $json.protocol_handler.allowed_origin_protocol_pairs
    if (-not $pairs) { Write-Host "$($p.Name): sin permisos de protocolo guardados"; continue }

    $changed = $false
    if ($Todo) {
        $json.protocol_handler.PSObject.Properties.Remove("allowed_origin_protocol_pairs")
        $changed = $true
    } else {
        $entry = $pairs.PSObject.Properties[$Dominio]
        if ($entry) {
            foreach ($scheme in @("edulock", "cdp")) {
                if ($entry.Value.PSObject.Properties[$scheme]) { $entry.Value.PSObject.Properties.Remove($scheme); $changed = $true }
            }
            if (($entry.Value.PSObject.Properties | Measure-Object).Count -eq 0) { $pairs.PSObject.Properties.Remove($Dominio) }
        }
    }

    if ($changed) {
        Copy-Item $file "$file.backup-$stamp" -Force
        $json | ConvertTo-Json -Depth 100 -Compress | Set-Content $file -Encoding UTF8 -NoNewline
        Write-Host "$($p.Name): permiso eliminado (copia: Preferences.backup-$stamp)" -ForegroundColor Green
    } else {
        Write-Host "$($p.Name): no tenía permiso para $Dominio"
    }
}
Write-Host ""
Write-Host "Listo. Abre Chrome, entra a la portada y pulsa Reproducir: Chrome volverá a preguntar." -ForegroundColor Cyan
Write-Host "Marca 'Siempre permitir…' y pulsa 'Abrir Edulock Systems Player' para conceder el permiso de nuevo."
