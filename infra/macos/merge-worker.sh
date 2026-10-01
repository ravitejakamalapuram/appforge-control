#!/usr/bin/env bash
# merge-worker.sh - APP-310. One pass of the deterministic merge worker (scripts/merge-worker.mjs).
#
# Runs the worker AND reads config/merge-policy.yaml from a detached worktree at origin/main, never from the
# shared checkout: agents switch branches there, and a job that can merge must not run (or take its policy
# from) an unmerged branch. Mints a 1-hour appforge-agents App token scoped to the policy's repos; the token
# lives only in this process's environment and is never printed.
#
#   merge-worker.sh [--dry-run]     # dry-run: print each decision; no merge, no comment, no state write
set -uo pipefail
# APP-294: stamp state/heartbeats/merge-worker.json so a missed or failed run is detected.
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap merge-worker "$@"

DRY=()
case "${1:-}" in
  --dry-run) DRY=(--dry-run) ;;
  "") ;;
  *) echo "usage: merge-worker.sh [--dry-run]" >&2; exit 2 ;;
esac

REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] merge-worker.sh: $*"; }
notify() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS -m 10 --retry 2 -H "Title: appforge merge worker" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}
fail() { log "FAIL $1 - no merge pass ran"; notify "merge worker did not run: $1"; exit 1; }

cd "$REPO" || fail "cannot cd $REPO"
git -C "$REPO" fetch origin --quiet || fail "git fetch"

WT="$(mktemp -d "${TMPDIR:-/tmp}/appforge-merge-worker.XXXXXX")/afc"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$REPO" worktree add --detach "$WT" origin/main --quiet || fail "worktree add"

[ -d "$REPO/scripts/node_modules" ] || fail "$REPO/scripts/node_modules missing (run npm install there)"
ln -s "$REPO/scripts/node_modules" "$WT/scripts/node_modules" || fail "node_modules link"
# github-app-token.mjs resolves the App key relative to its own checkout; secrets/ is gitignored, so link it.
ln -s "$REPO/secrets" "$WT/secrets" || fail "secrets link"

REPOS="$(cd "$WT/scripts" && "$NODE_BIN" -e 'const y=require("yaml");const p=y.parse(require("fs").readFileSync("../config/merge-policy.yaml","utf8"));console.log(Object.keys(p.repos||{}).join(","))')" \
  || fail "cannot read repos from config/merge-policy.yaml"
[ -n "$REPOS" ] || fail "config/merge-policy.yaml lists no repos"

TOKEN_JSON="$(cd "$WT" && "$NODE_BIN" scripts/github-app-token.mjs --repos "$REPOS")" || fail "could not mint the App token"
GH_TOKEN="$(printf '%s' "$TOKEN_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')"
unset TOKEN_JSON
[ -n "$GH_TOKEN" ] || fail "App token response had no token"
export GH_TOKEN

# State and log stay in the real repo (gitignored): the worktree is deleted after every pass.
(cd "$WT" && "$NODE_BIN" scripts/merge-worker.mjs "${DRY[@]+"${DRY[@]}"}" \
  --state-file "$REPO/state/merge-worker-state.json" \
  --log-file "$REPO/logs/merge-worker.log")
exit $?
