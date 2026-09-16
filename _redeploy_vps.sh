#!/usr/bin/env bash
# =============================================================================
#  _redeploy_vps.sh — REDESPLIEGUE en la VPS de Edulock Systems
#
#  Qué hace (se ejecuta EN LA VPS, con sudo):
#   1. Detiene el servidor viejo (pm2).
#   2. Respalda la instalación anterior (código) en /opt/reproductor.bak.FECHA
#   3. Reemplaza el código de /opt/reproductor por ESTE (el nuevo), SIN tocar tu .env real.
#   4. Instala dependencias, arranca con pm2 y recarga nginx.
#
#  IMPORTANTE — antes de correrlo:
#   · Sube ESTE código nuevo a una carpeta de staging en la VPS (NO a /opt/reproductor),
#     por ejemplo con rsync desde tu PC:
#       rsync -avz --exclude node_modules --exclude 'player-app/dist' --exclude .git \
#         ./  usuario@TU_VPS:/home/usuario/edulock-new/
#   · Entra por SSH y ejecuta ESTE script DESDE esa carpeta de staging:
#       cd /home/usuario/edulock-new && sudo bash _redeploy_vps.sh
# =============================================================================
set -uo pipefail

APP_DIR="/opt/reproductor"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"     # esta carpeta (el código nuevo / staging)
TS="$(date +%Y%m%d-%H%M%S)"

echo "==> Redeploy Edulock Systems"
echo "    Origen (nuevo): $SRC_DIR"
echo "    Destino (app):  $APP_DIR"

if [ "$SRC_DIR" = "$APP_DIR" ]; then
  echo "!! Ejecuta este script desde la carpeta de STAGING, no desde $APP_DIR."
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then apt-get install -yq rsync; fi

# 1) Detener el server viejo — incluido cualquier pm2 de OTRO usuario (evita EADDRINUSE)
echo "==> [1/6] Deteniendo pm2 (reproductor)…"
pm2 stop reproductor 2>/dev/null || true
pm2 delete reproductor 2>/dev/null || true
# La instalación original configuró pm2 bajo el usuario 'reproductor' (arranca en boot)
# y ese proceso viejo seguiría ocupando el puerto 3000. Lo matamos si existe.
if id reproductor >/dev/null 2>&1; then
  sudo -u reproductor -H pm2 delete all 2>/dev/null || true
  sudo -u reproductor -H pm2 kill      2>/dev/null || true
fi
# Último recurso: si algo sigue escuchando en 3000, liberarlo.
PORT_PID="$(ss -ltnp 2>/dev/null | grep -oP ':3000\s.*pid=\K[0-9]+' | head -1 || true)"
if [ -n "${PORT_PID:-}" ]; then
  echo "   Liberando puerto 3000 (pid $PORT_PID)…"
  kill "$PORT_PID" 2>/dev/null || true
  sleep 1
fi

# 2) Respaldar la instalación anterior
if [ -d "$APP_DIR" ]; then
  echo "==> [2/6] Respaldo: ${APP_DIR}.bak.${TS}"
  cp -a "$APP_DIR" "${APP_DIR}.bak.${TS}"
  # Poda: conservar solo los 2 backups más recientes (evita llenar el disco).
  ls -1dt "${APP_DIR}".bak.* 2>/dev/null | tail -n +3 | while read -r old; do
    echo "   Podando backup viejo: $old"
    rm -rf "$old"
  done
else
  mkdir -p "$APP_DIR"
fi

# 3) Reemplazar el código (borra lo viejo) SIN tocar el .env real ni node_modules/logs
echo "==> [3/6] Desplegando código nuevo (conservando tu .env)…"
rsync -a --delete \
  --exclude '.env' --exclude '.env.bak' \
  --exclude 'node_modules' --exclude '.git' \
  --exclude 'player-app/node_modules' --exclude 'player-app/dist' \
  --exclude 'player-apk-android/app/build' \
  --exclude 'logs' \
  --exclude 'data' \
  "$SRC_DIR"/ "$APP_DIR"/

# .env: preservar el del servidor si existe; en primer deploy usar el del proyecto.
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$SRC_DIR/.env" ]; then
    cp "$SRC_DIR/.env" "$APP_DIR/.env"
    echo "   Se instaló el .env del proyecto (trae APP_SECRET/EDU_MASTER_KEY)."
    echo "!! EDITA $APP_DIR/.env: pon el DATABASE_URL que generó setup.sh (cat /root/edulock-db-url.txt)."
  else
    cp -n "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || true
    echo "!! No había .env. Se copió .env.example → .env. Edítalo con tus valores reales."
  fi
fi

# 4) Dependencias de producción
echo "==> [4/6] npm install --production…"
cd "$APP_DIR"
npm install --production --no-audit --no-fund

# 5) Arrancar / reiniciar con pm2
echo "==> [5/6] Arrancando con pm2…"
pm2 start ecosystem.config.js --env production 2>/dev/null || pm2 restart reproductor
pm2 save

# 6) Nginx — instala la config SOLO la 1ª vez.
#    Si ya existe (p.ej. certbot le añadió el bloque SSL 443), NO la pisamos:
#    sobreescribirla borraría los certificados y dejaría nginx sin HTTPS.
echo "==> [6/6] Nginx…"
if [ ! -f /etc/nginx/sites-available/reproductor ]; then
  cp -f "$APP_DIR/nginx.conf" /etc/nginx/sites-available/reproductor
  ln -sf /etc/nginx/sites-available/reproductor /etc/nginx/sites-enabled/reproductor
  # Quitar el sitio por defecto para que responda el nuestro.
  rm -f /etc/nginx/sites-enabled/default
  if nginx -t; then
    systemctl reload nginx
    echo "   Config nginx instalada (solo HTTP). Ahora corre certbot para el HTTPS:"
    echo "     certbot --nginx -d edulocksystemsoficial.dpdns.org"
  else
    echo "!! nginx -t falló: revisa la config antes de recargar."
  fi
else
  echo "   Config nginx ya existe → se conserva (no se toca lo de certbot/SSL)."
  if nginx -t; then systemctl reload nginx; else echo "!! nginx -t falló: revísalo."; fi
fi

echo ""
echo "==> LISTO. Verifica:"
echo "    pm2 logs reproductor      # arranque del servidor"
echo "    curl -s http://localhost:3000/api/health"
echo ""
echo "    Respaldo del anterior: ${APP_DIR}.bak.${TS}"
echo "    Si algo falla, restaura con: pm2 stop reproductor; rm -rf $APP_DIR; mv ${APP_DIR}.bak.${TS} $APP_DIR; cd $APP_DIR; pm2 start ecosystem.config.js --env production"
