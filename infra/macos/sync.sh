#!/bin/bash
# sync.sh — catch-up sync for missed Paperclip routine fires (P0-03, the
# `appforge sync` half of §4.3 "Catch-up sync": "re-create today's routine
# issues that did not fire"). Runs on wake / periodically because this Mac
# sleeps when unplugged or the lid is closed, so Paperclip's cron routines
# only fire if the Mac happens to be awake at the scheduled instant.
#
# What it does:
#   1. Lists all routines for the AppForge AI company
#      (`paperclipai routine list --company-id <id> --json`).
#   2. For each *enabled schedule trigger*, computes the most recent cron
#      occurrence that should have already happened (parsing the trigger's
#      own `cronExpression` + `timezone` — no external cron library needed,
#      these are plain 5-field crons), bounded so it never looks further
#      back than the routine's own `createdAt` (otherwise a routine created
#      today with a weekly Monday schedule would wrongly look "overdue" for
#      last Monday, which predates the routine's existence).
#   3. If that occurrence is more than $GRACE_MINUTES late and Paperclip's
#      own `lastFiredAt` for that trigger doesn't already cover it, AND this
#      script's own state file hasn't already caught it up, it is genuinely
#      missed.
#   4. Missed occurrences are caught up via Paperclip's own on-demand run
#      endpoint — `paperclipai routine run <routineId>` — which is the same
#      mechanism a natural cron fire uses (confirmed via
#      `paperclipai routine --help` and the OpenAPI spec for
#      `POST /api/routines/{id}/run`: it creates the routine's normal
#      assignment issue against its existing `assigneeAgentId`, nothing
#      hand-rolled). An `idempotencyKey` (`catchup:<routineId>:<occurrence>`)
#      is also passed to Paperclip itself as a second line of defense.
#
# No fallback issue-creation logic is implemented here: `routine run` is a
# real, documented, on-demand trigger in this Paperclip version, so the
# "recreate the issue by hand" fallback the backlog item allowed for was not
# needed.
#
# Idempotency: this script keeps a local JSON state file
# ($STATE_FILE, one entry per trigger id: {"lastHandledOccurrence": <ISO>}).
# An occurrence is only ever caught up once — running this script twice in a
# row, or every 30 minutes forever, will not double-fire a routine, because
# (a) the state file remembers the latest occurrence already handled, and
# (b) Paperclip's own `lastFiredAt` is also checked, so a routine that fired
# normally between two sync runs is correctly left alone.
#
# Uses /usr/bin/curl and /usr/bin/python3 explicitly, not bare `curl`/
# `python3` — on this Mac, PATH can resolve to Anaconda's bundled copies,
# which ship their own CA bundle that does not trust the MDM root CA and
# fail all HTTPS with "self-signed certificate in certificate chain" (same
# issue documented in backup.sh, confirmed again while building this).
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CURL="/usr/bin/curl"
PYTHON3="/usr/bin/python3"
PAPERCLIPAI="$HOME/.local/bin/paperclipai"
export CLAUDE_CONFIG_DIR="$HOME/git-personal/appforge-control/.claude-appforge"

COMPANY_ID="18b2b6ef-fbaa-48d1-acf4-168841c269ae"   # AppForge AI (live company, P0-04/P0-05)
STATE_FILE="$HOME/git-personal/appforge-control/state/routine-sync-state.json"
GRACE_MINUTES="${SYNC_GRACE_MINUTES:-30}"

for v in HEALTHCHECKS_PING_URL_PAPERCLIP; do
  if [ -z "${!v:-}" ]; then
    echo "sync.sh: missing required env var $v" >&2
    exit 90
  fi
done

STAGE="starting"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/appforge-sync.XXXXXX")"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  local reason="$1"
  echo "sync.sh: FAILED at stage '$STAGE': $reason" >&2
  "$CURL" -fsS -m 10 --retry 3 -d "$STAGE: $reason" "${HEALTHCHECKS_PING_URL_PAPERCLIP%/}/fail" >/dev/null 2>&1 || true
  if [ -n "${NTFY_TOPIC:-}" ]; then
    "$CURL" -fsS -m 10 --retry 2 -d "AppForge sync failed at $STAGE: $reason" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
  fi
  exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

mkdir -p "$(dirname "$STATE_FILE")"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

# --- detect.py: pure computation. Reads routines JSON on stdin, reads (but
# does not write) the state file, prints a JSON array of missed occurrences
# to catch up. State is only ever written after a catch-up actually
# succeeds (below), so a crash here never marks anything handled that
# wasn't.
cat >"$WORKDIR/detect.py" <<'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

state_file, grace_minutes = sys.argv[1], float(sys.argv[2])
now = datetime.now(timezone.utc)
routines = json.load(sys.stdin)

try:
    with open(state_file) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {}


def parse_iso(ts):
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def field_match(value, field, lo, hi):
    if field == "*":
        return True
    for part in field.split(","):
        if "/" in part:
            rng, step_s = part.split("/")
            step = int(step_s)
            if rng == "*":
                a, b = lo, hi
            elif "-" in rng:
                a, b = (int(x) for x in rng.split("-"))
            else:
                a = b = int(rng)
            if a <= value <= b and (value - a) % step == 0:
                return True
        elif "-" in part:
            a, b = (int(x) for x in part.split("-"))
            if a <= value <= b:
                return True
        elif value == int(part):
            return True
    return False


