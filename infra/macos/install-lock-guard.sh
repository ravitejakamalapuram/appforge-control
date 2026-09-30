#!/bin/bash
# Deploys the Paperclip stale-lock guard: copies the script to a STABLE path that
# no other installer owns, renders the LaunchAgent plist, and (re)loads it.
# Idempotent; re-run it after editing scripts/paperclip-lock-guard.sh.
#
#   install-lock-guard.sh [--no-load] [--ops-dir DIR] [--dest DIR] [--envrc FILE]
#
#   --no-load     write files but leave launchd alone (used by the tests).
#   --ops-dir DIR where the script lives, as DIR/bin/paperclip-lock-guard.sh
#                 (default ~/.appforge-ops). Refused if it is, or resolves to
#                 something under, ~/.appforge or ~/.appforge.prev.
#   --dest DIR    LaunchAgents directory (default ~/Library/LaunchAgents).
#   --envrc FILE  where to read NTFY_TOPIC if it is not in the environment
#                 (default ~/git-personal/.envrc). Parsed, never executed.
#
# WHY NOT ~/.appforge/bin: that tree belongs to the runtime-launcher installer
# (scripts/install-runtime-launcher.sh), which redeploys it by stage-and-swap of
# the WHOLE directory. On 2026-09-30 01:21 that swap deleted a copy of this
# script, the LaunchAgent started exiting 127, and the guard went dark. A file
# in someone else's directory survives only until their next deploy. So this
# job lives in ~/.appforge-ops, which nothing else writes, and this installer
# refuses to put anything under ~/.appforge no matter what it is told.
#
# The committed plist carries a __NTFY_TOPIC__ placeholder; it is filled here
# from $NTFY_TOPIC or the .envrc and the result is written 0600. The topic is
# never echoed and never committed. (Same __NAME__ convention as
# install-plists.sh, so that generic installer can also render this template.)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="ing.paperclip.appforge-lock-guard"
NAME="paperclip-lock-guard.sh"
# The path the committed template hard-codes (house style: absolute, like the
# sibling plists). Rewritten below to wherever the script is actually deployed.
TEMPLATE_SCRIPT_PATH="/Users/rkamalapuram/.appforge-ops/bin/$NAME"

OPS_DIR="$HOME/.appforge-ops"
DEST="$HOME/Library/LaunchAgents"
ENVRC="$HOME/git-personal/.envrc"
LOAD=1

die() { echo "install-lock-guard: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-load)  LOAD=0 ;;
    --ops-dir)  [ $# -ge 2 ] || die "--ops-dir needs a directory"; OPS_DIR="$2"; shift ;;
    --dest)     [ $# -ge 2 ] || die "--dest needs a directory"; DEST="$2"; shift ;;
    --envrc)    [ $# -ge 2 ] || die "--envrc needs a file"; ENVRC="$2"; shift ;;
    -h|--help)  sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown option: $1" ;;
  esac
  shift
done

# Refuse anything that is, or resolves to, ~/.appforge or ~/.appforge.prev (or a
# path inside them). realpath resolves symlinks and works for paths that do not
# exist yet, and comparing whole path components keeps ~/.appforge-ops legal.
refuse_if_owned_by_another_installer() {
  python3 - "$OPS_DIR" "$HOME/.appforge" "$HOME/.appforge.prev" <<'PY'
import os, sys
target = os.path.realpath(sys.argv[1])
for owned in sys.argv[2:]:
    o = os.path.realpath(owned)
    if target == o or target.startswith(o + os.sep):
        sys.stderr.write(
            "install-lock-guard: refusing to write under %s (resolved from %r).\n"
            "  That tree is owned by another installer (scripts/install-runtime-launcher.sh),\n"
            "  which replaces it wholesale by stage-and-swap; anything placed there is\n"
            "  deleted on its next deploy. Use a directory nothing else owns, e.g. ~/.appforge-ops.\n"
            % (o, sys.argv[1]))
        sys.exit(1)
PY
}
refuse_if_owned_by_another_installer || exit 1

BIN_DIR="$OPS_DIR/bin"
DST="$BIN_DIR/$NAME"
PLIST_DST="$DEST/$LABEL.plist"
UID_N="$(id -u)"

mkdir -p "$BIN_DIR" "$DEST"

# Files here are kept 0555; unlock only this one, then re-lock.
[ -e "$DST" ] && chmod u+w "$DST"
cp "$HERE/../../scripts/$NAME" "$DST"
chmod 0555 "$DST"

topic="${NTFY_TOPIC:-}"
if [ -z "$topic" ] && [ -f "$ENVRC" ]; then
  topic="$(sed -n 's/^export NTFY_TOPIC="\(.*\)"[[:space:]]*$/\1/p' "$ENVRC" | head -1)"
fi

# Render via python so the topic and the script path are XML-escaped and never
# appear in argv (visible in `ps`).
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
APPFORGE_TOPIC="$topic" APPFORGE_SCRIPT="$DST" APPFORGE_OLD_SCRIPT="$TEMPLATE_SCRIPT_PATH" \
  python3 - "$HERE/$LABEL.plist" "$tmp" <<'PY'
import os, sys
from xml.sax.saxutils import escape
src, dst = sys.argv[1:]
text = open(src, encoding="utf-8").read()
old = escape(os.environ["APPFORGE_OLD_SCRIPT"])
if old not in text:
    sys.stderr.write("install-lock-guard: template no longer contains the expected script path; refusing to guess\n")
    sys.exit(3)
text = text.replace(old, escape(os.environ["APPFORGE_SCRIPT"]))
text = text.replace("__NTFY_TOPIC__", escape(os.environ["APPFORGE_TOPIC"]))
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(text)
PY
# plutil is macOS-only and this script's tests also run on Linux CI, so fall back to
# Python's plistlib, which parses the same XML plist format (same pattern as install-plists.sh).
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$tmp" >/dev/null || die "rendered plist failed plutil -lint"
else
  python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$tmp" >/dev/null 2>&1 \
    || die "rendered plist failed to parse as a property list"
fi
install -m 0600 "$tmp" "$PLIST_DST"
chmod 600 "$PLIST_DST"

if [ "$LOAD" -eq 1 ]; then
  mkdir -p "$HOME/git-personal/appforge-control/logs"
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
  # launchd sometimes answers the first bootstrap after a bootout with a
  # transient "Input/output error"; one retry is the known cure.
  launchctl bootstrap "gui/$UID_N" "$PLIST_DST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$UID_N" "$PLIST_DST"; }
  loaded="and loaded $LABEL"
else
  loaded="(not loaded: --no-load)"
fi

echo "installed $DST $loaded (ntfy: $([ -n "$topic" ] && echo enabled || echo disabled))"
