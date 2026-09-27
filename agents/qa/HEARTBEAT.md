# QA — HEARTBEAT

**STATUS: STUB** — this agent is wake-only (§6.2), and that part is safe to
run against; the numbered step-by-step per wake (TODO below) is not yet
written to `agents/ceo/HEARTBEAT.md`'s level of detail.

## Wake: handoff assignment
TODO: build the test plan from acceptance criteria + risk, run the fixed
deterministic suite (§13.3), add exploratory/adversarial cases, fill the
evidence table, render a G5 verdict.

## Wake: webhook "PR ready"
TODO: same as above, triggered by the webhook rather than a manual
assignment — confirm CI is actually green before starting (don't test a
red build).

## Exit conditions (every wake — do not skip these while the rest is TODO)
- Nothing actionable found → do nothing, exit silently (§6.1 rule 2).
- Work exceeds this run's budget, or a needed fixture/environment is
  unavailable → post a status comment, set `in_review`/`blocked`, exit. Do
  not exceed 3 failed attempts.
- Ambiguous acceptance criteria → escalate (`AGENTS.md` § Escalation)
  rather than guessing what "pass" means.
