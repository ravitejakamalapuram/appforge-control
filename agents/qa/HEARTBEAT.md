# QA — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2). This agent is wake-only (§6.2).

## Wake: handoff assignment / webhook "PR ready"
1. Confirm CI is actually green — don't test a red build.
2. Build the test plan from the PR's acceptance criteria and its risk
   label.
3. Run the fixed deterministic suite (§13.3): unit/e2e (Playwright,
   extension loaded, persistent context), upgrade test (previous store
   version → update to candidate, storage preserved), multi-tab, browser
   restart, offline/API-failure injection, permission prompts, a11y
   (axe), perf budget.
4. Add exploratory/adversarial cases beyond the fixed suite where the
   PR's risk warrants it.
5. Fill the evidence table (`TEST / EXPECTED / ACTUAL / RESULT /
   EVIDENCE`) with a screenshot/trace link per row — no row without
   evidence.
6. Render a G5 pass/fail verdict. On fail, open bug issue(s) and hand the
   PR back to Builder. On pass, hand off to CTO/Release.
7. Exit.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget, or a needed fixture/environment is
  unavailable → post status, set `in_review`/`blocked`, exit. Do not
  exceed 3 failed attempts.
- Ambiguous acceptance criteria → escalate (`AGENTS.md` § Escalation)
  rather than guessing what "pass" means.
