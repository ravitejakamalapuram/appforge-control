#!/bin/bash
# Backstop for the run-scratch worktree convention (APP-72, from APP-48 §2).
#
# Agents no longer switch branches in the shared ~/git-personal/<repo> checkout;
# they run `git worktree add --detach "$PAPERCLIP_RUN_SCRATCH_DIR/<repo>-<issue>"`
# and remove it at end of run. Paperclip deletes that scratch directory when the
# run ends, but nothing deletes the `.git/worktrees/<name>/` administrative entry
# that points into it. A run that dies before its own `worktree remove` therefore
# leaks an entry permanently, and enough of those make `git worktree list`
# unreadable - which is how APP-48's three collisions went unnoticed in the first
# place.
#
# `git worktree prune` removes ONLY entries whose working directory no longer
# exists, so it can never touch a concurrently live run's worktree. That is the
# property this whole backstop rests on: it is safe to run at launch, while other
# agents are mid-run.
#
# Best-effort by design. A repo that is absent, is not a git repo, or is mid-
# operation must never stop an agent from launching, so every failure is
# swallowed and the script always exits 0.
#
# Usage: prune-agent-worktrees.sh <comma-separated-repo-names>
#   APPFORGE_REPO_ROOT overrides the checkout root (default ~/git-personal).
#   The literal value `none` means "no repo scope" and prunes nothing.
set -uo pipefail

REPOS="${1:-}"
ROOT="${APPFORGE_REPO_ROOT:-$HOME/git-personal}"

if [ -z "$REPOS" ] || [ "$REPOS" = "none" ]; then
  exit 0
fi

IFS=',' read -r -a APPFORGE_PRUNE_REPOS <<< "$REPOS"
for repo in "${APPFORGE_PRUNE_REPOS[@]}"; do
  [ -n "$repo" ] || continue
  # A worktree's own .git is a file, the main checkout's is a directory; accept
  # either so this is not subtly wrong if the root ever holds one.
  if [ -d "$ROOT/$repo/.git" ] || [ -f "$ROOT/$repo/.git" ]; then
    git -C "$ROOT/$repo" worktree prune >/dev/null 2>&1 || true
  fi
done

exit 0
