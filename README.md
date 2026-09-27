# appforge-control

Company-as-code for AppForge AI: agent instruction files, skills, configuration, and infra notes for the self-hosted Paperclip control plane.

Per the master plan (`~/git-personal/.claude/appforge-ai-master-plan.md`), §4.3/§11.2/§29f.

## What's real right now (P0-01/P0-02, 2026-09-26)

Paperclip runs on this laptop as the founder's own user (no separate macOS user — this is a work laptop and a new account isn't possible; see the master plan §4.3 for the revised isolation approach):

- Installed via the official installer, managed under `~/.paperclip/cli/`
- Instance data (config, embedded Postgres, secrets, logs, local backups) under `~/.paperclip/instances/default/`
- Registered as a per-user LaunchAgent (`ing.paperclip.paperclipai`), starts on login
- `PAPERCLIP_TELEMETRY_DISABLED=1` set
- Reachable at `http://127.0.0.1:3100` (loopback only — no Tailscale yet, pending the founder's OK to install VPN-like software on a work machine)
- Claude Code runs as the **personal** account (never `~/.claude`, the work account on this laptop). See "Claude account wiring" below.

## Claude account wiring (2026-09-27)

Agents use Paperclip's **unmanaged** `claude_local` path: no "AI connection" is bound. Paperclip spawns the real `claude` CLI with `CLAUDE_CONFIG_DIR=~/git-personal/appforge-control/.claude-appforge`, and the CLI reads and refreshes its own macOS Keychain item. This is the same mechanism `~/git-personal/.envrc` relies on. Nothing is copied out of the Keychain, so nothing goes stale.

Do not use Paperclip's "Claude Subscription → Connect" button. In v2026.916.1 it imports only the short-lived OAuth access token (about 8h) into Paperclip's database and injects it as `CLAUDE_CODE_OAUTH_TOKEN`, with no refresh token. Every run bound to it fails once that token expires. On macOS it also can't find the Keychain item for a non-default `CLAUDE_CONFIG_DIR`.

The account is pinned in three places:
1. Per agent: `adapterConfig.env.CLAUDE_CONFIG_DIR`, plus `engine: "cli"` and `command: ~/.local/bin/claude`. This is the primary guard for runs.
2. LaunchAgent plist `EnvironmentVariables`: `CLAUDE_CONFIG_DIR` and a `PATH` that includes `~/.local/bin`.
3. `~/.paperclip/instances/default/.env`: `CLAUDE_CONFIG_DIR`, as a backstop if the plist is regenerated.

**After any `paperclipai` upgrade or `service install`, run `infra/macos/apply-service-env.sh`.** The installer rewrites the plist and drops custom env. The script checks that the dir is logged in as the personal account before it restarts anything.

If the login ever expires, run `CLAUDE_CONFIG_DIR=~/git-personal/appforge-control/.claude-appforge claude auth login` and sign in with the personal account.

## Layout

```
agents/<name>/{SOUL,AGENTS,HEARTBEAT,TOOLS}.md   agent instruction files (§6.1)
skills/<name>/SKILL.md                            skills synced into Paperclip's skill store (§8)
config/{company,agents,models,budgets,products,security,analytics}.yaml   (§29f)
infra/macos/                                      launchd/service notes (informational — the tool manages its own plist)
company/                                          nightly `paperclipai company export` lands here (not yet wired up)
```

## Deliberately not done yet

- Only the CEO agent exists (heartbeat disabled). It was used for smoke tests APP-1 and APP-2.
- No `company export` automation.
- No offsite (R2) backup of local Postgres backups.
- No Tailscale / remote phone access.
