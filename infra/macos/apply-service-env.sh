#!/bin/sh
# Re-apply AppForge's environment to the Paperclip LaunchAgent and restart it.
#
# Why this exists: `paperclipai service install` (run by upgrades/repairs)
# regenerates ~/Library/LaunchAgents/ing.paperclip.paperclipai.plist with only
# its own three env vars, silently dropping ours. Run this after any Paperclip
# install/upgrade. It is idempotent.
#
# What it pins:
#   CLAUDE_CONFIG_DIR -> the personal AppForge Claude Code login (never ~/.claude,
#                        which is the work account on this laptop). The same
#                        value is also in ~/.paperclip/instances/default/.env as
#                        a backstop.
#   PATH              -> includes ~/.local/bin so Paperclip can find `claude`, and
#                        /opt/homebrew/bin (last) so agents can find `flutter`.
#
# Auth model: agents use Paperclip's *unmanaged* claude_local path (no "AI
# connection" bound). Paperclip then spawns the real `claude` CLI with this
# CLAUDE_CONFIG_DIR, and the CLI reads/refreshes its own macOS Keychain item
# ("Claude Code-credentials-<sha256(dir)[:8]>"). Nothing is ever copied out of
# the Keychain, so nothing goes stale.
set -eu

LABEL="ing.paperclip.paperclipai"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLAUDE_DIR="$HOME/git-personal/appforge-control/.claude-appforge"
CLAUDE_BIN="$HOME/.local/bin/claude"
# /opt/homebrew/bin is LAST so nothing that resolves today changes; it is only there so Flutter (brew cask) is found.
SVC_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
EXPECTED_EMAIL="raviteja369.k@gmail.com"
PB=/usr/libexec/PlistBuddy

[ -f "$PLIST" ] || { echo "missing $PLIST (run: paperclipai service install)" >&2; exit 1; }

# Guard: refuse to wire anything unless this dir is logged in as the personal account.
status=$(CLAUDE_CONFIG_DIR="$CLAUDE_DIR" "$CLAUDE_BIN" auth status 2>/dev/null || true)
case "$status" in
  *"\"email\": \"$EXPECTED_EMAIL\""*) echo "ok: $CLAUDE_DIR is logged in as $EXPECTED_EMAIL" ;;
  *) echo "ABORT: $CLAUDE_DIR is not logged in as $EXPECTED_EMAIL." >&2
     echo "Fix: CLAUDE_CONFIG_DIR=\"$CLAUDE_DIR\" claude auth login   (sign in with the personal account)" >&2
     exit 1 ;;
esac

set_env() {
  $PB -c "Delete :EnvironmentVariables:$1" "$PLIST" >/dev/null 2>&1 || true
  $PB -c "Add :EnvironmentVariables:$1 string $2" "$PLIST"
}
set_env CLAUDE_CONFIG_DIR "$CLAUDE_DIR"
set_env PATH "$SVC_PATH"
plutil -lint "$PLIST" >/dev/null

uid=$(id -u)
launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
# bootout is asynchronous; wait for the old process to go away.
i=0; while launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
launchctl bootstrap "gui/$uid" "$PLIST"

i=0; until curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1; do
  i=$((i+1)); [ $i -ge 90 ] && { echo "Paperclip did not come back on :3100" >&2; exit 1; }; sleep 1
done
launchctl print "gui/$uid/$LABEL" | grep -E "CLAUDE_CONFIG_DIR|PATH =>" | sed 's/^[[:space:]]*/  /'
echo "ok: Paperclip restarted with the personal Claude config"
