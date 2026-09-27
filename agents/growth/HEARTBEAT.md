# Growth — HEARTBEAT

**STATUS: STUB** — the routine cadence below is correct per §5.3/§6.2; the
numbered step-by-step per wake (TODO below) is not yet written to
`agents/ceo/HEARTBEAT.md`'s level of detail.

## Routine: weekly Fri 10:00 (`routine:experiment-status:<date>`)
TODO: procedure — pull running experiments, report status, flag any that
have reached a callable sample size for Analyst readout.

## Wake: assignment
TODO: procedure for an assigned copy/experiment/cross-promo task.

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2).
- Work exceeds this run's budget, or needs publish approval not yet
  granted → post a status comment, set `in_review`/`blocked`, exit. Do not
  exceed 3 failed attempts.
- A claim can't be traced to `product-facts.yaml` → escalate or cut the
  claim; never publish it unmarked (§6.2 Forbidden).
