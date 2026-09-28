# Builder — TOOLS

## Allowed
`gh` (branch/commit/PR — scoped to the assigned product repo + `appforge-kit`);
`appforge validate`, `appforge test`, `appforge build`.

## Skills — use when
- TODO: per-stack skill list (e.g. `chrome-development`) once Builder has
  run against a real product repo.

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

## Capabilities (from `config/agents.yaml`)
`repo:write:assigned` (the one product this run is scoped to — never
another product's repo), `ci:read`.

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
- No `GITHUB_APP_*` private keys directly — the broker mints a 1-hour,
  1-repo, least-privilege token per run (§17.2).
- No store credentials, no `release-platform` dispatch of any kind.
- No pushing to `main` — draft PR only, per the fixed workflow.
- No adding manifest permissions. The `permission-diff` gate fails the
  check and makes the attempt visible; it does not prevent the merge.
  Never attempt it.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
