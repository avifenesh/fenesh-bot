#!/usr/bin/env bash
# fenesh-alert-relay - forward fenesh-bot alerts from the bot host's journal to the owner's phone (Hermes)
# Runs on the rig from a systemd user timer (deploy/fenesh-alert-relay.timer). The bot host cannot reach
# the rig, so the rig pulls: it reads alert lines after the saved journal cursor over SSH and sends each
# with `hermes send --to mobile`. The first run only records the cursor.
set -euo pipefail
HOST=${FENESH_HOST:-root@37.27.148.254}
TARGET=${FENESH_ALERT_TARGET:-mobile}
UNIT=${FENESH_UNIT:-fenesh-bot}
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/fenesh-bot
mkdir -p "$STATE"
CURSOR_FILE="$STATE/alert-cursor"
SSH=(/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

if [ ! -s "$CURSOR_FILE" ]; then
  LAST=$("${SSH[@]}" "journalctl -u $UNIT -n 1 -o json --no-pager")
  [ -n "$LAST" ] && printf '%s' "$LAST" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["__CURSOR"])' > "$CURSOR_FILE"
  exit 0
fi

ENTRIES=$(mktemp)
trap 'rm -f "$ENTRIES"' EXIT
"${SSH[@]}" "journalctl -u $UNIT -o json --no-pager --after-cursor='$(cat "$CURSOR_FILE")'" > "$ENTRIES"
[ -s "$ENTRIES" ] || exit 0

# One line per alert as "<cursor>\t<text>", then the last cursor seen, so a failed send is retried next run.
python3 - "$ENTRIES" > "$ENTRIES.alerts" <<'PY'
import json, sys
last = None
for line in open(sys.argv[1]):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    last = e.get("__CURSOR", last)
    try:
        m = json.loads(e.get("MESSAGE") or "")
    except (ValueError, TypeError):
        continue
    if isinstance(m, dict) and m.get("msg") == "alert" and m.get("text"):
        print(f"{e['__CURSOR']}\t{m['text']}".replace("\n", " "))
print(f"END\t{last}")
PY
trap 'rm -f "$ENTRIES" "$ENTRIES.alerts"' EXIT
while IFS=$'\t' read -r cursor text; do
  if [ "$cursor" = END ]; then
    [ -n "$text" ] && [ "$text" != None ] && printf '%s\n' "$text" > "$CURSOR_FILE"
    break
  fi
  # Stop at the first failed send; the cursor stays before it and the next run retries.
  hermes send --to "$TARGET" --subject "fenesh-bot" --quiet "$text"
  printf '%s\n' "$cursor" > "$CURSOR_FILE"
done < "$ENTRIES.alerts"
