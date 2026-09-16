# Recursos libres y PDF protegido en Android

Implementación verificada por compilación y pruebas JVM el 13 de septiembre de 2026. El propietario elige Libre o Protegido en su panel; el APK respeta la elección del servidor.

## Comportamiento

| Recurso | Android |
|---|---|
| Enlace existente sin campo de protección | Permanece libre. Se abre el navegador con HTTP/HTTPS y puede descargarse según el servidor de origen. |
| PDF alojado y marcado Libre | Abre `/resources/{UUID}/download` en el navegador, resuelto únicamente contra el servidor configurado. No se envía el JWT al navegador. |
| PDF marcado Protegido | Abre un visor nativo de páginas PNG, con autenticación, dispositivo y autorización de curso/licencia comprobados por el servidor. |
| Tipo de protección desconocido | No se interpreta como Libre; solicita actualizar el reproductor. |

El catálogo ahora incluye los recursos de módulos y videos, y puede abrirse desde **Mis cursos y recursos** en la pantalla de espera. El enlace `cdp://resource?id=UUID` conserva el destino a través del acceso y activación existentes, sin crear otra identidad Firebase.

El visor muestra nombre, página actual, Anterior/Siguiente, ampliación con botones o gesto y marca visible de correo/código. No incorpora PDF original, impresión, exportación, selección de texto, WebView ni descarga de páginas. Los enlaces libres conservan su comportamiento de navegador.

## Autorización y datos temporales

- `/api/resources/{id}/view` requiere la sesión y `X-Device-ID`. Una autorización protegida válida incluye ID, versión positiva, 1–200 páginas, correo/código de marca y una lease de hasta 30 segundos.
- Se renueva cada 15 segundos. La fecha límite se calcula desde el inicio de la petición, de modo que la latencia de red no prolongue el permiso.
- Un heartbeat tardío no revive una lease ya vencida. Cambio de versión, ausencia de permiso, fallo de red, expiración o cierre de sesión borran la página y cancelan solicitudes pendientes.
- Al pasar a segundo plano se elimina la imagen en memoria. Al volver se consulta el permiso otra vez antes de mostrar una página.
- Cada página exige HTTP 2xx, `image/png`, cabecera `X-Resource-Version` exacta, firma PNG y tamaño máximo de 12 MiB. La decodificación limita dimensiones a 8192 por lado y 8 millones de píxeles; el renderer del servidor usa un límite inferior, de 1800 por lado.
- El cliente no usa caché HTTP o archivos PDF, no sigue redirecciones y limita las solicitudes a 20 segundos. Los bytes temporales se limpian después de decodificar. No se agregaron permisos Android.
- `FLAG_SECURE` se conserva en el visor y el catálogo; no hay Picture-in-Picture del documento.

La renovación de sesión también se corrigió: ahora requiere HTTP 2xx, estado `approved` y token no vacío. Una respuesta tardía no puede volver a guardar la sesión después de que cambien el token o UID, y una sesión vacía no se restaura automáticamente desde Firebase.

## Verificación y paquetes

- Build final: **BUILD SUCCESSFUL**, 8 minutos y 53 segundos. Debug y release compilados; release pasó R8 y reducción de recursos.
- **26/26 pruebas JVM**: 15 de recursos y leases, 7 de acceso y 4 de recuperación de contraseña. Ningún fallo u omisión.
- Lint debug/release: **0 errores, 111 advertencias**. La base previa tenía 99; las nuevas advertencias corresponden a textos de interfaz aún no extraídos para traducción. No se desactivaron comprobaciones de lint.
- APK debug: firma Android Debug, APK v2, verificada.
- APK release: **sin firma de distribución**, confirmado con `apksigner`. No se leyó ni configuró una clave privada de distribución.
- ADB no detectó teléfonos ni emuladores conectados. Se cerró el servidor ADB iniciado para esa consulta. No se instalaron paquetes ni se ejecutó el visor en un teléfono.

Paquetes conservados en `dist-resources-qa`:

| Paquete | Bytes | SHA-256 |
|---|---:|---|
| Edulock-Android-1.1.0-resources-debug.apk | 14.330.923 | `9A2E45D062F6328EEF62309078EBA33B1A5D0ED37827F4C84345926CF13EFCB0` |
| Edulock-Android-1.1.0-resources-release-unsigned.apk | 7.105.697 | `EB623241BA81554C666B2276DCA58748F8AA1F91C8F70A9D447405AC56DE59A4` |

Evidencia detallada: `android-resources-final.log`, `android-resources-artifacts.json`, `android-resources-debug-signature.log`, `android-resources-release-signature.log`, `app/build/test-results/testDebugUnitTest/TEST-com.edulock.player.ui.ResourcePolicyTest.xml` y los informes de lint en `app/build/reports`.

## Límites y aceptación pendiente

La compilación y las políticas JVM no acreditan por sí solas zoom, rotación, captura bloqueada, consumo de memoria, apertura de navegador ni revocación real en distintos teléfonos. Esos recorridos requieren ejecución en dispositivos. El endpoint debe estar desplegado en el servidor al que apunte el APK; no se publicó producción desde este trabajo.

El modo protegido es online y presenta imágenes de páginas. No implementa búsqueda ni lectura accesible del texto original del PDF. La aplicación no puede garantizar que un dispositivo completamente controlado por su propietario no reconstruya las imágenes que recibió con autorización; la marca visible acompaña esas páginas.

`SecurityMonitorService` sigue siendo el servicio heredado que registra inicio y finalización: no contiene detección efectiva de root, debugging o bypass. No se lo contabiliza como protección demostrada. La firma comercial del APK y las pruebas físicas siguen pendientes.
