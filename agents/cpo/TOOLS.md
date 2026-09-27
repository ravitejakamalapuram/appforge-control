# CPO — TOOLS

## Allowed
WebSearch/WebFetch; `gh` — **read-only** (no push, no PR, no merge).

## Skills — use when
- `market-research` — opportunity discovery, sizing.
- `competitor-analysis` — competitive landscape for an opportunity or PRD.
- `prd-writing` — turning a G2-validated opportunity into a `PRODUCT.md`.
- `pricing` — pricing hypotheses.
- TODO: guidance on which to reach for first when a research task doesn't
  cleanly fall into one bucket.

## Environment available (§29g)
`APPFORGE_ENV`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (run JWT),
`APPFORGE_EDGE_URL`, `APPFORGE_EDGE_TOKEN_READ`, `ANTHROPIC_API_KEY`.

## Capabilities (from `config/agents.yaml`)
`web:research`, `brain:pr`, `metrics:read`.

## Explicit deny list
- No repo-write token of any kind (§7.1 threat model: "web research agents
  (CPO/Growth) have no repo-write token") — brain PRs only.
- No `GH_TOKEN`, no `GITHUB_APP_*` private keys.
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
