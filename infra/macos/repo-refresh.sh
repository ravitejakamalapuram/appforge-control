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
# Private repos need a credential this job does not hold; they fail quietly and are reported, not fatal.
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

ok=0; failed=0; skipped=0
for r in $REPOS; do
  dir="$ROOT/$r"
  if [ ! -d "$dir/.git" ] && [ ! -f "$dir/.git" ]; then
    log "skip $r (no checkout at $dir)"; skipped=$((skipped+1)); continue
  fi
  # lowSpeed* turns a stalled connection into a failure instead of a hung job (macOS has no `timeout`).
  if out="$(git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --prune origin 2>&1)"; then
    log "ok   $r $(git -C "$dir" rev-parse --short origin/main 2>/dev/null || echo '?')"; ok=$((ok+1))
  else
    log "FAIL $r: $(printf '%s' "$out" | head -1)"; failed=$((failed+1))
  fi
done
log "done: $ok refreshed, $failed failed, $skipped skipped"

# One broken repo is noise; nothing refreshing at all means the job itself is broken, so say so.
if [ "$ok" = "0" ] && [ "$failed" -gt 0 ]; then
  notify "no repo could be refreshed ($failed failed)"
  exit 1
fi
exit 0
