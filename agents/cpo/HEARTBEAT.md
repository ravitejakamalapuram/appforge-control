# CPO — HEARTBEAT

**STATUS: STUB** — wake reasons and the do-nothing/exit rules are correct
and safe to run against; the numbered step-by-step per wake (TODO below) is
not yet written to `agents/ceo/HEARTBEAT.md`'s level of detail.

## Routine: weekly Wed 10:00 (`routine:weekly-scouting:<date>`)
Opportunity scouting batch, capped at 5 opportunities per run (§5.3/§6.2).
TODO: exact procedure (source list, disproof-checklist-first vs. last,
what counts as "batch done").

## Wake: assignment
TODO: procedure for an assigned research/PRD task.

## Wake: @mention
TODO: procedure, mirroring `agents/ceo/HEARTBEAT.md`'s mention handling —
answer if answerable, otherwise apply `SOUL.md`'s decision rules.

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2).
- Work exceeds this run's budget or is blocked on a human → post a status
  comment, set `in_review`/`blocked`, exit. Do not exceed 3 failed
  attempts (§6.1 rule 5).
- Ambiguous scope → escalate (`AGENTS.md` § Escalation) rather than guess.
