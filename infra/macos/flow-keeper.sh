#!/usr/bin/env bash
# flow-keeper.sh - every 5 min: make sure no assigned Paperclip issue sits idle (scripts/flow-keeper.mjs; deterministic, no LLM).
# Runs the script from a detached worktree at origin/main (the shared checkout is routinely on an agent's branch); state
# (state/flow-keeper.json, state/assistant-inbox.json) stays in the real checkout.
#   flow-keeper.sh [--dry-run]
set -uo pipefail
# APP-294: stamp state/heartbeats/flow-keeper.json so a missed or failed run is detected.
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap flow-keeper "$@"
REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"
cd "$REPO" || { echo "flow-keeper.sh: FAIL cannot cd $REPO"; exit 1; }
# shellcheck source=lib/fetch-origin.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fetch-origin.sh"
fetch_origin "$REPO" || { echo "flow-keeper.sh: FAIL git fetch (anonymous and scoped-token)"; exit 1; }
WT="$(mktemp -d "${TMPDIR:-/tmp}/appforge-flow-keeper.XXXXXX")/afc"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$REPO" worktree add --detach "$WT" origin/main --quiet || { echo "flow-keeper.sh: FAIL worktree add"; exit 1; }
cd "$WT" && APPFORGE_STATE_DIR="$REPO/state" "$NODE_BIN" scripts/flow-keeper.mjs "$@"
