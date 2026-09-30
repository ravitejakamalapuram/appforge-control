# QA — TOOLS

## Allowed
`gh` (read product repos; write only to a separate tests-only PR);
`appforge test --e2e`; Playwright (persistent context, `--load-extension`).

### What `browser:e2e` is, and the one thing it is not (APP-194)

It is real and it works — verified 2026-09-29, not assumed. `@appforge/e2e`
(`appforge-kit`, `packages/e2e`) is merged, Playwright and its Chromium are
installed, the harness's own suite runs 10/10 green against a real browser, and
`appforge test --e2e` returns `ok: true` end to end. Reach for it without
checking first.

What it launches is a **clean, throwaway Chromium from an empty temp profile**,
with a built MV3 extension side-loaded. That profile has no cookies and no
relationship to any browser the founder is logged into. So `browser:e2e` gives
you **no** route to the Chrome Web Store Developer Dashboard, the Play Console,
or any other authenticated page — and there is no other route either. When a
task needs a logged-in dashboard, the answer is a founder-session manual step,
not a browser flag. Say so early rather than accepting the assignment: APP-54
was routed to you on the assumption that `browser:e2e` covered a CWS export,
and lost a day to it.

Two sharp edges when you run it:

- `appforge test --e2e` builds the product first, and that build shells out to
  `pnpm`, which is **not on `PATH` here**. It fails with
  `spawnSync pnpm ENOENT` before the browser ever starts. Build separately and
  pass `--dist`.
- `--dist` resolves against your **process cwd**, not against `--dir`. Give it
  an absolute path, or it silently looks somewhere else and reports a missing
  `manifest.json`.

Full definition, including what the other capability strings mean:
`docs/capabilities.md` in `appforge-control`.

## Skills — use when
- TODO: once a `chrome-qa`-style skill exists, list it here with when to
  reach for it vs. the fixed deterministic suite in §13.3.

## Environment available (§29g)
`APPFORGE_ENV`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (run JWT),
`ANTHROPIC_API_KEY`.

### If control-plane writes start failing (APP-64)

`PAPERCLIP_API_KEY` is a JWT whose `run_id` claim binds this run. If the
server cannot resolve it to a live run, **every** comment and status write in
the run is refused with `403 cross_issue_influence_run_context_required` — a
code whose name says "cross-issue" but which fires just as readily on your own
checked-out issue. The condition is fixed for the life of the run, so retrying
never helps.

Run `~/git-personal/appforge-control/scripts/paperclip-run-check.sh` to find
out in one call — use that absolute path, your heartbeat cwd is the project
workspace, not the checkout. Exit `0` means a write probe actually succeeded;
`1` means every write this run will 403; `2` means the check could not be
completed and is not an all-clear. On `1`, deliver via the courier pattern
(issue creation stays open) instead of going silent. Full decoder:
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

## Capabilities (from `config/agents.yaml`, defined in `docs/capabilities.md`)
`repo:read`, `repo:tests-pr` (a separate PR adding only `tests/` files —
never modifies product code), `browser:e2e` (headless Chromium against a built
extension — **not** an authenticated browser session; see above).

## Explicit deny list

> **This list is cooperative, not enforced.** It describes what a well-behaved
> agent does; it is not a sandbox. Every agent runs arbitrary Bash as the
> founder's own OS uid, and **the uid is the only containment boundary** — a
> process at that uid can reach any issue in this company with no credential
> and can read the instance's signing keys on disk. Treat each line below as a
> standing instruction you are accountable for following, not as something that
> would stop you. Ruling: `DEC-0016` (APP-73). Full model:
> `docs/containment-model.md`.
- No `GH_TOKEN` (the founder's own token).
- No `GITHUB_APP_*` private keys directly — broker-minted, read-scoped
  tokens for the assigned repo only.
- No product-code edits, even to "fix" a failing test.
- No approving a release — QA passes/fails at G5; release approval is a
  separate board/CTO step (§24.1).
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
