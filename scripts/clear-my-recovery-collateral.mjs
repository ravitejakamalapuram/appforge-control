#!/usr/bin/env node
// clear-my-recovery-collateral.mjs — APP-164.
//
// Clears the recovery actions that a pause cancellation left on THIS agent's
// own issues, using this run's own credential.
//
// WHY THIS IS A SCRIPT AN AGENT RUNS, AND NOT SOMETHING THE WATCHDOG DOES
//
// APP-164's board input asked `quota-retry-watchdog.mjs` to resolve these
// itself when it resumes an agent, instead of only reporting them. The
// detection half of that is built and live (see lib/quota-pause-collateral.mjs
// and the COLLATERAL/ORPHANED lines in the watchdog log). The resolving half
// cannot live in the watchdog, for a reason that is worth stating once:
//
// The safe hand-back route the board demonstrated is gated by
// `assertSafeRecoveryHandBackGates`, which requires the caller to be the
// issue's own assignee / the action's recorded return owner. Satisfying that
// honestly needs the OWNER's credential. Agent credentials are run-scoped
// JWTs: `PAPERCLIP_API_KEY` carries a `run_id` claim that the server must
// resolve to a LIVE run, or every write in that context 403s with
// `cross_issue_influence_run_context_required` (docs/paperclip-run-binding.md,
// scripts/paperclip-run-check.sh). A long-lived daemon therefore cannot hold
// any agent's credential — anything it cached would name a finished run and be
// refused. There is no per-agent key store for it to read, by design.
//
// That leaves the watchdog exactly one way to issue the write: the
// credential-less loopback path, which the control plane's `local_trusted`
// mode accepts as an instance-admin BOARD actor. The write would succeed. It
// would also be recorded as the founder having personally disposed of a
// recovery action, on a 90-second timer, with no human having read it. The
// underlying hand-back needs no board authority at all
// (`stranded_assigned_issue` is not an execution-reconciliation cause), so
// that attribution is not just over-privileged — it is false. Standing company
// rule: the unauthenticated write path is not used for issue writes.
//
// So the split is: the watchdog DETECTS and names the collateral in its log
// and in the wake it sends; the woken agent RESOLVES its own, in-run, with the
// only credential that satisfies the owner gate truthfully. Same drain, same
// automation, correct attribution.
//
// WHAT IT WILL NEVER TOUCH
//
// Selection is `classifyRecoveryDisposition` === 'hand_back', unchanged from
// the watchdog's own reporting path, so this script cannot widen the class:
//   - only `stranded_assigned_issue`, never any execution-reconciliation cause
//     (clearing one of those would mean attesting to a dead run's outcome);
//   - only runs cancelled with `errorCode: agent_paused`;
//   - only where this agent is still both assignee and recorded return owner;
//   - never where a first-class blocker or a live checkout/execution lock
//     exists.
// The `board_only` orphans are printed and left alone. No prior run outcome is
// ever asserted.
//
// IT NEEDS A TASK-BOUND RUN, NOT MERELY A LIVE ONE (APP-217 heartbeat)
//
// The header above says the woken agent's run-scoped credential satisfies the
// owner gate. That is half true, and the missing half made this script
// unreachable from the one wake that advertises it.
//
// `POST /api/issues/:id/recovery-actions/resolve` is a CROSS-ISSUE write, so it
// is gated by `cross_issue_influence_run_context_required`. That gate wants the
// run to be TASK-BOUND (`PAPERCLIP_TASK_ID` set), not just alive. A wake that
// does not bind one produces a run where EVERY resolve 403s, and so does every
// `PATCH /api/issues/:id`.
//
// Verified on run a520f601: sending `X-Paperclip-Run-Id` does not help (the
// 403's own `sanctionedPath` tells you to send the header you already sent),
// and neither does checking the issue out first. Checkout returns 200 and takes
// the lock, but it does NOT bind write attribution.
//
// CORRECTION (APP-181): an agent-level wake CAN be bound
//
// This header used to claim `POST /api/agents/:id/wakeup` "has no issue/task
// field at all (checked against the served OpenAPI), so the run it starts is
// always task-unbound". The OpenAPI reading was right and the conclusion was
// wrong. The route's body is `wakeAgentSchema`, whose `payload` is a free-form
// `z.record` — so no `issueId` key is *documented*, but the server reads one:
//
//   route (`routes/agents.js`)  wakePayload = req.body.payload -> heartbeat.wakeup
//   `enqueueWakeup`             -> enrichWakeContextSnapshot({ payload })
//   `enrichWakeContextSnapshot` payload.issueId ?? payload.taskId
//                               -> contextSnapshot.issueId AND .taskId
//   adapter `execute.js`        contextSnapshot.taskId ?? .issueId
//                               -> env.PAPERCLIP_TASK_ID
//
// (traced through `@paperclipai/server` + `@paperclipai/adapter-claude-local`
// 2026.916.1, the installed dist). So `paperclipai agent wake <agentId>
// --payload '{"issueId":"<uuid>"}'` yields a task-bound run, and the watchdog
// now sends exactly that (APP-181). `--resolve` is reachable from a watchdog
// resume whenever the interrupted run had a recorded issue.
//
// It still refuses up front on a task-unbound run rather than emitting one
// confusing 403 per issue, because two unbound wakes remain: a pending action
// written by a pre-APP-181 watchdog build, and an interrupted run the runtime
// never bound in the first place. The residual deadlock for those is tracked on
// APP-164:
//   pause cancellation -> sweep blocks the issues -> a blocked issue is never
//   picked for a task-bound heartbeat -> the collateral can never be cleared.
//
// NEVER `release` A COLLATERAL ISSUE TO "CLEAN UP" A CHECKOUT
//
// Also verified on that run: `POST /api/issues/:id/release` sets the issue back
// to `todo` AND clears `assigneeAgentId`. An unassigned issue with an active
// action is exactly the `board_only` shape this script refuses to touch, so
// releasing one converts a self-clearable item into one that needs the founder.
// If you checked one out, leave it checked out.
//
// Usage (inside a heartbeat, where PAPERCLIP_API_KEY is this run's token):
//   node scripts/clear-my-recovery-collateral.mjs            # report only
//   node scripts/clear-my-recovery-collateral.mjs --resolve  # clear them
//
// Exit codes: 0 = nothing to do, or every attempted hand-back succeeded.
//             1 = at least one hand-back was refused.
//             2 = misconfigured (missing env).
//             3 = `--resolve` on a task-unbound run; nothing was attempted.

