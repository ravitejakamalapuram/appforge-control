# CTO — TOOLS

## Allowed
`gh` (read/write in platform + product repos per capability below);
`appforge` CLI (`validate`, `test`, `build`, `route`, `security permissions`).

## Skills — use when
- `chrome-development` — reviewing/authoring Chrome extension architecture.
- `chrome-policy-review` — Chrome Web Store policy diffs.
- `security-review` — any PR touching permissions, auth, or data handling.
- `chrome-release` — staging/production release dispatch.
- TODO: guidance on which to reach for first when a review spans more than
  one of these.

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
`repo:write:platform`, `repo:write:products`, `repo:review`, `ci:read`,
`release:staging`, `release:production:approval_gated`.

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
- No `GITHUB_APP_*` private keys directly — tokens come from the broker
  (`appforge cred`), scoped and short-lived.
- No store credentials of any kind — production release dispatch goes
  through `release-platform`'s own OIDC → WIF path, never a credential the
  CTO agent holds.
- Production dispatch requires a verified approval id — never dispatch
  without one (§17.2/§24.1).
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN` (deploy job only, not agent
  env), `R2_*`, `GUMROAD_ACCESS_TOKEN`, `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.

## Host constraints (this Mac) - read before you run a package manager
- The public npm and yarn registries are blocked on purpose: `/etc/hosts` maps `registry.npmjs.org` and
  `registry.yarnpkg.com` to `127.0.0.1` (work-managed machine). `npm install`, `npm ci` and any command that
  downloads from them fail with `ECONNREFUSED`. This is a policy, not an outage: do not retry, do not edit
  hosts, do not configure proxies or alternative mirrors. Already-installed `node_modules` work; `pub.dev`
  (Dart/Flutter) and `github.com` work.
- If a task needs a fresh npm install (for example a Cloud Functions TypeScript project), say so in your
  comment and let GitHub Actions CI build and test it; never claim something was tested locally when it could
  not be.

## Flutter / InvTrack
- `flutter` lives in `/opt/homebrew/bin` (service PATH includes it since 2026-10-01; if `flutter` is "command not found",
  call `/opt/homebrew/bin/flutter` and tell the CTO - the service env needs `infra/macos/apply-service-env.sh`).
- A fresh worktree has no generated localization code (it is not committed). Before `flutter analyze` or `flutter test`
  run `flutter pub get && flutter gen-l10n`, otherwise analyze reports dozens of false `app_localizations.dart` errors.
  The exact CI command is the `test:` line in InvTrack's `release.yaml`; mirror it, do not invent a variant.

## Finish every run cleanly (no leftover background processes)
- Paperclip stops any background process still running when your run ends, and then records the WHOLE run as
  failed (`adapter_failed`, exit 143) and puts you in `error` - even when your work was complete and correct
  (APP-283, 2026-10-01). So: never leave a background task running at the end of a run.
- Prefer foreground commands with a timeout. If you did start something in the background (a long test or build),
  wait for it to finish, read its result, and only then post your final comment and end the run. If it cannot
  finish in time, kill it explicitly and say so in your comment instead of abandoning it.
