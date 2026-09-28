# QA — TOOLS

## Allowed
`gh` (read product repos; write only to a separate tests-only PR);
`appforge test --e2e`; Playwright (persistent context, `--load-extension`).

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

## Capabilities (from `config/agents.yaml`)
`repo:read`, `repo:tests-pr` (a separate PR adding only `tests/` files —
never modifies product code), `browser:e2e`.

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
