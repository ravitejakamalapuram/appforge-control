#!/usr/bin/env bash
# digest-gate.sh — the deterministic half of Analyst's §6.2 06:30 wake.
#
# APP-43 (routine restored under the APP-50 ruling).
#
# WHY THIS EXISTS AT ALL, rather than a plain Paperclip schedule trigger:
#
#   §6.2 gates Analyst's 06:30 wake on "the ingest job's deterministic anomaly
#   check". A Paperclip `schedule` trigger cannot express a condition — it
#   fires every day regardless. APP-50 removed the routine precisely because a
#   routine that "fires unconditionally and spends a model call to conclude
#   nothing" is the cost shape the APP-39 ruling rejected, against the smallest
#   budget in the company (Analyst, 400 cents).
#
#   So the condition is evaluated HERE, by a script, with no model in the loop,
#   and the routine is fired only when it holds. On a quiet day nothing fires
#   and nothing is spent. The routine therefore carries an `api` trigger and
#   NO schedule trigger — see its description.
#
# Exit-code contract from `metrics-digest.mjs --gate`:
#    0  >=1 anomaly flag fired      -> FIRE the routine
#   20  computed cleanly, no flag   -> stay silent, this is the quiet-day path
#    1  the check itself failed     -> do NOT fire, and do NOT call it quiet
#    2  bad usage                   -> same
#
# The 1-vs-20 split is the whole safety property: a broken check must never be
# indistinguishable from an all-clear. Anything that is not exactly 0 or 20 is
# reported as a gate failure.

set -uo pipefail
# APP-294: stamp state/heartbeats/digest-gate.json so a missed or failed run is detected.
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap digest-gate "$@"

# --dry-run does everything except the POST that wakes Analyst: fetch, worktree,
# node_modules link, the digest, and the exit-code decision, reporting which
# branch it WOULD have taken. This exists because the alternative way to verify
# this script is to fire it, which spends a model call against the smallest
# budget in the company — so the honest check would have been skipped instead.
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: digest-gate.sh [--dry-run]" >&2; exit 2 ;;
esac

ROUTINE_ID="91419456-6fa8-4521-bafe-c99eab44f2f1"
TRIGGER_ID="d2127cac-e6cb-46be-aa9e-7c94a04c22de"

REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] digest-gate: $*"; }

