# The runtime launcher: source vs. deployment

**Origin: APP-137.** The live agent launcher used to be executed straight out of
`scripts/` in the shared development checkout at `~/git-personal/appforge-control`.
Every agent on this box execs it, and every agent also does ordinary git work in
that same checkout. A routine `git checkout` there reverted a merged
availability fix (APP-132) and removed the APP-72 worktree-prune backstop for
every subsequent agent launch. Nothing alarmed. **Merging did not deploy.**

There are now two distinct things, and conflating them is the bug:

| | Path | What it is |
|---|---|---|
| **Source** | `appforge-control/scripts/agent-launch.sh` and friends | What you edit and review. Mutable, branch-dependent, executed by nobody. |
| **Deployment** | `~/.appforge/bin/agent-launch.sh` | What `adapterConfig.command` actually execs. Read-only, outside every git working tree, provenance in `~/.appforge/RELEASE`. |

Elsewhere in this repo — `agents/*/TOOLS.md`, `docs/containment-model.md` — a
control is cited by its **source** path. That remains the right citation: it
names the reviewable file. Just remember that editing it changes nothing live
until someone deploys.

Three scripts cover the lifecycle:

| Step | Script | Issue |
|---|---|---|
| Deploy from a named ref | `scripts/install-runtime-launcher.sh` | APP-161 |
| Detect drift / stale deploy | `scripts/detect-launcher-drift.mjs` | APP-162 |
| Prune leftover worktrees at launch | `scripts/prune-agent-worktrees.sh` | APP-72 |

## Deploying

One command, and it names a ref:

```sh
scripts/install-runtime-launcher.sh --ref origin/main      # or a tag
scripts/install-runtime-launcher.sh --dry-run              # plan + manifest, writes nothing
```

The script refuses anything that is not a published, named ref. Raw SHAs,
`HEAD`, `main~1` and **local branches** are all rejected. That is not
fussiness: `detect-launcher-drift.mjs` re-resolves `source_ref` later to decide
whether the deploy has fallen behind, so a ref nobody else can resolve disables
the staleness alarm.

It also refuses a dirty source checkout. `--allow-dirty` proceeds but stamps
`source_tree_state: dirty` and the offending paths into `RELEASE`. Agents share
that checkout and it is dirty most of the time, so `--allow-dirty` is expected
in practice — the point is that it leaves evidence, not that it never happens.

Every versioned file is materialised with `git show <commit>:<path>`. The
working tree is never read for a file that lives in a commit, so byte-identity
with the reviewed ref is a property of the construction rather than something
you check afterwards. The install is staged in full and swapped in with `mv`, so
an agent launching mid-deploy gets the whole old tree or the whole new one,
never a half-written prefix. The previous generation is kept at
`~/.appforge.prev`.

Nothing restarts a run in flight. Agents pick up a deploy on their next launch.

### Verifying and rolling back

```sh
node scripts/detect-launcher-drift.mjs                # exit 0 = no drift
rm -rf ~/.appforge && mv ~/.appforge.prev ~/.appforge \
  && scripts/install-runtime-launcher.sh --secrets-only
```

The rollback needs that trailing `--secrets-only` pass because a deploy deletes
`~/.appforge.prev/secrets` — see the private key section below.

### Reading a `stale` finding (APP-261)

A `stale` finding carries the `git diff` between the install commit and the ref
tip, bounded at 80 lines, plus a classification of what changed:

| classification | severity | what it means |
| --- | --- | --- |
| `comment_only` | `low` | comment-stripping both revisions yields identical bytes |
| `prose_string_only` | `low` | identical code skeleton, every changed literal is multi-word prose passed directly to a message sink (`console.*`, `new Error`, `stderr/stdout.write`) — a literal anywhere else may be a match key |
| `string_only` | `high` | identical skeleton, but a changed literal is a flag, path, URL or bare token |
| `behavioural` | `high` | executable content changed |
| `unmodelled_construct` | `high` | the file holds a shell heredoc or YAML block scalar, where a `#` line is data |
| `unmodelled_filetype` / `unavailable` / `unparseable` | `high` | the change could not be inspected |

Everything uncertain resolves to `high`: a false `low` reintroduces the APP-72
blind spot, a false `high` costs one read. Strings are only modelled for
`.mjs`/`.js`; shell and YAML get comment detection and nothing else (`#` only at a word start, never a `#!` shebang at byte 0), because
shell quoting and YAML's unquoted scalars are easy to model wrongly and a wrong
model there produces a false `low`.

The classifier **never suppresses a finding** and only ever touches `stale`.
`tampered`, `missing` and `manifest_mismatch` stay `critical` whatever the
delta looks like — an unexplained hand-edit to the credential-bearing launcher
tree is serious because it is unexplained.

Findings also record `launchPath`: whether `agent-launch.sh` execs or reads the
file on every launch. That is blast-radius context for the reader and
deliberately does **not** move severity. A sweep script that stops recovering
paused agents is a real failure, and demoting it because it cannot abort a
launch would open a second blind spot next to the one this closes.

If a classification looks wrong, the hunks are in the report — say so, and the
rule gets fixed rather than trusted.

## The layout invariant — do not flatten it

`~/.appforge/` mirrors the repo's relative layout. It is not a flat `bin`
directory, and making it one breaks APP-60 Control A.

