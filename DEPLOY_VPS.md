# Redespliegue en la VPS de Edulock Systems

Guía para **borrar lo que estaba** en la VPS y **desplegar este código nuevo**.
Dominio: `edulocksystemsoficial.dpdns.org` · App dir: `/opt/reproductor` · pm2: `reproductor`.

> Yo dejo todo preparado; **la conexión a tu VPS la haces tú** (SSH). Nada de esto toca
> tu VPS hasta que tú corras los comandos.

---

## Resumen del flujo
1. Subir este código a una carpeta de *staging* en la VPS.
2. Correr `_redeploy_vps.sh` (respalda lo viejo → despliega lo nuevo → pm2 → nginx).
3. Poner los valores reales en `.env`.
4. Configurar tu Bunny Storage en el panel.
5. SSL con certbot.

---

## 0) Requisitos en la VPS (solo la 1ª vez)
Si la VPS ya tenía Edulock corriendo, ya tiene Node/pm2/nginx/PostgreSQL y **te saltas esto**.
Si es una VPS limpia, corre una vez el instalador base:
```bash
sudo bash setup.sh    # instala Node 20, ffmpeg, pm2, nginx, certbot y crea /opt/reproductor
```

## 1) Subir el código nuevo a staging (desde tu PC Windows)
Usa **Git Bash / WSL** (traen `rsync`) o **WinSCP** (arrastrar la carpeta).
Con rsync (recomendado), desde la carpeta del proyecto:
```bash
rsync -avz --exclude node_modules --exclude 'player-app/node_modules' \
      --exclude 'player-app/dist' --exclude '.git' --exclude 'player-apk-android/app/build' \
      ./  USUARIO@TU_VPS_IP:/home/USUARIO/edulock-new/
```
(Reemplaza `USUARIO` y `TU_VPS_IP`.)

## 2) Redesplegar (en la VPS, por SSH)
```bash
ssh USUARIO@TU_VPS_IP
cd /home/USUARIO/edulock-new
sudo bash _redeploy_vps.sh
```
El script:
- detiene el server viejo,
- **respalda** `/opt/reproductor` en `/opt/reproductor.bak.FECHA`,
- reemplaza el código por el nuevo **sin tocar tu `.env` real**,
- `npm install --production`, `pm2 start`, y recarga nginx.

## 3) Configurar `.env` con valores REALES
`setup.sh` ya creó la base de datos y dejó el `DATABASE_URL` listo. Cópialo:
```bash
cat /root/edulock-db-url.txt      # → postgresql://edulock:XXXX@localhost:5432/campus_drm
```
Edita `/opt/reproductor/.env` y pon ese valor + el resto:
```bash
DATABASE_URL=postgresql://edulock:LA_QUE_SALIO@localhost:5432/campus_drm
PUBLIC_URL=https://edulocksystemsoficial.dpdns.org
JWT_SECRET=...(64+ hex)...
ADMIN_USER=tu-correo   ADMIN_PASS=tu-clave-fuerte
EDU_MASTER_KEY=...(genera: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")...
APP_SECRET=...(debe coincidir con el del reproductor)...
FIREBASE_PROJECT_ID=edulock-systems-oficial
# BUNNY: mejor configúralo desde el panel (paso 4)
```
> **EDU_MASTER_KEY**: si algún día la cambias, los `.edu` viejos dejan de abrir. Genérala UNA vez.
> Para **push (FCM)** coloca también `firebase-service-account.json` (ver `FIREBASE_SETUP.md`).

Reinicia tras editar:
```bash
pm2 restart reproductor && pm2 save
pm2 logs reproductor            # verifica que arranca sin errores
curl -s http://localhost:3000/api/health
```

## 4) Bunny Storage (para los `.edu`)
En el panel admin → **Licencias y Ventas → Tu Bunny Storage**: pega Storage Zone,
AccessKey (Password), Host (`storage.bunnycdn.com`) y Pull zone (`https://tu-zona.b-cdn.net`).
(Recuerda tener saldo en Bunny.)

## 5) SSL (HTTPS)
```bash
sudo certbot --nginx -d edulocksystemsoficial.dpdns.org
```
(Asegúrate de que el dominio apunte a la IP de la VPS antes de esto.)

## 6) Probar de punta a punta
1. Entra a `https://edulocksystemsoficial.dpdns.org/admin` (tu panel).
2. Crea un **productor** (Productores) → te da correo+clave.
3. Entra a `/productor` con esa clave → sube un video de prueba → genera su **sublink**.
4. Compila el reproductor (`cd player-app && npm run build:win`), instálalo y abre el sublink.

---

## Rollback (si algo sale mal)
```bash
pm2 stop reproductor
sudo rm -rf /opt/reproductor
sudo mv /opt/reproductor.bak.FECHA /opt/reproductor
cd /opt/reproductor && pm2 start ecosystem.config.js --env production && pm2 save
```

## Notas
- El servidor crea/actualiza las **tablas solo** al arrancar (incluye lo nuevo: `.edu`,
  productores, lotes, etc.). No necesitas migraciones manuales.
- La VPS ahora es **ligera**: solo mueve claves/permisos (KB); los videos (GB) los sirve Bunny.
- Borra `player-app/dist/` viejo antes de recompilar el reproductor (build con marca anterior).
