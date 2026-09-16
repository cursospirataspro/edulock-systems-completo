
$BASE = "https://edulocksystemsoficial.dpdns.org"
$lb = '{"username":"admin@edulocksystemsoficial.dpdns.org","password":"123456789"}'
$lr = Invoke-RestMethod -Method POST -Uri "$BASE/api/auth/admin-login" -ContentType "application/json" -Body $lb
$tk = $lr.token
$hd = @{Authorization="Bearer $tk"}

Write-Host "Login OK" -ForegroundColor Green

$catVivo = Invoke-RestMethod -Method GET -Uri "$BASE/api/video/catalog/export-seed" -Headers $hd
$crVivo  = Invoke-RestMethod -Method GET -Uri "$BASE/api/courses" -Headers $hd
$cursosVivos = $crVivo.courses
$backup = Get-Content "$PSScriptRoot\backup_render_1281videos_2026-05-13.json" -Raw | ConvertFrom-Json

Write-Host "Datos cargados: Servidor $($catVivo.Count) videos / $($cursosVivos.Count) cursos" -ForegroundColor Cyan

$errTotal = 0
$report   = [System.Collections.Generic.List[string]]::new()

# ---- 1. TOTALES ----
$report.Add("=== [1] TOTALES ===")
if ($catVivo.Count -eq $backup.totalVideos) {
    $report.Add("OK  Videos: $($catVivo.Count) servidor = $($backup.totalVideos) backup")
} else {
    $report.Add("ERR Videos: servidor=$($catVivo.Count) backup=$($backup.totalVideos)")
    $errTotal++
}
if ($cursosVivos.Count -eq $backup.totalCourses) {
    $report.Add("OK  Cursos: $($cursosVivos.Count) servidor = $($backup.totalCourses) backup")
} else {
    $report.Add("ERR Cursos: servidor=$($cursosVivos.Count) backup=$($backup.totalCourses)")
    $errTotal++
}

# ---- 2. ORDEN Y DATOS DE CURSOS ----
$report.Add("")
$report.Add("=== [2] ORDEN Y DATOS DE CADA CURSO ===")
for ($i = 0; $i -lt $cursosVivos.Count; $i++) {
    $cv = $cursosVivos[$i]
    $cb = $backup.courses[$i]
    $errCurso = @()
    if ($cv.id     -ne $cb.id)     { $errCurso += "ID-DIFF(serv:$($cv.id) back:$($cb.id))" }
    if ($cv.name   -ne $cb.nombre) { $errCurso += "NOMBRE-DIFF(serv:'$($cv.name)' back:'$($cb.nombre)')" }
    if ($cv.author -ne $cb.autor)  { $errCurso += "AUTOR-DIFF(serv:'$($cv.author)' back:'$($cb.autor)')" }
    if ($errCurso.Count -eq 0) {
        $report.Add("OK  [$($i+1)] $($cb.nombre) | autor: '$($cb.autor)'")
    } else {
        foreach ($e in $errCurso) { $report.Add("ERR [$($i+1)] $e"); $errTotal++ }
    }
}

# ---- 3. VIDEOS POR CURSO: cantidad, orden, id, titulo, links ----
$report.Add("")
$report.Add("=== [3] VIDEOS POR CURSO (cantidad + orden + titulo + links) ===")

foreach ($cb in $backup.courses) {
    $vivosCurso = @($catVivo | Where-Object { $_.courseId -eq $cb.id } | Sort-Object { [int]($_.sortOrder) })
    $bVideos    = @($cb.videos)
    $errCurso   = 0

    # Cantidad
    if ($vivosCurso.Count -ne $cb.totalVideos) {
        $report.Add("  ERR CANTIDAD: servidor=$($vivosCurso.Count) backup=$($cb.totalVideos)")
        $errCurso++; $errTotal++
    }

    # Cada video
    for ($i = 0; $i -lt $vivosCurso.Count; $i++) {
        $vv = $vivosCurso[$i]
        $vb = $bVideos[$i]
        if ($null -eq $vb) {
            $report.Add("  ERR pos $($i+1): video FALTA en backup")
            $errCurso++; $errTotal++; continue
        }
        $e = @()
        if ($vv.videoId  -ne $vb.videoId)         { $e += "videoId-DIFF" }
        if ($vv.title    -ne $vb.titulo_original)  { $e += "titulo-DIFF(serv:'$($vv.title)' back:'$($vb.titulo_original)')" }
        $espLink = "https://edulocksystemsoficial.dpdns.org/?v=$($vv.videoId)"
        if ($espLink     -ne $vb.link_player)      { $e += "link_player-DIFF" }
        if ($vv.bunnyUrl -ne $vb.link_original_hls){ $e += "bunnyUrl-DIFF(serv:'$($vv.bunnyUrl)' back:'$($vb.link_original_hls)')" }
        if ($vv.sourceType -ne $vb.sourceType)     { $e += "sourceType-DIFF" }
        if ($vv.status   -ne $vb.status)           { $e += "status-DIFF" }
        if ($e.Count -gt 0) {
            foreach ($err in $e) { $report.Add("  ERR pos $($i+1) [$($vv.videoId)]: $err"); $errCurso++; $errTotal++ }
        }
    }

    $st = if ($errCurso -eq 0) { "OK " } else { "ERR" }
    $report.Add("$st [$($cb.nombre)] servidor:$($vivosCurso.Count) backup:$($cb.totalVideos) errores:$errCurso")
}

# ---- 4. VERIFICAR QUE NINGUN VIDEO DEL SERVIDOR FALTA EN EL BACKUP ----
$report.Add("")
$report.Add("=== [4] TODOS LOS VIDEO-IDs DEL SERVIDOR PRESENTES EN BACKUP ===")
$backupIds = @{}
foreach ($c in $backup.courses) { foreach ($v in @($c.videos)) { $backupIds[$v.videoId] = $true } }
foreach ($v in @($backup.videosWithoutCourse)) { $backupIds[$v.videoId] = $true }

$faltantes = @($catVivo | Where-Object { -not $backupIds.ContainsKey($_.videoId) })
if ($faltantes.Count -eq 0) {
    $report.Add("OK  Ningun video falta. Todos los $($catVivo.Count) videoIds del servidor estan en el backup.")
} else {
    $report.Add("ERR Faltan $($faltantes.Count) videos en el backup:")
    foreach ($f in $faltantes) { $report.Add("  - $($f.videoId) | $($f.title)"); $errTotal++ }
}

# ---- RESULTADO FINAL ----
$report.Add("")
$report.Add("================================================")
if ($errTotal -eq 0) {
    $report.Add("RESULTADO: TODO CORRECTO - 0 ERRORES ENCONTRADOS")
    $report.Add("El backup es una copia exacta del servidor.")
    $report.Add("Cursos: $($backup.totalCourses) | Videos: $($backup.totalVideos)")
    $report.Add("Fecha backup: $($backup.exportedAt)")
} else {
    $report.Add("RESULTADO: SE ENCONTRARON $errTotal ERRORES")
}
$report.Add("================================================")

# Guardar reporte
$reportPath = "$PSScriptRoot\_reporte_verificacion_backup.txt"
$report | Out-File -FilePath $reportPath -Encoding UTF8

# Mostrar en pantalla
$report | ForEach-Object {
    if ($_ -match "^ERR") { Write-Host $_ -ForegroundColor Red }
    elseif ($_ -match "^OK") { Write-Host $_ -ForegroundColor Green }
    else { Write-Host $_ -ForegroundColor White }
}

Write-Host ""
Write-Host "Reporte guardado en: _reporte_verificacion_backup.txt" -ForegroundColor Yellow
