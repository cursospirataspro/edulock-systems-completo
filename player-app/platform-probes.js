'use strict';

function powershellCommand(script) {
    return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

const resolveDriverPath = String.raw`function Resolve-DriverPath([string]$value) {
    $p=$value.Trim()
    if ($p -match '^"([^"]+)"(?:\s.*)?$') { $p=$Matches[1] }
    $p=[Environment]::ExpandEnvironmentVariables($p)
    if ($p.StartsWith('\??\')) { $p=$p.Substring(4) }
    if ($p -match '^\\SystemRoot\\') { $p=Join-Path $env:SystemRoot $p.Substring(12) }
    elseif ($p -match '^System32\\') { $p=Join-Path $env:SystemRoot $p }
    $p
}`;

function driverProbe(names, allowedNames = []) {
    const literals = names.map(name => "'" + String(name).replace(/'/g, "''") + "'").join(',');
    const allowedLiterals = allowedNames.map(name => "'" + String(name).trim().replace(/'/g, "''") + "'").join(',');
    return String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
    ${resolveDriverPath}
    $patterns=@(${literals}); $allowed=@(${allowedLiterals}); $found=Get-CimInstance Win32_SystemDriver | Where-Object {
        if ($_.State -ine 'Running') { return $false }
        $n=([string]$_.Name).Trim(); $p=Resolve-DriverPath ([string]$_.PathName)
        if ($allowed -icontains $n) { return $false }
        $driverFile=[System.IO.Path]::GetFileName($p)
        $patterns | Where-Object { $n -ieq $_ -or $driverFile -ieq ($_ + '.sys') }
    } | Select-Object -First 1 -ExpandProperty Name
    if($found){$found}else{'clean'}`;
}

function unsignedDriverProbe(allowedNames = []) {
    const allowedLiterals = allowedNames.map(name => "'" + String(name).trim().replace(/'/g, "''") + "'").join(',');
    return String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
    ${resolveDriverPath}
    $allowed=@(${allowedLiterals}); $found=Get-CimInstance Win32_SystemDriver | Where-Object {
        if ($allowed -icontains ([string]$_.Name).Trim()) { return $false }
        $_.State -eq 'Running' -and ([string]$_.PathName) -notlike '*\system32\*' -and
        ([string]$_.PathName) -notlike '*\syswow64\*' -and ([string]$_.PathName) -notlike '*\systemroot\*'
    } | ForEach-Object {
        $p=Resolve-DriverPath ([string]$_.PathName)
        if($p -and (Test-Path -LiteralPath $p)) {
            $signature=Get-AuthenticodeSignature -LiteralPath $p
            if($signature.Status -eq 'NotSigned'){$_.Name}
            elseif($signature.Status -ne 'Valid') {
                $status=([string]$signature.Status).Trim()
                if(-not $status){$status='UnknownError'}
                'signature-status:' + $status + ':' + $_.Name
            }
        } else { 'probe-error:driver-file-unavailable:' + $_.Name }
    } | Select-Object -First 1
    if($found){$found}else{'clean'}`;
}

function dllProbe(pid, allowedNames = []) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process id');
    const allowedLiterals = allowedNames.map(name => "'" + String(name).trim().replace(/'/g, "''") + "'").join(',');
    return String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
    $allowed=@(${allowedLiterals}); $found=(Get-Process -Id ${pid} -ErrorAction Stop).Modules | Where-Object {
        $f=([string]$_.FileName).ToLower()
        if ($allowed -icontains [System.IO.Path]::GetFileName($f)) { return $false }
        $f -notlike '*\windows\*' -and $f -notlike '*\microsoft.net\*' -and
        $f -notlike '*edulock*' -and $f -notlike '*\appdata\*' -and
        $f -notlike '*electron*' -and $f -notlike '*\nodejs\*' -and $f.EndsWith('.dll')
    } | Select-Object -First 1 -ExpandProperty FileName
    if($found){$found}else{'clean'}`;
}

module.exports = { powershellCommand, driverProbe, unsignedDriverProbe, dllProbe };
