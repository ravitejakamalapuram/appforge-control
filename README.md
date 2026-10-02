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

## GitHub access for agents (changed 2026-10-02)

Agents act as the founder's **personal** GitHub account (`ravitejakamalapuram`), with admin on every personal repo. `scripts/agent-launch.sh` reads that account's token from the `gh` keyring at the start of each run (`gh auth token --user ravitejakamalapuram`), so nothing is stored in config or on disk. The `--user` flag matters: the keyring also holds the employer account, which must never be used here. This was a board decision ("we are just starting, admin access for everything, harden later").

- `APPFORGE_GIT_CREDENTIAL` is `founder` in a normal run, `unavailable` if the keyring lookup failed (the agent still starts, without push credentials), and `none` for agents with `APPFORGE_AGENT_REPOS=none`.
- Controls A and B in the launcher stay on, because they keep the employer keychain credential out of raw `git` and `gh`.
- The `appforge-agents` GitHub App and `scripts/github-app-token.mjs` still exist but are no longer called by the launcher. The `appforge-release` App is shelved (APP-92); nothing needs it.
- To tighten this later, restore the per-run App mint (git history before this change) and add real OS-level isolation first (see `docs/containment-model.md`).

## Deliberately not done yet

- No `company export` automation (nightly `paperclipai company export` into this repo).
- No Tailscale / remote phone access (still requires the founder's OK to run VPN-like software on this work laptop).
- Per-run scoped GitHub App tokens (shelved 2026-10-02 in favour of the founder token, see above).
- P1-03 (GitHub→Paperclip webhook relay over Tailscale) — blocked on the Tailscale decision above.
