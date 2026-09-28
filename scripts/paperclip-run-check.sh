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
#   0  run is bound and a write probe SUCCEEDED - write normally
#   1  run is NOT attributable - every write will 403, use the courier pattern
#   2  UNVERIFIED - the check could not be completed (missing env, no issue to
#      probe, decoder unavailable, probe inconclusive). This is not an all-clear:
#      treat writes as unsafe until a probe actually returns 2xx.
#
# Note that only exit 0 is evidence. The token always carries *some* `run_id`
# claim, so a claim on its own proves nothing - the APP-64 failure is a claim
# that names a run the server will not resolve, which only a write probe can
# distinguish from a healthy one.
set -uo pipefail

fail() { echo "paperclip-run-check: $*" >&2; }

# Keep the bearer token out of the process table and out of `bash -x` output by
# feeding it to curl on stdin (`-H @-`) instead of on the command line. xtrace is
# suppressed for the length of the expansion, since `set -x` would otherwise echo
# the token as a printf argument - which is exactly what a debugging agent turns on.
auth_header() {
  local was_x=""
  case "$-" in *x*) was_x=1; set +x ;; esac
  printf 'Authorization: Bearer %s\n' "$PAPERCLIP_API_KEY"
  [ -n "$was_x" ] && set -x
  return 0
}

# `${!v:+x}` tests set-and-non-empty WITHOUT expanding the value, so `set -x`
# cannot echo the token here either.
for v in PAPERCLIP_API_KEY PAPERCLIP_API_URL; do
  if [ -z "${!v:+x}" ]; then
    fail "$v is not set - not running inside a Paperclip heartbeat?"
    exit 2
  fi
done

if ! command -v node >/dev/null 2>&1; then
  fail "node is not on PATH - cannot decode the token's run_id claim."
  fail "Run binding is UNVERIFIED (which is not the same as unattributable)."
  exit 2
fi

# The JWT payload is not a secret (agent id, company id, run id - all of which
# are already in the environment), but never print the token or its signature.
# Decoder exit codes: 3 = not a JWT, 4 = decoded but no run_id claim,
# 5 = payload undecodable, anything else = the decoder itself failed.
CLAIM_RUN_ID="$(node -e '
  const t = process.env.PAPERCLIP_API_KEY || "";
  const parts = t.split(".");
  if (parts.length < 3) process.exit(3);
  let p;
  try {
    // Plain "base64" rather than "base64url" so old node does not throw here
    // and get misread as a malformed token.
    const b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    p = JSON.parse(Buffer.from(b, "base64").toString("utf8"));
  } catch { process.exit(5); }
  if (!p || !p.run_id) process.exit(4);
  process.stdout.write(String(p.run_id));
' 2>/dev/null)"
DECODE_STATUS=$?

case "$DECODE_STATUS" in
  0)
    if [ -z "$CLAIM_RUN_ID" ]; then DECODE_STATUS=4; fi
    ;;
esac

case "$DECODE_STATUS" in
  0) : ;;
  3|4)
    fail "PAPERCLIP_API_KEY carries no run_id claim (or is not a JWT)."
    fail "This run is structurally unattributable: every comment and status write"
    fail "will 403. Deliver via the courier pattern - see docs/paperclip-run-binding.md."
    exit 1
    ;;
  *)
    fail "could not decode the token payload (decoder exited $DECODE_STATUS)."
    fail "Run binding is UNVERIFIED - the decoder failed, which says nothing about"
    fail "whether this run can write. Treat writes as unsafe until a probe returns 2xx."
    exit 2
    ;;
esac

echo "token run_id claim : $CLAIM_RUN_ID"
echo "PAPERCLIP_RUN_ID   : ${PAPERCLIP_RUN_ID:-<unset>}"

if [ -n "${PAPERCLIP_RUN_ID:-}" ] && [ "$PAPERCLIP_RUN_ID" != "$CLAIM_RUN_ID" ]; then
  fail "MISMATCH: \$PAPERCLIP_RUN_ID does not match the token's run_id claim."
  fail "Sending X-Paperclip-Run-Id: \$PAPERCLIP_RUN_ID will 422 agent_jwt_run_id_mismatch."
  fail "Your shell environment is stale (a retried heartbeat mints a NEW run id)."
  fail "Send '$CLAIM_RUN_ID' as the header, or omit the header entirely."
fi

# A no-op PATCH is the cheapest authenticated write probe: it exercises the same
# run-attribution path as a real comment without creating an artifact. Re-sending
# the issue's CURRENT priority changes no field value - it does bump `updatedAt`,
# which feeds recency ordering, so this is cheap but not entirely invisible.
ISSUE_ID="${1:-${PAPERCLIP_TASK_ID:-}}"
if [ -z "$ISSUE_ID" ]; then
  fail "no issue id (pass one, or set PAPERCLIP_TASK_ID) - cannot run the write probe."
  fail "Run binding is UNVERIFIED. The token claim alone cannot detect this failure:"
  fail "a bad token carries a run_id claim too. Re-run with an issue id you can write to."
  exit 2
fi

BASE="${PAPERCLIP_API_URL%/}"
CUR_PRIORITY="$(auth_header | curl -sS -H @- "$BASE/api/issues/$ISSUE_ID" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).priority||""))}catch{}})' 2>/dev/null)"

if [ -z "$CUR_PRIORITY" ]; then
  fail "could not read issue $ISSUE_ID - cannot run a no-op write probe"
  exit 2
fi

BODY="$(node -e 'process.stdout.write(JSON.stringify({priority:process.argv[1]}))' "$CUR_PRIORITY")"
PROBE="$(auth_header | curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/issues/$ISSUE_ID" \
  -H @- \
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
