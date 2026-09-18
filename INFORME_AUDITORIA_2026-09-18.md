# Auditoría y corrección de Edulock — 18 de septiembre de 2026

Auditoría de extremo a extremo (servidor, PostgreSQL, panel de admin, panel de
productores, reproductor de PC y aplicación Android), con correcciones
implementadas y pruebas ejecutadas. No se desplegó nada a producción ni se
publicó ningún binario: todo el trabajo vive en una rama de correcciones.

---

## 1. Preparación y límites

| Dato | Valor |
|---|---|
| Rama de trabajo | `fix/auditoria-f01-f09-r01-r08` |
| Commit inicial | `b112d6c` |
| Commit final | `c9ab48f` |
| Archivos cambiados | 21 (+1991 / −218) |
| Node local | v24.11.1 · Node del servidor: v20.20.2 |
| Base de datos de pruebas | PostgreSQL 17 en el VPS, base **desechable** `edulock_qa_auditoria` |
| Motor de documentos | el real (`pdf-runtime` con `@napi-rs/canvas` y `pdfjs-dist`) |
| Android | Gradle 8.6 · JDK de Android Studio · pruebas JVM reales |

No hubo `reset` destructivo, ni `force-push`, ni fusión a `main`. No se tocó
ninguna fila de la base de producción: el entorno de pruebas es un directorio
aparte (`/root/edulock-audit`) con su propia base, y todas las cuentas, cursos y
licencias usadas son sintéticas y se borran al terminar cada prueba.

**Un dato de configuración que conviene que conozcas** (no se cambió nada):
`EDU_MASTER_KEY` no está definida en el servidor, así que la clave de cifrado de
campos se deriva de `JWT_SECRET`. Si algún día rotas `JWT_SECRET` sin más, las
URL y los documentos ya cifrados dejarán de poder leerse. Es una decisión tuya;
no toqué claves maestras.

---

## 2. Hallazgos F01–F09

| Id | Estado | Causa real | Corrección | Prueba |
|---|---|---|---|---|
| **F01** | Corregido y verificado | El catálogo de Android no pasaba el token de reproducción, así que el manifiesto se pedía con el JWT de la cuenta. El servidor exige un token atado al video y a la sesión: lo rechaza con `SESSION_REQUIRED`. **La reproducción desde «Mis Cursos» en Android no funcionaba.** | Política de reproducción compartida (`PlaybackPolicy`); el manifiesto, sus variantes, claves y segmentos usan siempre el token de reproducción. Sin ese token no se intenta la petición. | 3 pruebas del contrato del servidor + 10 pruebas Kotlin + 2 de integración cliente |
| **F02** | Corregido y verificado | El borrado en el servicio de video se decidía **después** de borrar en la base, leyendo la fila que acababa de desaparecer. Las colecciones y las bibliotecas **nunca llegaban a borrarse**. | El descriptor remoto se resuelve con las filas vivas y se encola en la **misma transacción** (tabla `provider_deletions`); la ejecución va después, con reintentos acotados, recuperación tras reinicio e idempotencia. | 7 pruebas de integración contra PostgreSQL real |
| **F03** | Corregido y verificado | Borrar un **módulo** o un **curso** desde el panel de admin dejaba documentos apuntando a elementos inexistentes, ajustes huérfanos y colecciones y bibliotecas sin borrar, mientras el panel del productor sí limpiaba todo. También afectaba a la operación masiva de borrado de todos los cursos. | Las dos rutas comparten las reglas de integridad, todo dentro de una transacción, y el borrado remoto se encola igual que en el panel del productor. La diferencia legítima (el admin arrastra submódulos y deja las clases sin curso ni módulo) se conserva. Las rutas responden 404 si el elemento no existe. | 3 pruebas + suite de integración |
| **F04** | Corregido | `IS_DEV` dependía solo de `--dev`: **el binario distribuido aceptaba esa bandera** y con ella se saltaba el control de sesión remota, el escaneo de seguridad periódico y la actualización obligatoria, y abría las herramientas de desarrollo. | `IS_DEV = !app.isPackaged && process.argv.includes('--dev')`. En un binario empaquetado es siempre falso. | 1 prueba + **verificado en el binario empaquetado** (ver §5) |
| **F05** | Corregido y verificado | Sin `ADMIN_PASS`, el servidor usaba `changeme`: creaba el administrador con esa contraseña y, en una instalación existente, **reescribía la contraseña real del propietario con una conocida**. | Sin `ADMIN_PASS` no se crea administrador (el arranque se detiene) y el existente queda intacto. El login ya no acepta contraseña por omisión y compara en tiempo constante. Los tokens llevan la huella de la credencial: al cambiarla, las sesiones abiertas dejan de valer. | 5 pruebas + reproducción del fallo en el código anterior |
| **F06** | Corregido y verificado | La columna `documents` puede venir cifrada (`enc1:`) y se le aplicaba `JSON.parse` directo: fallaba en silencio y el módulo aparecía **sin materiales**. | Conversor que entiende el cifrado y distingue «no hay materiales» de «no se pudieron leer». Aplicado en el catálogo del alumno y en el repositorio de recursos. | 5 pruebas + **una prueba que ya existía en el repo y fallaba desde antes vuelve a pasar** |
| **F07** | Corregido y verificado | `/api/catalog/add-bunny` y `/api/video/upload` respondían éxito antes de que la fila estuviera guardada. | Se espera la escritura; si falla, se responde error. Ninguna llamada a `addToCatalog` queda sin esperar. | 3 pruebas |
| **F08** | Corregido y verificado | El catálogo de Android no contemplaba `vdocipher_direct` (el modelo ni siquiera tenía el campo `directUrl`) y daba un error genérico. | Misma política compartida que el enlace, con validación por tipo y mensajes distintos para datos incompletos, credenciales ausentes y formato no admitido. | 10 pruebas Kotlin + 1 de integración |
| **F09** | Corregido y verificado | La consulta silenciosa de «Mis Cursos» no tenía control de generación: una respuesta tardía volvía a encender el botón tras cerrar sesión. Y si la primera consulta fallaba, no había reintento. | Misma cancelación que la carga, reintentos limitados (tres, con esperas crecientes) y nueva consulta al cambiar la sesión. El reproductor emite ese evento, que antes no existía. | 6 pruebas sobre el archivo real del reproductor |

