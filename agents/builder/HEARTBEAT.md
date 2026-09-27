# Builder — HEARTBEAT

**STATUS: STUB** — this agent is wake-only with `max_concurrent: 1`
(§6.2/`config/agents.yaml`), and that part is safe to run against; the
numbered step-by-step per wake (TODO below) is not yet written to
`agents/ceo/HEARTBEAT.md`'s level of detail.

## Wake: assignment
TODO: run the fixed `AGENTS.md` § Workflow end to end, one step per bullet.
Must respect `max_concurrent: 1` — if another Builder run is already
active, this run should not have been dispatched; treat that as a bug to
flag, not something to work around.

## Wake: mention on PR/issue
TODO: procedure for addressing review feedback on an existing PR (re-run
the workflow from the affected step forward, not from scratch).

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2).
- Work exceeds this run's budget, or is blocked (missing PRD/acceptance
  criteria, failing CI with no clear fix) → post a status comment, set
  `in_review`/`blocked`, exit. Do not exceed 3 failed attempts.
- Ambiguous scope → escalate to CTO (`AGENTS.md` § Escalation) rather than
  inventing requirements.
