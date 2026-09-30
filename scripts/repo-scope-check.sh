#!/bin/bash
# Answer one question, in milliseconds, BEFORE a heartbeat implements anything:
# CAN THIS RUN PUSH TO THE REPO THE TASK IS ABOUT?
#
# Background and the measurement trap that hid this: docs/agent-repo-scope.md.
#
# Short version: agent-launch.sh mints a per-run GitHub App installation token
# scoped to the repos named in THIS AGENT'S `APPFORGE_AGENT_REPOS`, which is set
# per-agent in the Paperclip adapter config. Different agents get different
# lists. A repo outside your list 404s on read and fails `git push` with
# `remote: Repository not found.` - a message that reads like the repo is gone
# or the token is broken, when the repo is fine and the token is fine and simply
# does not cover it.
#
# The cost of finding this out late is the whole point of this script. On
# APP-249 a correct 21-line change was implemented and verified across three
# runs, two of which hit their turn limit, and then dead-ended at `git push`.
# Every one of those calls was spent before anything checked a variable that was
# already in the environment at turn one.
#
# Usage:
#   repo-scope-check.sh                 # infer the repo from the git remote at $PWD
#   repo-scope-check.sh appforge-control [more-repos...]
#
# Exit codes:
#   0  every named repo IS in this run's scope - push will be authorised
#   1  at least one named repo is NOT in scope - implementing before you
#      escalate will waste the run; escalate FIRST (see the message)
#   2  UNVERIFIED - the check could not be completed. Not an all-clear.
#
# This check is purely local: it reads two environment variables and makes no
# network call. It cannot be rate-limited, cannot fail transiently, and costs
# nothing. There is no run in which it is too expensive to run first.
set -uo pipefail

fail() { echo "repo-scope-check: $*" >&2; }

if [ -z "${APPFORGE_AGENT_REPOS:+x}" ]; then
  fail "APPFORGE_AGENT_REPOS is not set - not running under agent-launch.sh?"
  fail "Repo scope is UNVERIFIED. Do not read that as unrestricted."
  exit 2
fi

CRED="${APPFORGE_GIT_CREDENTIAL:-<unset>}"
echo "repo scope   : $APPFORGE_AGENT_REPOS"
echo "credential   : $CRED"

# The credential-free paths fail closed on every repo, so the scope list is
# moot. Report that as its own outcome rather than letting a name match imply
# a push will work.
case "$CRED" in
  none)
    fail "APPFORGE_GIT_CREDENTIAL=none - this run has NO git push credential at all."
    fail "https to github.com is MEANT to fail closed here. Do not route around it."
    exit 1
    ;;
  unavailable)
    fail "APPFORGE_GIT_CREDENTIAL=unavailable - the token mint failed transiently"
    fail "(APP-132 degraded path). This run cannot push to ANY repo. Do the work"
    fail "that does not need GitHub, and hand off the push."
    exit 1
    ;;
esac

if [ "$APPFORGE_AGENT_REPOS" = "none" ]; then
  fail "APPFORGE_AGENT_REPOS=none - this agent holds no repo capability."
  exit 1
fi

# No arguments: infer from the remote at $PWD. Only `origin` is consulted, and
# only to extract the repo name - this never contacts the remote.
REPOS=("$@")
if [ ${#REPOS[@]} -eq 0 ]; then
  if ! command -v git >/dev/null 2>&1; then
    fail "no repo named and git is not on PATH - cannot infer one."
    exit 2
  fi
  REMOTE="$(git config --get remote.origin.url 2>/dev/null)"
  if [ -z "$REMOTE" ]; then
    fail "no repo named and \$PWD has no 'origin' remote - name the repo explicitly."
    exit 2
  fi
  # Handles https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  INFERRED="${REMOTE##*/}"
  INFERRED="${INFERRED%.git}"
  if [ -z "$INFERRED" ]; then
    fail "could not parse a repo name out of origin '$REMOTE' - name it explicitly."
    exit 2
  fi
  echo "inferred repo: $INFERRED (from origin in $PWD)"
  REPOS=("$INFERRED")
fi

# Exact, comma-delimited membership. Substring matching would pass
# `appforge` for `appforge-control`, which is the false all-clear this
# script exists to prevent.
in_scope() {
  case ",${APPFORGE_AGENT_REPOS}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

MISSING=()
for r in "${REPOS[@]}"; do
  if in_scope "$r"; then
    echo "  in scope   : $r"
  else
    echo "  OUT OF SCOPE: $r"
    MISSING+=("$r")
  fi
done

if [ ${#MISSING[@]} -eq 0 ]; then
  exit 0
fi

fail ""
fail "NOT in this run's repo scope: ${MISSING[*]}"
fail ""
fail "What will happen if you implement anyway: the work will be correct, and"
fail "'git push' will end it with 'remote: Repository not found.' That message"
fail "is not about the repo or the token - both are fine. Your token does not"
fail "cover that repo."
fail ""
fail "Do NOT infer the App is uninstalled on it. 'GET /installation/repositories'"
fail "returns YOUR TOKEN'S repos, not the installation's selection, so it will"
fail "agree with you and be no evidence at all. See docs/agent-repo-scope.md."
fail ""
fail "Do this instead, at turn one:"
fail "  1. Say on the issue that the repo is outside your scope, and name it."
fail "  2. Escalate to your manager to have the task re-routed, or to have the"
fail "     scope widened - APPFORGE_AGENT_REPOS is per-agent Paperclip adapter"
fail "     config, NOT a GitHub setting, and widening it adds a permission,"
fail "     which is a founder/board call."
fail "  3. Only then decide whether any part of the task is still worth doing."
exit 1
