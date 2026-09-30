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

- **Quota-retry watchdog (APP-45 / DEBT-0001)** — `../../scripts/quota-retry-watchdog.mjs`
  + `ing.paperclip.appforge-quota-watchdog.plist` (LaunchAgent
  `ing.paperclip.appforge-quota-watchdog`, separate from Paperclip's own
  service, the backup job, and the sync job).

  Why it exists: Paperclip's adapter correctly classifies a Claude provider
  session-limit failure as `errorCode: "provider_quota"` and the run's own
  `error` text carries the real reset time (`"...resets 9:50am
  (Asia/Calcutta)"`), but Paperclip's own retry scheduler
  (`@paperclipai/server` `services/recovery/service.js`, not ours to patch —
  see the APP-45 closing comment) ignores that and re-queues the run on a
  short transient-failure delay instead, observed retrying 30s and 1.6s
  after a failure against a reset ~6h away. 25 quota-failed runs burned
  1,035K input tokens in one 24h window and returned nothing. Per the
  founder's direction, this is deliberately NOT fixed by patching
  Paperclip's internals (fragile, silently overwritten by every
  `paperclipai update`, duplicates control-plane logic this repo does not
  own) — it's fixed at a boundary this repo does own, using Paperclip's own
  `agent pause`/`resume`/`wake` CLI, which work at board/operator level
  (confirmed; an agent's own self-pause 403s).

  What it does, every pass: reads recent heartbeat-run history
  (`GET /api/companies/{id}/heartbeat-runs`, the same endpoint
  `session-burn.mjs` uses — there is no `paperclipai` CLI subcommand that
  returns run history with `errorCode`). For each newly-seen
  `provider_quota` failure, parses the reset time out of the run's own
  `error` text, pauses that agent immediately (so Paperclip's scheduler
  cannot retry it early), and schedules an explicit resume+wake for
  reset-time + a 90s clock-skew buffer. For each newly-seen genuinely
  retryable non-quota failure (`process_lost` — the only such code observed
  in real run history; see `scripts/lib/quota-retry-watchdog.mjs` for the
  full reasoning), does the same pause-then-scheduled-resume, but with real
  exponential backoff + full jitter (Marc Brooker, "Exponential Backoff And
  Jitter", AWS Architecture Blog, 2015) instead of Paperclip's default
  cadence. Resets each agent's backoff attempt counter to 0 on any run it
  sees succeed.

  Idempotency: a local state file
  (`appforge-control/state/quota-retry-watchdog-state.json`, gitignored) —
  same pattern as `sync.sh`'s `routine-sync-state.json` — tracks handled run
  ids (pruned after 7 days), per-agent backoff attempt counts, and any
  pending scheduled resume+wake action. Running the job every 90 seconds
  forever never double-pauses or double-schedules the same failure.

  Tests: `scripts/tests/quota-retry-watchdog.test.mjs` (pure logic — reset-
  time parsing incl. day rollover, backoff bounds/jitter/reset-on-success,
  idempotency) and `scripts/tests/quota-retry-watchdog-integration.test.mjs`
  (the orchestration script against fake fetch data in `--dry-run`,
  including a fixture-driven demonstration that `session-burn.mjs`'s
  `quotaWaste().retriedWithinResetWindow` metric goes to zero once the
  watchdog preempts Paperclip's scheduler — no real quota event needed to
  prove it). `node --test` from `scripts/`.

  Log: `logs/quota-retry-watchdog.log` (every detection, parse, pause,
  resume, wake, and backoff decision — written by the script itself, one
  line per action). `logs/quota-retry-watchdog.{out,err}.log` catch launchd-
  level stdout/stderr (crashes, not routine activity).

- **Digest gate / Analyst 06:30 conditional wake (APP-43 / APP-50)** —
  `digest-gate.sh` + `ing.paperclip.appforge-digest-gate.plist` (LaunchAgent
  `ing.paperclip.appforge-digest-gate`).

  Why the schedule lives here and not in the control plane: §6.2 gates
  Analyst's 06:30 wake on "the ingest job's deterministic anomaly check". A
  Paperclip `schedule` trigger cannot express a condition — it fires every
  day regardless, which is exactly the cost shape APP-50 rejected (a routine
  that "fires unconditionally and spends a model call to conclude nothing",
  against the smallest budget in the company, 400 cents). So routine
  `91419456-6fa8-4521-bafe-c99eab44f2f1` deliberately carries an **`api`
  trigger and no schedule trigger**, and launchd holds the clock. The
  control plane having no 06:30 entry for analyst is correct, not drift —
  `config/agents.yaml` says the same thing next to the routine name.

  What it does: fetches and checks out `origin/main` into a throwaway
  detached worktree and runs `scripts/metrics-digest.mjs --gate` **from
  there**, not from the live working tree — same named-ref discipline as the
  launcher and watchdog deploys (APP-161 / APP-164), so a dirty checkout or
  a half-finished branch can never decide whether Analyst wakes. The gate
  recomputes the digest's §6.2 anomaly flags and exits **0 when at least one
  flag is raised**, **20 on a quiet day**, and **1 when the check itself
  failed**.
  The script POSTs the routine's api trigger on exit 0 only. Exit 20 fires
  nothing and is the expected common case; exit 1 is *not* treated as quiet
  — a broken check must not read as "nothing crossed a threshold", so it
  notifies instead of silently skipping the wake.

  `StartCalendarInterval` is 06:30 **local** time. This machine runs
  Asia/Kolkata, which is the timezone §6.2 names, so 6:30 here is 06:30 IST;
  launchd has no per-job timezone, so a machine timezone change needs this
  changed with it. `RunAtLoad` is `false` on purpose — loading the agent
  (reboot, repair run) must not fire Analyst's wake off-schedule. A missed
  day is cheaper than an unscheduled model call.

  No `PAPERCLIP_API_KEY` in the plist: the control plane serves these GETs
  unauthenticated on `127.0.0.1`, and minting a long-lived key would put a
  standing credential on disk for a job that only needs loopback reads and
  one trigger POST.

  Install: `cp infra/macos/ing.paperclip.appforge-digest-gate.plist
  ~/Library/LaunchAgents/` then `launchctl bootstrap gui/$(id -u)
  ~/Library/LaunchAgents/ing.paperclip.appforge-digest-gate.plist` — same
  copy-and-bootstrap pattern as the backup and sync jobs. Verify a firing
  decision without firing it with `infra/macos/digest-gate.sh --dry-run`.

  Log: `logs/digest-gate.log` / `logs/digest-gate.err.log`.

## Paperclip stale-lock guard (`ing.paperclip.appforge-lock-guard`)

**Why.** After an unclean shutdown (kernel panic 2026-09-28; forced reboot
2026-09-29 23:57 IST) `~/.paperclip/instances/default/db/postmaster.pid` is
left behind and its pid is reused by an unrelated daemon (`cfprefsd`).
Paperclip then refuses to start (`Refusing to reuse PostgreSQL: its data
directory belongs to another instance`) and `ing.paperclip.paperclipai`
crash-loops until someone moves the file aside by hand. It happened twice in
48h; this job does that one step, safely, and nothing else.

**What it does.** Every 60s `paperclip-lock-guard.sh` moves the lock to
`postmaster.pid.stale-<UTC>` (never `rm`; newest 5 kept) **only if all of**:
the lock exists; the API is not healthy (`/api/health` != 200 in 3s); the lock
is older than `MIN_LOCK_AGE_SEC` (60); the pid in it is not a live
`postgres`/`postmaster`; and no `postgres`/`postmaster` process has this data
dir in its args. Any doubt means it does nothing. It never touches Paperclip's
plist or restarts the service - launchd's own `KeepAlive` retries succeed once
the lock is gone. A low-priority ntfy push is sent when it clears a lock.

**Deploy** (also the way to redeploy after editing the script):

```
infra/macos/install-lock-guard.sh
```

The script runs from `~/.appforge-ops/bin/paperclip-lock-guard.sh` (a stable
copy, mode 0555), **not** from the shared checkout, whose branch changes under
live agents, and **not** from `~/.appforge`. That directory belongs to the
runtime-launcher installer, which redeploys it by stage-and-swap of the whole
tree: on 2026-09-30 01:21 a swap deleted this script, the job started exiting
127 and the guard went dark. `~/.appforge-ops` is written by nothing else, and
the installer refuses (`--ops-dir` included, symlinks resolved) to place
anything under `~/.appforge` or `~/.appforge.prev`.

The committed plist carries a `__NTFY_TOPIC__` placeholder; the installer
fills it from `$NTFY_TOPIC` or `~/git-personal/.envrc` and writes the result
`0600`, so the topic is never committed or echoed. Flags: `--no-load`,
`--ops-dir`, `--dest`, `--envrc` (the last three exist for the tests).

The placeholder follows the same `__NAME__` convention as the generic
`install-plists.sh` (PR #43), so that installer can render this template as
well; it does not deploy the script, so `install-lock-guard.sh` remains the
deploy step for this job.

**Undo an automatic clear** (should never be needed): stop Paperclip, then
`mv db/postmaster.pid.stale-<UTC> db/postmaster.pid`.

Log: `logs/paperclip-lock-guard.log` (one line per run, self-trimmed to ~1000
lines past 512KB; `healthy, nothing to do` is the normal line).
`logs/paperclip-lock-guard.{out,err}.log` catch launchd-level output only.
Tests: `scripts/tests/paperclip-lock-guard.test.mjs` (drives the real script
against a fake db dir, fake health endpoint and real postgres-named processes).

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

## Secrets never live in the plists in git (2026-09-30 incident)

**What happened.** Commit `52d4052` (P0-03) baked the real `CLOUDFLARE_R2_API_TOKEN`, the
healthchecks.io ping URLs and the ntfy topic straight into
`ing.paperclip.appforge-backup.plist`, `-sync.plist` and later `-digest-gate.plist`, because
launchd does not source `.envrc` and the values had to be *somewhere*. Those files were committed
and pushed to `main`. The repo is private with no forks, but a private repo is not a secret store:
every clone, PR diff, CI log and agent checkout carries the value.

**The rule now.** The committed `*.plist` files are **templates**. A secret is a named placeholder
(`__CLOUDFLARE_R2_API_TOKEN__`, `__HEALTHCHECKS_PING_URL_BACKUP__`,
`__HEALTHCHECKS_PING_URL_PAPERCLIP__`, `__NTFY_TOPIC__`). The real value is filled in **at install
time** from the environment or `~/git-personal/.envrc` and written only to
`~/Library/LaunchAgents/`, mode `0600`.

```
infra/macos/install-plists.sh --dry-run            # resolve + validate everything, write nothing
infra/macos/install-plists.sh                      # render, install (0600), bootout + bootstrap, all templates
infra/macos/install-plists.sh backup sync          # just those jobs (label suffix or full label)
infra/macos/install-plists.sh --no-load backup     # write the plist but leave launchd alone
```

Properties worth knowing: values are never printed (errors name the *variable*); all jobs are
rendered and `plutil -lint`ed before any file is written, so a missing variable for one job cannot
leave the others half-installed; `.envrc` is parsed, not executed (only `export NAME="literal"`
lines - a value that needs `$(...)` must be exported in the environment instead); the installer
refuses to write a plist that still contains a placeholder. `--dest` and `--envrc` exist for tests.

**The guard.** `scripts/tests/no-secrets-in-repo.test.mjs` scans every tracked (and untracked,
non-ignored) file for Cloudflare tokens, healthchecks ping URLs, GitHub tokens, age secret keys,
PEM private keys with key material, and literal `NTFY_TOPIC` values. It prints only
`file:line  rule`, never the matched text. Run it directly with `node scripts/secret-scan.mjs`.
A line carrying `secret-scan:allow` is skipped; prefer building fake fixtures at runtime instead.

**Rotate after any exposure - do not rely on deleting the file.** Git history still contains the
old values; rewriting shared history under live agents is riskier than the leak it would hide, so
**rotation, not history surgery, is the remediation**:

| Value | Risk if leaked | Action |
|---|---|---|
| `CLOUDFLARE_R2_API_TOKEN` | **High** - read/write/delete on every R2 bucket in the account, including `appforge-backups` | Create a new token, update `.envrc`, run the installer, revoke the old token |
| healthchecks.io ping URLs | Low - lets a stranger send fake "alive" pings for the dead-man's-switch | Optional: regenerate the check's ping URL |
| ntfy topic | Low - lets a stranger push notifications to the founder | Optional: pick a new topic and re-subscribe |

**Not covered here:** `backup.sh`, `sync.sh` and `digest-gate.sh` are still run from the shared
checkout by their plists (the same "runs whatever branch is checked out" hazard the watchdog and
launcher were moved off in APP-137/APP-164). Deploying them under `~/.appforge/bin` is a separate change.
