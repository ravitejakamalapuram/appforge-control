#!/bin/bash
# paperclip-lock-guard.sh - clear Paperclip's embedded-Postgres lock file when,
# and only when, it is provably stale.
#
# WHY THIS EXISTS: after an unclean shutdown (kernel panic 2026-09-28, forced
# reboot 2026-09-29 23:57 IST) db/postmaster.pid is left behind. Its pid is
# reused by an unrelated system daemon (cfprefsd), so Paperclip refuses to start
# ("Refusing to reuse PostgreSQL: its data directory belongs to another
# instance") and ing.paperclip.paperclipai crash-loops until someone moves the
# file aside by hand. Twice in 48h. This job does that step, safely.
#
# SAFETY MODEL - it acts only if EVERY one of these holds, in this order:
#   1. postmaster.pid exists
#   2. the API is not healthy (GET $PAPERCLIP_HEALTH_URL is not 200 within 3s)
#   3. the lock is older than MIN_LOCK_AGE_SEC (a start may be in progress)
#   4. the pid in the lock is not a live postgres/postmaster process
#   5. no postgres/postmaster process anywhere has THIS data dir in its args
# Then it MOVES the file to postmaster.pid.stale-<UTC> (never rm: reversible)
# and keeps the newest 5 such files. It touches nothing else in the db dir.
# Every "not sure" answer is "do nothing": a stuck-down Paperclip is annoying,
# a lock removed under a live Postgres can corrupt the database.
#
# Deliberately no `set -e` / `set -u`: every path must reach an explicit
# `exit 0` so launchd never sees this job as failing because of a hiccup.
#
# Config (env, all optional; overridden by tests):
#   PAPERCLIP_DB_DIR      default ~/.paperclip/instances/default/db
#   PAPERCLIP_HEALTH_URL  default http://127.0.0.1:3100/api/health
#   MIN_LOCK_AGE_SEC      default 60
#   PAPERCLIP_GUARD_LOG   default ~/git-personal/appforge-control/logs/paperclip-lock-guard.log
#   NTFY_TOPIC            if set, a low-priority push is sent when a lock is cleared
#   NTFY_URL_BASE         default https://ntfy.sh

export LC_ALL=C

DB_DIR="${PAPERCLIP_DB_DIR:-$HOME/.paperclip/instances/default/db}"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
MIN_LOCK_AGE_SEC="${MIN_LOCK_AGE_SEC:-60}"
LOG="${PAPERCLIP_GUARD_LOG:-$HOME/git-personal/appforge-control/logs/paperclip-lock-guard.log}"
NTFY_URL_BASE="${NTFY_URL_BASE:-https://ntfy.sh}"
KEEP_STALE=5
LOCK="$DB_DIR/postmaster.pid"

case "$MIN_LOCK_AGE_SEC" in ''|*[!0-9]*) MIN_LOCK_AGE_SEC=60 ;; esac

log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  printf '%s paperclip-lock-guard: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG" 2>/dev/null
  return 0
}

# Runs once a minute forever: keep the log bounded (~1000 lines once past 512KB).
trim_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(wc -c <"$LOG" 2>/dev/null | tr -d ' ')
  [ "${size:-0}" -gt 524288 ] || return 0
  tail -n 1000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
  return 0
}

trim_ws() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "$s"
}

# True if the first word of a `ps` command line is postgres or postmaster
# (path and a trailing ":" stripped, so "postgres: io worker" counts too).
first_word_is_postgres() {
  local tok="${1%% *}"
  tok="${tok##*/}"
  tok="${tok%:}"
  case "$tok" in postgres|postmaster) return 0 ;; esac
  return 1
}

