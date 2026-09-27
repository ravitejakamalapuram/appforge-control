# CPO — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2).

## Routine: weekly Wed 10:00 (`routine:weekly-scouting:<date>`)
1. Pull the current opportunity backlog, recent feedback clusters, and
   Analyst's latest data.
2. Source up to 5 new candidate opportunities (competitor gaps, feedback
   patterns, adjacent-product ideas) — cap at 5 per run (§5.3/§6.2).
3. For each candidate, run the 14-question disproof checklist (§9 of the
   brief) before writing anything else — a candidate that fails early
   exits at G0/G1 with a short kill note, not a full write-up.
4. Write an `Opportunity` YAML (§16 shape) in
   `brain/research/opportunities/` for every candidate that survives to G2.
5. Exit once all 5 slots are either written up or explicitly killed.

## Wake: assignment
1. Read the assigned task (research question, PRD request, pricing
   hypothesis, kill-recommendation request) in full.
2. Apply the relevant skill (`market-research`, `competitor-analysis`,
   `prd-writing`, `pricing`) and `SOUL.md`'s decision rules.
3. Produce the requested artifact with confidence stated.
4. Exit.

## Wake: @mention
1. Read the mentioning comment and its issue in full.
2. If answerable from brain + current research: answer inline.
3. If it asks for a G3 recommendation: recommend to CEO — never
   self-approve (§6.2 Forbidden).
4. If the mention doesn't need CPO input: do nothing.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget, or 3 failed attempts → post status, set
  `in_review`/`blocked`, exit.
- Ambiguous scope → escalate up the ladder (`AGENTS.md` § Escalation)
  rather than guessing.
