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
- No LLM provider configured yet — nothing can actually run until that's decided

## Layout

```
agents/<name>/{SOUL,AGENTS,HEARTBEAT,TOOLS}.md   agent instruction files (§6.1)
skills/<name>/SKILL.md                            skills synced into Paperclip's skill store (§8)
config/{company,agents,models,budgets,products,security,analytics}.yaml   (§29f)
infra/macos/                                      launchd/service notes (informational — the tool manages its own plist)
company/                                          nightly `paperclipai company export` lands here (not yet wired up)
```

## Deliberately not done yet

- No agents hired (needs an LLM provider decision first — see the founder conversation).
- No `company export` automation.
- No offsite (R2) backup of local Postgres backups.
- No Tailscale / remote phone access.