def cron_matches(dt_local, cron_expr):
    minute, hour, dom, month, dow = cron_expr.split()
    if not field_match(dt_local.minute, minute, 0, 59):
        return False
    if not field_match(dt_local.hour, hour, 0, 23):
        return False
    if not field_match(dt_local.month, month, 1, 12):
        return False
    dow = dow.replace("7", "0")  # cron alias: 7 == Sunday == 0
    py_dow = dt_local.isoweekday() % 7  # cron: 0=Sunday..6=Saturday
    dom_star, dow_star = dom == "*", dow == "*"
    dom_ok = field_match(dt_local.day, dom, 1, 31)
    dow_ok = field_match(py_dow, dow, 0, 6)
    if dom_star and dow_star:
        return True
    if dom_star:
        return dow_ok
    if dow_star:
        return dom_ok
    return dom_ok or dow_ok  # standard cron rule: OR, not AND, when both set


def most_recent_occurrence(cron_expr, tz_name, not_before_utc, search_days=14):
    tz = ZoneInfo(tz_name)
    candidate = now.astimezone(tz).replace(second=0, microsecond=0)
    earliest = candidate - timedelta(days=search_days)
    while candidate >= earliest:
        candidate_utc = candidate.astimezone(timezone.utc)
        if candidate_utc <= not_before_utc:
            return None  # nothing due since this trigger/routine was created
        if cron_matches(candidate, cron_expr):
            return candidate_utc
        candidate -= timedelta(minutes=1)
    return None


candidates = []
for r in routines:
    if r.get("status") != "active":
        continue
    routine_created = parse_iso(r.get("createdAt")) or (now - timedelta(days=3650))
    for t in r.get("triggers", []):
        if t.get("kind") != "schedule" or not t.get("enabled"):
            continue
        cron_expr, tz_name = t.get("cronExpression"), t.get("timezone") or "UTC"
        if not cron_expr:
            continue
        occurrence = most_recent_occurrence(cron_expr, tz_name, routine_created)
        if occurrence is None:
            continue
        if (now - occurrence).total_seconds() <= grace_minutes * 60:
            continue  # not overdue yet -- still inside its own grace window
        last_fired = parse_iso(t.get("lastFiredAt"))
        if last_fired and last_fired >= occurrence - timedelta(seconds=60):
            continue  # Paperclip already fired this occurrence naturally
        last_handled = parse_iso(state.get(t["id"], {}).get("lastHandledOccurrence"))
        if last_handled and last_handled >= occurrence:
            continue  # this sync script already caught this one up before
        candidates.append({
            "routineId": r["id"],
            "triggerId": t["id"],
            "title": (r.get("title") or "").replace("\t", " ").replace("\n", " "),
            "occurrence": occurrence.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

print(json.dumps(candidates))
PYEOF

# --- 1. Fetch live routines ---
STAGE="list-routines"
ROUTINES_JSON="$("$PAPERCLIPAI" routine list --company-id "$COMPANY_ID" --json 2>&1)" \
  || fail "paperclipai routine list failed: $ROUTINES_JSON"

# --- 2. Detect overdue triggers ---
STAGE="detect"
CANDIDATES_JSON="$("$PYTHON3" "$WORKDIR/detect.py" "$STATE_FILE" "$GRACE_MINUTES" <<<"$ROUTINES_JSON")" \
  || fail "overdue-detection failed: $CANDIDATES_JSON"

CANDIDATE_COUNT="$("$PYTHON3" -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"$CANDIDATES_JSON")"
echo "sync.sh: checked routines, found $CANDIDATE_COUNT missed occurrence(s)"

# --- 3. Catch up each missed occurrence via Paperclip's own run endpoint ---
STAGE="catch-up"
FIRED=0
FAILURES=0
while IFS=$'\t' read -r routine_id trigger_id title occurrence; do
  [ -z "$routine_id" ] && continue
  IDEMPOTENCY_KEY="catchup:$routine_id:$occurrence"
  RUN_PAYLOAD="$("$PYTHON3" -c 'import json,sys; print(json.dumps({"source":"api","idempotencyKey":sys.argv[1]}))' "$IDEMPOTENCY_KEY")"
  if RUN_OUT="$("$PAPERCLIPAI" routine run "$routine_id" --payload-json "$RUN_PAYLOAD" --json 2>&1)"; then
    echo "sync.sh: caught up routine '$title' ($routine_id) for missed occurrence $occurrence"
    FIRED=$((FIRED + 1))
    "$PYTHON3" -c '
import json, sys
state_file, trigger_id, occurrence = sys.argv[1], sys.argv[2], sys.argv[3]
with open(state_file) as f:
    state = json.load(f)
state.setdefault(trigger_id, {})["lastHandledOccurrence"] = occurrence
with open(state_file, "w") as f:
    json.dump(state, f, indent=2, sort_keys=True)
' "$STATE_FILE" "$trigger_id" "$occurrence" || fail "could not persist state after firing routine $routine_id"
  else
    echo "sync.sh: FAILED to fire routine '$title' ($routine_id) for occurrence $occurrence: $RUN_OUT" >&2
    FAILURES=$((FAILURES + 1))
  fi
done < <("$PYTHON3" -c '
import json, sys
for c in json.load(sys.stdin):
    print("\t".join([c["routineId"], c["triggerId"], c["title"], c["occurrence"]]))
' <<<"$CANDIDATES_JSON")

if [ "$FAILURES" -gt 0 ]; then
  fail "$FAILURES of $CANDIDATE_COUNT routine catch-up run(s) failed to fire (see log above)"
fi

# --- 4. Success ping (a "checked, nothing overdue" run is still a healthy run) ---
STAGE="healthcheck-ping"
"$CURL" -fsS -m 10 --retry 3 "$HEALTHCHECKS_PING_URL_PAPERCLIP" >/dev/null || fail "success ping to healthchecks.io failed"

echo "sync.sh: ok — $CANDIDATE_COUNT missed occurrence(s) found, $FIRED caught up"
