#!/bin/bash
# Answer two questions, cheaply, before a heartbeat spends calls on writes:
#   1. CAN THIS RUN WRITE TO THE CONTROL PLANE AT ALL?
#   2. WHEN IT WRITES, IS THE WRITE RECORDED AS THIS AGENT?
#
# Background and the full decoder for both failure families:
# docs/paperclip-run-binding.md.
#
# Failure family 1 - the write is REFUSED (APP-64). Agent writes are attributed
# to a heartbeat run named by the `run_id` claim inside PAPERCLIP_API_KEY (a
# JWT). If the server cannot resolve that to a live run it refuses EVERY comment
# and EVERY status write in the run with 403
# `cross_issue_influence_run_context_required` - a code whose name says
# "cross-issue" but which fires just as readily on your own checked-out issue.
# The condition is fixed for the life of the run, so retrying never helps and
# the only useful move is to find out early and switch to the courier pattern.
#
# Failure family 2 - the write SUCCEEDS but is LAUNDERED (APP-78/APP-119). This
# instance runs in `local_trusted` mode, where a request the auth middleware
# reads as carrying no credential is accepted as the board. It returns 2xx and
# is stored as `actorType: user` / `actorId: local-board` / `runId: null`, with
# nothing in the response body saying the credential was ignored. Family 1's
# probe passes clean on such a run, which is the blind spot this check closes:
# after a 2xx it reads the issue activity log back and asserts the write landed
# as `actorType: agent` with this agent's id and this run's id.
#
# Exit codes:
#   0  run is bound, a write probe SUCCEEDED, and the write was attributed to
#      this agent and this run - write normally
#   1  run is NOT attributable - every write will 403, use the courier pattern
#   2  UNVERIFIED - the check could not be completed (missing env, no issue to
#      probe, decoder unavailable, probe inconclusive, or the probe succeeded but
#      its attribution could not be read back). This is not an all-clear: treat
#      writes as unsafe until a probe returns 2xx AND reads back as this agent.
#   3  LAUNDERED - the write probe SUCCEEDED but was recorded as the board
#      (`actorType: user` / `actorId: local-board`) rather than as this agent.
#      Do not write. Every comment would land as a founder comment: it fires
#      `issue_commented` wakes, and the control plane applies founder reopen
#      semantics, so a status write can silently move an issue and cancel a
#      scheduled retry run. Report it and deliver in your final response.
#
# Note that only exit 0 is evidence. The token always carries *some* `run_id`
# claim, so a claim on its own proves nothing - the APP-64 failure is a claim
# that names a run the server will not resolve, which only a write probe can
# distinguish from a healthy one.
#
# SCOPE LIMIT, read this before trusting exit 0 too far: this script sends its
# own probe with `Authorization: Bearer`, so exit 0 proves that a CORRECTLY
# FORMED write from this run is attributed correctly. It cannot see a later call
# of yours that launders itself by sending the credential under the wrong header
# name - `X-Paperclip-Api-Key: $PAPERCLIP_API_KEY` is the observed typo, and it
# is unrecognised, so the request counts as presenting none. Exit 0 is a
# statement about the control plane, not a licence to stop checking your own
# calls. Verify `authorType`/`actorType` in the response of every real write.
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
#
# Two claims are read. `run_id` is the run binding (family 1). `sub` is the
# agent id, and is what the attribution read-back (family 2) compares against -
# preferred over $PAPERCLIP_AGENT_ID because the token is the thing the server
# actually authenticated, while the process environment can be stale on a
# retried heartbeat exactly as $PAPERCLIP_RUN_ID can.
CLAIM="$(node -e '
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
  // Tab-separated so the shell can split without a subshell per claim.
  process.stdout.write(String(p.run_id) + "\t" + String(p.sub || ""));
' 2>/dev/null)"
DECODE_STATUS=$?
CLAIM_RUN_ID="${CLAIM%%$'\t'*}"
CLAIM_AGENT_ID="${CLAIM#*$'\t'}"
[ "$CLAIM_AGENT_ID" = "$CLAIM" ] && CLAIM_AGENT_ID=""

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
echo "token sub (agent)  : ${CLAIM_AGENT_ID:-<absent>}"
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

# Watermark for the attribution read-back. The PATCH response body is the ISSUE
# object, and it carries no attribution for the write that just happened -
# `createdByAgentId` and `responsibleUserId` describe the issue, not this
# request - so there is nothing in it to assert on. The issue activity log is
# where a write's actor is recorded, and it is a shared append-only stream, so
# note the newest event's timestamp first and only consider events after it.
ACTIVITY_URL="$BASE/api/issues/$ISSUE_ID/activity?limit=25"
WATERMARK="$(auth_header | curl -sS -H @- "$ACTIVITY_URL" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const a=JSON.parse(s); const rows=Array.isArray(a)?a:[];
      let m=""; for (const r of rows) if (r && r.createdAt && String(r.createdAt) > m) m=String(r.createdAt);
      process.stdout.write(m);
    }catch{}})' 2>/dev/null)"

