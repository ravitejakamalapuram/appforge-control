#!/usr/bin/env bash
# repo-refresh.sh - keep the host's product-repo checkouts' origin/* refs current, hourly.
#
# Why: agents without product-repo credentials (Growth, CPO, Analyst) read a product repo at a pinned
# `origin/main` commit through the shared local checkouts (`git -C ~/git-personal/<repo> show origin/main:<path>`).
# They must not `git fetch` themselves (their token is scoped away from those repos, so GitHub answers
# "Repository not found" - APP-288), so without this job those refs go stale and every claim they cite
# is pinned to an old commit.
#
# Safety: `git fetch` only updates remote-tracking refs. It never touches a working tree, the current
# branch, the index or any uncommitted change, so it is safe to run against checkouts a human is using.
# Private repos fall back to a short-lived, repo-scoped App token (see fetch_authed); a repo that still fails is reported, not fatal.
#
#   repo-refresh.sh            # fetch every repo in REPO_REFRESH_REPOS under APPFORGE_PRODUCTS_ROOT
set -uo pipefail

ROOT="${APPFORGE_PRODUCTS_ROOT:-$HOME/git-personal}"
REPOS="${REPO_REFRESH_REPOS:-InvTrack session-transfer TeluguPanchangam TelePort StellarTab GitaVerses cors-enabler json-workbench echokit}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] repo-refresh: $*"; }

notify() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS -m 10 --retry 2 -H "Title: appforge repo-refresh" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

CTL="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
# Private repos need a credential. When an anonymous fetch fails, mint a short-lived App installation token scoped to
# THAT repo (the same minter the agent launcher uses) and retry once. The token goes to git through environment
# variables (never argv, so it is not visible in `ps`) and is never logged. REPO_REFRESH_TOKEN_CMD replaces the
# minter in tests.
fetch_authed() {
  local r="$1" dir="$2" json tok b64
  if [ -n "${REPO_REFRESH_TOKEN_CMD:-}" ]; then
    json="$($REPO_REFRESH_TOKEN_CMD --repos "$r" 2>/dev/null)" || return 1
  else
    json="$(node "$CTL/scripts/github-app-token.mjs" --repos "$r" 2>/dev/null)" || return 1
  fi
  tok="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')"
  [ -n "$tok" ] || return 1
  b64="$(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $b64" \
    git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --prune origin >/dev/null 2>&1
}

ok=0; failed=0; skipped=0
for r in $REPOS; do
  dir="$ROOT/$r"
  if [ ! -d "$dir/.git" ] && [ ! -f "$dir/.git" ]; then
    log "skip $r (no checkout at $dir)"; skipped=$((skipped+1)); continue
  fi
  # lowSpeed* turns a stalled connection into a failure instead of a hung job (macOS has no `timeout`).
  if out="$(git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --prune origin 2>&1)"; then
    log "ok   $r $(git -C "$dir" rev-parse --short origin/main 2>/dev/null || echo '?')"; ok=$((ok+1))
  elif fetch_authed "$r" "$dir"; then
    log "ok   $r $(git -C "$dir" rev-parse --short origin/main 2>/dev/null || echo '?') (authenticated)"; ok=$((ok+1))
  else
    log "FAIL $r: $(printf '%s' "$out" | head -1) (authenticated retry also failed)"; failed=$((failed+1))
  fi
done
log "done: $ok refreshed, $failed failed, $skipped skipped"

# One broken repo is noise; nothing refreshing at all means the job itself is broken, so say so.
if [ "$ok" = "0" ] && [ "$failed" -gt 0 ]; then
  notify "no repo could be refreshed ($failed failed)"
  exit 1
fi
exit 0
