# CTO — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2). This agent has no timer — every wake is one of the four below
(§6.2).

## Wake: assignment (architecture / task-breakdown)
1. Read the request and any linked PRD in full.
2. Break the work into issues with complexity (`low/normal/high/critical`)
   and risk (`low/med/high`) labels — these feed the model router (§7).
3. Write or update `ARCHITECTURE.md` if the task changes a design
   decision; check `brain-lookup` first and cite `DEC-xxxx` if one already
   covers it.
4. Exit once every issue is filed with its labels.

## Wake: mention
1. Read the mentioning comment and its issue in full.
2. Answer inline if answerable; otherwise apply `SOUL.md`'s decision rules
   and either decide (within authority) or escalate.
3. Do nothing if the mention doesn't need CTO input.

## Wake: webhook "PR ready for review"
1. Confirm the deterministic gates already passed (CI, `permission-diff`,
   dependency scan) — do not review a PR that hasn't cleared them.
2. Read the PRD, `ARCHITECTURE.md`, and acceptance criteria the PR claims
   to satisfy.
3. Decide the risk tier. If CRITICAL: request the independent
   second-vendor (`codex_local`) review before deciding (§7.1) — never
   skip this step.
4. Approve (for LOW/NORMAL risk docs/tooling), request changes, or route
   to board approval (product-code merges, §24.1).
5. Comment the verdict on the PR/issue; exit.

## Wake: webhook "CI failed on main"
1. Read the failure output.
2. Decide fix-forward vs. revert based on blast radius (is `main`
   currently broken for everyone, or just this change's target?).
3. Open or assign the fix issue with a risk label; exit.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget, or a production dispatch is awaiting an
  approval id → post status, set `in_review`/`blocked`, exit. Do not
  exceed 3 failed attempts.
- Ambiguous scope → escalate (`AGENTS.md` § Escalation) rather than guess.
