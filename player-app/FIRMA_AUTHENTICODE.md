# Firma Authenticode del reproductor de PC (Setup y Portable)

Estado (17-sep-2026): el build **ya firma automáticamente** cuando existe un certificado de firma de código.
Se comprobó con un certificado temporal de prueba (nunca distribuido): `electron-builder` firmó el ejecutable,
el Setup NSIS y el Portable, y luego aplicó la firma VMP de Castlabs. Lo único que falta es un certificado
emitido por una Autoridad Certificadora a nombre de Edulock Systems; ese trámite solo puede hacerlo el propietario.

## 1. Qué comprar (elige una)

| Opción | Costo aproximado | Resultado en Windows |
|---|---|---|
| **Azure Trusted Signing** (Microsoft) | ~10 USD/mes | Firma reconocida; SmartScreen deja de avisar casi de inmediato |
| Certificado **OV** de firma de código (SSL.com, Sectigo, DigiCert, GlobalSign, Certum) | 100–300 USD/año | Firma reconocida; SmartScreen deja de avisar a medida que gana reputación |
| Certificado **EV** de firma de código | 250–500 USD/año, llave en token USB o HSM | Firma reconocida y reputación SmartScreen inmediata |

Desde 2023 todas las CA entregan la llave en hardware (token USB) o en un HSM en la nube; ya no se entrega un
`.pfx` simple salvo con Trusted Signing o firma en la nube del proveedor.

## 2. Cómo conectarlo al build (sin tocar código)

**A. Certificado en archivo `.pfx` (si la CA lo permite) o certificado de prueba:**

```powershell
$env:CSC_LINK = "C:\ruta\edulock-codesign.pfx"
$env:CSC_KEY_PASSWORD = "contraseña-del-pfx"
npm run build:win
```

**B. Certificado en token USB / almacén de Windows (OV/EV):** instala el certificado en el almacén del usuario y
en `package.json` → `build.win` añade el nombre exacto del sujeto:

```json
"win": { "signtoolOptions": { "publisherName": "Edulock Systems", "certificateSubjectName": "Edulock Systems" } }
```

**C. Azure Trusted Signing:** en `package.json` → `build.win` añade `"azureSignOptions"` con `endpoint`,
`certificateProfileName` y `codeSigningAccountName`, y exporta `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` antes de `npm run build:win` (soportado por electron-builder 26).

En los tres casos `electron-builder` firma con sello de tiempo, y después `scripts/sign-evs.js` aplica la firma VMP.

## 3. Cómo comprobar que quedó firmado

```powershell
Get-AuthenticodeSignature "player-app\dist\EdulockSystems-Player-Setup-1.1.2.exe" | Format-List Status, SignerCertificate
```

`Status` debe ser `Valid` y el sujeto del certificado, Edulock Systems. Con el certificado temporal de prueba el estado
fue `UnknownError` (firmado pero sin CA de confianza), que es lo esperado para una prueba de pipeline.

## 4. Qué NO hacer

- No distribuir instaladores firmados con un certificado autofirmado: Windows los trata igual que sin firma.
- No compartir el `.pfx` ni la contraseña por chat; se configuran en el equipo que compila.
