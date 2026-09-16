# Campus Digital Player — Reproductor Externo

Aplicación Electron que se registra como manejador del protocolo `cdp://` y reproduce
videos HLS protegidos de Edulock Systems sin exponer URLs reales al usuario.

---

## Flujo de uso

```
Campus web                        Reproductor externo
──────────────                    ───────────────────
POST /api/playback/generate-command
    → { playerUrl: "cdp://play?cmd=...&auth=..." }
                                  ← OS abre Campus Digital Player
                                  POST /api/playback/resolve { command }
                                      → { manifestUrl (temporal), watermarkText }
                                  HLS.js reproduce en memoria
```

El alumno **nunca ve la URL real** del CDN. La URL de manifiesto es temporal
(TTL configurado en el servidor) y lleva marca de agua forense.

---

## Requisitos

- Node.js >= 18
- npm >= 8
- (Para compilar instaladores): Wine en Linux/macOS para builds de Windows

---

## Instalación y desarrollo

```bash
# Dentro del directorio player-app/
cd player-app
npm install

# Ejecutar en modo desarrollo (abre DevTools)
npm run dev

# Ejecutar normalmente
npm start
```

### Configurar el servidor

Edita `config.json` o usa la interfaz dentro del reproductor:

```json
{
  "API_BASE": "https://tu-servidor.com"
}
```

---

## Compilar instaladores

```bash
# Windows (.exe NSIS installer) — solo en Windows o con Wine
npm run build:win

# macOS (.dmg) — solo en macOS
npm run build:mac

# Linux (.AppImage) — en Linux
npm run build:linux
```

Los instaladores se generan en `player-app/dist/`.

El instalador de Windows registra automáticamente el protocolo `cdp://` en el registro.
En Linux, el AppImage incluye el `desktop-entry` con el `MimeType=x-scheme-handler/cdp`.
En macOS, el DMG incluye el `Info.plist` con `CFBundleURLSchemes`.

---

## Registro del protocolo cdp:// en desarrollo

Para probar el protocolo `cdp://` sin instalar el reproductor, ejecuta:

```bash
npm run dev
```

Electron registra el protocolo automáticamente cuando se detecta el flag `--dev`.

Luego en el navegador o desde el campus puedes abrir:
```
cdp://play?cmd=TU_COMANDO_CIFRADO&auth=TU_JWT_TOKEN
```

---

## Estructura de archivos

```
player-app/
├── package.json       # Dependencias y configuración de electron-builder
├── config.json        # URL del servidor (editable por el usuario)
├── main.js            # Proceso principal de Electron
│                        - Registro del protocolo cdp://
│                        - Single instance lock
│                        - BrowserWindow
│                        - IPC handlers
├── preload.js         # contextBridge: expone window.cdpPlayer al renderer
└── renderer/
    ├── index.html     # UI del reproductor
    └── player.js      # Lógica de reproducción HLS + marca de agua + seguridad
```

---

## Seguridad

| Capa | Implementación |
|------|----------------|
| Comando cifrado | AES-256-GCM en el servidor, el token `cmd` no revela URLs |
| JWT de reproductor | 15 minutos de TTL, scope `player` |
| Anti-replay | Nonce único por sesión, registrado en SQLite |
| Marca de agua | 5 posiciones rotativas cada 12s, código CDP-XXXXX + fecha/hora |
| Sin DevTools en prod | `devTools: false` en `webPreferences` de producción |
| Sin Node en renderer | `nodeIntegration: false`, `sandbox: true`, `contextIsolation: true` |
| Sin menú contextual | Bloqueado sobre el elemento video |
| Sin navegación externa | `will-navigate` cancela todo lo que no sea `file://` |

---

## Notas de producción

- El token JWT del alumno (`playerToken`) tiene un TTL de 15 minutos y **no es renovable** desde el reproductor. Pasado ese tiempo la sesión se pausa y el alumno debe volver al campus para obtener un nuevo enlace.
- El servidor debe estar accesible desde la máquina del alumno (puede ser HTTPS en producción).
- Para builds de producción en Windows cambia el ícono en `assets/icon.ico`.
