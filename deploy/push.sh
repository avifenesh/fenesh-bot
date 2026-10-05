#!/usr/bin/env bash
# push.sh - ship the current commit to a host and (re)install fenesh-bot there.
# Usage: deploy/push.sh <ssh-target> [env-file]
#   env-file defaults to building one from ~/.config/metaculus/bot.env, ~/.config/tiyuvta/bedrock.env
#   and ~/.config/asknews/env. Alerts reach the owner through deploy/alert-relay.sh on the rig.
# Also ships the harness-websearch CLI (avifenesh/tools), built for the host's glibc, to /usr/local/bin.
# The env file is copied with mode 0640 root:fenesh and never stored in the repo or the tarball.
set -euo pipefail
HOST=${1:?usage: push.sh <ssh-target> [env-file]}
ENV_FILE=${2:-}
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
REV=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/fenesh-bot-$REV.tar.gz" HEAD
TOOLS=${FENESH_TOOLS_DIR:-$HOME/projects/tools}
WEBSEARCH_BIN="$TOOLS/target/x86_64-unknown-linux-gnu/release/harness-websearch-cli"
# Ubuntu 24.04 hosts have glibc 2.39; a native build on a newer rig would not run there. zigbuild is
# incremental, so it always runs, and the result is checked before it ships.
(cd "$TOOLS" && cargo zigbuild --release -p harness-websearch --bin harness-websearch-cli --target x86_64-unknown-linux-gnu.2.39)
NEED=$(objdump -T "$WEBSEARCH_BIN" | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1)
[ "$(printf '%s\nGLIBC_2.39\n' "$NEED" | sort -V | tail -1)" = GLIBC_2.39 ] || { echo "websearch CLI needs $NEED, host has 2.39" >&2; exit 1; }
if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$TMP/env"
  umask 077
  {
    grep -h '^METACULUS_TOKEN=' ~/.config/metaculus/bot.env
    grep -h '^AWS_BEARER_TOKEN_BEDROCK=' ~/.config/tiyuvta/bedrock.env
    echo 'BEDROCK_REGION=us-east-1'
    grep -h '^ASKNEWS_API_KEY=' ~/.config/asknews/env 2>/dev/null || true
    grep -hv '^\s*#' .env.example | grep -E '^FENESH_' || true
  } > "$ENV_FILE"
fi
SSH="/usr/bin/ssh -o BatchMode=yes"
/usr/bin/scp -q "$TMP/fenesh-bot-$REV.tar.gz" deploy/install.sh "$HOST:/root/"
/usr/bin/scp -q "$WEBSEARCH_BIN" "$HOST:/root/harness-websearch-cli"
/usr/bin/scp -q "$ENV_FILE" "$HOST:/root/fenesh-bot.env"
$SSH "$HOST" "set -e; install -d -m 0750 /etc/fenesh-bot; id fenesh >/dev/null 2>&1 || useradd --system --home /var/lib/fenesh-bot --shell /usr/sbin/nologin fenesh;
  install -m 0640 -o root -g fenesh /root/fenesh-bot.env /etc/fenesh-bot/env; rm -f /root/fenesh-bot.env;
  install -m 0755 /root/harness-websearch-cli /usr/local/bin/harness-websearch-cli; rm -f /root/harness-websearch-cli;
  chgrp fenesh /etc/fenesh-bot; bash /root/install.sh /root/fenesh-bot-$REV.tar.gz; rm -f /root/fenesh-bot-$REV.tar.gz /root/install.sh"
echo "deployed $REV to $HOST"
