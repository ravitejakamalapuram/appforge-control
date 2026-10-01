#!/bin/bash
# backup.sh — nightly encrypted Paperclip DB backup to Cloudflare R2 (P0-03).
#
# What it does:
#   1. Dumps the Paperclip database via `paperclipai db:backup`. This is the
#      officially supported path: Paperclip's embedded Postgres
#      (embedded-postgres@54329 under ~/.paperclip/instances/default/db/) is
#      driven entirely by the paperclipai CLI itself — there is no separate
#      vendored pg_dump binary to shell out to, and the CLI already gzips the
#      dump for us (paperclip-<ts>.sql.gz).
#   2. age-encrypts that file with the backup public key and deletes the
#      plaintext dump immediately.
#   3. Uploads the encrypted file to R2 under paperclip-db/.
#   4. Prunes R2 to the last 14 daily + 8 weekly encrypted backups.
#   5. Pings healthchecks.io on success/failure; pushes an ntfy alert on
#      failure (SEV-worthy per the master plan's ops framework).
#
# Required environment (baked into the LaunchAgent plist for scheduled runs;
# export these yourself for a manual test run — see infra/macos/README.md):
#   CLOUDFLARE_R2_API_TOKEN       Cloudflare API token scoped to R2. Used both
#                                 as wrangler's CLOUDFLARE_API_TOKEN and as the
#                                 Bearer token for the Cloudflare REST API
#                                 listing call below (wrangler has no
#                                 `r2 object list` command — only get/put/
#                                 delete exist on this wrangler version, so
#                                 listing for retention goes through
#                                 api.cloudflare.com directly instead).
#   CLOUDFLARE_ACCOUNT_ID         Must be passed explicitly — this token lacks
#                                 the permission wrangler's own account
#                                 auto-lookup needs.
#   HEALTHCHECKS_PING_URL_BACKUP  Dead-man's-switch ping URL.
#   NTFY_TOPIC                   ntfy.sh topic for founder push alerts.
#
# Never leaves a plaintext dump on disk: all work happens in a mktemp -d
# workdir that is removed on every exit path (success, failure, or signal).
#
# Uses /usr/bin/curl and /usr/bin/python3 explicitly, not bare `curl`/
# `python3` — on this Mac, PATH can resolve to Anaconda's bundled curl, which
# ships its own CA bundle that does not trust the MDM root CA and fails all
# HTTPS with "self-signed certificate in certificate chain".
set -euo pipefail
# APP-294: stamp state/heartbeats/backup.json so a missed or failed run is detected.
. "$(dirname "${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap backup "$@"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CURL="/usr/bin/curl"
PYTHON3="/usr/bin/python3"
PAPERCLIPAI="$HOME/.local/bin/paperclipai"
AGE_KEY_FILE="$HOME/git-personal/appforge-control/secrets/backup-age-key.txt"
R2_BUCKET="appforge-backups"
R2_PREFIX="paperclip-db"
DAILY_KEEP=14
WEEKLY_KEEP=8

for v in CLOUDFLARE_R2_API_TOKEN CLOUDFLARE_ACCOUNT_ID HEALTHCHECKS_PING_URL_BACKUP NTFY_TOPIC; do
  if [ -z "${!v:-}" ]; then
    echo "backup.sh: missing required env var $v" >&2
    exit 90
  fi
done

STAGE="starting"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/appforge-backup.XXXXXX")"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  local reason="$1"
  echo "backup.sh: FAILED at stage '$STAGE': $reason" >&2
  "$CURL" -fsS -m 10 --retry 3 -d "$STAGE: $reason" "${HEALTHCHECKS_PING_URL_BACKUP%/}/fail" >/dev/null 2>&1 || true
  "$CURL" -fsS -m 10 --retry 2 -d "AppForge backup failed at $STAGE: $reason" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
  exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

# Lists paperclip-db/*.sql.gz.age in the bucket (newest key first — the
# ISO-8601 timestamp in the filename sorts lexicographically the same as
# chronologically), then deletes everything past the retention window: the
# most recent $DAILY_KEEP are always kept; beyond that, at most one backup
# per ISO week is kept for the next $WEEKLY_KEEP distinct weeks, and anything
# older than that is deleted.
prune_old_backups() {
  local listing keys
  listing="$("$CURL" -fsS -m 20 --retry 3 \
    -H "Authorization: Bearer $CLOUDFLARE_R2_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$R2_BUCKET/objects?prefix=$R2_PREFIX/")" || return 1

  keys="$("$PYTHON3" -c "
import json, sys
data = json.loads(sys.argv[1])
if not data.get('success'):
    print('LIST_ERROR:' + json.dumps(data.get('errors')), file=sys.stderr)
    sys.exit(1)
ks = sorted((o['key'] for o in data['result'] if o['key'].endswith('.sql.gz.age')), reverse=True)
print('\n'.join(ks))
" "$listing")" || return 1

  if [ -z "$keys" ]; then
    echo "prune: no backups found under $R2_PREFIX/"
    return 0
  fi

  local i=0 week_count=0 last_week="" to_delete=()
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    i=$((i + 1))
    if [ "$i" -le "$DAILY_KEEP" ]; then
      continue # inside the daily retention window — always keep
    fi
    local base datepart weekkey
    base="$(basename "$key")"
    datepart="${base#backup-}"
    datepart="${datepart:0:8}"
    weekkey="$(date -j -f "%Y%m%d" "$datepart" "+%G-%V" 2>/dev/null || echo "unparseable-$key")"
    if [ "$weekkey" != "$last_week" ] && [ "$week_count" -lt "$WEEKLY_KEEP" ]; then
      last_week="$weekkey"
      week_count=$((week_count + 1))
      continue # newest backup seen for this ISO week, within the weekly budget — keep
    fi
    to_delete+=("$key")
  done <<<"$keys"

  if [ "${#to_delete[@]}" -eq 0 ]; then
    echo "prune: nothing to delete (${i} backups within retention)"
    return 0
  fi

  local k
  for k in "${to_delete[@]}"; do
    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_R2_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
      wrangler r2 object delete "$R2_BUCKET/$k" --remote >/dev/null || return 1
    echo "prune: deleted $k"
  done
}

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# --- 1. Dump ---
STAGE="db-dump"
BACKUP_RAW="$("$PAPERCLIPAI" db:backup --dir "$WORKDIR" --json --filename-prefix paperclip --retention-days 1 2>&1)" \
  || fail "paperclipai db:backup failed: $BACKUP_RAW"
# --json still wraps the JSON in the CLI's decorative ANSI-colored banner
# (escape codes run right up against the "{" with no newline in between), so
# strip ANSI escapes and pull out the { ... } block before parsing.
DUMP_FILE="$("$PYTHON3" -c "
import json, re, sys
raw = sys.stdin.read()
clean = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', raw)
start = clean.index('{')
end = clean.rindex('}') + 1
obj = json.loads(clean[start:end])
print(obj['backupFile'])
" <<<"$BACKUP_RAW")" || fail "could not parse backupFile from db:backup --json output: $BACKUP_RAW"
[ -f "$DUMP_FILE" ] || fail "backup file reported but not found on disk: $DUMP_FILE"

LOCAL_DUMP="$WORKDIR/backup-$TIMESTAMP.sql.gz"
mv "$DUMP_FILE" "$LOCAL_DUMP"

# --- 2. Encrypt, then delete the plaintext dump immediately ---
STAGE="encrypt"
AGE_PUBKEY="$(grep "public key" "$AGE_KEY_FILE" | sed 's/.*: //')"
[ -n "$AGE_PUBKEY" ] || fail "could not read age public key from $AGE_KEY_FILE"
ENCRYPTED="$LOCAL_DUMP.age"
age -r "$AGE_PUBKEY" -o "$ENCRYPTED" "$LOCAL_DUMP" || fail "age encryption failed"
rm -f "$LOCAL_DUMP"

# --- 3. Upload to R2 ---
STAGE="upload"
R2_KEY="$R2_PREFIX/backup-$TIMESTAMP.sql.gz.age"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_R2_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  wrangler r2 object put "$R2_BUCKET/$R2_KEY" --file "$ENCRYPTED" --remote >/dev/null \
  || fail "wrangler r2 object put failed"
rm -f "$ENCRYPTED"

# --- 4. Retention (only after a successful upload) ---
STAGE="retention"
prune_old_backups || fail "retention pruning failed"

# --- 5. Success ping ---
STAGE="healthcheck-ping"
"$CURL" -fsS -m 10 --retry 3 "$HEALTHCHECKS_PING_URL_BACKUP" >/dev/null || fail "success ping to healthchecks.io failed"

echo "backup.sh: ok — uploaded $R2_KEY"