---

## 3. Riesgos R01–R08

| Id | Estado | Qué se encontró y qué se hizo |
|---|---|---|
| **R01** | Corregido | Un video **no guardaba en qué biblioteca vive**: todo se resolvía con la biblioteca vigente del curso. Ahora `catalog.bunny_library_id` lo anota; las clases de una biblioteca anterior se consultan y se borran en la suya, con su propia clave, y no se reorganizan dentro de la nueva. Las filas antiguas (sin anotación) siguen resolviéndose con la biblioteca vigente, que es donde están. |
| **R02** | Corregido y verificado | El borrado de un **video** no comprobaba procedencia: bastaba que el identificador tuviera forma de UUID. Ahora se exige el registro que dejó esta plataforma al crearlo. Un video ajeno se quita del catálogo pero **no se toca en el proveedor**. |
| **R03** | Corregido y verificado | La conexión remota a PostgreSQL usaba `rejectUnauthorized:false`: cifraba pero no comprobaba con quién hablaba. Ahora se verifica con la autoridad configurada (`PGSSLROOTCERT` o `DATABASE_CA_CERT`); sin ella el arranque se detiene en vez de degradarse en silencio. Las conexiones locales siguen igual, así que **tu servidor no cambia de comportamiento**. |
| **R04** | Corregido | Tres cosas: la sesión (con el token) se guardaba en **texto plano** en disco; los dominios del inicio de sesión se comparaban por subcadena (`includes`), de modo que `https://ajeno.test/?x=accounts.google.com` pasaba el filtro; y cualquier dirección que no fuera `file://` se entregaba al sistema operativo. Ahora: almacén del sistema (`safeStorage`) con migración del archivo antiguo, comparación por host exacto, solo `http`/`https`, y los canales IPC comprueban quién llama. |
| **R05** | Corregido | El catálogo de Android informaba `appVersion = "1.0.0"` fijo (la app va por 1.1.4), abría la clase en un ámbito suelto que sobrevivía a la pantalla, no protegía contra el doble toque y no liberaba el WebView de VdoCipher. Todo corregido. |
| **R06** | Corregido y verificado | Renombrar un módulo desde el panel de admin enviaba `sortOrder: 0` aunque no se hubiera indicado posición: **el módulo saltaba al principio de la lista**. Ahora la posición solo se toca cuando llega, un cero explícito se respeta y un valor inválido se rechaza. |
| **R07** | Revisado y reforzado | La atestación es **telemetría**: nunca bloquea el acceso, por decisión del propietario, y así sigue. Pero el veredicto no era veraz: no comprobaba la **vigencia** de los certificados, no leía la **identidad de la aplicación** (una cadena legítima de otra app del mismo teléfono pasaba como propia) y no decía que la **revocación no se consulta**. Las tres cosas están corregidas y verificadas contra una cadena real de un dispositivo. |
| **R08** | Corregido | La comprobación de firmas confundía tres estados en uno y, pese a lo que decía su comentario, **se saltaba los ejecutables sin firma**. Ahora distingue amenaza comprobada, binario sin firma y comprobación no disponible; compara los campos CN/O del certificado en vez de una subcadena del asunto; y solo una firma que contradice al editor esperado cuenta como amenaza. Un sondeo que no se puede ejecutar ya no cuenta como «limpio». |

