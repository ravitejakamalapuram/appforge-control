# Builder — HEARTBEAT

Exact procedure per wake reason. If none of the conditions below holds,
the wake trigger misfired — exit without posting (do-nothing rule, §6.1
rule 2). `max_concurrent: 1` (§6.2/`config/agents.yaml`) — if another
Builder run is already active, this run should not have been dispatched;
flag that as a bug, don't work around it.

## Wake: assignment
1. READ CONTEXT: the issue, its linked PRD, `ARCHITECTURE.md`, and
   acceptance criteria in full. If any of these is missing, escalate to
   CTO instead of guessing (§6.2 Forbidden: "invent requirements").
2. Implement against the acceptance criteria only — anything else becomes
   a follow-up issue, not part of this PR.
3. Write tests that exercise the acceptance criteria.
4. Run `appforge validate && appforge test && appforge build`; fix
   failures before continuing.
5. Run the self-review checklist.
6. Open a draft PR (`gh pr create --draft`).
7. Once CI is green on the draft, mark it ready and hand off to QA.
8. Exit.

## Wake: mention on PR/issue
1. Read the review feedback in full.
2. Re-run the workflow from the affected step forward (e.g. re-implement,
   re-test) — not from scratch.
3. Push the update, wait for CI, exit once green or once blocked.

## Exit conditions (every wake)
- Nothing actionable found → do nothing, exit silently.
- Work exceeds this run's budget, or CI fails with no clear fix after
  reasonable attempts → post status, set `in_review`/`blocked`, exit. Do
  not exceed 3 failed attempts.
- Ambiguous scope or missing spec → escalate to CTO rather than inventing
  requirements.
