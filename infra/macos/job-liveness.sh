#!/usr/bin/env bash
# job-liveness.sh - every 10 min: prove every launchd job ran (stamps vs plist cadence) and run the instruction-sync
# and launcher-drift verifiers; one Paperclip issue + ntfy per problem, auto-closed when fresh again (APP-294).
#   job-liveness.sh [--dry-run] [--self-only]
# The checkout is routinely on another agent's branch, and the drift verifiers compare agents/ and the launcher with
# what is deployed, so the checker runs from a detached worktree at origin/main (same reasoning as digest-gate.sh).
# Stamps stay in the real checkout's state/ (APPFORGE_STATE_DIR), not in the throwaway worktree.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap job-liveness "$@"
REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"
cd "$REPO" || { echo "job-liveness: FAIL cannot cd $REPO"; exit 1; }
export APPFORGE_STATE_DIR="${APPFORGE_STATE_DIR:-$REPO/state}"
WT="$(mktemp -d "${TMPDIR:-/tmp}/appforge-job-liveness.XXXXXX")/afc"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# shellcheck source=lib/fetch-origin.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/fetch-origin.sh"
fetch_origin "$REPO" || { echo "job-liveness: FAIL git fetch (anonymous and scoped-token)"; exit 1; }
git -C "$REPO" worktree add --detach "$WT" origin/main --quiet || { echo "job-liveness: FAIL worktree add"; exit 1; }
[ -d "$REPO/scripts/node_modules" ] || { echo "job-liveness: FAIL $REPO/scripts/node_modules missing"; exit 1; }
ln -s "$REPO/scripts/node_modules" "$WT/scripts/node_modules" || { echo "job-liveness: FAIL node_modules link"; exit 1; }
cd "$WT" && "$NODE_BIN" scripts/job-liveness.mjs "$@"