---

## 4. Hallazgos nuevos (segunda auditoría)

| Id | Estado | Descripción |
|---|---|---|
| **N01** | Documentado | El motor de documentos se carga desde `pdf-runtime/node_modules`, un directorio **fuera del repositorio** y sin declarar en `package.json`. En una copia limpia del proyecto ese motor no existe y sus 3 pruebas fallan. No es un fallo del producto en tu servidor (allí está instalado), pero sí impide validar esa parte en una instalación nueva. Requiere una decisión tuya: declararlo en el proyecto o documentar el paso de instalación. |
| **N02** | Corregido | El filtro de origen de `/api/video/:videoId/play` comparaba por subcadena: un sitio llamado `<tu-dominio>.ajeno.test` contenía tu dominio y pasaba; y `startsWith` dejaba pasar cualquier host que empezara igual que uno autorizado. Ahora se compara el host exacto o un subdominio real. |
| **N03** | Documentado | 16 pruebas del reproductor de PC fallaban **desde antes de esta auditoría** porque fijaban una pantalla de acceso anterior (un botón de Google eliminado, una cuenta atrás que ahora arranca tras el reintento automático y una API de solicitudes de registro que ya no existe). Se conservó la propiedad que comprobaban y se reescribieron contra el flujo vigente: **306/306**. |
| **N04** | Documentado | `EDU_MASTER_KEY` no está definida; la clave de cifrado de campos se deriva de `JWT_SECRET`. Rotar `JWT_SECRET` haría ilegible lo ya cifrado. No se tocó nada. |

**Comprobado y limpio** (sin hallazgos): inyección SQL en el servidor y en la
capa de datos —todas las consultas van parametrizadas y las cláusulas se arman
desde listas cerradas—; inyección de HTML en los dos paneles —todo el contenido
del servidor pasa por el escapador `h()`—; y las restricciones de navegación y
apertura de ventanas del reproductor.

---

## 5. Pruebas: antes y después

Cada bloque se midió en su propio entorno; **no se suman entre sí**.

### Servidor y capa de datos (VPS, PostgreSQL de QA real, motor de PDF real)

| | Pruebas | Pasan | Fallan |
|---|---|---|---|
| Antes (`b112d6c`) | 504 | 503 | 1 |
| Después | 557 | **557** | **0** |

El fallo anterior —«legacy document arrays remain byte-for-byte unchanged beside
new resources»— era **el mismo defecto F06** y ahora pasa. El resultado se
repitió tres veces seguidas para descartar intermitencias.

### Reproductor de PC (suite propia, Windows)

| | Pruebas | Pasan | Fallan |
|---|---|---|---|
| Antes | 306 | 290 | 16 |
| Después | 306 | **306** | **0** |

### Android (pruebas JVM reales, Gradle)

| | Pruebas | Pasan | Fallan |
|---|---|---|---|
| Antes | 26 | 26 | 0 |
| Después | 36 | **36** | **0** |

### Node en Windows sin base de datos

437 pruebas · 434 pasan · 3 fallan. Las 3 son las del motor de documentos
(N01): en este equipo no existe `pdf-runtime`. Con el motor real, en el
servidor, pasan.

### Verificación sobre el binario empaquetado (F04 y R04)

No basta con el código fuente: la corrección se comprobó dentro del paquete real.

- Se compiló el portable con `npm run build:win-portable`. La firma **VMP de
  Castlabs** se verificó durante la compilación: *«Signature is valid: streaming,
  1398 days left»*.
