# CEO — TOOLS

## Allowed
- Paperclip API — read/write within the CEO's own capability scope.
- `gh` — **read-only** (list/view issues, PRs, releases across registered
  repos). No push, no PR creation, no merges.
- `appforge metrics` (read).
- `appforge approval request` / `appforge approval verify`.

## Skills — use when
- `portfolio-review` — the weekly portfolio review and SCALE/ITERATE/
  PAUSE/SUNSET recommendations.
- `brain-lookup` — before any recommendation, to find prior Decision
  records and postmortems on the same question.
- `decision-record` — to write a new `DEC-xxxx` once a decision is made.

## Environment available (§29g)
`APPFORGE_ENV`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (this run's JWT,
injected by Paperclip), `APPFORGE_EDGE_URL`, `APPFORGE_EDGE_TOKEN_READ`,
`ANTHROPIC_API_KEY` (this agent's own key, per-agent workspace where the
vendor supports it). Nothing else — see the deny list below.

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
`paperclip:company`, `metrics:read`, `brain:pr`.

## Explicit deny list

> **This list is cooperative, not enforced.** It describes what a well-behaved
> agent does; it is not a sandbox. Every agent runs arbitrary Bash as the
> founder's own OS uid, and **the uid is the only containment boundary** — a
> process at that uid can reach any issue in this company with no credential
> and can read the instance's signing keys on disk. Treat each line below as a
> standing instruction you are accountable for following, not as something that
> would stop you. Ruling: `DEC-0016` (APP-73). Full model:
> `docs/containment-model.md`.
- No `GH_TOKEN` (the founder's own token). Never *provided* to any agent —
  `agent-launch.sh` does not export it and resets git's credential helpers so
  no git operation reaches it. It remains *reachable* at this uid via
  `gh auth git-credential get` (`DEC-0013`); that path is forbidden, not
  absent.
- No `GITHUB_APP_AGENTS_PRIVATE_KEY` / `GITHUB_APP_RELEASE_PRIVATE_KEY`.
- No store credentials of any kind (Chrome Web Store, Play Console).
- No `release-platform` workflow dispatch.
- No repo write access beyond `brain:pr` (company-brain PRs only) — never
  push to a product repo or `appforge-kit`.
- No `SOPS_AGE_KEY`, `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY`, `GUMROAD_ACCESS_TOKEN`, `ANDROID_KEYSTORE_*` —
  broker/CI-only secrets, never in an agent's own env (§17.1/§17.2).
- No editing `SOUL.md` files — its own or any other agent's.
