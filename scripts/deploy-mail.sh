#!/usr/bin/env bash
# Deploy the inbound mail receiver (services/mail) to the VM over SSH, next to
# the engine (see services/mail/README.md):
#
#   MAIL_HOST=ubuntu@<ip> scripts/deploy-mail.sh
#
# MAIL_SSH_KEY picks the key (default ~/.ssh/takumo_oracle). The host needs
# Docker, Caddy and /etc/takumo/mail.env with INBOUND_EMAIL_SECRET, WEBHOOK_URL,
# MAIL_DOMAINS and MAIL_HOSTNAME (the MX host, e.g. mx.in.takumo.ai).
#
# It copies services/mail, opens TCP 25 in iptables, gives Caddy a site for
# MAIL_HOSTNAME (so Caddy obtains and renews its certificate, which the
# container reads for STARTTLS), rebuilds and restarts the container, and
# checks its health endpoint.
set -euo pipefail

: "${MAIL_HOST:?Set MAIL_HOST, e.g. ubuntu@143.47.98.0}"
KEY="${MAIL_SSH_KEY:-$HOME/.ssh/takumo_oracle}"
SSH=(ssh -i "$KEY" "$MAIL_HOST")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Copying services/mail to $MAIL_HOST..."
"${SSH[@]}" 'sudo mkdir -p /opt/takumo && sudo chown "$USER" /opt/takumo'
rsync -az --delete -e "ssh -i $KEY" \
  --exclude 'node_modules' --exclude 'dist' --exclude 'dist-test' \
  --relative "$ROOT/./services/mail" \
  "$MAIL_HOST:/opt/takumo/"

echo "Configuring Caddy and the firewall, building and starting it..."
"${SSH[@]}" "bash /opt/takumo/services/mail/deploy/install.sh"
echo "Deployed. Test it with swaks (services/mail/README.md)."