import { partitionRecoveryCollateral } from './lib/quota-pause-collateral.mjs';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`clear-my-recovery-collateral: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

const resolve = process.argv.includes('--resolve');
const apiBase = (process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const companyId = requireEnv('PAPERCLIP_COMPANY_ID');
const apiKey = requireEnv('PAPERCLIP_API_KEY');
const me = requireEnv('PAPERCLIP_AGENT_ID');
const auth = { Authorization: `Bearer ${apiKey}` };

const res = await fetch(`${apiBase}/api/companies/${companyId}/issues?limit=1000`, { headers: auth });
if (!res.ok) {
  console.error(`clear-my-recovery-collateral: issue list failed ${res.status}`);
  process.exit(2);
}
const raw = await res.json();
const issues = (Array.isArray(raw) ? raw : raw.issues || []).filter((i) => {
  const a = i.activeRecoveryAction;
  return a && ['active', 'escalated'].includes(a.status);
});

const { handBack, boardOnly } = partitionRecoveryCollateral(issues);
// Only ever this agent's own. The server would refuse the rest anyway; not
// sending them keeps the log free of expected 403s.
const mine = handBack.filter((e) => e.returnOwnerAgentId === me);

for (const e of boardOnly) {
  console.log(
    `board-only  ${e.identifier} status=${e.status} action=${e.recoveryActionId} ` +
      `returnOwner=${e.returnOwnerAgentId} assignee=${e.assigneeAgentId} (no agent credential can close this)`,
  );
}

if (!mine.length) {
  console.log('nothing to hand back: no active pause-cancellation action names this agent as return owner');
  process.exit(0);
}

// A task-unbound run can hold a checkout but cannot attribute a cross-issue
// write, so every resolve below would 403. Say so once, with the pending list,
// instead of once per issue. See the header note for the full chain.
const taskBound = Boolean(process.env.PAPERCLIP_TASK_ID);
if (resolve && !taskBound) {
  for (const e of mine) {
    console.log(`pending ${e.identifier} (${e.status}) action=${e.recoveryActionId} run=${e.pausedRunId}`);
  }
  console.error(
    `clear-my-recovery-collateral: refusing --resolve for ${mine.length} issue(s) — this run is ` +
      'task-unbound (PAPERCLIP_TASK_ID is empty), and recovery-actions/resolve is a cross-issue ' +
      'write that 403s with cross_issue_influence_run_context_required in that context. Sending ' +
      'X-Paperclip-Run-Id does not help, and neither does checking the issue out first. Re-run ' +
      'from a task-bound heartbeat. Do NOT release these checkouts — release unassigns the issue ' +
      'and turns it into a board-only orphan.',
  );
  process.exit(3);
}

let refused = 0;
for (const e of mine) {
  if (!resolve) {
    console.log(`would hand back ${e.identifier} (${e.status}) action=${e.recoveryActionId} run=${e.pausedRunId}`);
    continue;
  }
  const r = await fetch(`${apiBase}/api/issues/${e.issueId}/recovery-actions/resolve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actionId: e.recoveryActionId,
      outcome: 'restored',
      sourceIssueStatus: 'todo',
      resolutionNote:
        `Pause-cancellation collateral (run ${e.pausedRunId}, errorCode agent_paused): the quota ` +
        'watchdog paused this agent to wait out a provider quota stop, which cancelled this run, ' +
        'and the recovery sweep could not classify that as a quota wait. Handed back to the ' +
        'recorded return owner by that owner. No prior run outcome is asserted. APP-164.',
    }),
  });
  if (!r.ok) {
    refused += 1;
    console.log(`refused ${e.identifier} action=${e.recoveryActionId} ${r.status} ${(await r.text()).slice(0, 200)}`);
    continue;
  }
  const body = await r.json();
  console.log(
    `handed back ${e.identifier} -> ${body?.issue?.status ?? '?'} ` +
      `(outcome=${body?.recoveryAction?.outcome ?? '?'}) action=${e.recoveryActionId}`,
  );
}
process.exit(refused ? 1 : 0);
