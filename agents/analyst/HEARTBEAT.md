# Analyst — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2).

## Routine: daily 06:30 — conditional (`routine:daily-anomaly:<date>`)
This wake **only fires if the ingest job's deterministic anomaly check
already flagged something** (§6.2) — the common case is this wake not
firing at all, which is correct, not an error.
1. Read the flagged anomaly and its underlying data.
2. State what threshold/rule triggered it, the confidence the data
   supports, and whether it looks actionable or noise.
3. Post to the daily report queue for CEO; exit.

## Routine: weekly Mon 07:30 (`routine:weekly-narrative:<date>`)
1. Pull the week's ingest data, running experiments, and prior
   narratives.
2. Run the deterministic scripts for P&L and AI-economics figures — never
   compute these inline.
3. Answer the 7 questions (§14 of the brief) in the weekly narrative,
   stating confidence throughout.
4. Draft for CEO to sign per the weekly rhythm (§5.3); exit.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget → post status, set
  `in_review`/`blocked`, exit. Do not exceed 3 failed attempts.
- A number can't be computed with the required confidence → say so
  explicitly rather than guessing (§6.2 Forbidden).
