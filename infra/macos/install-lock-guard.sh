#!/bin/bash
# Deploys the Paperclip stale-lock guard: copies the script to a STABLE path
# (~/.appforge/bin, the same place agent-launch.sh lives - the shared checkout
# changes branches under it, so a LaunchAgent must never point into it), renders
# the LaunchAgent plist, and (re)loads it. Idempotent; safe to re-run after
# editing scripts/paperclip-lock-guard.sh.
#
# The committed plist carries a __NTFY_TOPIC__ placeholder on purpose: the real
# topic is filled in here from $NTFY_TOPIC or ~/git-personal/.envrc and is never
# echoed or committed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="ing.paperclip.appforge-lock-guard"
BIN_DIR="$HOME/.appforge/bin"
DST="$BIN_DIR/paperclip-lock-guard.sh"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"

mkdir -p "$BIN_DIR" "$HOME/Library/LaunchAgents" "$HOME/git-personal/appforge-control/logs"

# Files in ~/.appforge/bin are kept 0555; unlock only this one, then re-lock.
[ -e "$DST" ] && chmod u+w "$DST"
cp "$HERE/../../scripts/paperclip-lock-guard.sh" "$DST"
chmod 0555 "$DST"

topic="${NTFY_TOPIC:-}"
if [ -z "$topic" ] && [ -f "$HOME/git-personal/.envrc" ]; then
  topic="$(sed -n 's/^export NTFY_TOPIC="\(.*\)"$/\1/p' "$HOME/git-personal/.envrc" | head -1)"
fi
tmp="$(mktemp)"
sed "s|__NTFY_TOPIC__|$topic|" "$HERE/$LABEL.plist" >"$tmp"
plutil -lint "$tmp" >/dev/null
install -m 0644 "$tmp" "$PLIST_DST"
rm -f "$tmp"

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
# launchd sometimes answers the first bootstrap after a bootout with a
# transient "Input/output error"; one retry is the known cure.
launchctl bootstrap "gui/$UID_N" "$PLIST_DST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$UID_N" "$PLIST_DST"; }

echo "installed $DST and loaded $LABEL (ntfy: $([ -n "$topic" ] && echo enabled || echo disabled))"
