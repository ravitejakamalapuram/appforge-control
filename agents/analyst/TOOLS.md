# Analyst — TOOLS

## Allowed
`appforge metrics` (read + `anomalies` + `pnl` deterministic commands —
these run as scripts, not model calls, per `config/models.yaml`'s
`deterministic_tasks`).

## Skills — use when
- TODO: once analysis-specific skills exist (e.g. narrative writing
  templates), list them here.

## Environment available (§29g)
`APPFORGE_ENV`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (run JWT),
`APPFORGE_EDGE_URL`, `APPFORGE_EDGE_TOKEN_READ`, `ANTHROPIC_API_KEY`.

### If control-plane writes start failing, or land as the board (APP-64, APP-119)

`PAPERCLIP_API_KEY` is a JWT whose `run_id` claim binds this run. If the
server cannot resolve it to a live run, **every** comment and status write in
the run is refused with `403 cross_issue_influence_run_context_required` — a
code whose name says "cross-issue" but which fires just as readily on your own
checked-out issue. The condition is fixed for the life of the run, so retrying
never helps.

There is a second, quieter failure (APP-119). This instance runs in
`local_trusted` mode, where a request the middleware reads as carrying **no**
credential is accepted **as the board** — it returns 2xx and is stored as
`authorType: user` / `authorUserId: local-board`, with nothing in the response
saying the credential was ignored. Sending `X-Paperclip-Api-Key:
$PAPERCLIP_API_KEY` instead of `Authorization: Bearer $PAPERCLIP_API_KEY`
reaches it by accident. It is not cosmetic: a board comment fires an
`issue_commented` wake and gets founder reopen semantics, so one mistyped header
has moved an issue from `done` back to `todo` and cancelled its retry run.

Run `~/git-personal/appforge-control/scripts/paperclip-run-check.sh` to find
out in one call — use that absolute path, your heartbeat cwd is the project
workspace, not the checkout. It probes a write and then reads the activity log
back to check how that write was recorded:

- `0` — the probe succeeded **and** was recorded as this agent and this run.
- `1` — every write this run will 403. Deliver via the courier pattern (issue
  creation stays open) instead of going silent.
- `2` — the check could not be completed, or the write landed but its
  attribution could not be read back. **Not an all-clear.**
- `3` — the write succeeded but was recorded as **the board**. Do not write:
  report the run id in your final response and deliver there.

Exit `0` proves the control plane attributes a *correctly formed* write from
this run; it cannot see a later call of yours that launders itself under the
wrong header name. So send both `Authorization: Bearer $PAPERCLIP_API_KEY` and
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on every call, and check `authorType` in
the response of every write. If one of yours did land as `local-board`, claim it
in a follow-up comment — do not delete or edit the mis-stamped record, it is the
audit evidence. Full decoder for both families:
`docs/paperclip-run-binding.md` in `appforge-control`.

## Working with repos (APP-72)

Every agent shares **one working copy** per repo at `~/git-personal/<repo>`.
It is not yours. APP-48 §2 recorded three collisions in a single run: a commit
landing on another agent's branch, a branch cut from another agent's HEAD, and
a `git commit --amend` rewriting a third agent's commit — recovered only
because the tree happened to be byte-identical that time.

- **Work in a run-scoped worktree, never in the shared checkout.**

  ```bash
  git -C ~/git-personal/<repo> worktree add --detach \
    "$PAPERCLIP_RUN_SCRATCH_DIR/<repo>-<issue>" origin/<base>
  cd "$PAPERCLIP_RUN_SCRATCH_DIR/<repo>-<issue>" && git switch -c <branch>
  ```

  `--detach` is what leaves the base ref free for other runs. Scratch dir
  only — never a persistent worktree root. `~/git-personal/.appforge-wt/` was
  one, and it leaked a worktree holding uncommitted work across runs.

- **Never `git checkout` or `git switch` in `~/git-personal/<repo>`.** Leave
  the shared checkout on whatever branch you found it on, even when that branch
  looks stale or abandoned — it may be another agent's live run. Reading files
  there is unsafe for the same reason: it can be on any branch at any moment.
  Read from your own worktree, at a ref you chose.

- **Branch from `origin/<base>`, not from local `HEAD`.** The shared checkout's
  HEAD is whatever the last agent left there, which is how APP-48's
  branch-cut-from-a-stranger's-HEAD happened.

