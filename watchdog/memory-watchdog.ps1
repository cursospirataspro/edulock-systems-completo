# memory-watchdog.ps1 — Watchdog de memoria para la VPS Edulock
# Corre cada 2 minutos como tarea programada (SYSTEM).
# Si la memoria virtual libre cae a nivel crítico en 2 mediciones seguidas,
# reinicia Windows de forma ordenada ANTES de que el sistema se congele
# (los cuelgues del 15/07 y 17/07 fueron por agotamiento de memoria:
#  winlogon y Cloudflared morían por "recursos insuficientes").
#
# Tras el reinicio todo vuelve solo: EdulockVPS, Cloudflared y PostgreSQL
# están en arranque automático. PostgreSQL es seguro ante reinicios (WAL).
#
# Desactivar: Disable-ScheduledTask -TaskName 'EdulockMemoryWatchdog'
param([switch]$Test)

# Rutas relativas a la ubicación de este script (carpeta del proyecto)
$ProjRoot  = Split-Path -Parent $PSScriptRoot
$LogFile   = Join-Path $ProjRoot 'logs\watchdog.log'
$StateFile = Join-Path $ProjRoot 'logs\watchdog.state'

# ── Umbrales ──────────────────────────────────────────────────────────────────
# Virtual = RAM + pagefile. El sistema colapsa cuando esta se agota
# ("el archivo de paginación es demasiado pequeño"). 700 MB libres es ya
# patológico (lo normal en esta VPS son ~4 GB libres) pero deja margen
# suficiente para que el watchdog y el reinicio puedan ejecutarse.
$CriticalVirtualMB = 700
$WarningVirtualMB  = 1500
$StrikesToReboot   = 2      # 2 mediciones seguidas (~4 min) para evitar falsos positivos

function Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    # Rotación simple: si el log pasa de 5 MB, conservar solo las últimas 500 líneas
    try {
        if ((Get-Item $LogFile -ErrorAction SilentlyContinue).Length -gt 5MB) {
            Get-Content $LogFile -Tail 500 | Set-Content $LogFile
        }
    } catch {}
}

$os        = Get-CimInstance Win32_OperatingSystem
$freeRamMB  = [math]::Round($os.FreePhysicalMemory  / 1024)
$freeVirtMB = [math]::Round($os.FreeVirtualMemory   / 1024)

# ── Lectura de strikes previos ────────────────────────────────────────────────
$strikes = 0
try { $strikes = [int](Get-Content $StateFile -ErrorAction SilentlyContinue) } catch {}

if ($freeVirtMB -lt $CriticalVirtualMB) {
    $strikes++
    Set-Content -Path $StateFile -Value $strikes
    Log "CRITICO: virtual libre=${freeVirtMB}MB ram libre=${freeRamMB}MB (strike $strikes/$StrikesToReboot)"

    if ($strikes -ge $StrikesToReboot) {
        # Top 5 procesos por memoria para el post-mortem
        $top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 |
               ForEach-Object { "$($_.ProcessName)=$([math]::Round($_.WorkingSet64/1MB))MB" }
        Log ("REINICIANDO VPS por memoria agotada. Top: " + ($top -join ' '))
        Set-Content -Path $StateFile -Value 0

        if ($Test) {
            Log 'MODO TEST: no se reinicia realmente.'
        } else {
            # Parada ordenada del backend (mejor esfuerzo, máx 20 s) y reinicio.
            # shutdown.exe /r es un reinicio ordenado de Windows: los servicios
            # (PostgreSQL incluido) reciben su señal de parada normal.
            try { Stop-Service EdulockVPS -Force -ErrorAction SilentlyContinue } catch {}
            & shutdown.exe /r /f /t 15 /c "Watchdog Edulock: reinicio preventivo por memoria agotada"
        }
    }
} else {
    if ($strikes -gt 0) { Set-Content -Path $StateFile -Value 0 }
    if ($freeVirtMB -lt $WarningVirtualMB) {
        $top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 3 |
               ForEach-Object { "$($_.ProcessName)=$([math]::Round($_.WorkingSet64/1MB))MB" }
        Log ("AVISO: virtual libre=${freeVirtMB}MB ram libre=${freeRamMB}MB. Top: " + ($top -join ' '))
    }
}
