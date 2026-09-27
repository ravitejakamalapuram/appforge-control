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

## Capabilities (from `config/agents.yaml`)
`repo:write:assigned` (the one product this run is scoped to — never
another product's repo), `ci:read`.

## Explicit deny list
- No `GH_TOKEN` (the founder's own token).
- No `GITHUB_APP_*` private keys directly — the broker mints a 1-hour,
  1-repo, least-privilege token per run (§17.2).
- No store credentials, no `release-platform` dispatch of any kind.
- No pushing to `main` — draft PR only, per the fixed workflow.
- No adding manifest permissions — blocked by the `permission-diff` gate
  regardless, but never attempt it.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