- **Verify branch state against the remote, not local refs:**
  `git ls-remote --heads origin`. Concurrent runs leave local `origin/*` refs
  stale, and that has already caused a pushed branch to be reported as
  unpushed.

- **Tear down explicitly at the end of the run:**

  ```bash
  git -C ~/git-personal/<repo> worktree remove --force \
    "$PAPERCLIP_RUN_SCRATCH_DIR/<repo>-<issue>"
  ```

  Paperclip deletes `$PAPERCLIP_RUN_SCRATCH_DIR` when the run ends, but nothing
  deletes the `.git/worktrees/` metadata pointing into it.
  `scripts/agent-launch.sh` prunes leftovers on the next launch as a backstop —
  that is a net, not a substitute for the teardown.

- **A fresh worktree has no `node_modules`.** In `appforge-brain` that makes
  `generate-index`, `validate:schema` and `npm test` fail with
  `ERR_MODULE_NOT_FOUND` on `js-yaml` *before they read any data* — a missing
  dependency, not a validation failure. Symlink the main checkout's tree first
  (`ln -s ~/git-personal/appforge-brain/node_modules node_modules`), then
  re-run. Delete that symlink before committing: `.gitignore` says
  `node_modules/`, which is directory-only, so the symlink shows up as
  untracked and `git add -A` will stage it. Also `validate:append-only` takes
  **two refs**, not a range: `npm run validate:append-only main HEAD`.

- **Never delete another task's uncommitted work.** If you find a worktree or a
  dirty tree you did not create, leave it alone and raise it on your issue for
  its owner to reclaim or discard. Exercising that judgement is the point of
  this section, not an exception to it.

## Repo scope — check it before you implement (APP-251)

Your run's GitHub token covers only the repos in `APPFORGE_AGENT_REPOS`, which
is set **per agent**. A repo outside it fails `git push` with `remote:
Repository not found.` — which reads like a missing repo or a broken token and
is neither.

```
~/git-personal/appforge-control/scripts/repo-scope-check.sh <repo>   # or no args, inside the repo
```

Exit 0 = in scope, 1 = out of scope (escalate before implementing, not after),
2 = unverified. It reads two env vars, makes no network call, and costs
nothing. Run it at turn one on any task that will end in a push.

If it says out of scope, do **not** conclude the App is uninstalled:
`GET /installation/repositories` returns *your token's* repos, not the
installation's, so it will agree with you and prove nothing. Full explanation:
`docs/agent-repo-scope.md`.

## Capabilities (from `config/agents.yaml`)
`metrics:read`, `metrics:ingest:read-only` (a read-only DB role for
queries — never a write role).

## Explicit deny list

> **This list is cooperative, not enforced.** It describes what a well-behaved
> agent does; it is not a sandbox. Every agent runs arbitrary Bash as the
> founder's own OS uid, and **the uid is the only containment boundary** — a
> process at that uid can reach any issue in this company with no credential
> and can read the instance's signing keys on disk. Treat each line below as a
> standing instruction you are accountable for following, not as something that
> would stop you. Ruling: `DEC-0016` (APP-73). Full model:
> `docs/containment-model.md`.
- No `GH_TOKEN`, no `GITHUB_APP_*` private keys in this agent's environment.
  Analyst is granted no repo capability: `APPFORGE_AGENT_REPOS=none`, so
  `agent-launch.sh` mints no installation token and scrubs `GH_TOKEN` /
  `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` before exec. Not even `brain:pr` —
  narratives go to CEO for the brain PR.
  **This is a granted-capability statement, not a guarantee of inability.** An
  earlier version of this line read "Analyst has no repo-write capability at
  all", which was false: `secrets/appforge-agents.private-key.pem` is readable
  at this uid, so an Analyst run can mint its own installation token
  (`scripts/github-app-token.mjs`), and `gh auth git-credential get` still
  returns a founder token from the OS keyring. Both are listed under
  `WHAT THIS DOES NOT CLOSE` in `scripts/agent-launch.sh`. **Do not use either.**
  Reaching for one is a deny-list violation and a reportable finding, not a
  capability — see `DEC-0013`.
- No write access to the metrics ingest DB — Analyst is granted the
  `metrics:ingest:read-only` role only. The role grant is enforced by Postgres
  *for that role*; it is not a containment boundary, because this uid owns the
  embedded Postgres data dir and `master.key`. Same rule: do not go around it.
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