# True if some process IS postgres/postmaster AND has this data dir in its args.
# Strings go through the environment, not argv: an awk whose own argv contained
# "postgres" and the dir would find itself and always report an owner.
datadir_has_owner() {
  ps -axo pid=,command= 2>/dev/null | GUARD_DIR="$DB_DIR" GUARD_ME="$$" awk '
    {
      if ($1 == ENVIRON["GUARD_ME"]) next
      tok = $2; sub(/^.*\//, "", tok); sub(/:$/, "", tok)
      if ((tok == "postgres" || tok == "postmaster") && index($0, ENVIRON["GUARD_DIR"]) > 0) found = 1
    }
    END { exit found ? 0 : 1 }'
}

prune_stale() {
  local f i=0
  for f in "$DB_DIR"/postmaster.pid.stale-*; do
    [ -e "$f" ] && printf '%s\n' "$f"
  done | sort -r | while IFS= read -r f; do
    i=$((i + 1))
    [ "$i" -le "$KEEP_STALE" ] || rm -f -- "$f"
  done
  return 0
}

trim_log

# 1. Nothing to do without a lock file.
if [ ! -f "$LOCK" ]; then
  log "no lock file at $LOCK, nothing to do"
  exit 0
fi

# 2. A healthy API means Postgres is up and the lock is live.
code=$(/usr/bin/curl -s -o /dev/null -m 3 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)
if [ "$code" = "200" ]; then
  log "healthy, nothing to do (lock present, API answered 200)"
  exit 0
fi

# 3. A young lock plus an API that is not up yet looks like a start in progress.
mtime=$(stat -f %m "$LOCK" 2>/dev/null)
case "$mtime" in ''|*[!0-9]*) mtime=$(stat -c %Y "$LOCK" 2>/dev/null) ;; esac
case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac
age=$(( $(date +%s) - mtime ))
if [ "$age" -lt "$MIN_LOCK_AGE_SEC" ]; then
  log "lock is fresh (${age}s < ${MIN_LOCK_AGE_SEC}s) and API is not up yet (HTTP ${code:-none}): a start may be in progress, leaving it"
  exit 0
fi

# 4. Is the pid recorded in the lock a live postgres?
pid=$(head -n 1 "$LOCK" 2>/dev/null | tr -d '[:space:]')
case "$pid" in ''|*[!0-9]*) pid="" ;; esac
cur=""
if [ -n "$pid" ]; then
  cur=$(trim_ws "$(ps -p "$pid" -o command= 2>/dev/null)")
fi
if [ -n "$cur" ] && first_word_is_postgres "$cur"; then
  log "lock owner pid $pid is alive and is postgres ($(printf '%s' "$cur" | cut -c1-100)): real owner, leaving the lock even though the API is not healthy (HTTP ${code:-none})"
  exit 0
fi

# 5. Or is any postgres running against THIS data dir, whatever the lock says?
if datadir_has_owner; then
  log "a postgres process is running on data dir $DB_DIR (lock pid ${pid:-unparseable} is not it): real owner, leaving the lock"
  exit 0
fi

# 6. Stale. Move it aside; never delete.
what="no such process"
[ -n "$cur" ] && what=$(printf '%s' "$cur" | cut -c1-80)
ts=$(date -u +%Y%m%dT%H%M%SZ)
dest="$LOCK.stale-$ts"
if mv -n "$LOCK" "$dest" 2>/dev/null && [ ! -e "$LOCK" ]; then
  log "stale lock: pid ${pid:-unparseable} is now: ${what}; API HTTP ${code:-none}; lock age ${age}s. moved aside -> $(basename "$dest")"
  prune_stale
  if [ -n "${NTFY_TOPIC:-}" ]; then
    /usr/bin/curl -s -m 5 -o /dev/null \
      -H "Priority: low" -H "Title: Paperclip stale Postgres lock auto-cleared" \
      -d "Paperclip stale Postgres lock auto-cleared: pid ${pid:-unparseable} was ${what}. Kept as $(basename "$dest")." \
      "${NTFY_URL_BASE%/}/${NTFY_TOPIC}" >/dev/null 2>&1 || log "ntfy push failed (ignored)"
  fi
else
  log "WARNING: lock looks stale (pid ${pid:-unparseable} is now: ${what}) but could not be moved to $(basename "$dest"); leaving it for a human"
fi
exit 0
