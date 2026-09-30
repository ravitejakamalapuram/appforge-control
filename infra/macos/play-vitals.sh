#!/usr/bin/env bash
# play-vitals.sh - daily Google Play crash/ANR check (AI-1 step 1, "Detect").
#
# Runs scripts/play-vitals.mjs from a detached worktree at origin/main (the shared checkout is
# routinely on another branch), then acts on the exit code:
#    0  ok                -> log only
#    3  insufficient data -> log only (too few users for Play to report; NOT an all-clear and NOT a failure)
#    1  ALERT             -> open ONE Paperclip issue for the CTO per data window + push via ntfy
#    2  the check failed  -> push via ntfy; a broken check must never look like a quiet day
#
# The service-account key stays in the file named by PLAY_SA_KEY_FILE. It is read by the node script only;
# this wrapper never prints or copies it, and no agent is given it (docs/metrics-ingest.md section 4).
#
#   play-vitals.sh [--dry-run]     # dry-run: print the requests, call nothing, open nothing
set -uo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: play-vitals.sh [--dry-run]" >&2; exit 2 ;;
esac

REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
NODE_BIN="${APPFORGE_NODE:-/opt/homebrew/bin/node}"
PACKAGES="${PLAY_VITALS_PACKAGES:-com.invtracker.inv_tracker}"
CTO_ID="${PLAY_VITALS_ASSIGNEE:-3cba1fb3-21e1-4851-832b-95de5247bff1}"
INVTRACK_PROJECT="${PLAY_VITALS_PROJECT:-122db053-1f31-4add-b77c-db5061c82140}"
STATE_DIR="${APPFORGE_STATE_DIR:-$REPO/state}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] play-vitals: $*"; }

notify() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS -m 10 --retry 2 -H "Title: appforge play-vitals" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

if [ "$DRY_RUN" = "0" ]; then
  for v in PLAY_SA_KEY_FILE PAPERCLIP_API_URL PAPERCLIP_COMPANY_ID; do
    if [ -z "${!v:-}" ]; then
      log "FAIL ${v} is not set - check did not run. This is NOT a quiet day."
      notify "check did not run: ${v} unset"
      exit 1
    fi
  done
  [ -r "$PLAY_SA_KEY_FILE" ] || { log "FAIL key file is not readable"; notify "check did not run: key file unreadable"; exit 1; }
fi

cd "$REPO" || { log "FAIL cannot cd $REPO"; notify "check did not run: cannot cd $REPO"; exit 1; }
git -C "$REPO" fetch origin --quiet || { log "FAIL git fetch"; notify "check did not run: git fetch failed"; exit 1; }

WT="$(mktemp -d "${TMPDIR:-/tmp}/appforge-play-vitals.XXXXXX")/afc"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$REPO" worktree add --detach "$WT" origin/main --quiet || { log "FAIL worktree add"; notify "check did not run: worktree add failed"; exit 1; }

# ESM resolves `jsonwebtoken` by walking up for node_modules, so link the shared checkout's installed tree
# into the same relative spot (symlink, not `npm ci`: no network dependency in a cheap daily check).
[ -d "$REPO/scripts/node_modules" ] || { log "FAIL $REPO/scripts/node_modules missing - run npm install there"; notify "check did not run: node_modules missing"; exit 1; }
ln -s "$REPO/scripts/node_modules" "$WT/scripts/node_modules" || { log "FAIL node_modules link"; notify "check did not run: node_modules link failed"; exit 1; }

worst=0
for pkg in $PACKAGES; do
  if [ "$DRY_RUN" = "1" ]; then
    (cd "$WT" && "$NODE_BIN" scripts/play-vitals.mjs --package "$pkg" --dry-run | head -3)
    log "dry-run: would check $pkg; nothing called, nothing opened"
    continue
  fi
  OUT="$(cd "$WT" && "$NODE_BIN" scripts/play-vitals.mjs --package "$pkg" 2>&1)"
  RC=$?
  # The runner writes its JSON result into the WORKTREE's data/ dir; keep a copy in the real repo.
  mkdir -p "$REPO/data/metrics/raw"
  cp "$WT"/data/metrics/raw/play-vitals-"$pkg"-*.json "$REPO/data/metrics/raw/" 2>/dev/null || true
  case "$RC" in
    0) log "ok $pkg" ;;
    3) log "insufficient_data $pkg (too few users for Play to report vitals) - not an all-clear" ;;
    1)
      END="$(printf '%s' "$OUT" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).window.end)}catch{console.log("unknown")}})')"
      SUMMARY="$(printf '%s' "$OUT" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log([...(j.crash.reasons||[]),...(j.anr.reasons||[])].join("; "))}catch{console.log("see data/metrics/raw")}})')"
      log "ALERT $pkg window_end=$END: $SUMMARY"
      notify "ALERT $pkg: $SUMMARY"
      mkdir -p "$STATE_DIR"
      MARK="$STATE_DIR/play-vitals-alerted-$pkg"
      if [ "$(cat "$MARK" 2>/dev/null)" = "$END" ]; then
        log "issue already opened for $pkg window_end=$END - not opening another"
      else
        BODY="$("$NODE_BIN" -e 'const [pkg,end,sum,to,proj]=process.argv.slice(1);console.log(JSON.stringify({title:`Play vitals alert: ${pkg} (data to ${end})`,description:`The daily Play vitals check flagged ${pkg}.\n\nFindings: ${sum}\n\nFull result: data/metrics/raw/play-vitals-${pkg}-${end}.json in appforge-control.\n\nTask: find the crash/ANR signature (Firebase Crashlytics, stack traces), say whether it is tied to the latest release, and propose the smallest safe fix as a DRAFT PR with a regression test. Do NOT merge, deploy or halt a rollout yourself; the assistant decides. If you cannot identify a cause, say so and set status blocked. Max 40 turns.`,status:"todo",priority:"high",assigneeAgentId:to,projectId:proj}))' "$pkg" "$END" "$SUMMARY" "$CTO_ID" "$INVTRACK_PROJECT")"
        if curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d "$BODY" "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" >/dev/null; then
          printf '%s' "$END" > "$MARK"; log "opened Paperclip issue for $pkg"
        else
          log "FAIL could not open the Paperclip issue for $pkg"; notify "ALERT for $pkg but the issue could not be opened"; worst=1
        fi
      fi ;;
    *) log "FAIL $pkg check failed (rc=$RC): $(printf '%s' "$OUT" | head -3 | tr '\n' ' ')"; notify "check failed for $pkg (rc=$RC)"; worst=1 ;;
  esac
done
exit "$worst"
