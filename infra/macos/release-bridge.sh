#!/usr/bin/env bash
# release-bridge.sh - hourly GitHub -> Paperclip + ntfy bridge for release-platform failures (APP-293).
# Runs scripts/release-bridge.mjs from the checkout; it only READS GitHub (gh issue list / gh run list).
#   release-bridge.sh [--dry-run]     # dry-run: calls nothing, opens nothing
set -uo pipefail
# APP-294: stamp state/heartbeats/release-bridge.json so a missed or failed run is detected.
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap release-bridge "$@"
REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"
cd "$REPO" || { echo "release-bridge: FAIL cannot cd $REPO"; exit 1; }
exec "$NODE_BIN" scripts/release-bridge.mjs "$@"
