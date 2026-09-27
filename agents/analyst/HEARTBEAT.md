# Analyst — HEARTBEAT

**STATUS: STUB** — the routine cadence below is correct per §5.3/§6.2
(including the daily wake's conditional trigger); the numbered step-by-step
per wake (TODO below) is not yet written to `agents/ceo/HEARTBEAT.md`'s
level of detail.

## Routine: daily 06:30 — conditional (`routine:daily-anomaly:<date>`)
This wake **only fires if the ingest job's deterministic anomaly check
already flagged something** (§6.2) — it is not a general daily report.
TODO: procedure for writing up a flagged anomaly with confidence.

## Routine: weekly Mon 07:30 (`routine:weekly-narrative:<date>`)
TODO: procedure — answer the 7 questions (§14 of the brief), pull P&L and
AI-economics figures from the deterministic scripts (never compute them
inline), draft for CEO to sign per the weekly rhythm (§5.3).

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2). Note:
  the daily wake not firing at all (because nothing was flagged) is the
  expected common case, not an error.
- Work exceeds this run's budget → post a status comment, set
  `in_review`/`blocked`, exit. Do not exceed 3 failed attempts.
- A number can't be computed with the required confidence → say so
  explicitly rather than guessing (§6.2 Forbidden).
