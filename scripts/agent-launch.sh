#!/bin/bash
# Wrapper that Paperclip's adapterConfig.command points to instead of the
# raw `claude` binary. Mints a fresh, hour-lived GitHub App installation
# token scoped to this agent's repos (APPFORGE_AGENT_REPOS, set per-agent
# in adapterConfig.env - not sensitive, just a repo-name list), exports it
# as GH_TOKEN/GITHUB_TOKEN for gh/git, then execs the real claude binary
# with the original args. A stale bake-in isn't possible since a fresh
# token is minted on every run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_CLAUDE="${APPFORGE_REAL_CLAUDE_BIN:-$HOME/.local/bin/claude}"

if [ -z "${APPFORGE_AGENT_REPOS:-}" ]; then
  echo "agent-launch.sh: APPFORGE_AGENT_REPOS is not set - refusing to run without a defined repo scope" >&2
  exit 1
fi

TOKEN_JSON="$(node "$SCRIPT_DIR/github-app-token.mjs" --repos "$APPFORGE_AGENT_REPOS")"
GH_TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$TOKEN_JSON")"

if [ -z "$GH_TOKEN" ]; then
  echo "agent-launch.sh: failed to mint a GitHub App installation token" >&2
  exit 1
fi

export GH_TOKEN
export GITHUB_TOKEN="$GH_TOKEN"

exec "$REAL_CLAUDE" "$@"
