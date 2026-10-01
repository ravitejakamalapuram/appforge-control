#!/usr/bin/env bash
# heartbeat.sh - sourced by every launchd job script (APP-294). Writes the stamp the lateness checker reads:
#   state/heartbeats/<job>.json  {job, started, finished, exitCode, lastSuccess}
# Usage, first lines of a job script (after `set -uo pipefail`):
#   . "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap <job> "$@"
# hb_wrap runs the script a second time as a child (HB_ACTIVE guards the recursion), then stamps the child's REAL
# exit code. That also covers `exec`, `exit` in the middle and the script's own EXIT traps, which a trap here would
# have fought with. A --dry-run is not a run: no stamp. The stamp never changes the job's exit code, and a stamp that
# cannot be written is logged, not fatal: the checker then reports the job overdue, which is the loud outcome.
HB_DIR="${APPFORGE_STATE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/state}/heartbeats"

hb_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Must never fail: under the caller's `set -e` + pipefail, a missing stamp (first run) would otherwise kill the job
# silently before it did anything (found by scripts/tests/heartbeat-live-scripts.test.mjs, review of PR #72).
hb_last_success() { [ -f "$HB_DIR/$1.json" ] || return 0; sed -n 's/.*"lastSuccess":"\([^"]*\)".*/\1/p' "$HB_DIR/$1.json" 2>/dev/null | head -1 || true; }
hb_write() { # job started finished exitCode lastSuccess  ("" = null)
  local f="$HB_DIR/$1.json" q='"'
  mkdir -p "$HB_DIR" 2>/dev/null || { echo "heartbeat: cannot create $HB_DIR" >&2; return 0; }
  local fin="null" ec="null" ls="null"
  [ -n "$3" ] && fin="$q$3$q"; [ -n "$4" ] && ec="$4"; [ -n "$5" ] && ls="$q$5$q"
  printf '{"job":"%s","started":"%s","finished":%s,"exitCode":%s,"lastSuccess":%s}\n' "$1" "$2" "$fin" "$ec" "$ls" >"$f.tmp" 2>/dev/null \
    && mv "$f.tmp" "$f" 2>/dev/null || echo "heartbeat: cannot write $f" >&2
  return 0
}

hb_wrap() {
  local job="$1"; shift
  [ "${HB_ACTIVE:-}" = "$job" ] && return 0
  local a; for a in "$@"; do [ "$a" = "--dry-run" ] && return 0; done
  local started prev rc end
  started="$(hb_now)"; prev="$(hb_last_success "$job")"
  hb_write "$job" "$started" "" "" "$prev"
  rc=0; HB_ACTIVE="$job" "${BASH:-bash}" "$0" "$@" || rc=$?   # `|| rc=$?`: a job with `set -e` must still get stamped
  end="$(hb_now)"
  if [ "$rc" -eq 0 ]; then hb_write "$job" "$started" "$end" 0 "$end"; else hb_write "$job" "$started" "$end" "$rc" "$prev"; fi
  exit "$rc"
}
