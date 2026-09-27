# Growth — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2).

## Routine: weekly Fri 10:00 (`routine:experiment-status:<date>`)
1. Pull all currently running experiments and their sample sizes so far.
2. For each: report status (running / ready-for-readout / stalled).
3. Flag any that have reached a callable sample size to Analyst for a
   joint readout.
4. Exit.

## Wake: assignment
1. Read the assigned task (listing copy, landing page, tutorial,
   cross-promo placement, experiment design) in full.
2. Draft against `product-facts.yaml` — every capability claim gets a
   `[fact:x]` marker; cut anything that can't be traced.
3. If the task is a new experiment: define the hypothesis and success
   metric before drafting anything else, so Analyst can read it out
   later.
4. Post the draft for approval (`in_review` → CEO) — never publish
   directly while autonomy is L1/L2 for this capability.
5. Exit.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget or needs publish approval not yet
  granted → post status, set `in_review`/`blocked`, exit. Do not exceed 3
  failed attempts.
- A claim can't be traced to `product-facts.yaml` → cut it or escalate;
  never publish it unmarked.
