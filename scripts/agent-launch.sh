#!/bin/bash
# Wrapper that Paperclip's adapterConfig.command points to instead of the
# raw `claude` binary. Mints a fresh, hour-lived GitHub App installation
# token scoped to this agent's repos (APPFORGE_AGENT_REPOS, set per-agent
# in adapterConfig.env - not sensitive, just a repo-name list), exports it
# as GH_TOKEN/GITHUB_TOKEN for gh/git, then execs the real claude binary
# with the original args. A stale bake-in isn't possible since a fresh
# token is minted on every run.
#
# The literal value `none` means the agent has no repo capability at all:
# nothing is minted, and the two credential paths this wrapper can actually
# reach are closed before exec. Read the NO-REPO section below before
# changing it - the obvious one-line version of that branch is a privilege
# ESCALATION, not a restriction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_CLAUDE="${APPFORGE_REAL_CLAUDE_BIN:-$HOME/.local/bin/claude}"

if [ -z "${APPFORGE_AGENT_REPOS:-}" ]; then
  echo "agent-launch.sh: APPFORGE_AGENT_REPOS is not set - refusing to run without a defined repo scope" >&2
  exit 1
fi

# ---------------------------------------------------------------- NO-REPO ----
# APPFORGE_AGENT_REPOS=none => this agent has no repo:* capability in
# config/agents.yaml (today: analyst, whose agents/analyst/TOOLS.md deny list
# reads "No GH_TOKEN, no GITHUB_APP_* private keys").
#
# Observed 2026-09-28 (APP-41): an Analyst run held GH_TOKEN and GITHUB_TOKEN
# despite that deny list, because this wrapper minted and exported them
# unconditionally. A denial that lives only in a markdown file is not a
# boundary.
#
# WHY THIS IS NOT JUST `unset GH_TOKEN GITHUB_TOKEN`:
# gh's auth precedence is env token FIRST, then hosts.yml + the OS keyring.
# This machine has two personal accounts logged into the keyring, both with
# full `repo` scope on EVERY repo the founder owns. Unsetting the env token
# alone makes gh silently fall through to those - so the "restricted" agent
# would end up with BROADER access than the App token it just lost (the App
# is installed on 11 repos and deliberately excludes InvTrack and
# release-platform; the founder's personal token excludes nothing).
# Verified: with the env tokens unset, `gh auth status` reports the keyring
# accounts as logged in; with GH_CONFIG_DIR also pointed at an empty dir it
# reports "not logged into any GitHub hosts".
#
# So: scrub the env tokens AND give gh a private, empty config dir. mktemp
# per run rather than a fixed path, because gh writes config.yml into
# GH_CONFIG_DIR on first use and a shared dir would accumulate state.
#
# GH_CONFIG_DIR alone is NOT enough: raw git never consults it. Its
# credential helpers are a separate path, and on this machine they hand out a
# personal token. Measured 2026-09-28 with GH_TOKEN/GITHUB_TOKEN unset:
#
#   $ printf 'protocol=https\nhost=github.com\n\n' | git credential fill
#   username=rkamalapuram_tkinc
#   password=gho_...                 <- personal token, scopes: repo, gist, ...
#
# That token carries `repo` on EVERY repo the founder owns, including the two
# the App deliberately excludes (InvTrack, release-platform). So a "restricted"
# agent could reach more via git than an unrestricted one reaches via gh.
#
# The fix (suggested by the founder, verified here) is git's env-var config:
# GIT_CONFIG_COUNT/KEY_n/VALUE_n apply only to this process tree and leave the
# founder's ~/.gitconfig untouched. An empty credential.helper resets the
# accumulated helper list. Note it must be the GENERIC key even though
# ~/.gitconfig configures the URL-scoped `credential.https://github.com.helper`
# (-> `!gh auth git-credential`, an absolute path, so PATH scrubbing does not
# reach it): git accumulates helpers from the generic and URL-matched keys into
# ONE list, and because env config is applied last, the empty value clears the
# whole list. Verified - the `git credential fill` above then fails with
# "could not read Username", i.e. no credential at all.
#
# WHAT THIS DOES NOT CLOSE (deliberately not overclaimed - see APP-52):
#   1. secrets/appforge-agents.private-key.pem is readable by this uid, so a
#      no-repo agent can run scripts/github-app-token.mjs and mint its own
#      token.
#   2. ~/.ssh holds keys that can push to any repo the founder can, and the
#      product repos' git remotes are switchable to ssh. This wrapper only
#      governs https; an agent that rewrites a remote to ssh bypasses it.
# Both need OS-level isolation (separate uid or a sandboxed HOME), not a
# wrapper script.
if [ "$APPFORGE_AGENT_REPOS" = "none" ]; then
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN
  GH_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/appforge-gh-noauth.XXXXXX")"
  export GH_CONFIG_DIR
  # No extraheader here: this agent gets no token, so git https to github.com
  # must fail closed rather than fall through to the keychain.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0=""
  exec "$REAL_CLAUDE" "$@"
fi
# -------------------------------------------------------------------------- --

TOKEN_JSON="$(node "$SCRIPT_DIR/github-app-token.mjs" --repos "$APPFORGE_AGENT_REPOS")"
GH_TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$TOKEN_JSON")"

if [ -z "$GH_TOKEN" ]; then
  echo "agent-launch.sh: failed to mint a GitHub App installation token" >&2
  exit 1
fi

export GH_TOKEN
export GITHUB_TOKEN="$GH_TOKEN"

# Same credential-helper reset as the no-repo path, plus an explicit
# Authorization header so raw git still has a way to authenticate - GH_TOKEN
# is read by `gh`, not by git. Until now agent pushes worked only because the
# `!gh auth git-credential` helper relayed it; with helpers reset, that relay
# is gone and this header replaces it.
#
# Net effect: git to github.com authenticates via THIS scoped, hour-lived App
# token and nothing else. Requests to repos outside the installation (InvTrack,
# release-platform) now fail closed instead of silently succeeding on the
# founder's personal token.
#
# The header is basic auth over `x-access-token:<token>`, GitHub's documented
# form for App installation tokens. It is no more exposed than GH_TOKEN, which
# is already in this environment.
GIT_AUTH_B64="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=""
export GIT_CONFIG_KEY_1="http.https://github.com/.extraheader"
export GIT_CONFIG_VALUE_1="AUTHORIZATION: basic $GIT_AUTH_B64"
unset GIT_AUTH_B64

exec "$REAL_CLAUDE" "$@"
