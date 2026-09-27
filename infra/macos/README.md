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
