#!/usr/bin/env bash
# play-ingest.sh — launchd entrypoint for the Play reviews ingest (APP-210).
#
# The board ruled on 2026-09-30 that this is a deterministic script, not an
# agent run: ingest is plumbing, not judgement, so no model call and no LLM
# ever sits between the credential and the manifest.
#
# THE CREDENTIAL IS A PATH, NOT A VALUE. `PLAY_READONLY_INGEST_KEY_FILE` names
# a mode-0600 JSON key the founder placed on this machine. That is why the
# plist template is safe to commit and why `.envrc` is a safe place to set it:
# neither file ever holds the key. A plist carrying the JSON itself would be a
# second copy of a credential, with a second lifetime and a second way to leak.
#
# This script is not reachable from an agent run and does not read or write
# Paperclip. It touches exactly two things: Google's read-only endpoint and
# data/metrics/ in this repo.
#
#   play-ingest.sh [--dry-run]
#
# Exit codes: 0 ok, 1 ingest failed, 2 bad usage/missing configuration.

set -uo pipefail

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "usage: play-ingest.sh [--dry-run]" >&2; exit 2 ;;
esac

REPO="${APPFORGE_REPO:-$HOME/git-personal/appforge-control}"
LOG_TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "${PLAY_READONLY_INGEST_KEY_FILE:-}" ]; then
  echo "$(LOG_TS) play-ingest: PLAY_READONLY_INGEST_KEY_FILE is unset." >&2
  echo "  It holds the PATH to the service-account JSON key on this machine, never the key." >&2
  echo "  Set it in ~/git-personal/.envrc and re-run infra/macos/install-plists.sh play-ingest." >&2
  exit 2
fi

# Named, not echoed. The path is not a secret; the file's contents are, and
# nothing below ever reads them — only node does, and only to sign a JWT.
if [ ! -f "$PLAY_READONLY_INGEST_KEY_FILE" ]; then
  echo "$(LOG_TS) play-ingest: no key file at $PLAY_READONLY_INGEST_KEY_FILE" >&2
  exit 2
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "$(LOG_TS) play-ingest: node not on PATH ($PATH)" >&2
  exit 2
fi

cd "$REPO" || { echo "$(LOG_TS) play-ingest: no repo at $REPO" >&2; exit 2; }

echo "$(LOG_TS) play-ingest: starting$([ "$DRY" -eq 1 ] && echo ' (dry-run)')"
if [ "$DRY" -eq 1 ]; then
  "$NODE" scripts/play-reviews-ingest.mjs --dry-run
else
  "$NODE" scripts/play-reviews-ingest.mjs
fi
rc=$?
echo "$(LOG_TS) play-ingest: exit $rc"
exit "$rc"
