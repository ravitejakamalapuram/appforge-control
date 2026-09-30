#!/bin/bash
# Renders and (re)loads the AppForge LaunchAgents from the committed plist
# TEMPLATES. Secrets never live in git: a template carries a named placeholder
# like __CLOUDFLARE_R2_API_TOKEN__, and this script fills it from the environment
# or ~/git-personal/.envrc at install time and writes the result, mode 0600, to
# ~/Library/LaunchAgents. launchd does not source .envrc, which is why the values
# have to be materialised into the installed plist at all.
#
#   install-plists.sh [--dry-run] [--no-load] [--dest DIR] [--envrc FILE] [job ...]
#
#   job          a label suffix (backup, sync, digest-gate, quota-watchdog) or a
#                full label. Default: every ing.paperclip.appforge-*.plist template.
#   --dry-run    resolve and validate everything, print what WOULD happen, write nothing.
#   --no-load    write the plists but do not touch launchd.
#   --dest DIR   install directory (default ~/Library/LaunchAgents).
#   --envrc FILE where to read values (default ~/git-personal/.envrc).
#
# Guarantees:
#   * Never prints a secret value. Errors name the VARIABLE, never its value.
#   * All jobs are rendered and validated BEFORE anything is written, so a missing
#     variable for one job cannot leave the others half-installed.
#   * .envrc is parsed, not executed: only `export NAME="literal"` lines are read
#     (sourcing it would run `gh auth token` and whatever else it contains). A
#     value that needs shell evaluation must be exported in the environment instead.
#   * Refuses to install a plist that still contains a placeholder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${PLIST_TEMPLATE_DIR:-$HERE}"
DEST="$HOME/Library/LaunchAgents"
ENVRC="$HOME/git-personal/.envrc"
DRY=0
LOAD=1
JOBS=()

die() { echo "install-plists: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-load) LOAD=0 ;;
    --dest)    [ $# -ge 2 ] || die "--dest needs a directory"; DEST="$2"; shift ;;
    --envrc)   [ $# -ge 2 ] || die "--envrc needs a file"; ENVRC="$2"; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown option: $1" ;;
    *)         JOBS+=("$1") ;;
  esac
  shift
done

# Resolve job names to labels.
if [ ${#JOBS[@]} -eq 0 ]; then
  for f in "$TEMPLATE_DIR"/ing.paperclip.appforge-*.plist; do
    [ -e "$f" ] || die "no plist templates found in $TEMPLATE_DIR"
    JOBS+=("$(basename "$f" .plist)")
  done
fi
LABELS=()
for j in "${JOBS[@]}"; do
  case "$j" in
    ing.paperclip.*) label="$j" ;;
    *)               label="ing.paperclip.appforge-$j" ;;
  esac
  [ -f "$TEMPLATE_DIR/$label.plist" ] || die "no template for job '$j' ($TEMPLATE_DIR/$label.plist)"
  LABELS+=("$label")
done

# Value for NAME: environment first, then a literal export line in $ENVRC.
# Prints the value; returns 1 if unset/empty; returns 2 if it needs shell evaluation.
lookup() {
  local name="$1" v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENVRC" ]; then
    v="$(sed -n -e "s/^export ${name}=\"\(.*\)\"[[:space:]]*\$/\1/p" \
                -e "s/^export ${name}='\(.*\)'[[:space:]]*\$/\1/p" \
                -e "s/^export ${name}=\([^\"' ][^ ]*\)[[:space:]]*\$/\1/p" "$ENVRC" | head -1)"
  fi
  [ -n "$v" ] || return 1
  case "$v" in *'$('*|*'`'*|*'${'*) return 2 ;; esac
  printf '%s' "$v"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
umask 077

# Phase 1: render + validate every job into $WORK. Nothing outside $WORK is touched.
for label in "${LABELS[@]}"; do
  tpl="$TEMPLATE_DIR/$label.plist"
  names="$(grep -o '__[A-Z][A-Z0-9_]*__' "$tpl" | sort -u | sed 's/^__//; s/__$//' || true)"
  filled=()
  for name in $names; do
    if val="$(lookup "$name")"; then
      export "APPFORGE_PLIST_VAL_$name=$val"
      filled+=("$name")
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then
        die "variable $name (needed by $label) needs shell evaluation; export it in the environment instead of relying on $ENVRC"
      fi
      die "missing required variable $name (needed by $label): set it in the environment or as 'export $name=\"...\"' in $ENVRC"
    fi
  done

  # Substitute via python so values are XML-escaped and never appear in argv/ps.
  python3 - "$tpl" "$WORK/$label.plist" "${filled[@]+"${filled[@]}"}" <<'PY'
import os, re, sys
from xml.sax.saxutils import escape
src, dst, *names = sys.argv[1:]
text = open(src, encoding="utf-8").read()
for n in names:
    text = text.replace("__%s__" % n, escape(os.environ["APPFORGE_PLIST_VAL_" + n]))
left = sorted(set(re.findall(r"__[A-Z][A-Z0-9_]*__", text)))
if left:
    sys.stderr.write("install-plists: unsubstituted placeholder(s) remain: %s\n" % ", ".join(left))
    sys.exit(3)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(text)
PY
  # (python exits non-zero on leftovers; set -e aborts before any install.)
  for name in ${filled[@]+"${filled[@]}"}; do unset "APPFORGE_PLIST_VAL_$name"; done

  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$WORK/$label.plist" >/dev/null || die "rendered $label.plist failed plutil -lint"
  fi
  echo "ok   $label  fills: ${filled[*]:-(no secrets, installed as-is)}"
done

if [ "$DRY" -eq 1 ]; then
  echo "dry-run: nothing written, launchd untouched. Would install to $DEST:"
  for label in "${LABELS[@]}"; do echo "  $DEST/$label.plist"; done
  exit 0
fi

# Phase 2: install.
mkdir -p "$DEST"
UID_N="$(id -u)"
for label in "${LABELS[@]}"; do
  out="$DEST/$label.plist"
  install -m 0600 "$WORK/$label.plist" "$out"
  chmod 600 "$out"
  if [ "$LOAD" -eq 1 ]; then
    launchctl bootout "gui/$UID_N/$label" 2>/dev/null || true
    # launchd sometimes answers the first bootstrap after a bootout with a
    # transient "Input/output error"; one retry is the known cure.
    launchctl bootstrap "gui/$UID_N" "$out" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$UID_N" "$out"; }
    echo "installed and loaded $label"
  else
    echo "installed $label (not loaded: --no-load)"
  fi
done
