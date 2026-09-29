// quota-pause-collateral.mjs — APP-164.
//
// THE PROBLEM THIS DETECTS
//
// `quota-retry-watchdog.mjs` (DEBT-0001 / APP-45) waits out a provider quota
// stop by pausing the agent at board level. Pausing cancels every in-flight
// run for that agent with `status: "cancelled"`, `errorCode: "agent_paused"`,
// `error: "Cancelled due to agent pause"`.
//
// Paperclip's recovery sweep then treats each of those cancelled runs as an
// unreconciled failure. Its quota classifier
// (`@paperclipai/server` services/recovery/service.js,
// `isProviderQuotaRecovery`) recognises a quota stop only when the run has
// `errorCode === "provider_quota"`, or `resultJson.errorFamily ===
// "provider_quota"`, or `errorCode === "adapter_failed"` plus quota-shaped
// error text. A pause cancellation has none of those: its errorCode is
// `agent_paused` and its resultJson carries no errorFamily. So the sweep
// falls through to `stranded_assigned_issue`, escalates to the *board*
// (`routingPolicy: board_escalation_no_takeover_v1`), and hard-sets the
// issue to `blocked`.
//
// The result is that waiting out a quota stop converts the paused agent's
// entire in-flight workload into board-escalated `blocked` issues. These are
// false blocks: nothing about the work is actually stuck, and the recovery
// action's own evidence names the pause as the cause. Measured on the week of
// 2026-09-28: 100 recovery actions against 487 runs (20.5%, threshold 2%), of
// which 36 were `stranded_assigned_issue` + `agent_paused` — the single
// largest bucket, and all of it self-inflicted by this watchdog.
//
// WHO MAY CLEAR ONE (corrected 2026-09-30, verified against shipped source)
//
// An earlier revision of this file asserted that the restore-to-todo path is
// `assertBoard`-gated and therefore unreachable by any agent. That is wrong.
// It is reachable -- by the OWNER, not by the board.
//
// Read `@paperclipai/server` routes/issues.js at the
// `POST /issues/:id/recovery-actions/resolve` handler. `assertBoard` is
// called in exactly two places:
//
//   1. when `outcome` is `false_positive` or `cancelled`; and
//   2. when `sourceIssueStatus === "todo"` AND
//      `requiresExecutionReconciliation(action.cause)`.
//
// `stranded_assigned_issue` is NOT in `EXECUTION_RECONCILIATION_CAUSES`
// (@paperclipai/shared types/execution-projection.js — that list is the
// `uncertain_*` / `native_*` / `legacy_execution_requires_reconciliation`
// family, i.e. the incidents where a provider may have taken an unverified
// external action). So `outcome: "restored"` + `sourceIssueStatus: "todo"`
// on a `stranded_assigned_issue` action asks for no board authority and
// carries no `executionReconciliation` attestation about anybody's dead run.
//
// What it does pass through is `assertSafeRecoveryHandBackGates`, a
// purpose-built gate whose entire job is handing an issue back to its
// recorded original owner. It requires: the recorded `returnOwnerAgentId` is
// still the assignee; no conflicting `checkoutRunId`/`executionRunId`; no
// pending execution-review stage; no subtree pause hold; the project is not
// paused; and no pending governed approval. The server records the result as
// `outcome: "handed_back"`, not `"restored"` — it names this path itself.
//
// Verified live on 2026-09-30: APP-148 and APP-71 were both cleared
// blocked -> todo by their own assignee's agent credential, HTTP 200,
// `outcome: "handed_back"`, no board involvement. (Re-confirmed against the
// API on 2026-09-30: both sit at `todo` with no active action.)
//
// WHO PERFORMS IT, THEREFORE
//
// The owner, in-run, via `scripts/clear-my-recovery-collateral.mjs`. NOT
// `quota-retry-watchdog.mjs`: agent credentials are run-scoped JWTs, so a
// daemon cannot hold one, and its only alternative is the credential-less
// loopback path that would record a founder write every 90 seconds for an
// authority the hand-back does not even need. The watchdog detects and names;
// the owner clears. See the long note above `runOnce`'s resume block.
//
// THE ONE CLASS THAT REALLY IS BOARD-ONLY
//
// `assertSafeRecoveryHandBackGates` keys on `issue.assigneeAgentId ===
// action.returnOwnerAgentId`. If something clears the assignee while the
// action is still active, the action becomes unreachable: no agent satisfies
// `requireRecoveryActionAuthority` (the actor is neither the assignee nor the
// action's `ownerAgentId`, both being null/foreign), so every agent gets a
// 403 and only a board actor can dispose of it. Seven such orphans existed on
// 2026-09-30 — issues already sitting at `todo` with an `active` recovery
// action nobody can close. They are reported, never acted on.

