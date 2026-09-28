# Growth — TOOLS

## Allowed
`gh` — **read-only** (no push, no PR beyond `brain:pr`/`hubsite:pr` scope);
`appforge metrics` (read).

## Skills — use when
- TODO: once growth-specific skills (listing copy, cross-promo) exist,
  list them here with when to reach for each.

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
`brain:pr`, `metrics:read`, `hubsite:pr`.

## Explicit deny list
- No repo-write token beyond `brain:pr`/`hubsite:pr` (§7.1 threat model:
  "web research agents (CPO/Growth) have no repo-write token" — Growth's
  only write surface is brain and hub-site content PRs).
- No `GH_TOKEN`, no `GITHUB_APP_*` private keys.
- No paid-ads accounts or spend of any kind.
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
