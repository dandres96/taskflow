#!/bin/sh
# Start script - syncs source files from /data/ (persistent) to /app/ (ephemeral)
# then starts the node server.
# This ensures that updates to server.js, index.html, and soporte.html survive restarts.

echo "[start.sh] Syncing source files from /data/ to /app/..."

# Cloudflare R2 credentials (baked in - rotate from Cloudflare if compromised)
export R2_ACCOUNT_ID="3b368df3ee1171990226c6a9c88a2813"
export R2_ACCESS_KEY="fe23529cc663b1dc517ba5c93380eefc"
export R2_SECRET_KEY="67bf0bf7e0781ea3551d10578974efa88fd644f8dda11af550e566afce01f59d"
export R2_BUCKET="taskflow-videos"
export R2_PUBLIC_URL="https://pub-39a33a2f04d14e7faa2f5e49103a6072.r2.dev"

# Ensure /data/public exists
mkdir -p /data/public

# Sync server.js
if [ -f /data/server.js ]; then
  cp /data/server.js /app/server.js
  echo "[start.sh] Synced server.js"
else
  echo "[start.sh] WARNING: /data/server.js not found, using bundled version"
fi

# Sync public/index.html
if [ -f /data/index.html ]; then
  cp /data/index.html /app/public/index.html
  echo "[start.sh] Synced index.html"
fi

# Sync public/soporte.html
if [ -f /data/soporte.html ]; then
  cp /data/soporte.html /app/public/soporte.html
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
node server.js
