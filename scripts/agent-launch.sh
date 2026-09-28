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
#
# Containment (board approval 2569ea51, APP-60) applies to EVERY path through
# this script, before the repo scope is even looked at:
#   Control A - GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_CONFIG_NOSYSTEM, so
#               agents read the AppForge-owned .gitconfig-appforge instead of
#               the founder's ~/.gitconfig (`!gh auth git-credential`) and
#               Apple's system gitconfig (`osxkeychain`).
#   Control B - GH_CONFIG_DIR, a per-run empty dir, so `gh` itself has no
#               logged-in founder account to act as: `gh auth status`, `gh api`
#               and `gh pr` see no host, whether gh is reached by PATH or by
#               absolute path.
#
# These two are NOT equal partners, and an earlier version of this comment had
# it backwards (APP-97). Measured per-control, 2026-09-28:
#
#   no containment          -> git credential fill returns a founder token
#   Control A alone         -> no credential. SUFFICIENT.
#   Control B alone         -> git credential fill returns a founder token.
#                              NOT sufficient.
#
# A is what closes C3, on its own: it resets the accumulated credential.helper
# list so no git operation can reach a founder credential. B is hygiene layered
# on top - it keeps gh from acting as a founder ACCOUNT. B does not remove the
# authenticated state the helper reads: that state lives in the OS keyring, not
# in GH_CONFIG_DIR (~/.config/gh/hosts.yml carries no oauth_token). Do not relax
# A on the belief that B still holds the line; it does not. See the APP-60
# plan, and item 3 under WHAT THIS DOES NOT CLOSE.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_CLAUDE="${APPFORGE_REAL_CLAUDE_BIN:-$HOME/.local/bin/claude}"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${APPFORGE_AGENT_REPOS:-}" ]; then
  echo "agent-launch.sh: APPFORGE_AGENT_REPOS is not set - refusing to run without a defined repo scope" >&2
  exit 1
fi

# ------------------------------------------------------- CONTROL A (APP-60) --
# Do not inherit the founder's git config. ~/.gitconfig configures
# credential."https://github.com".helper = !/opt/homebrew/bin/gh auth
# git-credential, and every agent process was reading it; an ordinary
# read-only `git ls-remote` invoked it implicitly and got back a live founder
# OAuth token. GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are per-process, so the
# founder's own shell is untouched.
#
# This is a HARD dependency, not a best-effort one: if the replacement file is
# missing, git would silently fall back to "no global config" and agents would
# lose their commit identity while still looking contained. Fail loudly.
APPFORGE_GITCONFIG="$REPO_ROOT/.gitconfig-appforge"
if [ ! -f "$APPFORGE_GITCONFIG" ]; then
  echo "agent-launch.sh: $APPFORGE_GITCONFIG is missing - refusing to launch an agent that would fall back to the founder's git config" >&2
  exit 1
fi
export GIT_CONFIG_GLOBAL="$APPFORGE_GITCONFIG"
export GIT_CONFIG_SYSTEM=/dev/null
# GIT_CONFIG_NOSYSTEM is defense in depth, and it is stated as exactly that -
# it is NOT what makes C3 pass. Measured 2026-09-28 (git 2.39.5, Apple
# Git-154), accumulated `git config --get-all credential.helper`:
#
#   no containment at all      [osxkeychain, !gh auth git-credential, ]
#                              -> fill returns username=rkamalapuram_tkinc
#                                 and a live password. This is the gap.
#   Control A, no NOSYSTEM     [osxkeychain, , ]
#                              -> fill fails, "could not read Username".
#   Control A, with NOSYSTEM   [, , ]
#                              -> fill fails, same.
#
# So the empty helper in .gitconfig-appforge already resets the list. But note
# the middle row: GIT_CONFIG_SYSTEM=/dev/null did NOT remove osxkeychain.
# Apple's git reads /Applications/Xcode.app/.../share/git-core/gitconfig in
# addition to the standard system path, and GIT_CONFIG_SYSTEM only redirects
# the standard one. Without NOSYSTEM the containment is correct but rests on
# git's reset-ordering (system read before global) rather than on the helper
# never being read. NOSYSTEM removes that dependency.
#
# Deviation from the approved plan, which named only GIT_CONFIG_SYSTEM:
# one extra env var, strictly narrowing, no behaviour an agent can observe
# beyond a shorter helper list.
export GIT_CONFIG_NOSYSTEM=1

# ------------------------------------------------------- CONTROL B (APP-60) --
# Give gh a private, empty config dir on EVERY path, not just the no-repo one.
# Until this change the scoped-repo path left GH_CONFIG_DIR at the founder's
# own ~/.config/gh, whose hosts.yml names both the personal account (repo +
# workflow - i.e. a path to editing Actions files and therefore to the
# release-platform pipeline, DEC-0005) and the employer account (repo on every
# private repo that account can reach).
#
# Control A does not cover this. A resets git's credential.helper list, which
# is what closes C3; it does nothing about `gh` invoked as a CLI in its own
# right, which stays executable at its absolute path regardless of PATH
# hygiene. What this dir removes is the ACCOUNT LIST (hosts.yml) that gh reads
# to decide who it is - not the credential itself, which is in the OS keyring
# and remains reachable via `gh auth git-credential get` (APP-97, item 3 under
# WHAT THIS DOES NOT CLOSE).
#
# Prefer Paperclip's run scratch dir - it is per-run and the runtime deletes it
# when the run ends. mktemp is the fallback for non-Paperclip invocations. A
# fixed shared path would be wrong either way: gh writes config.yml into
# GH_CONFIG_DIR on first use and the dir would accumulate state across runs.
if [ -n "${PAPERCLIP_RUN_SCRATCH_DIR:-}" ] && [ -d "${PAPERCLIP_RUN_SCRATCH_DIR}" ]; then
  GH_CONFIG_DIR="$PAPERCLIP_RUN_SCRATCH_DIR/gh"
  mkdir -p "$GH_CONFIG_DIR"
else
  GH_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/appforge-gh.XXXXXX")"
fi
export GH_CONFIG_DIR

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
# Read that second result narrowly. `gh auth status` reads hosts.yml, so an
# empty GH_CONFIG_DIR only hides the accounts from `status` - it does NOT
# establish that gh holds no credential. Measured 2026-09-28 (APP-97) in that
# exact environment, `gh auth git-credential get` invoked directly still
# returned a founder `gho_` token, because that subcommand reads the OS keyring
# and never needs hosts.yml. `status` is the wrong probe for this question.
#
# So: scrub the env tokens AND give gh a private, empty config dir. The dir is
# Control B above, which now applies to every path; only the env-token scrub
# below is specific to this branch.
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
#   3. `gh auth git-credential get`, invoked directly as a binary, returns a
#      founder `gho_` user token from the OS keyring regardless of
#      GH_CONFIG_DIR - the keyring is not what GH_CONFIG_DIR points at.
#      Measured 2026-09-28 (APP-97) with GH_TOKEN/GITHUB_TOKEN unset and
#      GH_CONFIG_DIR empty. Both founder accounts carry full `repo`, so this
#      is the same reach as item 1.
# All three need OS-level isolation (separate uid or a sandboxed HOME), not a
# wrapper script.
if [ "$APPFORGE_AGENT_REPOS" = "none" ]; then
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN
  # GH_CONFIG_DIR (Control B) is already an empty per-run dir, set above for
  # every path. With the env tokens also scrubbed, gh will not ACT as any
  # account by default. It is not stripped of credentials - see item 3 under
  # WHAT THIS DOES NOT CLOSE.
  #
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
