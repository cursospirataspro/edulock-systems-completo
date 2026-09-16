@echo off
rem Compila el APK release firmado con el JDK de Android Studio.
rem Uso: doble clic o  _build_release.cmd  (deja el log en _build_release.log)
cd /d "%~dp0"
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "EDULOCK_SIGNING_PROPERTIES=%~dp0keystore.properties"
echo [%date% %time%] inicio > "_build_release.log"
rem Sin lint "vital" (se quedaba sin memoria junto a R8) y con menos trabajadores en paralelo.
call gradlew.bat --no-daemon --max-workers=2 -Dorg.gradle.jvmargs="-Xmx5g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8" -Dkotlin.compiler.execution.strategy=in-process assembleRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease >> "_build_release.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "_build_release.log"
echo [%date% %time%] fin >> "_build_release.log"