notify() {
  # Best-effort push on a gate failure. Never fails the script.
  # NTFY_TOPIC is the bare topic, matching backup.sh and sync.sh.
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS -m 10 --retry 2 -H "Title: appforge digest-gate" \
    -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

# PAPERCLIP_API_KEY is deliberately NOT required. A heartbeat run has a
# run-scoped JWT injected; this LaunchAgent has none, and minting a long-lived
# key so it could have one would put a standing credential on disk for GETs the
# local control plane already serves unauthenticated on 127.0.0.1. The shipped
# quota-watchdog LaunchAgent runs on exactly this basis. If the key IS present
# it is passed through, so the same script works unchanged inside a run.
for v in PAPERCLIP_API_URL PAPERCLIP_COMPANY_ID; do
  if [ -z "${!v:-}" ]; then
    log "FAIL ${v} is not set — gate did not run. This is NOT a quiet day."
    notify "gate did not run: ${v} unset"
    exit 1
  fi
done

cd "$REPO" || { log "FAIL cannot cd $REPO"; notify "gate did not run: cannot cd $REPO"; exit 1; }

# The shared checkout is routinely sitting on another agent's branch, so run
# the gate from a detached worktree at origin/main — same reasoning as the
# hourly integrity sweep. Cleaned up unconditionally on the way out.
WT="$(mktemp -d "${TMPDIR:-/tmp}/appforge-digest-gate.XXXXXX")/afc"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# shellcheck source=lib/fetch-origin.sh
. "$(dirname "$0")/lib/fetch-origin.sh"
fetch_origin "$REPO" || { log "FAIL git fetch (anonymous and scoped-token)"; notify "gate did not run: git fetch failed"; exit 1; }
git -C "$REPO" worktree add --detach "$WT" origin/main --quiet || { log "FAIL worktree add"; notify "gate did not run: worktree add failed"; exit 1; }

# metrics-digest needs `yaml`, and the fresh worktree has no node_modules of its
# own. NODE_PATH does NOT solve this: it is a CommonJS-only mechanism and ESM
# `import` ignores it outright, so the earlier NODE_PATH version of this script
# failed with ERR_MODULE_NOT_FOUND on every run — exit 1, "the check did not
# run", every single day. That is the worst available failure: it never fires
# the routine AND it pages the founder daily.
#
# ESM resolution walks parent directories looking for a real `node_modules`, so
# linking the shared checkout's installed tree into the same relative position
# is what actually works. Symlink, not a copy: `npm ci` here would add a network
# dependency to a gate whose whole job is to be cheap and quiet.
if [ ! -d "$REPO/scripts/node_modules" ]; then
  log "FAIL $REPO/scripts/node_modules is missing — run npm install there. Gate did not run; this is NOT a quiet day."
  notify "gate did not run: scripts/node_modules missing"
  exit 1
fi
ln -s "$REPO/scripts/node_modules" "$WT/scripts/node_modules" || {
  log "FAIL could not link node_modules into the worktree"
  notify "gate did not run: node_modules link failed"
  exit 1
}

# APP-294, "who checks the checker": the schedule-liveness checker watches this job through its stamp, and this job
# watches the checker's stamp. If the checker has stopped, --self-only exits 1 and sends ntfy. It does not change the
# gate's own result. (The checker's optional HEALTHCHECKS_PING_URL_LIVENESS dead-man's switch covers both dying.)
if [ "$DRY_RUN" != "1" ]; then
  if [ -f "$WT/scripts/job-liveness.mjs" ]; then
    (cd "$WT" && APPFORGE_STATE_DIR="${APPFORGE_STATE_DIR:-$REPO/state}" "$NODE_BIN" scripts/job-liveness.mjs --self-only) \
      || log "WARN schedule-liveness checker is not running (see its self-check above)"
  else
    log "WARN origin/main has no scripts/job-liveness.mjs yet: the checker's own stamp is not being checked"
  fi
fi

OUT="$(cd "$WT" && "$NODE_BIN" scripts/metrics-digest.mjs --gate 2>&1)"
RC=$?

case "$RC" in
  0)
    log "FIRE $OUT"
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run: would POST trigger $TRIGGER_ID to routine $ROUTINE_ID; not firing"
      exit 0
    fi
    AUTH=()
    [ -n "${PAPERCLIP_API_KEY:-}" ] && AUTH=(-H "x-api-key: $PAPERCLIP_API_KEY")
    # `${AUTH[@]+"${AUTH[@]}"}`, not the plain `"${AUTH[@]}"`. Under `set -u`,
    # bash 3.2 — what macOS ships and what this LaunchAgent actually runs —
    # treats the expansion of an EMPTY array as an unbound variable and aborts.
    # The no-API-key path is the NORMAL path here (see the note above), so the
    # plain form would kill the gate at precisely the moment it had flags to
    # report, and the failure would look like a gate error rather than a
    # missing wake. Verified against bash 3.2.57 both with and without the key.
    RESP="$(curl -fsS -m 30 -X POST \
      ${AUTH[@]+"${AUTH[@]}"} \
      -H "Content-Type: application/json" \
      -d "{\"triggerId\":\"$TRIGGER_ID\",\"source\":\"api\",\"idempotencyKey\":\"digest-gate:$(date -u +%Y-%m-%d)\"}" \
      "$PAPERCLIP_API_URL/api/routines/$ROUTINE_ID/run" 2>&1)"
    if [ $? -ne 0 ]; then
      log "FAIL flags fired but the routine could not be triggered: $RESP"
      notify "anomaly flags fired but Analyst could not be woken"
      exit 1
    fi
    log "fired routine $ROUTINE_ID"
    ;;
  20)
    log "quiet $OUT"
    [ "$DRY_RUN" = "1" ] && log "dry-run: quiet day, nothing would have fired"
    # Explicit: the `&&` test above returns 1 when DRY_RUN=0, and launchd would
    # record that as a failed exit on every quiet day (APP-314).
    exit 0
    ;;
  *)
    log "FAIL gate exited $RC — the check did not run, so this is NOT a quiet day: $OUT"
    notify "digest gate failed (exit $RC) — anomaly state is UNKNOWN today"
    exit 1
    ;;
esac
