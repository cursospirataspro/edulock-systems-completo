$BASE="https://edulocksystemsoficial.dpdns.org"
$lr=Invoke-RestMethod "$BASE/api/auth/admin-login" -Method POST -ContentType "application/json" -Body '{"username":"admin@edulocksystemsoficial.dpdns.org","password":"123456789"}' -TimeoutSec 15
$tok=$lr.token
$mk=Invoke-RestMethod "$BASE/api/monitor/key" -Headers @{Authorization="Bearer $tok"} -TimeoutSec 10
$act=Invoke-RestMethod "$BASE/api/monitor/activity?limit=500" -Headers @{Authorization="Bearer $($mk.monitorKey)"} -TimeoutSec 20

$fecha = Get-Date -Format "yyyy-MM-dd_HH-mm"

$conEmail = $act.activity | Where-Object { $_.studentEmail -ne "" -and $_.studentEmail -ne $null } | Group-Object studentEmail | ForEach-Object {
    $g = $_.Group | Select-Object -First 1
    [PSCustomObject]@{ correo=$g.studentEmail; deviceId=$g.deviceId; usuario=$g.studentEmail.Split("@")[0] }
} | Sort-Object correo

$todosDevices = $act.activity | Group-Object deviceId | ForEach-Object {
    $g = $_.Group | Select-Object -First 1
    [PSCustomObject]@{ deviceId=$g.deviceId; correo=if($g.studentEmail){$g.studentEmail}else{"ANONIMO"}; ultimoVideo=$g.videoTitle; ultimaFecha=$g.at }
} | Sort-Object correo

$backup = @{
    exportadoEn        = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    totalConEmail      = $conEmail.Count
    totalDevicesVistos = $todosDevices.Count
    vinculados         = $conEmail
    todosDispositivos  = $todosDevices
}

$outFile = "D:\descargas\proyectos hunter 2\reproductor-cursos-master\backup_deviceid_correos_$fecha.json"
$backup | ConvertTo-Json -Depth 5 | Set-Content $outFile -Encoding UTF8
Write-Host "Backup guardado: $outFile"
Write-Host "Vinculados (con correo): $($conEmail.Count)"
Write-Host "Total dispositivos vistos: $($todosDevices.Count)"
