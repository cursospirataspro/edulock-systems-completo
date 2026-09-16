'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, test } = require('node:test');
const { driverProbe, unsignedDriverProbe, dllProbe } = require('../platform-probes');

const driver = (Name, PathName, State = 'Running') => ({ Name, PathName, State });
const fixtures = [
    { name: 'Windows EhStorTcgDrv does not match gdrv', drivers: [driver('EhStorTcgDrv', 'C:\\Windows\\System32\\drivers\\EhStorTcgDrv.sys')], expected: 'clean' },
    { name: 'service substrings do not match', drivers: [driver('gdrvhelper', 'C:\\Drivers\\unrelated.sys')], expected: 'clean' },
    { name: 'binary substrings do not match', drivers: [driver('OtherDriver', 'C:\\Drivers\\gdrv_helper.sys')], expected: 'clean' },
    { name: 'directory names do not match', drivers: [driver('OtherDriver', 'C:\\Drivers\\gdrv\\unrelated.sys')], expected: 'clean' },
    { name: 'directory names ending in sys do not match', drivers: [driver('OtherDriver', 'C:\\Drivers\\gdrv.sys\\unrelated.sys')], expected: 'clean' },
    { name: 'an exact running service matches', drivers: [driver('gdrv', 'C:\\Drivers\\unrelated.sys')], expected: 'gdrv' },
    { name: 'service matching is case insensitive', drivers: [driver('GdRv', 'C:\\Drivers\\unrelated.sys')], expected: 'GdRv' },
    { name: 'a renamed service with the exact binary still matches', drivers: [driver('RenamedDriver', 'C:\\Drivers\\gdrv.sys')], expected: 'RenamedDriver' },
    { name: 'binary matching is case insensitive', drivers: [driver('RenamedDriver', 'C:\\Drivers\\GDRV.SYS')], expected: 'RenamedDriver' },
    { name: 'a quoted binary path with spaces matches', drivers: [driver('QuotedDriver', '"C:\\Program Files\\Driver Vendor\\gdrv.sys"')], expected: 'QuotedDriver' },
    { name: 'a quoted unrelated path does not match', drivers: [driver('OtherDriver', '"C:\\Program Files\\gdrv\\unrelated.sys"')], expected: 'clean' },
    { name: 'a stopped matching service is not reported as loaded', drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys', 'Stopped')], expected: 'clean' },
    { name: 'a stopped renamed matching binary is not reported as loaded', drivers: [driver('StoppedDriver', 'C:\\Drivers\\gdrv.sys', 'Stopped')], expected: 'clean' },
    { name: 'a pending matching driver is not reported as loaded', drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys', 'Start Pending')], expected: 'clean' },
    { name: 'a later running match is found after stopped and unrelated drivers', drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys', 'Stopped'), driver('EhStorTcgDrv', 'C:\\Windows\\System32\\drivers\\EhStorTcgDrv.sys'), driver('ActualDriver', 'C:\\Drivers\\gdrv.sys', 'running')], expected: 'ActualDriver' },
    { name: 'an exact running service without a path still matches', drivers: [driver('gdrv', null)], expected: 'gdrv' },
    { name: 'a similar binary without the sys extension does not match', drivers: [driver('OtherDriver', 'C:\\Drivers\\gdrv.sys.backup')], expected: 'clean' },
    { name: 'other blocked identifiers retain exact matching', drivers: [driver('RenamedDriver', 'C:\\Drivers\\rtcore64.sys')], expected: 'RenamedDriver' },
    { name: 'no drivers is clean', drivers: [], expected: 'clean' },
    { name: 'an allowed first driver does not hide a later blocked driver', allowed: ['gdrv'], drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys'), driver('rtcore64', 'C:\\Drivers\\rtcore64.sys')], expected: 'rtcore64' },
    { name: 'all exact allowed drivers are excluded case insensitively', allowed: [' GDRV ', 'RtCore64'], drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys'), driver('rtcore64', 'C:\\Drivers\\rtcore64.sys')], expected: 'clean' },
    { name: 'a similar service is not covered by an allowed name', allowed: ['VendorDriver'], drivers: [driver('VendorDriverExtra', 'C:\\Drivers\\gdrv.sys')], expected: 'VendorDriverExtra' },
    { name: 'allowing a filename identifier does not allow a renamed service', allowed: ['gdrv'], drivers: [driver('VendorDriver', 'C:\\Drivers\\gdrv.sys')], expected: 'VendorDriver' },
    { name: 'an apostrophe in an allowed service name is escaped literally', allowed: ["Vendor'Driver"], drivers: [driver("Vendor'Driver", 'C:\\Drivers\\gdrv.sys'), driver('rtcore64', 'C:\\Drivers\\rtcore64.sys')], expected: 'rtcore64' },
    { name: 'an allowed name containing PowerShell syntax remains literal', allowed: ["Vendor'; throw 'injected"], drivers: [driver("Vendor'; throw 'injected", 'C:\\Drivers\\gdrv.sys'), driver('rtcore64', 'C:\\Drivers\\rtcore64.sys')], expected: 'rtcore64' },
    { name: 'unsigned: default empty allowlist reports the driver', unsigned: true, drivers: [driver('UnsignedA', 'C:\\Drivers\\a.sys')], expected: 'UnsignedA' },
    { name: 'unsigned: an allowed first driver does not hide a later blocked driver', unsigned: true, allowed: ['UnsignedA'], drivers: [driver('UnsignedA', 'C:\\Drivers\\a.sys'), driver('UnsignedB', 'C:\\Drivers\\b.sys')], expected: 'UnsignedB' },
    { name: 'unsigned: all exact allowed drivers are excluded case insensitively', unsigned: true, allowed: [' UNSIGNEDA ', 'unsignedb'], drivers: [driver('UnsignedA', 'C:\\Drivers\\a.sys'), driver('UnsignedB', 'C:\\Drivers\\b.sys')], expected: 'clean' },
    { name: 'unsigned: a similar service is not covered by an allowed name', unsigned: true, allowed: ['UnsignedA'], drivers: [driver('UnsignedAExtra', 'C:\\Drivers\\a.sys')], expected: 'UnsignedAExtra' },
    { name: 'unsigned: an apostrophe in an allowed name is escaped literally', unsigned: true, allowed: ["Vendor'Driver"], drivers: [driver("Vendor'Driver", 'C:\\Drivers\\a.sys'), driver('UnsignedB', 'C:\\Drivers\\b.sys')], expected: 'UnsignedB' },
    { name: 'unsigned: an allowed name containing PowerShell syntax remains literal', unsigned: true, allowed: ["Vendor'; throw 'injected"], drivers: [driver("Vendor'; throw 'injected", 'C:\\Drivers\\a.sys'), driver('UnsignedB', 'C:\\Drivers\\b.sys')], expected: 'UnsignedB' },
    { name: 'unsigned: a valid signature remains excluded', unsigned: true, drivers: [{ ...driver('SignedDriver', 'C:\\Drivers\\signed.sys'), SignatureStatus: 'Valid' }, driver('UnsignedB', 'C:\\Drivers\\b.sys')], expected: 'UnsignedB' },
    { name: 'unsigned: stopped and system drivers remain excluded', unsigned: true, drivers: [driver('StoppedDriver', 'C:\\Drivers\\stopped.sys', 'Stopped'), driver('WindowsDriver', 'C:\\Windows\\System32\\drivers\\windows.sys')], expected: 'clean' },
    { name: 'Unicode service and quoted accented path retain their exact identity', drivers: [driver('ControladorPeña', '"C:\\Controladores José\\gdrv.sys"')], expected: 'ControladorPeña' },
    { name: 'an accented allowed service matches case insensitively', allowed: ['CONTROLADORPEÑA'], drivers: [driver('ControladorPeña', 'C:\\Controladores José\\gdrv.sys')], expected: 'clean' },
    { name: 'a native NT path retains a blocked basename', drivers: [driver('NativeDriver', '\\??\\C:\\Drivers\\gdrv.sys')], expected: 'NativeDriver' },
    { name: 'a SystemRoot path retains a blocked basename', drivers: [driver('RootDriver', '\\SystemRoot\\drivers\\gdrv.sys')], expected: 'RootDriver' },
    { name: 'a System32 relative path retains a blocked basename', drivers: [driver('RelativeDriver', 'System32\\drivers\\gdrv.sys')], expected: 'RelativeDriver' },
    { name: 'a variable-expanded path retains a blocked basename', drivers: [driver('VariableDriver', '%SystemRoot%\\drivers\\gdrv.sys')], expected: 'VariableDriver' },
    { name: 'a paused driver is not described as running', drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys', 'Paused')], expected: 'clean' },
    { name: 'an unknown driver state is not described as running', drivers: [driver('gdrv', 'C:\\Drivers\\gdrv.sys', 'Unknown')], expected: 'clean' },
    { name: 'query access denied is unavailable rather than clean', queryError: true, drivers: [], expectedError: true },
    { name: 'unsigned query access denied is unavailable rather than clean', unsigned: true, queryError: true, drivers: [], expectedError: true },
    { name: 'unsigned inaccessible signature is unavailable rather than unsigned', unsigned: true, signatureError: true, drivers: [driver('VendorDriver', 'C:\\Drivers\\vendor.sys')], expectedError: true },
    { name: 'unsigned inaccessible path is unavailable rather than clean', unsigned: true, pathError: true, drivers: [driver('VendorDriver', 'C:\\Drivers\\vendor.sys')], expectedError: true },
    { name: 'unsigned missing file is explicitly unavailable', unsigned: true, drivers: [{ ...driver('VendorDriver', 'C:\\Drivers\\missing.sys'), Missing: true }], expected: 'probe-error:driver-file-unavailable:VendorDriver' },
    { name: 'unsigned native NT path is resolved before signature check', unsigned: true, drivers: [{ ...driver('NativeDriver', '\\??\\C:\\Drivers\\native.sys'), ResolvedPath: 'C:\\Drivers\\native.sys', SignatureStatus: 'Valid' }], expected: 'clean' },
    { name: 'unsigned quoted accented path is checked literally', unsigned: true, drivers: [driver('ControladorPeña', '"C:\\Controladores José\\a.sys"')], expected: 'ControladorPeña' },
];

// Brand names label synthetic inventories; these are not vendor/device certifications.
for (const [brand, name] of [
    ['Dell Intel', 'Netwtw14'], ['HP Realtek', 'rt640x64'], ['Lenovo Intel', 'iaStorVD'],
    ['ASUS NVIDIA', 'nvlddmkm'], ['MSI AMD', 'amdkmdag'], ['Acer Qualcomm', 'qcamain10x64'],
    ['Microsoft Surface', 'SurfaceHidMini'], ['Gigabyte Realtek', 'RTKVHD64'],
]) {
    const sample = { ...driver(name, `C:\\Vendor Drivers\\${name}.sys`), SignatureStatus: 'Valid' };
    fixtures.push({ name: `synthetic ${brand}: unrelated driver is not BYOVD`, drivers: [sample], expected: 'clean' });
    fixtures.push({ name: `synthetic ${brand}: valid signature is not unsigned`, unsigned: true, drivers: [sample], expected: 'clean' });
}
for (const status of ['NotTrusted', 'UnknownError', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible']) {
    fixtures.push({ name: `signature ${status} is retained as its own state`, unsigned: true,
        drivers: [{ ...driver('VendorDriver', 'C:\\Drivers\\vendor.sys'), SignatureStatus: status }],
        expected: `signature-status:${status}:VendorDriver` });
}
fixtures.push({ name: 'a valid signature does not bypass a known blocked driver name',
    drivers: [{ ...driver('gdrv', 'C:\\Drivers\\gdrv.sys'), SignatureStatus: 'Valid' }], expected: 'gdrv' });
for (const fixture of [
    { name: 'DLL: allowed first module does not hide later anomaly', allowed: ['vendor.dll'], modules: ['C:\\Vendor\\vendor.dll', 'C:\\Other\\other.dll'], expected: 'C:\\Other\\other.dll' },
    { name: 'DLL: similar module name is not allowed', allowed: ['vendor.dll'], modules: ['C:\\Vendor\\my-vendor.dll'], expected: 'C:\\Vendor\\my-vendor.dll' },
    { name: 'DLL: all exact allowed modules are excluded', allowed: ['VENDOR.DLL'], modules: ['C:\\Vendor\\vendor.dll'], expected: 'clean' },
    { name: 'DLL: no modules produces no anomaly', modules: [], expected: 'clean' },
    { name: 'DLL: process access denied is unavailable', modules: [], queryError: true, expectedError: true },
]) fixtures.push({ ...fixture, dll: true, drivers: [] });

let results;
before(() => {
    if (process.platform !== 'win32') return;
    const fixtureData = Buffer.from(JSON.stringify(fixtures.map(fixture => ({
        ...fixture,
        probe: fixture.dll ? dllProbe(12345, fixture.allowed) : fixture.unsigned ? unsignedDriverProbe(fixture.allowed) : driverProbe(['gdrv', 'rtcore64'], fixture.allowed),
    }))), 'utf8').toString('base64');
    const script = `
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'These regressions must execute in Windows PowerShell 5.1.'
}
$cases=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixtureData}')))
function Get-CimInstance {
    param([string]$ClassName)
    if ($ClassName -ne 'Win32_SystemDriver') { throw 'Unexpected CIM query' }
    if ($script:ActiveFixture.queryError) { throw 'Synthetic query access denied' }
    $script:DriverFixture
}
function Get-Process {
    param([int]$Id)
    if ($Id -ne 12345) { throw 'Unexpected process ID' }
    if ($script:ActiveFixture.queryError) { throw 'Synthetic process access denied' }
    [pscustomobject]@{ Modules=@($script:ActiveFixture.modules | ForEach-Object { [pscustomobject]@{ FileName=$_ } }) }
}
function Test-Path {
    param([string]$LiteralPath)
    if ($script:ActiveFixture.pathError) { throw 'Synthetic path access denied' }
    $entry=$script:DriverFixture | Where-Object { (([string]$_.PathName).Trim('"') -ceq $LiteralPath) -or ($_.ResolvedPath -ceq $LiteralPath) } | Select-Object -First 1
    [bool]($entry -and -not $entry.Missing)
}
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    if ($script:ActiveFixture.signatureError) { throw 'Synthetic signature access denied' }
    $entry=$script:DriverFixture | Where-Object { (([string]$_.PathName).Trim('"') -ceq $LiteralPath) -or ($_.ResolvedPath -ceq $LiteralPath) } | Select-Object -First 1
    if (-not $entry) { throw 'Unexpected signature path' }
    if ($entry.SignatureStatus) { [pscustomobject]@{ Status=$entry.SignatureStatus } }
    else { [pscustomobject]@{ Status='NotSigned' } }
}
$results=@(foreach ($case in $cases) {
    $script:ActiveFixture=$case
    $script:DriverFixture=$case.drivers
    try {
        $actual=@(& ([scriptblock]::Create($case.probe)))
        [pscustomobject]@{name=$case.name; actual=($actual -join "\n"); failed=$false}
    } catch {
        [pscustomobject]@{name=$case.name; actual=$null; failed=$true; error=$_.Exception.Message}
    }
})
ConvertTo-Json -InputObject $results -Compress
`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // A fixture file avoids Windows' command-line length limit as the suite grows.
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'edulock-driver-probe-'));
    const scriptPath = path.join(temporaryDirectory, 'fixtures.ps1');
    try {
        fs.writeFileSync(scriptPath, script, 'utf8');
        const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
            encoding: 'utf8', timeout: 30000, windowsHide: true,
        });
        results = new Map(JSON.parse(output.trim()).map(result => [result.name, result]));
    } finally {
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        fs.rmdirSync(temporaryDirectory);
    }
});

for (const fixture of fixtures) {
    test(fixture.name, { skip: process.platform !== 'win32' ? 'Requires Windows PowerShell 5.1' : false }, () => {
        const result = results.get(fixture.name);
        assert.equal(result.failed, !!fixture.expectedError, result.error);
        if (fixture.expectedError) assert.match(result.error, /Synthetic .*access denied/);
        else assert.equal(result.actual, fixture.expected);
    });
}
