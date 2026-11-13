#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEPLOY_HOST:=dorfspy}"
test -f .env || { echo 'Missing .env' >&2; exit 1; }
# Dedicated directory and account; all other sites and their Caddy configuration are preserved.
ssh "$DEPLOY_HOST" 'set -eu
  if ss -H -tln "sport = :3270" | grep -q . && ! systemctl is-active --quiet videomaker; then echo "Port 3270 is already in use" >&2; exit 1; fi
  id videomaker >/dev/null 2>&1 || useradd --system --home-dir /opt/videomaker --shell /usr/sbin/nologin videomaker
  install -d -m 0755 /opt/videomaker
  install -d -o videomaker -g videomaker -m 0700 /var/lib/videomaker
  install -m 0600 /dev/null /etc/videomaker.env.new'
rsync -az --delete --exclude=.git --exclude=node_modules --exclude=.next --exclude=.env --exclude='data/' --exclude='*.log' ./ "$DEPLOY_HOST:/opt/videomaker/"
scp -q .env "$DEPLOY_HOST:/etc/videomaker.env.new"
ssh "$DEPLOY_HOST" 'set -eu
  # The server service selects its own persistent DATA_DIR.
  sed -i "/^DATA_DIR=/d" /etc/videomaker.env.new
  install -o root -g videomaker -m 0640 /etc/videomaker.env.new /etc/videomaker.env
  rm /etc/videomaker.env.new
  cd /opt/videomaker
  npm ci --no-audit --no-fund
  npm run build
  chown -R videomaker:videomaker /opt/videomaker
  install -m 0644 deploy/videomaker.service /etc/systemd/system/videomaker.service
  systemctl daemon-reload
  systemctl enable --now videomaker
  systemctl restart videomaker
  for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3270/api/health >/dev/null && break; sleep 1; done
  curl -fsS http://127.0.0.1:3270/api/health >/dev/null
  install -m 0644 deploy/videomaker.caddy /etc/caddy/videomaker.caddy
  cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.videomaker-backup
  if ! grep -Fxq "import /etc/caddy/videomaker.caddy" /etc/caddy/Caddyfile; then printf "\nimport /etc/caddy/videomaker.caddy\n" >> /etc/caddy/Caddyfile; fi
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then cp -a /etc/caddy/Caddyfile.videomaker-backup /etc/caddy/Caddyfile; exit 1; fi
  if ! systemctl reload caddy; then cp -a /etc/caddy/Caddyfile.videomaker-backup /etc/caddy/Caddyfile; systemctl reload caddy || true; exit 1; fi
  systemctl is-active --quiet caddy
  echo "Deployment completed."
'
