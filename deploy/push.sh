#!/usr/bin/env bash
# push.sh - ship the current commit to a host and (re)install fenesh-bot there.
# Usage: deploy/push.sh <ssh-target> [env-file]
#   env-file defaults to building one from ~/.config/metaculus/bot.env, ~/.config/tiyuvta/bedrock.env
#   and ~/.config/asknews/env, plus a fresh LAYA sidecar key
# The env file is copied with mode 0640 root:fenesh, the sidecar's key alone to laya.env (0600 root),
# and neither is ever stored in the repo or the tarball.
set -euo pipefail
HOST=${1:?usage: push.sh <ssh-target> [env-file]}
ENV_FILE=${2:-}
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
REV=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/fenesh-bot-$REV.tar.gz" HEAD
umask 077
LAYA_KEY=$(grep -h '^LAYA_API_KEY=' "${ENV_FILE:-/dev/null}" 2>/dev/null | cut -d= -f2- || true)
LAYA_KEY=${LAYA_KEY:-$(openssl rand -hex 24)}
echo "LAYA_API_KEY=$LAYA_KEY" > "$TMP/laya.env"
if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$TMP/env"
  {
    grep -h '^METACULUS_TOKEN=' ~/.config/metaculus/bot.env
    grep -h '^AWS_BEARER_TOKEN_BEDROCK=' ~/.config/tiyuvta/bedrock.env
    echo 'BEDROCK_REGION=us-east-1'
    grep -h '^ASKNEWS_API_KEY=' ~/.config/asknews/env 2>/dev/null || true
    # Loopback-only sidecar key, fresh on every push; the sidecar gets it in a file of its own.
    echo "LAYA_API_KEY=$LAYA_KEY"
    grep -hv '^\s*#' .env.example | grep -E '^FENESH_' || true
  } > "$ENV_FILE"
fi
if ! grep -q '^LAYA_API_KEY=' "$ENV_FILE"; then
  # A given env file without the sidecar key: ship a copy with the key added.
  cp "$ENV_FILE" "$TMP/env.given" && echo "LAYA_API_KEY=$LAYA_KEY" >> "$TMP/env.given" && ENV_FILE="$TMP/env.given"
fi
SSH="/usr/bin/ssh -o BatchMode=yes"
/usr/bin/scp -q "$TMP/fenesh-bot-$REV.tar.gz" deploy/install.sh "$HOST:/root/"
/usr/bin/scp -q "$ENV_FILE" "$HOST:/root/fenesh-bot.env"
/usr/bin/scp -q "$TMP/laya.env" "$HOST:/root/fenesh-laya.env"
$SSH "$HOST" "set -e; install -d -m 0750 /etc/fenesh-bot; id fenesh >/dev/null 2>&1 || useradd --system --home /var/lib/fenesh-bot --shell /usr/sbin/nologin fenesh;
  install -m 0640 -o root -g fenesh /root/fenesh-bot.env /etc/fenesh-bot/env; rm -f /root/fenesh-bot.env;
  install -m 0600 -o root -g root /root/fenesh-laya.env /etc/fenesh-bot/laya.env; rm -f /root/fenesh-laya.env;
  chgrp fenesh /etc/fenesh-bot; bash /root/install.sh /root/fenesh-bot-$REV.tar.gz; rm -f /root/fenesh-bot-$REV.tar.gz /root/install.sh"
echo "deployed $REV to $HOST"
