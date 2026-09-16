# DRM propio `.edu` — Edulock (basado en la guía DRM)

Sistema de protección de video con formato cifrado propio `.edu`, **usando Bunny**
como almacenamiento/CDN y el servidor de Edulock como servidor de claves online.

## Cómo funciona (resumen)

```
  TÚ (offline)                         BUNNY                 SERVIDOR EDULOCK           ALUMNO (navegador)
  mp4 --> empaquetar.py --> .edu  -->  (almacena .edu)       /api/edu/register          /edu-player?c=<id>
                                                             /api/edu/key   (CEK online) --> descifra con
                                                             /api/edu/data  (proxy .edu)      WebCrypto y reproduce
```

- **Clave por video** derivada de un `MASTER_KEY` del servidor: `CEK = HKDF(MASTER_KEY, salt, content_id)`.
  El servidor la re-deriva por sesión y **nunca la almacena ni la mete en el reproductor**
  (corrige el "error de la clave global fija" del `.ipr`).
- **Cifrado multicapa** (guía §6), todo con primitivas estándar y auditadas:
  1. Cada trozo de 8 KB → **AES-256-GCM** con subclave `HKDF(CEK,"chunk"||i)`.
  2. Todo el cuerpo → **AES-256-CTR** de transporte (obfuscación; nativo en WebCrypto).
  3. Cabecera JSON → **AES-256-GCM**. Contenedor → **HMAC-SHA256** final (integridad).
- **Marca de agua por comprador**: el servidor incrusta el correo del alumno en la respuesta de clave;
  el reproductor la pinta en movimiento.
- **Entrega online por sesión** (guía Opción C): la clave se pide en cada reproducción validando licencia;
  revocación instantánea (usa el mismo `studentAccessRevoked` que el resto).

## Uso

### 1) Empaquetar un video (offline, en tu PC)
```bash
cd drm-edu
python empaquetar.py entrada.mp4 salida.edu \
    --content-id curso03-modulo3 \
    --title "Módulo 3" \
    --master <EDU_MASTER_KEY del .env>
```
Salida: `salida.edu` + el `salt`. (El `.edu` **no** contiene la clave.)

### 2) Subir `salida.edu` a Bunny
Súbelo a tu Storage/Stream de Bunny y copia su URL (debe ser un dominio Bunny:
`*.b-cdn.net`, `*.bunnycdn.com` o `*.mediadelivery.net`).

### 3) Registrar en el servidor (una vez por video)
```
POST /api/edu/register        (auth admin)
{ "contentId":"curso03-modulo3", "salt":"<hex del paso 1>",
  "bunnyUrl":"https://...b-cdn.net/.../salida.edu",
  "title":"Módulo 3", "courseId":"<id del curso>", "watermark":"buyer:{ID_COMPRADOR}" }
```
`courseId`/`videoId` sirven para que la licencia/acceso del alumno autorice el contenido.

### 4) El alumno reproduce
**Modelo InfoProtector (reproductor de escritorio Electron) — principal:**
El alumno abre un enlace de clase (`cdp://…`) → arranca el reproductor de escritorio →
la 1ª vez pide el serial y vincula el dispositivo (flujo de activación ya existente) →
`resolve`/`resolve-perm` detecta que el video está migrado a `.edu` y devuelve
`sourceType:'edu'` → el proceso principal **descarga el `.edu` de Bunny, lo descifra en
RAM** (nunca toca el disco) y lo reproduce vía el protocolo `edu://` con marca de agua.

Para que un video use `.edu`, regístralo con su `videoId` del catálogo (paso 3, campo
`videoId`), o desde el panel: **Licencias y Ventas → Contenido protegido (.edu)**.

**Reproductor web (alternativa):** `/edu-player?c=curso03-modulo3&token=<JWT del alumno>`
(o guarda el JWT en `localStorage.edulock_token`).

## Endpoints del servidor
| Método | Ruta | Auth | Función |
|---|---|---|---|
| POST | `/api/edu/register` | admin | Registra un `.edu` (salt + url Bunny) |
| GET  | `/api/edu/list` | admin | Lista contenidos registrados |
| DELETE | `/api/edu/:contentId` | admin | Elimina un registro |
| POST | `/api/edu/key` | alumno | Entrega la CEK online (valida licencia) |
| GET  | `/api/edu/data/:contentId` | alumno | Proxy del `.edu` desde Bunny (con Range) |

## Verificación
El pipeline completo está probado: empaquetador (Python) → derivación de clave en el
servidor (Node) → descifrado en el navegador (WebCrypto) recuperan el mp4 **byte-idéntico**.
`desempaquetar_ref.py` es un descifrador de referencia para validar `.edu` sueltos.

## Endurecimiento pendiente (guía §7, §8) — opcional
- **MSE + fMP4**: hoy el reproductor web descifra el mp4 completo a memoria (Blob). Para que el
  mp4 no exista nunca entero, migrar a Media Source Extensions alimentado por el lector bajo
  demanda (descifrar solo el trozo que pide el decodificador). Requiere video fragmentado (fMP4).
- **Envoltura de clave por sesión (ECDH)**: hoy la CEK viaja por HTTPS gated por JWT (igual que
  `/api/drm/key`). Se puede envolver con una clave de sesión ECDH para que no viaje "en claro".
- **App de escritorio (Ruta 1)** con FFmpeg + lector bajo demanda para consumo offline.

> Recordatorio de la guía §3: ningún DRM local es invulnerable (los frames descodificados
> siempre existen en la máquina del alumno). El valor real está en: clave online + marca de
> agua por comprador + subir el coste del ataque. Eso ya está cubierto aquí.
