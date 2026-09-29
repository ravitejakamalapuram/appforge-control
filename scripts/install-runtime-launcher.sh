#!/bin/bash
# Installs the agent runtime launcher AND the quota-retry watchdog into a prefix
# OUTSIDE every git working tree (default ~/.appforge), from a NAMED, PUBLISHED
# ref.
#
# The watchdog was added in APP-164 for the same reason as the launcher: its
# LaunchAgent named scripts/quota-retry-watchdog.mjs in the shared development
# checkout, so the daemon executed whatever branch was checked out there. On
# 2026-09-29 that was an unmerged feature branch. One deploy step, one manifest,
# one drift check for both runtimes - see infra/macos/*quota-watchdog.plist for
# the three runtime paths that plist must keep pinned, and why.
#
# Why this exists (APP-137): the live launcher used to be served straight from
# scripts/ in the shared development checkout. Every agent on this box execs it,
# and every agent also does ordinary git work in that same checkout - so a
# routine `git checkout` there reverted a merged availability fix (APP-132) and
# removed the APP-72 worktree-prune backstop for every subsequent agent run,
# with no alarm. Merging did not deploy. This script is the deploy step that was
# missing, and APP-161 is the requirement that it be a committed, reviewable
# artifact rather than a one-off written to a scratch dir.
#
# The two properties everything else here is in service of:
#
#   1. REPRODUCIBLE. Every versioned file is materialised with
#      `git show <commit>:<path>`. The working tree is never read for a file
#      that lives in a commit, so byte-identity with the reviewed ref is by
#      construction, not by inspection afterwards.
#   2. AUDITABLE. $PREFIX/RELEASE records the source commit, the ref it was
#      named by, a sha256 and source path per installed file, and the run id
#      that installed it. APP-161's acceptance is that this manifest is written
#      BY THIS SCRIPT and never by hand.
#
# The manifest format is the contract scripts/lib/launcher-drift.mjs parses
# (APP-162, already merged): a `key: value` header of [a-z_]+ keys, then a
# `files:` block of indented `<sha256>  <install-path>  <versioning>
# <source-path>` rows. The fourth column is what lets the drift detector
# compare a live file against the blob at the commit rather than fall back to
# its hard-coded path table. Do not reorder those columns without reading
# `parseReleaseManifest`.
#
# ---------------------------------------------------------- LAYOUT INVARIANT --
# The install mirrors the repo's relative layout. It is NOT a flat bin
# directory, and flattening it breaks APP-60 Control A. Four resolutions
# depend on it:
#
#   agent-launch.sh       REPO_ROOT=$SCRIPT_DIR/..      -> $PREFIX/.gitconfig-appforge
#   agent-launch.sh       $SCRIPT_DIR/                  -> prune-agent-worktrees.sh,
#                                                          github-app-token.mjs
#   github-app-token.mjs  CONTROL_ROOT=<minter dir>/..  -> $PREFIX/config/github-apps.yaml
#                                                          $PREFIX/secrets/*.pem
#   node                  upward from the minter        -> $PREFIX/bin/node_modules
#   quota-retry-watchdog  $SCRIPT_DIR/lib/              -> $PREFIX/bin/lib/*.mjs
#
# The watchdog also derives REPO_ROOT=$SCRIPT_DIR/.. and hangs THREE runtime
# paths off it: its state file, its log, and CLAUDE_CONFIG_DIR - the directory
# the bundled `paperclipai` CLI authenticates from. Installing it here therefore
# repoints all three at $PREFIX unless the caller pins them. The plist pins them
# back at the checkout on purpose; do not "fix" that by letting them drift to
# $PREFIX, which has no credential dir and no state history. An empty state file
# is not benign: it re-handles every run still in the lookback window, which
# means duplicate pauses, resumes and wakes.
#
# Mirroring the layout is what lets every installed file stay BYTE-IDENTICAL to
# the reviewed ref with no edits. A flat directory would require patching the
# path resolution inside agent-launch.sh, and a patched launcher is no longer
# the file anyone reviewed.
#
# A flattened install does fail closed rather than silently: if
# .gitconfig-appforge is not one level above the launcher, the launcher exits 1
# by design rather than fall back to the founder's ~/.gitconfig. Correct, but it
# means every agent on the box stops launching. Do not "simplify" the layout.
#
#   $PREFIX/
#     RELEASE                      manifest, written here, mode 0444
#     .gitconfig-appforge          versioned
#     bin/agent-launch.sh          versioned, 0555
#     bin/github-app-token.mjs     versioned, 0555
#     bin/prune-agent-worktrees.sh versioned, 0555   (called with `|| true`;
#                                                     silently inert if absent)
#     bin/lib/github-app.mjs       versioned
#     bin/package.json             versioned
#     bin/package-lock.json        versioned
#     bin/node_modules/            NOT versioned - `npm ci` from the lockfile above
#     config/github-apps.yaml      versioned
#     secrets/*.private-key.pem    NOT versioned - copied from the source checkout
#     secrets/KEYS.sha256          digests of the above, 0400
#
# ------------------------------------------------ THE TWO UNVERSIONED INPUTS --
# The live runtime has always depended on two inputs that exist in no commit.
# Naming them is half the value of this script. They are also exactly the two
# prefixes launcher-drift.mjs treats as permanently uncheckable, so anything
# that lands there is outside the alarm.
#
# 1. node_modules (`yaml`, `jsonwebtoken` + transitives). Step 1 copied the
#    development checkout's scripts/node_modules/ wholesale. This script does
#    NOT: it runs `npm ci --omit=dev --ignore-scripts` against the
#    package-lock.json AT THE INSTALLED REF. The lockfile is versioned and pins
#    integrity hashes, so the dependency tree becomes a deterministic function
#    of the ref instead of a snapshot of whatever happened to be on disk. This
#    is the APP-161 decision on that question: lockfile install, not a
#    working-tree copy, and not vendoring node_modules into git - the lockfile
#    already carries the integrity hashes, and committing the tree would make
#    every dependency bump a large unreviewable diff.
#
#    --ignore-scripts is deliberate. Nothing here has a legitimate install
#    script, and a lifecycle hook would execute at the founder's uid - which
#    per DEC-0001 is the containment boundary itself.
#
# 2. The GitHub App private key. Genuinely unversioned and must stay that way.
#    It is COPIED (not symlinked) into $PREFIX/secrets/ at mode 0400, because a
#    `git clean -xdf` in the development checkout would otherwise delete the
#    target of the symlink and break every agent launch on the box.
#
#    ROTATION HAS TWO WRITE TARGETS. The key now exists at both
#    <repo>/secrets/ and $PREFIX/secrets/. This is not new exposure - per
#    DEC-0001 the OS uid is the containment boundary and both paths were
#    already readable by it - but a rotation that updates only the checkout
#    leaves the live runtime minting with the old key until someone notices.
#    The supported procedure is: rotate in the checkout, then run
#    `install-runtime-launcher.sh --secrets-only`, which refreshes $PREFIX's
#    copy without disturbing the installed code or its RELEASE provenance.
#
# ---------------------------------------------------------------------- USE --
#   scripts/install-runtime-launcher.sh                      # from origin/main
#   scripts/install-runtime-launcher.sh --ref refs/tags/runtime-v3
#   scripts/install-runtime-launcher.sh --dry-run            # plan + manifest, no writes
#   scripts/install-runtime-launcher.sh --secrets-only       # key rotation only
#
# Nothing restarts a run in flight. Agents pick up a deploy on their next launch.
set -euo pipefail

