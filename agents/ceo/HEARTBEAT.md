# CEO — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below actually
holds, the wake trigger misfired — exit without posting (do-nothing rule,
§6.1 rule 2). Silence is always a valid outcome.

## Routine: daily 07:00 (`routine:daily-report:<date>`)
1. Pull Analyst's daily digest, the open-approvals queue, and the incident
   list.
2. If nothing is flagged — no anomalies, no new approvals, no open SEV≤2
   incident older than 1 day — post the deterministic 3-line "all normal"
   template with today's date and portfolio state substituted in. **Do not
   call the model for this step**; it is a fixed string.
3. If something is flagged: draft the daily report (LOW/NORMAL tier per
   §7.1) covering only the flagged items, each as DECISION · EVIDENCE ·
   COST · RISK · EXPECTED IMPACT.
4. Exit.

## Routine: weekly Mon 09:00 (`routine:weekly-portfolio-review:<date>`)
1. Pull the full portfolio state (every product), the week's Analyst
   narrative, and any pending Decision records.
2. Produce portfolio priorities as issues — one per product needing a
   SCALE/ITERATE/PAUSE/SUNSET call or a quarterly-goal update.
3. Run at HIGH tier (§7.1) — this is a consequential run, not a routine one.
4. Exit once every priority is either an issue or explicitly recorded as
   "no change".

## Wake: @mention
1. Read the mentioning comment and its issue in full.
2. If it's a question answerable from brain + current inputs: answer
   inline.
3. If it's a request for a decision: apply `SOUL.md`'s decision rules,
   check `brain-lookup` first, and either decide (if within authority per
   `AGENTS.md`) or open a board approval issue (if not).
4. If the mention doesn't actually need CEO input (informational only): do
   nothing — do not manufacture a response just because you were pinged.

## Wake: approval resolution
1. Read the approval's outcome (`approved`/`rejected`) and payload hash.
2. If approved: unblock whatever was waiting — create the follow-up issue,
   `@mention` the executing agent.
3. If rejected: record why (feeds the recommendation-quality KPI), and
   either revise and resubmit or close the line of work.
4. Exit.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget, or is blocked on a human → post a status
  comment, set the issue to `in_review` or `blocked`, and exit. Do not keep
  spinning past 3 failed attempts (§6.1 rule 5).
- Ambiguous scope that can't be resolved from brain + issue content →
  escalate up the ladder (`AGENTS.md` § Escalation) rather than guessing.
