#!/usr/bin/env bash
# Deploy the scheduling engine to a VM over SSH (docs/DEPLOY.md step 4):
# copies the engine and the seed it reads, then rebuilds and restarts it.
#
#   ENGINE_HOST=ubuntu@<ip> ENGINE_DOMAIN=<host name> scripts/deploy-engine.sh
#
# ENGINE_SSH_KEY picks the key (default ~/.ssh/takumo_oracle). The host needs
# Docker, Caddy and /etc/takumo/engine.env with ENGINE_SECRET=...
set -euo pipefail

: "${ENGINE_HOST:?Set ENGINE_HOST, e.g. ubuntu@143.47.98.0}"
: "${ENGINE_DOMAIN:?Set ENGINE_DOMAIN, e.g. 143-47-98-0.sslip.io}"
KEY="${ENGINE_SSH_KEY:-$HOME/.ssh/takumo_oracle}"
SSH=(ssh -i "$KEY" "$ENGINE_HOST")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Copying the engine to $ENGINE_HOST..."
"${SSH[@]}" 'sudo mkdir -p /opt/takumo && sudo chown "$USER" /opt/takumo'
rsync -az --delete -e "ssh -i $KEY" \
  --exclude '.venv' --exclude '__pycache__' --exclude '.pytest_cache' \
  --relative "$ROOT/./services/engine" "$ROOT/./seed/acme-precision" \
  "$ENGINE_HOST:/opt/takumo/"

echo "Building and starting it..."
"${SSH[@]}" "set -e
  sudo test -f /etc/takumo/engine.env || { echo 'Missing /etc/takumo/engine.env (ENGINE_SECRET=...)'; exit 1; }
  cd /opt/takumo/services/engine/deploy
  sudo docker compose --env-file /etc/takumo/engine.env up -d --build
  sudo docker image prune -f >/dev/null
  # One file per site, imported by the main Caddyfile, so other services
  # (scripts/deploy-mail.sh) can add their own sites next to the engine's.
  sudo mkdir -p /etc/caddy/sites
  printf '%s {\n\treverse_proxy 127.0.0.1:8000\n}\n' '$ENGINE_DOMAIN' | sudo tee /etc/caddy/sites/engine.caddy >/dev/null
  printf 'import /etc/caddy/sites/*.caddy\n' | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl reload caddy"

echo "Checking https://$ENGINE_DOMAIN/health..."
for _ in $(seq 1 30); do
  if curl -fsS "https://$ENGINE_DOMAIN/health"; then
    echo
    exit 0
  fi
  sleep 5
done
echo "The engine didn't answer on https://$ENGINE_DOMAIN/health" >&2
exit 1
