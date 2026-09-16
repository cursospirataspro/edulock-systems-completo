# Ofuscación del reproductor (subir el coste de ingeniería inversa)

La defensa MÁS fuerte ya la tienes: **la clave (CEK) no está en el binario** —
vive en tu servidor y se entrega online por sesión. Por más que descompilen el
reproductor, no encuentran la clave. La ofuscación es la **segunda capa**: convierte
el RE de "una tarde" en "días de un experto".

## Capa 1 — Ofuscar el JavaScript antes de empaquetar (gratis)

El código del reproductor (`main.js`, `preload.js`, `edu-native.js`, `renderer/*.js`)
va dentro de `app.asar` en texto. Ofuscarlo dificulta leerlo.

1. Instala la herramienta (una vez):
   ```
   npm i -D javascript-obfuscator
   ```
2. Antes de `electron-builder`, ofusca los `.js` de producción a una carpeta build:
   ```
   npx javascript-obfuscator main.js --output main.obf.js \
       --compact true --control-flow-flattening true \
       --string-array true --string-array-encoding base64 \
       --self-defending true
   ```
   (Repite para `preload.js`, `edu-native.js`, `renderer/player.js`.)
3. Empaqueta usando los `.obf.js`. Recomendado: hazlo en un script `prebuild` que
   copie los fuentes a `build/`, los ofusque ahí y apunte `main` a `build/main.js`,
   para no ofuscar tus fuentes de trabajo.

> Nota: NO ofusques `edu-native.js` de forma que rompa `crypto` — prueba que el
> reproductor sigue abriendo un `.edu` después de ofuscar.

## Capa 2 — Proteger el .exe (comercial, la más fuerte)

Los ejecutables de Electron son inspeccionables. Para elevar mucho el coste:

- **Themida** o **VMProtect** (Windows). Tras compilar con electron-builder,
  aplica el protector al `.exe` final (virtualización de código, anti-dump,
  anti-debug a nivel nativo):
  1. `npm run build:win` → genera `dist/EdulockSystems-Player-Setup-x.y.z.exe`
     y `dist/win-unpacked/Edulock Systems Player.exe`.
  2. Abre el `.exe` de `win-unpacked` con Themida/VMProtect, aplica el perfil
     (recomendado: Ultra + anti-debugger + anti-VM opcional) y guarda.
  3. Re-empaqueta el instalador con el `.exe` protegido, o distribuye el portable
     protegido.
- Firma de código (Authenticode) con tu certificado para evitar avisos de SmartScreen
  y dar integridad: configúralo en `electron-builder` (`win.certificateFile`).

## Capa 3 — Fuses de Electron (ya activadas)

`scripts/setup-fuses.js` (afterPack) ya endurece Electron:
- Deshabilita `--inspect`/debugging de Node en producción.
- Deshabilita `runAsNode`, cookie-encryption off, etc.
Verifica que sigue activo tras cualquier cambio de build.

## Recordatorio honesto
Nada de esto hace el binario "irrompible" (la guía §8 lo dice). El objetivo es que
romperlo cueste **más que comprar/re-grabar** el curso. Con clave server-side +
marca de agua + ofuscación, ya estás por encima de InfoProtector en lo que importa.
