# Analyst — TOOLS

## Allowed
`appforge metrics` (read + `anomalies` + `pnl` deterministic commands —
these run as scripts, not model calls, per `config/models.yaml`'s
`deterministic_tasks`).

## Skills — use when
- TODO: once analysis-specific skills exist (e.g. narrative writing
  templates), list them here.

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
`metrics:read`, `metrics:ingest:read-only` (a read-only DB role for
queries — never a write role).

## Explicit deny list
- No `GH_TOKEN`, no `GITHUB_APP_*` private keys — Analyst has no repo-write
  capability at all (not even `brain:pr` — narratives go to CEO for the
  brain PR).
- No write access to the metrics ingest DB — read-only role only.
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