PREFIX="${APPFORGE_RUNTIME_PREFIX:-$HOME/.appforge}"
REF="${APPFORGE_RUNTIME_REF:-origin/main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
# Absolute, so the rollback hint we print is copy-pasteable from any cwd.
INSTALLER_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
DRY_RUN=0
ALLOW_DIRTY=0
DO_FETCH=1
SECRETS_ONLY=0

die() { echo "install-runtime-launcher: $*" >&2; exit 1; }
say() { echo "==> $*"; }
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)          REF="${2:?--ref needs a value}"; shift 2 ;;
    --prefix)       PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --repo)         REPO="${2:?--repo needs a value}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --allow-dirty)  ALLOW_DIRTY=1; shift ;;
    --no-fetch)     DO_FETCH=0; shift ;;
    --secrets-only) SECRETS_ONLY=1; shift ;;
    -h|--help)      sed -n '2,/^set -euo pipefail$/p' "$INSTALLER_PATH" | sed '$d; s/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *)              die "unknown argument: $1" ;;
  esac
done

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git repository"
REPO="$(git -C "$REPO" rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------
# Secrets. Also the whole of --secrets-only, which is the second half of the
# rotation procedure and deliberately does NOT rewrite RELEASE: the installed
# code did not change, and claiming a fresh install would falsify the
# provenance the manifest exists to carry.
# ---------------------------------------------------------------------------
install_secrets() {
  local dest="$1" yaml="$2" installed=0 rel src key_paths
  # Every private_key_path in the App config, not just appforge-agents, so this
  # keeps working when the locked-down appforge-release App is created (§17.1).
  key_paths="$(grep -E '^[[:space:]]*private_key_path:' "$yaml" | sed 's/.*private_key_path:[[:space:]]*//' | tr -d '"'"'" || true)"
  [ -n "$key_paths" ] || die "no private_key_path found in $yaml - refusing to install a runtime that cannot mint"

  mkdir -p "$dest/secrets"
  chmod 0700 "$dest/secrets"
  : > "$dest/secrets/KEYS.sha256.tmp"

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    src="$REPO/$rel"
    [ -f "$src" ] || die "private key $src does not exist. It is in no commit by design; it must be present in the source checkout for the install to produce a runtime that can mint tokens."
    mkdir -p "$dest/$(dirname "$rel")"
    # Write under a temp name and rename, so a concurrent agent launch never
    # observes a truncated key.
    install -m 0400 "$src" "$dest/$rel.tmp"
    mv -f "$dest/$rel.tmp" "$dest/$rel"
    chmod 0400 "$dest/$rel"
    # The digest goes in the secrets dir at 0400, NOT in the 0444 RELEASE
    # manifest. It is what lets a half-finished rotation be detected, and there
    # is no reason to widen a secret's derived data to every reader of the
    # manifest to get that.
    echo "$(sha256 "$dest/$rel")  $rel" >> "$dest/secrets/KEYS.sha256.tmp"
    say "secret installed: $rel (0400, from working tree - UNVERSIONED)"
    installed=$((installed + 1))
  done <<< "$key_paths"

  mv -f "$dest/secrets/KEYS.sha256.tmp" "$dest/secrets/KEYS.sha256"
  chmod 0400 "$dest/secrets/KEYS.sha256"
  say "$installed private key(s) refreshed"
}

