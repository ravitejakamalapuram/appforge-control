# infra/macos — actual current state (not the original hand-plist design)

The master plan's original §4.3 design assumed a hand-authored launchd plist
for a dedicated `appforge` macOS user. Neither exists. Per §4.3's
**REVISED 2026-09-26** note: this is a work laptop, a new macOS user isn't an
option, and containers were judged as more setup than this stage needs. What
actually runs is documented here instead.

## What's real

- **No separate macOS user.** Everything runs under the founder's own user,
  same as every other repo in `~/git-personal/`. The security boundary is
  *not* the filesystem — it's that agent processes get a clean, minimal
  environment (no `~/git-personal/.envrc`, no `GH_TOKEN`, no
  `CLOUDSDK_CONFIG`) and their own `CLAUDE_CONFIG_DIR`
  (`~/git-personal/appforge-control/.claude-appforge/`, the personal Claude
  account — never `~/.claude`, the work profile, and never the founder's own
  personal session state). See §4.3 for the accepted risk this trades off.

- **No hand-authored plist.** The LaunchAgent at
  `~/Library/LaunchAgents/ing.paperclip.paperclipai.plist` (label
  `ing.paperclip.paperclipai`) is generated and managed entirely by
  Paperclip's own CLI:

  | Task | Command |
  |---|---|
  | Install / register the LaunchAgent | `paperclipai service install` |
  | Check whether it's running | `paperclipai service status` |
  | Restart it | `paperclipai service restart` |

  Nothing in this repo hand-edits that plist's structure. The one exception
  is `apply-service-env.sh` below, which patches two environment variables
  into the plist *after* `paperclipai service install` has generated it —
  because that command only writes its own three env vars and silently drops
  ours.

- **`apply-service-env.sh`** (this directory) — re-applies
  `CLAUDE_CONFIG_DIR` (pointed at the personal AppForge Claude Code login,
  guarded by an `auth status` email check before it touches anything) and
  `PATH` (so Paperclip can find the `claude` binary) to the running
  LaunchAgent, then restarts it and waits for `/api/health` to come back.
  Idempotent; safe to re-run after any Paperclip install/upgrade. Read the
  script's own header comment for the full auth model (agents use
  Paperclip's *unmanaged* `claude_local` path; the CLI reads its own macOS
  Keychain item, nothing is copied out of it).

- **Paperclip itself** — installed via the official installer
  (`paperclip.ing/install.sh`, downloaded, reviewed, and checksum-verified
  before running), self-managed under `~/.paperclip/cli/`. Instance state
  (config, embedded Postgres on port 54329, secrets, logs, local backups)
  lives under `~/.paperclip/instances/default/`. Reachable at
  `http://127.0.0.1:3100` (loopback only — no Tailscale yet). Node via the
  already-installed `nvm`, no system Node change. See the master plan §4.3
  for the full "ACTUAL as of 2026-09-26" state and what's still deferred
  (Tailscale, `pmset` sleep prevention, offsite R2 backup of local backups).

