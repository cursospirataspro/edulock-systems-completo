param(
    [string[]]$Tasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug'),
    [string]$JavaHome = $env:JAVA_HOME,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$previousJavaHome = $env:JAVA_HOME
$previousJavaOptions = $env:JAVA_TOOL_OPTIONS
$previousDirectory = Get-Location

try {
    Set-Location -LiteralPath $PSScriptRoot
    if (-not $JavaHome) {
        $studioJava = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
        if (Test-Path -LiteralPath (Join-Path $studioJava 'bin\java.exe')) {
            $JavaHome = $studioJava
        } else {
            throw 'Define JAVA_HOME o proporciona -JavaHome con un JDK compatible.'
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
        throw 'El JDK indicado no contiene bin\java.exe.'
    }
    $env:JAVA_HOME = $JavaHome

    # Java NIO uses a Unix-domain socket internally on Windows. The user's
    # redirected TEMP can reject connect(), even when normal TCP works.
    # The documented property keeps those sockets inside this project.
    $socketDirectory = Join-Path $PSScriptRoot '.socket-tmp'
    New-Item -ItemType Directory -Path $socketDirectory -Force | Out-Null
    $fileSystem = New-Object -ComObject Scripting.FileSystemObject
    $socketDirectory = $fileSystem.GetFolder($socketDirectory).ShortPath
    if ([Text.Encoding]::UTF8.GetByteCount($socketDirectory) -gt 80) {
        throw 'Ruta de sockets demasiado larga. Usa una ruta de proyecto Windows mas corta.'
    }
    $socketOption = '-Djdk.net.unixdomain.tmpdir="' + $socketDirectory + '"'
    $env:JAVA_TOOL_OPTIONS = ($previousJavaOptions + ' ' + $socketOption).Trim()

    $gradleArguments = @('--no-daemon', '--console=plain') + $Tasks
    if ($Offline) { $gradleArguments += '--offline' }
    & .\gradlew.bat @gradleArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle termino con codigo $LASTEXITCODE."
    }
} finally {
    $env:JAVA_HOME = $previousJavaHome
    $env:JAVA_TOOL_OPTIONS = $previousJavaOptions
    Set-Location -LiteralPath $previousDirectory.Path
}