- Leyendo `main.js` **dentro del `app.asar` empaquetado**: contiene
  `const IS_DEV = !app.isPackaged && process.argv.includes('--dev')`, usa
  `safeStorage`, incluye la comparación por host exacto y los tres estados de la
  comprobación de firmas, y **no queda ninguna escritura de la sesión en texto
  plano**.
- Comportamiento: se ejecutó el binario **con `--dev` y sin él**. En los dos casos
  aparece la misma y única ventana «Iniciar sesión» y **no se abre ninguna ventana
  de herramientas de desarrollo**.

### Artefactos generados

| Archivo | Tamaño | SHA-256 |
|---|---|---|
| `EdulockSystems-Player-Portable-1.1.3.exe` | 92 458 687 B | `E733C117EF239893035B1BE73452DC72CBBA12B5ED79DB74F3DE2A4788600DAF` |

Firmas: la **VMP (Castlabs EVS)** está aplicada y verificada; la **Authenticode**
no, porque el certificado sigue pendiente de compra. Son firmas distintas y no se
sustituyen entre sí. El instalador (`Setup`) que hay en `dist/` es de una
compilación anterior y **no** incluye estas correcciones: habría que regenerarlo.

Estos artefactos **no se han publicado ni desplegado**.

### Antes y después de cada parche

Las regresiones nuevas se ejecutaron contra el commit anterior para demostrar
que fallaban:

- `test/auditoria-credenciales-documentos.test.js`: **3/35 pasaban antes**, 35/35 después. Las 3 que ya pasaban describen el contrato del servidor, que no cambió: son precisamente la razón por la que F01 era un fallo.
- `test/auditoria-borrado-proveedor-postgres.test.js`: **0/7 antes**, 7/7 después.
- `test/auditoria-mis-cursos-sondeo.test.js`: **2/6 antes**, 6/6 después. Las 2 que ya pasaban comprueban comportamiento que no estaba roto.
- F05 y F02 se reprodujeron además de forma directa sobre el código anterior, no solo por ausencia de la función nueva.

---

## 6. Migraciones, compatibilidad y reversión

**Migraciones** (aditivas, con `IF NOT EXISTS`, sin borrar ni transformar datos):

- `provider_deletions` — cola duradera de borrados en el servicio de video.
- `catalog.bunny_library_id` — biblioteca de cada clase (R01). Las filas
  existentes quedan en `NULL` y se resuelven como hasta ahora.

**Compatibilidad**

- Los tokens de administrador emitidos antes del cambio **se siguen aceptando
  hasta que caducan** (no llevan huella), para que la actualización no te expulse.
  Los emitidos después dejan de valer si cambias la contraseña.
- La sesión del reproductor de PC guardada en texto plano se migra a cifrada la
  primera vez que se lee; el alumno no nota nada.
- Los documentos en texto plano y los cifrados se leen igual.
- Si el sistema no ofrece almacén cifrado (Linux sin llavero), el reproductor
  conserva el comportamiento anterior y lo deja registrado.

**Reversión**: `git revert` de los commits de la rama, o simplemente no
fusionarla. Nada se desplegó. La única migración con efecto persistente son dos
objetos nuevos en la base que el código anterior ignora.

---

## 7. Qué queda pendiente y qué necesita una acción tuya

| Pendiente | Por qué | Quién |
|---|---|---|
| Regenerar el **instalador** (`Setup`) con estas correcciones | El portable ya está compilado y verificado; el instalador de `dist/` es anterior | Propietario, cuando decida publicar |
| Compilar y firmar el **APK** y probarlo en el teléfono | Hace falta el dispositivo conectado y la clave de firma | Propietario |
| Probar el borrado en cascada **contra Bunny real** | La cuenta de Bunny quedó deshabilitada al acabar la prueba gratuita | Propietario: reactivar o crear cuenta |
| Decidir qué hacer con `pdf-runtime` (N01) | Cambia cómo se instala el proyecto | Propietario |
| Decidir sobre `EDU_MASTER_KEY` (N04) | Afecta a claves maestras; no se toca sin tu orden | Propietario |
| Certificado de firma de código (Authenticode) | Sigue pendiente de compra | Propietario |
| **Despliegue** | La auditoría no autoriza desplegar | Propietario |

**No se declara** que el sistema esté libre de errores. Lo que se afirma es lo
que está en las tablas: los defectos confirmados están corregidos, cada uno con
una prueba que falla antes del parche y pasa después, y lo que no se pudo
verificar está dicho como pendiente, no como hecho.
