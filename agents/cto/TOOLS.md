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


### If control-plane writes start failing (APP-64)

`PAPERCLIP_API_KEY` is a JWT whose `run_id` claim binds this run. If the
server cannot resolve it to a live run, **every** comment and status write in
the run is refused with `403 cross_issue_influence_run_context_required` — a
code whose name says "cross-issue" but which fires just as readily on your own
checked-out issue. The condition is fixed for the life of the run, so retrying
never helps.

Run `scripts/paperclip-run-check.sh` to find out in one call, then deliver via
the courier pattern (issue creation stays open) instead of going silent. Full
decoder: `docs/paperclip-run-binding.md`.

## Capabilities (from `config/agents.yaml`)
`repo:write:platform`, `repo:write:products`, `repo:review`, `ci:read`,
`release:staging`, `release:production:approval_gated`.

## Explicit deny list
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
