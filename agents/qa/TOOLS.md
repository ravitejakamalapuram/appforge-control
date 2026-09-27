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

## Capabilities (from `config/agents.yaml`)
`repo:read`, `repo:tests-pr` (a separate PR adding only `tests/` files —
never modifies product code), `browser:e2e`.

## Explicit deny list
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
