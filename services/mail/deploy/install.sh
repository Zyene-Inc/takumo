#!/usr/bin/env bash
# Runs ON THE VM, started by scripts/deploy-mail.sh after it copied
# services/mail to /opt/takumo: Caddy site, firewall, certificate paths,
# docker compose up, health check. Safe to run again.
set -euo pipefail
ENV_FILE=/etc/takumo/mail.env
RUNTIME_ENV=/etc/takumo/mail-runtime.env
CERTS=/var/lib/caddy/.local/share/caddy/certificates

sudo test -f "$ENV_FILE" || {
  echo "Missing $ENV_FILE (INBOUND_EMAIL_SECRET, WEBHOOK_URL, MAIL_DOMAINS, MAIL_HOSTNAME)"
  exit 1
}
MAIL_HOSTNAME="$(sudo sed -n 's/^MAIL_HOSTNAME=//p' "$ENV_FILE" | tail -1 | tr -d "\"' \r")"
[ -n "$MAIL_HOSTNAME" ] || { echo "Set MAIL_HOSTNAME in $ENV_FILE (e.g. mx.in.takumo.ai)"; exit 1; }

# Caddy: one file per site under /etc/caddy/sites, imported by the main
# Caddyfile (scripts/deploy-engine.sh writes engine.caddy the same way). A main
# Caddyfile from before this layout holds the engine's site: keep it.
sudo mkdir -p /etc/caddy/sites
if ! sudo grep -qx 'import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  if sudo test -s /etc/caddy/Caddyfile && ! sudo test -e /etc/caddy/sites/engine.caddy; then
    sudo cp /etc/caddy/Caddyfile /etc/caddy/sites/engine.caddy
  fi
  printf 'import /etc/caddy/sites/*.caddy\n' | sudo tee /etc/caddy/Caddyfile >/dev/null
fi
# Caddy only needs the site to obtain and renew the MX host's certificate.
printf '%s {\n\trespond "Takumo inbound mail" 200\n}\n' "$MAIL_HOSTNAME" |
  sudo tee /etc/caddy/sites/mail.caddy >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl reload caddy

# TCP 25: Oracle's Ubuntu image ends INPUT with a REJECT rule, so insert above it.
if ! sudo iptables -C INPUT -m state --state NEW -p tcp --dport 25 -j ACCEPT 2>/dev/null; then
  POS="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
  if [ -n "$POS" ]; then
    sudo iptables -I INPUT "$POS" -m state --state NEW -p tcp --dport 25 -j ACCEPT
  else
    sudo iptables -A INPUT -m state --state NEW -p tcp --dport 25 -j ACCEPT
  fi
  sudo netfilter-persistent save
fi

# Wait for Caddy's certificate (needs DNS for MAIL_HOSTNAME and ports 80/443).
echo "Waiting for Caddy's certificate for $MAIL_HOSTNAME..."
CRT=""
for _ in $(seq 1 24); do
  CRT="$(sudo find "$CERTS" -path "*/$MAIL_HOSTNAME/$MAIL_HOSTNAME.crt" 2>/dev/null | head -1 || true)"
  [ -n "$CRT" ] && break
  sleep 5
done
if [ -z "$CRT" ]; then
  # Start without STARTTLS; the container picks the files up when they appear.
  echo "No certificate yet (check DNS and 'journalctl -u caddy'); starting without STARTTLS for now."
  CRT="$CERTS/acme-v02.api.letsencrypt.org-directory/$MAIL_HOSTNAME/$MAIL_HOSTNAME.crt"
fi
REL="${CRT#"$CERTS"/}"

# The container runs as the caddy user (never root) so it can read the key.
{
  echo "MAIL_UID=$(id -u caddy)"
  echo "MAIL_GID=$(id -g caddy)"
  echo "CADDY_CERTS_DIR=$CERTS"
  echo "TLS_CERT_FILE=/certs/$REL"
  echo "TLS_KEY_FILE=/certs/${REL%.crt}.key"
} | sudo tee "$RUNTIME_ENV" >/dev/null
sudo chmod 600 "$RUNTIME_ENV"

# Docker would create a missing mount source as root, which Caddy can't write to.
sudo test -d "$CERTS" || sudo install -d -o caddy -g caddy -m 700 "$CERTS"

cd /opt/takumo/services/mail/deploy
sudo docker compose --env-file "$ENV_FILE" --env-file "$RUNTIME_ENV" up -d --build
sudo docker image prune -f >/dev/null

echo "Checking http://127.0.0.1:2526/health on the VM..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:2526/health; then
    echo
    exit 0
  fi
  sleep 2
done
echo "The mail receiver didn't answer on 127.0.0.1:2526/health" >&2
sudo docker compose --env-file "$ENV_FILE" --env-file "$RUNTIME_ENV" logs --tail 50 >&2 || true
exit 1
