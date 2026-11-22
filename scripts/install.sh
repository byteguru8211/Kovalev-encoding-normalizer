#!/usr/bin/env bash
# Installation of the FileLab service on Ubuntu 24.04.
# Run from the repository root:  sudo bash scripts/install.sh
# Re-runnable: replaces the installed release; data in /var/lib/filelab is kept.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install.sh" >&2
  exit 1
fi

VERSION="$(node -e 'process.stdout.write(require("'"$SRC_DIR"'/package.json").version)' 2>/dev/null || echo 1.0.0)"

echo "==> Checking Node.js 24"
if [[ ! -x /opt/node24/bin/node ]]; then
  echo "Node.js is not installed at /opt/node24." >&2
  echo "Install it first (see README 'Развёртывание с чистой ОС', step 2)." >&2
  exit 1
fi
NODE_MAJOR="$(/opt/node24/bin/node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "24" ]]; then
  echo "Expected Node.js major version 24, found $($(/opt/node24/bin/node --version))" >&2
  exit 1
fi
ln -sfn /opt/node24/bin/node /usr/local/bin/node
ln -sfn /opt/node24/bin/npm /usr/local/bin/npm

if [[ ! -d "$SRC_DIR/node_modules" ]]; then
  echo "==> Installing dependencies (npm ci)"
  (cd "$SRC_DIR" && npm ci --omit=dev)
fi

echo "==> Creating service user filelab"
if ! id filelab >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/filelab --shell /usr/sbin/nologin filelab
fi

echo "==> Deploying code to /opt/filelab and /var/www/filelab"
mkdir -p /opt/filelab
rsync -a --delete \
  --include 'server.mjs' --include 'worker.mjs' --include 'package.json' \
  --include 'package-lock.json' --include 'bin/***' --include 'src/***' \
  --include 'node_modules/***' --exclude '*' \
  "$SRC_DIR/" /opt/filelab/
echo "$VERSION" > /opt/filelab/VERSION

mkdir -p /var/www/filelab
rsync -a --delete "$SRC_DIR/public/" /var/www/filelab/

chown -R root:root /opt/filelab /var/www/filelab
chmod -R u+rwX,go+rX,go-w /opt/filelab /var/www/filelab

echo "==> Preparing data directory /var/lib/filelab"
mkdir -p /var/lib/filelab/jobs
chown -R filelab:filelab /var/lib/filelab
chmod 0750 /var/lib/filelab

echo "==> Installing configuration and systemd units"
install -m 0644 "$SRC_DIR/deploy/filelab.env" /etc/filelab.env
install -m 0644 "$SRC_DIR/deploy/filelab-api.service" /etc/systemd/system/filelab-api.service
install -m 0644 "$SRC_DIR/deploy/filelab-worker.service" /etc/systemd/system/filelab-worker.service
systemctl daemon-reload
systemctl enable --now filelab-api filelab-worker
systemctl restart filelab-api filelab-worker

echo "==> Configuring Nginx"
install -m 0644 "$SRC_DIR/deploy/nginx-filelab" /etc/nginx/sites-available/filelab
ln -sfn /etc/nginx/sites-available/filelab /etc/nginx/sites-enabled/filelab
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Waiting for the API to answer"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:3000/api/health
echo
curl -fsS http://127.0.0.1/api/health
echo

echo "==> Installation finished (version $VERSION)"
systemctl status filelab-api filelab-worker nginx --no-pager -n 0 | head -30
