#!/bin/bash
# Answer one question, cheaply, before a heartbeat spends calls on writes that
# cannot land: CAN THIS RUN WRITE TO THE CONTROL PLANE AT ALL?
#
# Background and the full error-code decoder: docs/paperclip-run-binding.md.
#
# Short version: agent writes are attributed to a heartbeat run named by the
# `run_id` claim inside PAPERCLIP_API_KEY (a JWT). If the server cannot resolve
# that to a live run it refuses EVERY comment and EVERY status write in the run
# with 403 `cross_issue_influence_run_context_required` - a code whose name says
# "cross-issue" but which fires just as readily on your own checked-out issue.
# The condition is fixed for the life of the run, so retrying never helps and
# the only useful move is to find out early and switch to the courier pattern.
#
# Exit codes:
#   0  run is bound and a write probe succeeded - write normally
#   1  run is NOT attributable - every write will 403, use the courier pattern
#   2  could not determine (missing env, probe inconclusive) - treat as unsafe
set -uo pipefail

fail() { echo "paperclip-run-check: $*" >&2; }

for v in PAPERCLIP_API_KEY PAPERCLIP_API_URL; do
  if [ -z "${!v:-}" ]; then
    fail "$v is not set - not running inside a Paperclip heartbeat?"
    exit 2
  fi
done

# The JWT payload is not a secret (agent id, company id, run id - all of which
# are already in the environment), but never print the token or its signature.
CLAIM_RUN_ID="$(node -e '
  const t = process.env.PAPERCLIP_API_KEY || "";
  const parts = t.split(".");
  if (parts.length < 2) process.exit(3);
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString()); }
  catch { process.exit(3); }
  process.stdout.write(String(p.run_id || ""));
' 2>/dev/null)" || true

if [ -z "$CLAIM_RUN_ID" ]; then
  fail "PAPERCLIP_API_KEY carries no run_id claim (or is not a JWT)."
  fail "This run is structurally unattributable: every comment and status write"
  fail "will 403. Deliver via the courier pattern - see docs/paperclip-run-binding.md."
  exit 1
fi

echo "token run_id claim : $CLAIM_RUN_ID"
echo "PAPERCLIP_RUN_ID   : ${PAPERCLIP_RUN_ID:-<unset>}"

if [ -n "${PAPERCLIP_RUN_ID:-}" ] && [ "$PAPERCLIP_RUN_ID" != "$CLAIM_RUN_ID" ]; then
  fail "MISMATCH: \$PAPERCLIP_RUN_ID does not match the token's run_id claim."
  fail "Sending X-Paperclip-Run-Id: \$PAPERCLIP_RUN_ID will 422 agent_jwt_run_id_mismatch."
  fail "Your shell environment is stale (a retried heartbeat mints a NEW run id)."
  fail "Send '$CLAIM_RUN_ID' as the header, or omit the header entirely."
fi

# A no-op PATCH is the cheapest authenticated write probe: it exercises the same
# run-attribution path as a real comment without creating an artifact. Re-send
# the issue's CURRENT priority so a successful probe changes nothing.
ISSUE_ID="${1:-${PAPERCLIP_TASK_ID:-}}"
if [ -z "$ISSUE_ID" ]; then
  echo "no issue id (pass one, or set PAPERCLIP_TASK_ID) - skipping write probe"
  echo "run binding looks OK based on the token claim alone"
  exit 0
fi

BASE="${PAPERCLIP_API_URL%/}"
CUR_PRIORITY="$(curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$BASE/api/issues/$ISSUE_ID" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).priority||""))}catch{}})' 2>/dev/null)"

if [ -z "$CUR_PRIORITY" ]; then
  fail "could not read issue $ISSUE_ID - cannot run a no-op write probe"
  exit 2
fi

BODY="$(node -e 'process.stdout.write(JSON.stringify({priority:process.argv[1]}))' "$CUR_PRIORITY")"
PROBE="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $CLAIM_RUN_ID" \
  -H 'Content-Type: application/json' \
  -d "$BODY" 2>/dev/null)"

case "$PROBE" in
  2*)
    echo "write probe        : HTTP $PROBE - this run CAN write"
    exit 0
    ;;
  403)
    fail "write probe: HTTP 403 - this run CANNOT write to any issue."
    fail "Every comment and status update this heartbeat will be rejected."
    fail "Deliver via the courier pattern (issue creation stays open) and report"
    fail "run id $CLAIM_RUN_ID in your final response. See docs/paperclip-run-binding.md."
    exit 1
    ;;
  *)
    fail "write probe: HTTP $PROBE - inconclusive; treat writes as unsafe"
    exit 2
    ;;
esac