/** Run errorCode Paperclip stamps on a run it cancelled because the agent was paused. */
export const QUOTA_PAUSE_ERROR_CODE = 'agent_paused';

/** Recovery cause the sweep falls back to when it cannot classify the failure. */
export const STRANDED_CAUSE = 'stranded_assigned_issue';

/**
 * Causes where the server demands a board `executionReconciliation`
 * attestation before restoring to `todo`, because a provider may have taken
 * an unverified external action. Mirrors `EXECUTION_RECONCILIATION_CAUSES` in
 * `@paperclipai/shared`. Nothing in this module may ever touch one of these:
 * clearing it means attesting to the outcome of a run we did not observe.
 */
export const RECONCILIATION_CAUSES = new Set([
  'uncertain_provider_action',
  'uncertain_external_action',
  'uncertain_control_plane_action',
  'completed_action_context_missing',
  'continuation_evidence_incomplete',
  'execution_finalization_deadline_exceeded',
  'execution_recovery_budget_exhausted',
  'provider_effect_inventory_unavailable',
  'provider_failure_meaning_unverified',
  'provider_ownership_unverified',
  'native_provider_terminal_failed',
  'native_event_replay_conflict',
  'native_session_cleanup_quarantined',
  'native_session_retry_exhausted',
  'native_restart_recovery_blocked',
  'native_continuation_requires_reconciliation',
  'legacy_execution_requires_reconciliation',
]);

/**
 * Classifies one issue's active recovery action into the disposition this
 * tooling is allowed to apply. Returns one of:
 *
 *   'hand_back'  -- `stranded_assigned_issue`, owner still assigned, no run
 *                   lock. The owning agent may clear this with its own
 *                   credential via the safe hand-back route.
 *   'board_only' -- `stranded_assigned_issue` whose assignee no longer
 *                   matches the recorded return owner. Unreachable by any
 *                   agent; report it and leave it for the board.
 *   null         -- anything else, including every reconciliation cause.
 *                   Not ours to touch under any circumstance.
 *
 * `pausedRunIds`, when non-empty, narrows `hand_back` to runs this watchdog
 * itself paused. Without it the `agent_paused` signature alone is used, which
 * is still specific -- only a pause produces that errorCode -- but does not
 * distinguish our pause from an operator's manual one.
 *
 * Note what is deliberately NOT a criterion: whether the dead run had a
 * `startedAt`. That proxy is under-inclusive. APP-71's run carried a
 * `startedAt` and died 598ms later on a launcher error
 * ("github-app-token: could not list installations: fetch failed") without
 * ever opening a provider session. The authoritative question -- "might this
 * run have taken an unverified external action?" -- is the one the server
 * already answers by choosing the cause, so the cause is what we read.
 */
export function classifyRecoveryDisposition(issue, { pausedRunIds } = {}) {
  const action = issue?.activeRecoveryAction;
  if (!action) return null;
  if (!['active', 'escalated'].includes(action.status)) return null;
  if (RECONCILIATION_CAUSES.has(action.cause)) return null;
  if (action.cause !== STRANDED_CAUSE) return null;

  // A genuine dependency hold is not ours to reinterpret, even if a pause
  // cancellation also touched it.
  if (Number(issue.unresolvedBlockerCount) > 0) return null;

  const returnOwner = action.returnOwnerAgentId || null;
  if (!returnOwner) return null;
  if (issue.assigneeAgentId !== returnOwner) return 'board_only';

  // `assertSafeRecoveryHandBackGates` rejects on either lock, so filtering
  // here turns a guaranteed 409 into a skip we can explain in the log.
  if (issue.checkoutRunId || issue.executionRunId) return null;

  const evidence = action.evidence || {};
  if (evidence.latestRunStatus !== 'cancelled') return null;
  if (evidence.latestRunErrorCode !== QUOTA_PAUSE_ERROR_CODE) return null;

  if (pausedRunIds && pausedRunIds.size > 0 && !pausedRunIds.has(evidence.latestRunId)) {
    return null;
  }
  return 'hand_back';
}

/**
 * True when `issue` is blocked solely because a recovery sweep could not
 * classify a pause cancellation, and its own owner can clear it.
 *
 * Retained as the narrow `blocked`-only predicate the original report path
 * used. `classifyRecoveryDisposition` is the general form.
 */
