# CTO — HEARTBEAT

**STATUS: STUB** — this agent is wake-only (no timer, §6.2), and that part
is safe to run against; the numbered step-by-step per wake (TODO below) is
not yet written to `agents/ceo/HEARTBEAT.md`'s level of detail.

## Wake: assignment
TODO: procedure for an assigned architecture/task-breakdown item.

## Wake: mention
TODO: procedure, mirroring `agents/ceo/HEARTBEAT.md`'s mention handling.

## Wake: webhook "PR ready for review"
TODO: review procedure — read PRD/ARCHITECTURE/acceptance criteria, run
the deterministic gates, decide LOW/NORMAL/HIGH/CRITICAL risk, review or
route to independent second opinion if CRITICAL (§7.1).

## Wake: webhook "CI failed on main"
TODO: triage procedure — read the failure, decide fix-forward vs. revert,
open or assign the fix issue.

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2).
- Work exceeds this run's budget or is blocked on a human (e.g. awaiting a
  board approval id before a production dispatch) → post a status comment,
  set `in_review`/`blocked`, exit. Do not exceed 3 failed attempts.
- Ambiguous scope → escalate (`AGENTS.md` § Escalation) rather than guess.
