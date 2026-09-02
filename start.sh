#!/bin/sh
# Start script - syncs source files from /data/ (persistent) to /app/ (ephemeral)
# then starts the node server.
# This ensures that updates to server.js, index.html, and soporte.html survive restarts.

echo "[start.sh] Syncing source files from /data/ to /app/..."

# Las credenciales de Cloudflare R2 vienen de `fly secrets`, no de aqui: este
# fichero esta commiteado en un repo publico y las llaves que habia escritas a
# mano quedaron expuestas en la historia de git. Ver DEPLOY.md.
#   fly secrets set R2_ACCOUNT_ID=... R2_ACCESS_KEY=... R2_SECRET_KEY=... \
#     R2_BUCKET=... R2_PUBLIC_URL=... --app taskflow-cwti
if [ -z "$R2_ACCESS_KEY" ]; then
  echo "[start.sh] AVISO: R2 sin configurar; la subida de imagenes y videos de tickets quedara deshabilitada."
fi

# Ensure /data/public exists
mkdir -p /data/public

# Sync server.js
if [ -f /data/server.js ]; then
  cp /data/server.js /app/server.js
  echo "[start.sh] Synced server.js"
else
  echo "[start.sh] WARNING: /data/server.js not found, using bundled version"
fi

# Sync public/index.html (FIXED: was /data/index.html, should be /data/public/index.html)
if [ -f /data/public/index.html ]; then
  cp /data/public/index.html /app/public/index.html
  echo "[start.sh] Synced index.html"
else
  echo "[start.sh] WARNING: /data/public/index.html not found, using bundled version"
fi

# Sync public/soporte.html
if [ -f /data/public/soporte.html ]; then
  cp /data/public/soporte.html /app/public/soporte.html
  echo "[start.sh] Synced soporte.html"
fi

# Sync package.json (for new deps)
if [ -f /data/package.json ]; then
  cp /data/package.json /app/package.json
  echo "[start.sh] Synced package.json"
fi

# Ensure uploads dir
mkdir -p /data/uploads

# Install npm packages if needed
if [ -f /app/package.json ]; then
  if [ ! -d /app/node_modules ] || [ /app/package.json -nt /app/node_modules ]; then
    echo "[start.sh] Installing npm packages..."
    cd /app && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
  fi
fi

echo "[start.sh] Starting server..."
cd /app
# Use exec so node becomes PID 1 (important for proper signal handling
# and for 'fly machine restart' / 'kill 1' to work cleanly).
exec node server.js
