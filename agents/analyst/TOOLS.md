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

Run `~/git-personal/appforge-control/scripts/paperclip-run-check.sh` to find
out in one call — use that absolute path, your heartbeat cwd is the project
workspace, not the checkout. Exit `0` means a write probe actually succeeded;
`1` means every write this run will 403; `2` means the check could not be
completed and is not an all-clear. On `1`, deliver via the courier pattern
(issue creation stays open) instead of going silent. Full decoder:
`docs/paperclip-run-binding.md` in `appforge-control`.

## Capabilities (from `config/agents.yaml`)
`metrics:read`, `metrics:ingest:read-only` (a read-only DB role for
queries — never a write role).

## Explicit deny list

> **This list is cooperative, not enforced.** It describes what a well-behaved
> agent does; it is not a sandbox. Every agent runs arbitrary Bash as the
> founder's own OS uid, and **the uid is the only containment boundary** — a
> process at that uid can reach any issue in this company with no credential
> and can read the instance's signing keys on disk. Treat each line below as a
> standing instruction you are accountable for following, not as something that
> would stop you. Ruling: `DEC-0016` (APP-73). Full model:
> `docs/containment-model.md`.
- No `GH_TOKEN`, no `GITHUB_APP_*` private keys in this agent's environment.
  Analyst is granted no repo capability: `APPFORGE_AGENT_REPOS=none`, so
  `agent-launch.sh` mints no installation token and scrubs `GH_TOKEN` /
  `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` before exec. Not even `brain:pr` —
  narratives go to CEO for the brain PR.
  **This is a granted-capability statement, not a guarantee of inability.** An
  earlier version of this line read "Analyst has no repo-write capability at
  all", which was false: `secrets/appforge-agents.private-key.pem` is readable
  at this uid, so an Analyst run can mint its own installation token
  (`scripts/github-app-token.mjs`), and `gh auth git-credential get` still
  returns a founder token from the OS keyring. Both are listed under
  `WHAT THIS DOES NOT CLOSE` in `scripts/agent-launch.sh`. **Do not use either.**
  Reaching for one is a deny-list violation and a reportable finding, not a
  capability — see `DEC-0013`.
- No write access to the metrics ingest DB — Analyst is granted the
  `metrics:ingest:read-only` role only. The role grant is enforced by Postgres
  *for that role*; it is not a containment boundary, because this uid owns the
  embedded Postgres data dir and `master.key`. Same rule: do not go around it.
- No store credentials, no `release-platform` dispatch.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_*`, `GUMROAD_ACCESS_TOKEN`,
  `ANDROID_KEYSTORE_*`.
- No editing `SOUL.md` files — its own or any other agent's.