```
~/.appforge/
  RELEASE                        manifest (0444) — written by the installer, never by hand
  .gitconfig-appforge            versioned
  bin/agent-launch.sh            versioned, 0555
  bin/github-app-token.mjs       versioned, 0555
  bin/prune-agent-worktrees.sh   versioned, 0555
  bin/lib/github-app.mjs         versioned
  bin/package.json               versioned
  bin/package-lock.json          versioned
  bin/node_modules/              NOT versioned — `npm ci` from the lockfile above
  config/github-apps.yaml        versioned
  secrets/*.private-key.pem      NOT versioned — copied from the source checkout, 0400
  secrets/KEYS.sha256            digests of the above, 0400
```

Four resolutions depend on that shape:

| Resolved by | Expression | Resolves to |
|---|---|---|
| `agent-launch.sh` | `REPO_ROOT=$SCRIPT_DIR/..` | `~/.appforge/.gitconfig-appforge` |
| `agent-launch.sh` | `$SCRIPT_DIR/` | `prune-agent-worktrees.sh`, `github-app-token.mjs` |
| `github-app-token.mjs` | `CONTROL_ROOT=<minter dir>/..` | `config/github-apps.yaml`, `secrets/*.pem` |
| `node` | upward from the minter's directory | `bin/node_modules` |

Mirroring the layout is what lets every installed file stay **byte-identical to
the reviewed ref with no edits**. A flat directory would require patching the
path resolution inside `agent-launch.sh`, and a patched launcher is no longer
the file anyone reviewed.

A flattened install does fail closed rather than silently: if
`.gitconfig-appforge` is not one level above the launcher, the launcher exits 1
by design instead of falling back to the founder's `~/.gitconfig`. That is the
correct behaviour, but it means every agent on the box stops launching.

## The two unversioned inputs

The live runtime has always depended on two things that exist in no commit.
These are also precisely the two prefixes `launcher-drift.mjs` treats as
permanently uncheckable, so anything that lands there is outside the alarm.

### 1. `node_modules` — now derived from a versioned lockfile

`github-app-token.mjs` imports `yaml` and `jsonwebtoken`. `scripts/node_modules/`
is gitignored, so the deployed dependency tree used to be a copy of whatever
happened to be on the development checkout's disk.

The installer runs `npm ci --omit=dev --ignore-scripts` against the
`package-lock.json` **at the installed ref**. The lockfile is versioned and pins
integrity hashes, so the dependency tree is now a deterministic function of the
ref. Vendoring `node_modules` into git was considered and rejected: the lockfile
already carries the integrity hashes, and committing 16 packages of third-party
source would make every dependency bump a large, unreviewable diff.

`--ignore-scripts` is deliberate. Nothing in this tree has a legitimate install
script, and a lifecycle hook here would execute at the founder's uid — which per
`DEC-0001` is the containment boundary itself.

The change is behaviour-neutral: at commit `92183a2` the `npm ci` tree is
byte-identical to the working-tree copy it replaces.

### 2. The GitHub App private key — two homes, so rotation has two targets

`secrets/appforge-agents.private-key.pem` is in no commit and must stay that way.
The installer **copies** it into `~/.appforge/secrets/` at mode 0400 rather than
symlinking, because a `git clean -xdf` in the development checkout would
otherwise delete the symlink's target and break every agent launch on the box.

So the key exists in two places at the same uid. This is **not new exposure** —
per `DEC-0001` the OS uid is the containment boundary, and both paths were
already readable by it. What it changes is rotation:

> **A rotation that updates only the checkout leaves the live runtime minting
> with the old key until someone notices.**

The supported procedure:

```sh
# 1. rotate the key in the source checkout's secrets/ as usual, then:
scripts/install-runtime-launcher.sh --secrets-only
```

`--secrets-only` refreshes `~/.appforge/secrets/` and deliberately does **not**
rewrite `RELEASE`: the installed code did not change, and claiming a fresh
install would falsify the provenance the manifest exists to carry. It refreshes
every `private_key_path` in `config/github-apps.yaml`, so it keeps working when
the locked-down `appforge-release` App is created.

For the same reason a deploy deletes `~/.appforge.prev/secrets` after the swap.
Otherwise a rotation would leave the revoked key sitting on disk indefinitely in
the rolled-aside generation. Rolling back therefore needs a `--secrets-only`
pass afterwards — which is also what you want: the old code with the current key.

## `RELEASE`

Written by `scripts/install-runtime-launcher.sh` and by nothing else. Do not
hand-edit it — `detect-launcher-drift.mjs` compares the live tree against these
digests, and a hand-edited manifest makes that check assert nothing.

The format is the contract `scripts/lib/launcher-drift.mjs` parses: a
`key: value` header of `[a-z_]+` keys, then a `files:` block of indented
`<sha256>  <install-path>  <versioning>  <source-path>` rows. It is
deliberately not YAML — the installer writes it with shell, and a parser
needing a dependency is a parser the hourly sweep cannot run from a bare
worktree.

That fourth column is load-bearing. Without it the detector falls back to a
hard-coded install-path→source-path table, and any file missing from both is
reported as `unmapped` rather than silently skipped. The installer emits it for
every file, which is what extends drift coverage to `bin/package.json` and
`bin/package-lock.json` — the two files the step-1 hand-written manifest did not
have at all.

Digests of the private keys are **not** in `RELEASE`, which is 0444. They go in
`secrets/KEYS.sha256` at 0400 instead, which is what lets a half-finished
rotation be detected without widening a secret's derived data to every reader of
the manifest.