if [ "$SECRETS_ONLY" -eq 1 ]; then
  [ -f "$PREFIX/config/github-apps.yaml" ] \
    || die "--secrets-only needs an existing install at $PREFIX (no config/github-apps.yaml found). Run a full install first."
  [ "$DRY_RUN" -eq 0 ] || { say "dry-run: would refresh private keys in $PREFIX/secrets/ from $REPO"; exit 0; }
  install_secrets "$PREFIX" "$PREFIX/config/github-apps.yaml"
  say "secrets refreshed. RELEASE left untouched on purpose - the installed code did not change."
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Resolve the ref. It must be NAMED and PUBLISHED.
# ---------------------------------------------------------------------------
if [ "$DO_FETCH" -eq 1 ]; then
  say "fetching $REPO"
  git -C "$REPO" fetch --tags --quiet origin \
    || die "git fetch failed. Refusing to install from possibly-stale remote refs. Pass --no-fetch only if you have independently confirmed the ref is current."
fi

case "$REF" in
  HEAD|@|@*|*'@{'*)
    die "'$REF' is not a named ref. It resolves to whatever the checkout happens to be on, which is exactly the failure mode APP-137 is about." ;;
esac

FULL_REF="$(git -C "$REPO" rev-parse --symbolic-full-name --verify --quiet "$REF" || true)"
case "$FULL_REF" in
  refs/remotes/*|refs/tags/*)
    : ;;
  refs/heads/*)
    die "'$REF' is a LOCAL branch ($FULL_REF). A local branch may hold commits nobody else can see or review; install from a tag or a remote-tracking ref (e.g. origin/main) instead." ;;
  '')
    die "'$REF' is not a named ref - it did not resolve to refs/tags/* or refs/remotes/*. Raw SHAs and revisions like 'main~1' are refused on purpose: the manifest must record a name a reviewer can look up, and launcher-drift.mjs re-resolves that name to detect a stale deploy." ;;
  *)
    die "'$REF' resolved to '$FULL_REF', which is not a tag or a remote-tracking ref." ;;
esac

COMMIT="$(git -C "$REPO" rev-parse --verify "${FULL_REF}^{commit}")"
say "installing from $FULL_REF ($COMMIT)"

# ---------------------------------------------------------------------------
# 2. $PREFIX must not be inside a git working tree, or this script installs the
#    very bug APP-137 exists to fix. Checked BEFORE anything is written:
#    discovering it afterwards means the bad install is already live.
# ---------------------------------------------------------------------------
PREFIX_PROBE="$PREFIX"
[ -d "$PREFIX_PROBE" ] || PREFIX_PROBE="$(dirname "$PREFIX")"
if git -C "$PREFIX_PROBE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "$PREFIX is inside a git working tree. That is the APP-137 failure mode exactly: a git checkout, restore, stash or clean could silently revert the live launcher for every agent on this box. Choose a prefix outside every repo."
fi

# ---------------------------------------------------------------------------
# 3. Refuse a dirty source tree.
#
# Every versioned file comes from `git show`, so a dirty tree cannot actually
# contaminate them. The check is here because the private key - the one input
# that IS read from the working tree - comes from this same checkout, and
# because a tree mid-edit is a tree nobody has reviewed. --allow-dirty exists
# because agents share this checkout and it is dirty most of the time; it does
# not silently weaken the audit, it stamps source_tree_state: dirty and the
# offending paths into RELEASE so the next reader can see it happened.
# Untracked files are ignored: secrets/ and node_modules/ are gitignored, and
# an unrelated stray file cannot reach the install.
# ---------------------------------------------------------------------------
DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=no)"
TREE_STATE=clean
DIRTY_PATHS=""
if [ -n "$DIRTY" ]; then
  if [ "$ALLOW_DIRTY" -eq 0 ]; then
    echo "$DIRTY" >&2
    die "source checkout $REPO has uncommitted changes to tracked files (above). Versioned files are read from $FULL_REF and are unaffected, but the private key is read from this tree. Re-run with --allow-dirty to proceed and record it in RELEASE."
  fi
  TREE_STATE=dirty
  DIRTY_PATHS="$(echo "$DIRTY" | awk '{print $NF}' | paste -sd, -)"
  say "WARNING: source tree is dirty; proceeding under --allow-dirty and recording it in RELEASE"
fi

# ---------------------------------------------------------------------------
# 4. Stage the whole tree, then swap it in. Never edit $PREFIX in place: agents
#    launch continuously on this box and a half-written $PREFIX is a launcher
#    that fails closed for whoever starts during the write.
# ---------------------------------------------------------------------------
# "<repo path>:<install path>:<mode>"
VERSIONED=(
  "scripts/agent-launch.sh:bin/agent-launch.sh:0555"
  "scripts/github-app-token.mjs:bin/github-app-token.mjs:0555"
  "scripts/prune-agent-worktrees.sh:bin/prune-agent-worktrees.sh:0555"
  "scripts/lib/github-app.mjs:bin/lib/github-app.mjs:0444"
  "scripts/quota-retry-watchdog.mjs:bin/quota-retry-watchdog.mjs:0555"
  "scripts/lib/quota-retry-watchdog.mjs:bin/lib/quota-retry-watchdog.mjs:0444"
  "scripts/lib/quota-pause-collateral.mjs:bin/lib/quota-pause-collateral.mjs:0444"
  "scripts/package.json:bin/package.json:0444"
  "scripts/package-lock.json:bin/package-lock.json:0444"
  ".gitconfig-appforge:.gitconfig-appforge:0444"
  "config/github-apps.yaml:config/github-apps.yaml:0444"
)

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/appforge-runtime.XXXXXX")"
cleanup() { if [ -n "${STAGE:-}" ]; then rm -rf "$STAGE"; fi; return 0; }
trap cleanup EXIT

MANIFEST_FILES=""
for spec in "${VERSIONED[@]}"; do
  IFS=: read -r src dst mode <<< "$spec"
  git -C "$REPO" cat-file -e "$COMMIT:$src" 2>/dev/null \
    || die "$src does not exist at $FULL_REF. The launcher hard-depends on it; refusing to install a runtime that is missing a file."
  mkdir -p "$STAGE/$(dirname "$dst")"
  # From the commit, never from the working tree. This is the reproducibility
  # guarantee; do not replace it with cp.
  git -C "$REPO" show "$COMMIT:$src" > "$STAGE/$dst"
  chmod "$mode" "$STAGE/$dst"
  MANIFEST_FILES="${MANIFEST_FILES}  $(sha256 "$STAGE/$dst")  $dst  versioned  $src
"
done
say "${#VERSIONED[@]} versioned files materialised from $COMMIT"

# ---------------------------------------------------------------------------
# 5. Dependencies from the lockfile at the installed ref - see UNVERSIONED
#    INPUTS above.
# ---------------------------------------------------------------------------
say "npm ci from the lockfile at $FULL_REF"
chmod 0644 "$STAGE/bin/package.json" "$STAGE/bin/package-lock.json"
( cd "$STAGE/bin" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent ) \
  || die "npm ci failed against the lockfile at $FULL_REF. Not falling back to copying the checkout's node_modules: that is the unreproducible behaviour this script replaces."
chmod 0444 "$STAGE/bin/package.json" "$STAGE/bin/package-lock.json"
# `npm ci` creates no node_modules/ at all when the lockfile has no
# dependencies, so this must not assume the directory exists.
DEP_COUNT=0
if [ -d "$STAGE/bin/node_modules" ]; then
  DEP_COUNT="$(find "$STAGE/bin/node_modules" -maxdepth 1 -mindepth 1 -type d ! -name '.*' | wc -l | tr -d ' ')"
fi
# The modules that must resolve are exactly package.json's dependencies. Read
# them rather than hardcoding `yaml jsonwebtoken`, so adding a dependency to the
# minter is covered by this check automatically instead of silently escaping it.
RUNTIME_DEPS="$(node -e 'const p=require(process.argv[1]);process.stdout.write(Object.keys(p.dependencies||{}).join(" "))' "$STAGE/bin/package.json")"

# ---------------------------------------------------------------------------
# 6. Cheap pre-swap smoke checks. No network and no token minted: a real mint
#    would burn a GitHub API call on every install.
# ---------------------------------------------------------------------------
bash -n "$STAGE/bin/agent-launch.sh"           || die "staged agent-launch.sh does not parse"
bash -n "$STAGE/bin/prune-agent-worktrees.sh"  || die "staged prune-agent-worktrees.sh does not parse"
node --check "$STAGE/bin/github-app-token.mjs" || die "staged github-app-token.mjs does not parse"
node --check "$STAGE/bin/lib/github-app.mjs"   || die "staged lib/github-app.mjs does not parse"
node --check "$STAGE/bin/quota-retry-watchdog.mjs"     || die "staged quota-retry-watchdog.mjs does not parse"
node --check "$STAGE/bin/lib/quota-retry-watchdog.mjs" || die "staged lib/quota-retry-watchdog.mjs does not parse"
node --check "$STAGE/bin/lib/quota-pause-collateral.mjs" || die "staged lib/quota-pause-collateral.mjs does not parse"
# The watchdog resolves its two libs relative to its own directory. Importing it
# proves bin/lib/ landed with it, which a parse check alone does not: a missing
# sibling only fails at import time, i.e. on the live 90s tick after the swap.
# This does not start the daemon: the watchdog only acts under its
# `import.meta.url === file://$process.argv[1]` entrypoint guard, and under
# `node -e` argv[1] is not the module path, so importing it is inert. Its
# top-level scope is const declarations only.
( cd "$STAGE/bin" && node -e "import('./quota-retry-watchdog.mjs').then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})" ) \
  || die "staged quota-retry-watchdog.mjs cannot import its own libs from bin/lib/ - the layout invariant is broken"
# Proves node's upward resolution from the minter's directory finds the staged
# node_modules - the invariant that breaks if bin/ is ever flattened or moved.
for dep in $RUNTIME_DEPS; do
  ( cd "$STAGE/bin" && node -e "import(process.argv[1]).then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})" "$dep" ) \
    || die "node cannot resolve '$dep' from the staged bin/ - the layout invariant is broken or npm ci was incomplete"
done
say "smoke checks passed (parse + resolution of ${RUNTIME_DEPS:-no} runtime dependencies)"

RELEASE_BODY="# AppForge runtime launcher install manifest
# Written by scripts/install-runtime-launcher.sh (APP-161). Do not hand-edit:
# scripts/detect-launcher-drift.mjs (APP-162) compares the live tree against
# these digests, and a hand-edited manifest makes that check assert nothing.
source_repo: $REPO
source_ref: $FULL_REF
source_commit: $COMMIT
source_tree_state: $TREE_STATE
source_dirty_paths: ${DIRTY_PATHS:-none}
installed_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
installed_by_run: ${PAPERCLIP_RUN_ID:-unknown}
installer_sha256: $(sha256 "$INSTALLER_PATH")
prefix: $PREFIX
node_version: $(node --version)
npm_version: $(npm --version)
node_modules: lockfile-derived from bin/package-lock.json at $COMMIT ($DEP_COUNT top-level packages, npm ci --omit=dev --ignore-scripts)
files:
${MANIFEST_FILES}  (bin/node_modules/)          UNVERSIONED - reproducible: npm ci from the versioned lockfile above
  (secrets/*.private-key.pem)  UNVERSIONED - in no commit by design; copied from \$source_repo. Digests in secrets/KEYS.sha256 (0400). Rotation has TWO write targets: rotate in the checkout, then re-run with --secrets-only."

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run: $PREFIX not touched. The manifest that would be written:"
  echo
  echo "$RELEASE_BODY"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. Swap. mv of a directory is atomic, so an agent launching during the
#    install gets the whole old tree or the whole new one. The previous
#    generation is kept at $PREFIX.prev for rollback, minus its secrets.
# ---------------------------------------------------------------------------
echo "$RELEASE_BODY" > "$STAGE/RELEASE"
chmod 0444 "$STAGE/RELEASE"

# The key goes into the STAGED tree before the swap, so the new prefix is
# complete and mintable from its first instant.
install_secrets "$STAGE" "$STAGE/config/github-apps.yaml"

mkdir -p "$(dirname "$PREFIX")"
if [ -d "$PREFIX" ]; then
  rm -rf "$PREFIX.prev"
  mv "$PREFIX" "$PREFIX.prev"
fi
mv "$STAGE" "$PREFIX"
STAGE=""   # consumed; keep the EXIT trap from deleting the live install
chmod 0755 "$PREFIX" "$PREFIX/bin" "$PREFIX/bin/lib" "$PREFIX/config"
chmod 0700 "$PREFIX/secrets"

# Do not let the rolled-aside generation keep a copy of the private key. After
# a rotation that copy is the REVOKED key sitting on disk indefinitely, and
# even without one it is a third copy of a secret for no benefit. Rolling back
# therefore takes a --secrets-only pass; see the rollback line printed below.
rm -rf "$PREFIX.prev/secrets"

# ---------------------------------------------------------------------------
# 8. Verify what actually landed, not what we believe we staged.
# ---------------------------------------------------------------------------
ROLLBACK="rm -rf '$PREFIX' && mv '$PREFIX.prev' '$PREFIX' && '$INSTALLER_PATH' --secrets-only"
FAILED=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  want="$(echo "$line" | awk '{print $1}')"
  rel="$(echo "$line" | awk '{print $2}')"
  got="$(sha256 "$PREFIX/$rel" 2>/dev/null || echo MISSING)"
  if [ "$want" != "$got" ]; then
    echo "  DRIFT $rel: manifest $want, on disk $got" >&2
    FAILED=1
  fi
done <<< "$MANIFEST_FILES"
[ "$FAILED" -eq 0 ] || die "installed tree does not match the manifest. $PREFIX.prev holds the previous generation; roll back with: $ROLLBACK"

say "installed $FULL_REF ($COMMIT) to $PREFIX"
say "manifest: $PREFIX/RELEASE"
say "rollback: $ROLLBACK"
say "verify:   node $REPO/scripts/detect-launcher-drift.mjs"
say "agents pick this up on their next launch; nothing restarts a run in flight."
# The watchdog is the exception: it is a LaunchAgent, not exec'd per agent run,
# so it keeps running its previously-resolved program path until launchd reloads.
say "watchdog: reload the LaunchAgent to pick up this deploy -"
say "  launchctl bootout  gui/\$(id -u)/ing.paperclip.appforge-quota-watchdog"
say "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/ing.paperclip.appforge-quota-watchdog.plist"