BODY="$(node -e 'process.stdout.write(JSON.stringify({priority:process.argv[1]}))' "$CUR_PRIORITY")"
PROBE="$(auth_header | curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/issues/$ISSUE_ID" \
  -H @- \
  -H "X-Paperclip-Run-Id: $CLAIM_RUN_ID" \
  -H 'Content-Type: application/json' \
  -d "$BODY" 2>/dev/null)"

# Read back how the control plane recorded the write we just made. Exit codes
# from the reader: 0 = attributed to this agent and this run, 3 = attributed to
# the board (laundered), 2 = no matching event, or one we cannot classify.
#
# Note on `responsibleUserId`: it reads `local-board` on a CORRECTLY attributed
# agent write too, because it is the human whose authority the agent rides (the
# token's own `responsible_user_id` claim). It is NOT the laundering signal and
# must not be tested. The signal is `actorType` / `actorId` / `runId`.
verify_attribution() {
  auth_header | curl -sS -H @- "$ACTIVITY_URL" 2>/dev/null | node -e '
    const [issueId, wantAgent, wantRun, watermark] = process.argv.slice(1);
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let rows;
      try { rows = JSON.parse(s); } catch { process.exit(2); }
      if (!Array.isArray(rows)) process.exit(2);
      // ISO-8601 with a fixed Z offset sorts lexicographically, so a string
      // compare is a correct "after the watermark" test and needs no Date parse.
      const fresh = rows.filter(r =>
        r && r.action === "issue.updated" && r.entityId === issueId &&
        (!watermark || String(r.createdAt || "") > watermark));
      if (!fresh.length) {
        console.error("no issue.updated event recorded after the probe");
        process.exit(2);
      }
      const mine = fresh.find(r =>
        r.actorType === "agent" && r.actorId === wantAgent && r.runId === wantRun);
      if (mine) {
        console.log("agent " + mine.actorId + " run " + mine.runId);
        process.exit(0);
      }
      const board = fresh.find(r => r.actorType !== "agent" || r.actorId === "local-board");
      if (board) {
        console.error("recorded as actorType=" + String(board.actorType) +
          " actorId=" + String(board.actorId) + " runId=" + String(board.runId));
        process.exit(3);
      }
      console.error("events found, but none match this agent/run and none look board-authored: " +
        fresh.map(r => r.actorType + ":" + r.actorId).join(", "));
      process.exit(2);
    });
  ' "$ISSUE_ID" "$CLAIM_AGENT_ID" "$CLAIM_RUN_ID" "$WATERMARK"
}

case "$PROBE" in
  2*)
    echo "write probe        : HTTP $PROBE - this run CAN write"

    if [ -z "$CLAIM_AGENT_ID" ]; then
      fail "the token carries no \`sub\` claim, so there is no expected agent id to"
      fail "compare against. The write landed, but whether it was attributed to you"
      fail "or to the board is UNVERIFIED. Check \`authorType\` on your first real write."
      exit 2
    fi

    ATTRIB="$(verify_attribution 2>&1)"
    ATTRIB_STATUS=$?
    case "$ATTRIB_STATUS" in
      0)
        echo "attribution        : $ATTRIB - write is recorded as THIS AGENT"
        exit 0
        ;;
      3)
        fail "attribution: $ATTRIB"
        fail "LAUNDERED: the write SUCCEEDED but was recorded as the board, not as you."
        fail "Do not write this heartbeat. A comment would land as a founder comment,"
        fail "firing an issue_commented wake; a status write gets founder reopen"
        fail "semantics and can move the issue and cancel a scheduled retry run."
        fail "Check that every call sends 'Authorization: Bearer' - the header name"
        fail "X-Paperclip-Api-Key is unrecognised and counts as no credential at all."
        fail "Report run id $CLAIM_RUN_ID in your final response."
        fail "See the laundered-write section of docs/paperclip-run-binding.md."
        exit 3
        ;;
      *)
        fail "attribution: $ATTRIB"
        fail "The write landed but its attribution could NOT be read back, so whether"
        fail "it was recorded as you or as the board is UNVERIFIED. This is not an"
        fail "all-clear: verify \`authorType\` in the response of your first real write."
        exit 2
        ;;
    esac
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
