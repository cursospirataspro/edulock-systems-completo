# Firebase — 100% proyecto edulock-systems-oficial (sin Santana)

Todo el código quedó apuntando a **tu** proyecto real `edulock-systems-oficial`
(número de proyecto `61528672386`, cuenta `edulocksystemsoficial@gmail.com`).

## Qué quedó configurado (hecho)

| Componente | Valor | Estado |
|---|---|---|
| Config web (login Google/email) en `admin.html`, `remote-admin.html`, `served-admin.html`, `player-app/renderer/auth.html` | apiKey `AIzaSyASI4Qa_GVmylE4QjkkzTdSNxLt1NgXSu4`, senderId `61528672386`, appId `1:61528672386:web:742bd1ab09f2d47c900c9b` | ✅ |
| `google-services.json` (APK) | tu archivo oficial de Downloads (`edulock-systems-oficial`, `61528672386`) | ✅ |
| `.env` → `FIREBASE_PROJECT_ID` | `edulock-systems-oficial` | ✅ |
| Service account de Santana (`santana-fx-player-9b6f0`) | **eliminado** | ✅ |

Ya **no queda nada** apuntando a `santana-fx-player-9b6f0` ni al proyecto `635936221331`.

## Lo único que falta hacer TÚ (no se puede generar por código)

El backend necesita un **service account** para enviar notificaciones push (FCM).
Ese archivo contiene una clave privada y solo se genera desde tu consola:

1. Entra a la consola de Firebase → proyecto **edulock-systems-oficial**.
2. Rueda dentada (⚙️) → **Configuración del proyecto** → pestaña **Cuentas de servicio**.
3. Botón **"Generar nueva clave privada"** → se descarga un `.json`.
4. Renómbralo a **`firebase-service-account.json`** y ponlo en la raíz de esta carpeta
   (junto a `server.js`).

### Mientras tanto
- **El login SÍ funciona** ahora mismo (el servidor verifica los tokens con
  `FIREBASE_PROJECT_ID`, sin necesidad del service account).
- **Las notificaciones push NO se envían** hasta que pongas ese archivo.

> No subas `firebase-service-account.json` a ningún repositorio (ya está en `.gitignore`).
