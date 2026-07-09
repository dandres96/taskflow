FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Bake the latest server.js / public/* into /data/ so the persistent volume
# has them on first boot. Subsequent deploys use the release_command in
# fly.toml to keep /data/ in sync.
RUN mkdir -p /data/public /data/uploads && \
    cp server.js /data/server.js && \
    cp public/index.html /data/public/index.html && \
    cp public/soporte.html /data/public/soporte.html && \
    echo "Baked server.js and public/* into /data/"
EXPOSE 3000
# Use start.sh so the persistent volume /data can override /app/ at every boot.
# This is the autoclaw pattern: source of truth is /data/, image is the fallback.
CMD ["sh", "/app/start.sh"]