export function isQuotaPauseCollateral(issue, opts = {}) {
  if (!issue || issue.status !== 'blocked') return false;
  return classifyRecoveryDisposition(issue, opts) === 'hand_back';
}

function describe(issue, disposition) {
  const action = issue.activeRecoveryAction;
  return {
    identifier: issue.identifier,
    issueId: issue.id,
    title: issue.title,
    status: issue.status,
    disposition,
    recoveryActionId: action.id,
    pausedRunId: (action.evidence || {}).latestRunId ?? null,
    returnOwnerAgentId: action.returnOwnerAgentId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    blockedAt: action.createdAt ?? null,
  };
}

/**
 * Filters `issues` to the quota-pause collateral, newest recovery action
 * first, in a shape small enough to log verbatim.
 */
export function selectQuotaPauseCollateral(issues, opts = {}) {
  return (issues || [])
    .filter((issue) => isQuotaPauseCollateral(issue, opts))
    .map((issue) => describe(issue, 'hand_back'))
    .sort((a, b) => String(b.blockedAt).localeCompare(String(a.blockedAt)));
}

/**
 * Splits `issues` into the two actionable buckets. `handBack` is what the
 * owning agent may clear itself; `boardOnly` is the orphaned residue that
 * needs a board actor and must only ever be reported.
 */
export function partitionRecoveryCollateral(issues, opts = {}) {
  const handBack = [];
  const boardOnly = [];
  for (const issue of issues || []) {
    const disposition = classifyRecoveryDisposition(issue, opts);
    if (disposition === 'hand_back') handBack.push(describe(issue, disposition));
    else if (disposition === 'board_only') boardOnly.push(describe(issue, disposition));
  }
  const newestFirst = (a, b) => String(b.blockedAt).localeCompare(String(a.blockedAt));
  return { handBack: handBack.sort(newestFirst), boardOnly: boardOnly.sort(newestFirst) };
}

/**
 * Renders one log line per collateral issue plus a header, or a single line
 * when there is none. Returns an array of lines so the caller can feed them
 * to its own logger one at a time.
 */
export function formatCollateralReport(entries, { agentName } = {}) {
  const who = agentName ? ` agent=${agentName}` : '';
  if (!entries.length) {
    return [`COLLATERAL none${who} (no blocked issue traces to a pause cancellation)`];
  }
  const lines = [
    `COLLATERAL ${entries.length} issue(s)${who} blocked by pause-cancellation misclassification; ` +
      `each is clearable by its own owner running scripts/clear-my-recovery-collateral.mjs --resolve`,
  ];
  for (const e of entries) {
    lines.push(`COLLATERAL   ${e.identifier} run=${e.pausedRunId} action=${e.recoveryActionId} ${e.title ?? ''}`.trimEnd());
  }
  return lines;
}

/**
 * Renders the board-only residue: recovery actions whose issue no longer
 * carries the recorded return owner as assignee, so no agent credential can
 * dispose of them. Reported so the board can see them; never acted on here.
 */
export function formatBoardOnlyReport(entries, { agentName } = {}) {
  if (!entries.length) return [];
  const who = agentName ? ` agent=${agentName}` : '';
  const lines = [
    `ORPHANED ${entries.length} recovery action(s)${who} have lost their assignee and are ` +
      `unreachable by any agent credential (403 on requireRecoveryActionAuthority); board disposition required`,
  ];
  for (const e of entries) {
    lines.push(
      `ORPHANED   ${e.identifier} status=${e.status} action=${e.recoveryActionId} ` +
        `returnOwner=${e.returnOwnerAgentId} assignee=${e.assigneeAgentId}`,
    );
  }
  return lines;
}

/**
 * Collects the run ids this watchdog paused, from its own state file's
 * handled-run audit trail. Used to narrow `isQuotaPauseCollateral`.
 *
 * Note this returns the ids of the runs whose *failure* triggered a pause.
 * The pause also cancels that agent's other in-flight runs, whose ids the
 * watchdog never sees, so callers should treat an empty intersection as a
 * reason to fall back to the signature match rather than as proof of nothing.
 */
export function pausedRunIdsFromState(state) {
  const ids = new Set();
  for (const [runId, entry] of Object.entries(state?.handledRunIds || {})) {
    if (entry?.action === 'quota' || entry?.action === 'transient') ids.add(runId);
  }
  return ids;
}