- **Nightly backup (P0-03)** — `backup.sh` + `ing.paperclip.appforge-backup.plist`
  (loaded as LaunchAgent `ing.paperclip.appforge-backup`, separate from
  Paperclip's own service). Runs nightly at 02:00: `paperclipai db:backup`
  (the CLI's own backup subcommand — Paperclip has no standalone `pg_dump`
  binary to shell out to; embedded Postgres lives on port 54329) → age-encrypt
  → upload to R2 (`appforge-backups/paperclip-db/`) → prune to 14 daily + 8
  weekly → ping healthchecks.io (`HEALTHCHECKS_PING_URL_BACKUP`), with an
  ntfy.sh push alert on any failure. Secrets are baked directly into the
  plist's `EnvironmentVariables` (same pattern as `apply-service-env.sh`
  above) since launchd doesn't source `.envrc`. R2 has no `wrangler r2 object
  list`, so retention listing goes through the Cloudflare REST API
  (`GET /accounts/{id}/r2/buckets/{bucket}/objects`) directly with the same
  token. `WorkingDirectory`/`HOME` are set explicitly in the plist — without
  them, wrangler resolves its cache dir relative to launchd's default cwd
  (`/`) and fails with "Missing file or directory: /.wrangler/cache".

- **Catch-up sync (P0-03, `appforge sync`)** — `sync.sh` +
  `ing.paperclip.appforge-sync.plist` (LaunchAgent
  `ing.paperclip.appforge-sync`, separate from both Paperclip's own service
  and the nightly backup job). This is the routine-catch-up half of §4.3's
  "Catch-up sync" (part 2 of 3: "re-create today's routine issues that did
  not fire"); the PR/failed-run backfill and stale-metrics-ingest parts of
  §4.3 are not built by this job.

  Why it exists: the Mac sleeps when unplugged or the lid is closed, so
  Paperclip's own cron scheduler only fires a routine if the Mac happens to
  be awake at the scheduled instant. Every live routine's `catchUpPolicy` is
  `skip_missed` (Paperclip's own default, confirmed via
  `paperclipai routine list --json`) — Paperclip does not catch up a miss on
  its own.

  What it does: lists all routines for the AppForge AI company
  (`paperclipai routine list --company-id <id> --json`), and for each
  enabled schedule trigger, computes the most recent cron occurrence that
  should already have happened (parsing `cronExpression` + `timezone`
  itself — plain 5-field cron, no external library), bounded so it never
  treats an occurrence from before the routine's own `createdAt` as missed
  (otherwise a routine created today with a Monday schedule would wrongly
  flag last Monday, before it existed — this was caught and fixed during
  testing). If an occurrence is more than 30 minutes overdue and neither
  Paperclip's `lastFiredAt` nor this script's own state file already covers
  it, it's genuinely missed and gets caught up via Paperclip's own on-demand
  trigger — `paperclipai routine run <routineId>` (confirmed via
  `paperclipai routine --help` and the OpenAPI spec for
  `POST /api/routines/{id}/run`) — which produces the same effect as a
  natural cron fire (creates the routine's normal assignment issue against
  its existing assignee). No hand-rolled issue creation was needed since
  this on-demand mechanism already exists in this Paperclip version.

  Idempotency: a local state file
  (`appforge-control/state/routine-sync-state.json`, gitignored, one entry
  per trigger id recording the latest occurrence already caught up) plus an
  `idempotencyKey` passed to Paperclip's own run endpoint
  (`catchup:<routineId>:<occurrenceISO>`) as a second line of defense.
  Running the job twice in a row, or every 30 minutes forever, never fires
  the same missed occurrence twice.

  Wake detection: **polling, not a real sleep/wake hook.** launchd has no
  clean, low-complexity "run this on wake from sleep" primitive short of a
  helper daemon watching IOKit power notifications (real added complexity
  for a single-founder side project). The plist instead uses `RunAtLoad`
  (fires immediately when the LaunchAgent loads, e.g. at login) plus
  `StartInterval: 1800` (every 30 minutes, launchd's documented behavior for
  a job whose interval elapsed while the Mac was asleep is to run it
  promptly on wake) as an honest, good-enough fallback. Verified: manual run
  succeeds end-to-end (checked all 5 live routines, correctly found 0
  overdue since none of their schedules have actually passed yet, pinged
  `HEALTHCHECKS_PING_URL_PAPERCLIP` on success); `launchctl bootstrap`
  loaded clean on the first try and `RunAtLoad` fired it immediately,
  logging the same successful run to `logs/sync.log`. Secrets
  (`HEALTHCHECKS_PING_URL_PAPERCLIP`, `NTFY_TOPIC`) are baked into the
  plist's `EnvironmentVariables`, same pattern as the backup job, since
  launchd doesn't source `.envrc`.

## What's not here (and why)

- No `cloud-init.yaml` for a VPS yet — that's the §4.3 "move-to-VPS
  triggers" path, not needed until one of those triggers fires.
- No systemd unit — same reason; only relevant after a VPS move.
- No containerization — considered and declined for V1 (§4.3's "lighter
  intermediate step" section covers what was considered).

## If you're about to hand-edit the plist

Don't, unless you're fixing a bug in `apply-service-env.sh` itself. Run
`paperclipai service install` (or `restart`) first, then
`./apply-service-env.sh` to re-apply the two env vars this repo owns. If the
plist's *structure* ever needs to differ from what Paperclip generates, that
is itself a decision worth a Decision record — see the master plan §4.3 and
§26.
