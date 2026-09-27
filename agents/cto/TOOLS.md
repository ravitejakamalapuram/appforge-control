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
