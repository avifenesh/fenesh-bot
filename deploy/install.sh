#!/usr/bin/env bash
# install.sh - set up or update fenesh-bot on an Ubuntu 24.04 host (run as root on the host).
# Usage: deploy/install.sh <path-to-release-tarball>
# The env file /etc/fenesh-bot/env (0600, owner fenesh) must be copied separately; see .env.example.
set -euo pipefail
TARBALL=${1:?usage: install.sh <release.tar.gz>}
NODE_VERSION=${NODE_VERSION:-24.11.1}
UV_VERSION=${UV_VERSION:-0.11.7}

id fenesh >/dev/null 2>&1 || useradd --system --home /var/lib/fenesh-bot --shell /usr/sbin/nologin fenesh
install -d -o fenesh -g fenesh -m 0750 /var/lib/fenesh-bot
install -d -o root -g fenesh -m 0750 /etc/fenesh-bot

# Node: official binary, pinned. Strip-types needs Node >= 23.6.
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  arch=$(uname -m); [ "$arch" = x86_64 ] && arch=x64; [ "$arch" = aarch64 ] && arch=arm64
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi

# Valkey on loopback with an append-only log so queued jobs survive restarts.
if ! command -v valkey-server >/dev/null; then
  apt-get update -qq && apt-get install -y -qq valkey-server || apt-get install -y -qq valkey
fi
conf=$(ls /etc/valkey/valkey.conf 2>/dev/null || true)
if [ -n "$conf" ]; then
  sed -i -E 's/^#? ?bind .*/bind 127.0.0.1 -::1/; s/^appendonly .*/appendonly yes/; s/^#? ?maxmemory .*/maxmemory 512mb/' "$conf"
  grep -q '^appendonly yes' "$conf" || echo 'appendonly yes' >> "$conf"
  systemctl enable --now valkey-server
  systemctl restart valkey-server
fi

# Code: replace /opt/fenesh-bot atomically, keep data and env outside it.
rm -rf /opt/fenesh-bot.new && mkdir -p /opt/fenesh-bot.new
tar -xzf "$TARBALL" -C /opt/fenesh-bot.new
(cd /opt/fenesh-bot.new && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund)
rm -rf /opt/fenesh-bot.old; [ -d /opt/fenesh-bot ] && mv /opt/fenesh-bot /opt/fenesh-bot.old
mv /opt/fenesh-bot.new /opt/fenesh-bot
chown -R root:fenesh /opt/fenesh-bot && chmod -R g+rX,o-rwx /opt/fenesh-bot

# LAYA sidecar: Python env from sidecar/uv.lock (CPU torch) in a venv that outlives code updates,
# weights in the bot's data dir. uv only syncs what changed.
if ! /usr/local/bin/uv --version 2>/dev/null | grep -q "uv ${UV_VERSION}"; then
  curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi
# The venv holds no secrets and must be readable by the sidecar's dynamic user.
install -d -o root -g root -m 0755 /opt/fenesh-laya
(cd /opt/fenesh-bot/sidecar && UV_PROJECT_ENVIRONMENT=/opt/fenesh-laya/venv UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/bin/python3.12 \
  /usr/local/bin/uv sync --frozen --no-dev --no-install-project)
chmod -R a+rX /opt/fenesh-laya

# Swap as a cushion: the sidecar holds about 2 GB and the host may have only 4 GB.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 0644 /opt/fenesh-bot/deploy/fenesh-laya.service /etc/systemd/system/fenesh-laya.service
install -m 0644 /opt/fenesh-bot/deploy/fenesh-bot.service /etc/systemd/system/fenesh-bot.service
systemctl daemon-reload
if [ -f /etc/fenesh-bot/env ]; then
  [ -f /etc/fenesh-bot/laya.env ] || { echo "missing /etc/fenesh-bot/laya.env (push.sh writes it)" >&2; exit 1; }
  systemctl enable fenesh-laya fenesh-bot
  systemctl restart fenesh-laya
  # First start downloads the pinned weights; wait for health before the worker starts asking.
  for _ in $(seq 1 90); do curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1 && break; sleep 10; done
  curl -fsS http://127.0.0.1:8790/health >/dev/null || echo "warning: LAYA sidecar not healthy yet; the bot runs without its vote until it is"
  systemctl restart fenesh-bot
  systemctl --no-pager status fenesh-laya fenesh-bot | grep -E '^(●|\s+Active:)'
else
  echo "env file /etc/fenesh-bot/env missing; service installed but not started"
fi
