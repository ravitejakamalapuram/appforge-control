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
  idempotency, and the bounded-pause ceilings),
  `scripts/tests/watchdog-notify.test.mjs` (liveness signalling and alert
  throttling: what it sends when configured, that it sends *nothing* when
  not, and that it never throws on any network failure shape),
  `scripts/tests/quota-retry-watchdog-resilience.test.mjs` (a real failing
  `paperclipai` binary, no mocks), and
  `scripts/tests/quota-retry-watchdog-integration.test.mjs`
  (the orchestration script against fake fetch data in `--dry-run`,
  including a fixture-driven demonstration that `session-burn.mjs`'s
  `quotaWaste().retriedWithinResetWindow` metric goes to zero once the
  watchdog preempts Paperclip's scheduler — no real quota event needed to
  prove it). `node --test` from `scripts/`.

  Log: `logs/quota-retry-watchdog.log` (every detection, parse, pause,
  resume, wake, and backoff decision — written by the script itself, one
  line per action). `logs/quota-retry-watchdog.{out,err}.log` catch launchd-
  level stdout/stderr (crashes, not routine activity).

  **Liveness signalling (APP-103 / DEBT-0003).** This job was the only
  LaunchAgent with no liveness signal, and the one where silence costs the
  most: a silent backup job means a missed backup, but a silent watchdog can
  mean a *paused agent*, because pausing is how the workaround preempts
  Paperclip's scheduler. It now follows the `backup.sh` / `sync.sh` pattern —
  a healthchecks.io ping on a healthy pass, and a `/fail` ping plus an ntfy
  push on a failed one. A pass counts as failed if it throws *or* if any
  individual `pause`/`resume`/`wake` call failed, so a `resume` that cannot
  land raises an alert rather than quietly leaving an agent parked.

  The ntfy push is **throttled**; the `/fail` ping is not. At one pass per
  90s, an unthrottled persistent failure is ~960 phone pushes a day, and a
  channel that noisy gets muted. So the push goes out on the first failure,
  when *what* is failing changes (digits are normalised away, so "due 41min
  ago" vs "due 42min ago" is the same failure), and otherwise at most once an
  hour, plus one "recovered" push when a healthy pass ends the streak (it
  says how many repeats were suppressed). The throttle's record is
  `state/quota-retry-watchdog-state-alerts.json`, kept apart from the main
  state file because a pass that throws never reaches `saveState` — and that
  is the pass that must alert. Losing the record costs at most a duplicate
  push, never a missed one.

  Two env vars drive it: `HEALTHCHECKS_PING_URL_WATCHDOG` (this job's **own**
  check — reusing the sync or backup check would let one job's pings mask
  another's silence) and `NTFY_TOPIC` (shared with the sibling jobs). Either
  may be absent; the script then skips that half silently and still does its
  real job, and every pass logs `liveness=on|off` so the state is visible.

  **Provisioning.** The plist is a template like every other job here (see
  *Secrets never live in the plists in git* below): nothing secret is
  committed, and `install-plists.sh` fills `__NAME__` placeholders from the
  environment or `~/git-personal/.envrc` at install time.
  - `NTFY_TOPIC` is already a placeholder in the template, so failure alerts
    work as soon as the watchdog is reinstalled:
    `infra/macos/install-plists.sh quota-watchdog`.
  - `HEALTHCHECKS_PING_URL_WATCHDOG` is **not** in the template yet, on
    purpose: `install-plists.sh` refuses to install when a placeholder has no
    value, so adding it before the check exists would block reinstalling the
    watchdog at all. Founder step: create a healthchecks.io check for this
    job (period 90s; grace **10 minutes**, ~6 passes — survives one slow pass
    or a brief sleep, catches a dead LaunchAgent within the hour), add
    `export HEALTHCHECKS_PING_URL_WATCHDOG="..."` to `.envrc`, then add the
    `HEALTHCHECKS_PING_URL_WATCHDOG` / `__HEALTHCHECKS_PING_URL_WATCHDOG__`
    pair to the template's `EnvironmentVariables` and reinstall. Confirm the
    next log line says `liveness=on` and the check goes green.

  **The bounded-pause invariant (APP-103 / DEBT-0003).** Monitoring only
  catches the cases where the script stops running. The complementary case —
  the script *is* running but has lost track of a pause — is handled inside
  the script. Alongside `pendingActions` ("when should this agent come
  back?") the state file keeps `pausedAgents`: a registry of agents this
  watchdog actually parked and has not yet successfully got back out,
  including the interrupted run's `issueId`. A pending action is cleared once
  its resume succeeds; a pause claim the same way, and the sweep below never
  depends on the pending action still existing.

  Every pass, after the ordinary due-resume loop, a claim is force-resumed
  when it is more than **10 minutes** past its own scheduled resume, when its
  scheduled resume is missing/unusable, or when it has been held past an
  absolute ceiling — **12 hours** for a backoff pause (those are capped at
  30min, so 12h means the schedule is wrong), **8 days** for a quota pause.
  The quota ceiling is long because provider resets are: a weekly limit
  resets days out, and a daily reset that rolled over can be ~24h away. A 12h
  ceiling there would force-resume the agent into the same limit and re-pause
  it every 12h. The first ceiling catches a `resume` that keeps failing or a
  pending action that was lost; the second a schedule never written; the
  third a schedule that is itself wrong (a mangled parse landing weeks out),
  which the first cannot catch because it trusts the very number that is
  wrong.

  The force-resume wake is the same wake as the ordinary path: bound to the
  interrupted run's issue (`--payload {"issueId"}`, APP-181) so the resumed
  run can PATCH and comment, and carrying the APP-164 pause-collateral note.

  **Fail open.** A premature resume costs one failed run — the agent wakes,
  hits the quota again, and the watchdog re-pauses it on the next pass. A
  missed resume costs an agent indefinitely. When the two are in tension,
  the sweep resumes.

  Two deliberate limits on the sweep. It only force-resumes pauses the
  watchdog itself issued: if an agent is already paused when a failure is
  detected and there is no existing claim, the watchdog schedules the resume
  but logs `PAUSE-OWNERSHIP` and does not take ownership, because silently
  undoing a founder's deliberate pause would be worse than the bug being
  fixed. And if the state file is lost entirely, the registry goes with it —
  there is then no way to tell a watchdog pause from an operator pause, so
  that case is covered by liveness signalling, not by the sweep. To narrow
  that window the state file is written atomically (write `.tmp`, then
  `rename`; a failed rename removes the `.tmp`), so a crash or a launchd
  `ExitTimeOut` kill mid-write cannot leave truncated JSON.

  An individual `pause`/`resume`/`wake` failure no longer throws out of the
  pass. It used to, which skipped every remaining agent *and* `saveState`.
  Failures are now collected, logged and alerted on, and the pass carries on;
  a failed pause leaves its run unmarked so the next pass retries it, and a
  failed resume leaves both the pending action and the pause claim in place.

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

## play-vitals (daily Google Play crash/ANR check)

`play-vitals.sh` + `ing.paperclip.appforge-play-vitals.plist` (LaunchAgent `ing.paperclip.appforge-play-vitals`,
daily 09:10 local). Runs `scripts/play-vitals.mjs` from a detached worktree at `origin/main` for each package in
`PLAY_VITALS_PACKAGES` (default InvTrack). Exit handling: ok and `insufficient_data` are logged only (too few users for
Play to report vitals is not an all-clear, and not a failure); an **alert** opens ONE Paperclip issue for the CTO per
data window and pushes via ntfy; a **failed check** pushes via ntfy and exits non-zero. The key is only a *path*
(`PLAY_SA_KEY_FILE`); the job alone reads it. Install: `infra/macos/install-plists.sh play-vitals`. Preview:
`infra/macos/play-vitals.sh --dry-run`. Tests: `scripts/tests/play-vitals-job.test.mjs`.


## release-bridge (hourly GitHub -> Paperclip + ntfy, APP-293)

`release-bridge.sh` + `ing.paperclip.appforge-release-bridge.plist` (LaunchAgent `ing.paperclip.appforge-release-bridge`,
hourly). `scripts/release-bridge.mjs` reads the app repos in `release-platform/apps.yaml` (`RELEASE_BRIDGE_APPS`) and
polls GitHub **read-only** (`gh issue list --label listing-verify`, `gh run list`) for open `listing-verify` issues and
failed `listing`/`release`/`promote` runs (last 48h). Each NEW one opens ONE Paperclip issue for the CTO and sends ntfy;
the GitHub issue/run URL is the de-dup key (`state/release-bridge-seen.json`). A `gh` error, an unreadable app list or a
failed Paperclip POST is **broken**: ntfy plus a non-zero exit, never a quiet day. Uses the host's `gh` login.
Install: `infra/macos/install-plists.sh release-bridge`. Preview: `infra/macos/release-bridge.sh --dry-run`.
Tests: `scripts/tests/release-bridge.test.mjs`.


## job-liveness (did every job run? APP-294)

Every job writes a stamp, `state/heartbeats/<job>.json` = `{job, started, finished, exitCode, lastSuccess}`: shell jobs through
`heartbeat.sh` (`hb_wrap <job> "$@"` re-runs the script as a child, so the stamp has the real exit code; `--dry-run` is not a run),
`lock-guard` and `quota-watchdog` inline (they deploy standalone). `job-liveness.sh` + `ing.paperclip.appforge-job-liveness.plist`
(every 10 min, from a detached `origin/main` worktree) watches the jobs listed under `expected` in `config/jobs.yaml`
(a reviewed list: every plist template must be in `expected` or `not_installed`, otherwise the checker fails loud; jobs
under `not_installed` are never watched). It reads the cadence from each plist (`StartInterval` / `StartCalendarInterval`)
and reports, per expected job: **not-loaded** (absent from `launchctl list`), **never-ran** (no stamp), **failed** (last exit non-zero),
**overdue** (last success older than cadence + grace; grace = max(5 min, cadence/2), 3 h for daily jobs, 12 h for weekly),
**unreadable** or **no-cadence**. It also runs `sync-agent-instructions.mjs` (report mode) and `detect-launcher-drift.mjs`:
exit 1 = drift, any other failure = broken. Each finding opens **one** Paperclip issue (`Schedule liveness: <key>`, CTO) plus
ntfy and closes that issue by itself when the key is healthy again. A pass right after the Mac slept (checker's own last
success older than 2 cycles) holds alerts one pass so jobs can catch up. Does not unpause the "Hourly platform integrity sweep"
routine; that needs CTO/board sign-off.
**Who checks the checker:** (on this host the digest gate is in `not_installed`, so (1) and (2) are off and only (3) applies) (1) the digest gate (`digest-gate.sh`, separate launchd job, daily 06:30) runs
`job-liveness.mjs --self-only`, which fails and sends ntfy if the checker's own stamp is missing or older than cadence + grace;
(2) the checker watches the digest gate's stamp, so the two watch each other; (3) optional `HEALTHCHECKS_PING_URL_LIVENESS`
is pinged only after a complete pass, an external dead-man's switch for the case where both die (Mac off).
Install: `infra/macos/install-plists.sh job-liveness`. Preview: `infra/macos/job-liveness.sh --dry-run`.
Tests: `scripts/tests/job-liveness.test.mjs`.
