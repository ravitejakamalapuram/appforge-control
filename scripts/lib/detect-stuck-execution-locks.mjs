/**
 * Classify Paperclip execution locks as stuck or healthy (APP-53, APP-91).
 *
 * WHY THIS EXISTS
 *
 * Paperclip takes an issue's execution lock (`executionRunId` +
 * `executionLockedAt`) when the heartbeat run row is *created*, and releases it
 * when the run *completes*. A run that is enqueued and never dispatched
 * therefore pins its issue forever, and `POST /api/issues/{id}/release` is
 * guarded by the very lock it exists to break. That is how APP-26 sat locked
 * from 05:02Z behind run `302d7d7c` — `status: queued`, `startedAt: null`,
 * `controllerBootId: null`, never claimed by any runner.
 *
 * The liveness check that returns 409 counts that run as live. The correct
 * upstream fix is to gate liveness on `startedAt`; that is filed on APP-79 and
 * deliberately NOT patched locally (vendoring a patch into a dependency we
 * intend to upgrade buys one incident and costs every upgrade after). This
 * module is the detection half we do own: it reads the same public API fields a
 * human would read and says, in writing, which locks are not backed by a live
 * run.
 *
 * DETECTION ONLY — THIS MODULE MUST NOT REMEDIATE
 *
 * CEO ruling on APP-91 (2026-09-28): "the detector detects. It does not
 * remediate." Board approval 3ac22df9 authorised ONE clear, of ONE named run,
 * once, by a named actor (carried on APP-98) — not a standing licence for an
 * hourly job to decide for itself which locks to force-release. An automated
 * clear can hit a run that is merely slow to dispatch, with nobody reading the
 * diagnosis first. If automated clearing is ever worth proposing, it goes
 * through its own approval with a stated false-positive rate. Keep this module
 * pure and read-only: no force-release, no cancel, no release calls, here or in
 * the caller.
 *
 * THE FALSE-POSITIVE THIS IS BUILT TO AVOID
 *
 * A freshly queued run is indistinguishable in shape from a permanently
 * orphaned one — both are `queued` with `startedAt: null`. Only elapsed time
 * separates them, because agents dispatch serially and a real backlog can hold
 * a run queued for minutes. So a queued run is NOT reported until its lock is
 * older than `queuedGraceMs`. At the APP-53 verification this rule was what
 * made the detector flag APP-26 while correctly ignoring five healthy
 * backlogged issues. Lower the grace period and you re-introduce exactly the
 * noise that would make an operator stop reading the output.
 *
 * A lock whose run has already reached a terminal state is a different, harder
 * fact: the run is over and the lock outlived it. There is no benign reading of
 * that, so it is reported with no grace period at all.
 *
 * THE THIRD SHAPE: A LIVE RUN THAT CANNOT WRITE (APP-224)
 *
 * A live run was originally treated as proof the lock is healthy. It is not.
 * A **task-unbound** run — one dispatched with no issue binding — takes a
 * checkout with a 200 and then 403s
 * (`cross_issue_influence_run_context_required`) on every PATCH and comment to
 * the issue it just locked. The lock buys that run nothing and starves the
 * assigned agent's own task-bound run, which gets 409
 * `issue_write_assignee_run_lock` for as long as the unbound run lives.
 *
 * Measured on APP-217, 2026-09-30: run `47c79a69` (a `max_turns_continuation`
 * retry of the watchdog-resume run `a520f601`) held the lock 00:03:42 -> 00:17:26
 * while unable to write to it; a task-bound run on a different issue read that
 * as a 409 the whole time. It is NOT permanent — the lock cleared when the
 * unbound run ended and APP-217's own bound run closed the issue at 00:22:58 —
 * so this is a starvation window bounded by the unbound run's lifetime, not a
 * deadlock. It is still worth reporting: nothing can come of such a lock.
 *
 * The discriminator is API-visible and does not need the run's env: a run row's
 * `contextSnapshot.taskId` / `.issueId` are set on a task-bound run and absent
 * on an unbound one. `invocationSource` is NOT the discriminator — `automation`
 * runs are frequently task-bound (53 agent comments in this company were
 * written by `automation` runs), so classifying on it would be wrong.
 */

/** Run states that mean the run is over. A lock outliving one of these is stuck by definition. */
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'expired',
  'timed_out',
]);

/** Run states that mean the run has not yet been claimed by a runner. */
const UNDISPATCHED_RUN_STATUSES = new Set(['queued', 'scheduled_retry', 'pending']);

/** Default grace for an undispatched run before its lock counts as stuck. */
export const DEFAULT_QUEUED_GRACE_MS = 60 * 60 * 1000;

/** Locks held at least this long escalate past a note on the routine's own issue. */
export const DEFAULT_ESCALATION_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Default grace for a live but task-unbound lock holder (APP-224).
 *
 * A short unbound touch of a lock harms nothing, so it is not worth a report.
 * The harm is an unbound heartbeat that holds the lock for its whole life: the
 * APP-217 window was 13m44s, and agent heartbeats here run on a minutes-scale
 * cadence. 15 minutes is therefore long enough to ignore a passing checkout and
 * short enough that the hourly sweep still catches a full unbound heartbeat.
 */
export const DEFAULT_UNBOUND_HOLDER_GRACE_MS = 15 * 60 * 1000;

/** Issue statuses that can legitimately hold an execution lock. */
const LOCKABLE_ISSUE_STATUSES = new Set(['todo', 'in_progress', 'in_review', 'blocked']);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(String(status ?? '').toLowerCase());
}

export function isUndispatchedRunStatus(status) {
  return UNDISPATCHED_RUN_STATUSES.has(String(status ?? '').toLowerCase());
}

/**
 * Whether a run row is bound to an issue: `bound`, `unbound`, or `unknown`.
 *
 * `unknown` is deliberately distinct from `unbound`. A payload that carries no
 * `contextSnapshot` at all tells us nothing about binding, and a missing field
 * must never be read as a finding — the same rule the `run_unreadable` branch
 * applies to a failed fetch.
 */
export function taskBindingOf(run) {
  const snapshot = run?.contextSnapshot;
  const direct = run?.taskId ?? run?.issueId ?? null;
  if (direct) return 'bound';
  if (!snapshot || typeof snapshot !== 'object') return 'unknown';
  return snapshot.taskId || snapshot.issueId ? 'bound' : 'unbound';
}

/** Issues worth checking at all: non-terminal, and actually holding a lock. */
export function selectLockedIssues(issues) {
  return (issues ?? []).filter(
    (issue) => LOCKABLE_ISSUE_STATUSES.has(issue?.status) && Boolean(issue?.executionRunId),
  );
}

function ageMs(lockedAt, now) {
  if (!lockedAt) return null;
  const started = Date.parse(lockedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, now - started);
}

export function formatDuration(ms) {
  if (ms == null) return 'unknown';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Classify one issue's lock.
 *
 * `run` is the heartbeat-run row for `issue.executionRunId`, or null when the
 * run could not be read. A missing run row is reported (a lock pointing at a
 * run that no longer exists cannot be backed by a live run), but a *fetch
 * failure* must be passed as `runFetchFailed: true` so a flaky API call is
 * never mistaken for a deleted run.
 */
export function classifyLock({
  issue,
  run,
  runFetchFailed = false,
  now,
  queuedGraceMs = DEFAULT_QUEUED_GRACE_MS,
  unboundHolderGraceMs = DEFAULT_UNBOUND_HOLDER_GRACE_MS,
}) {
  const heldMs = ageMs(issue.executionLockedAt, now);
  const base = {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    issueStatus: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    runId: issue.executionRunId,
    lockedAt: issue.executionLockedAt ?? null,
    heldMs,
    heldHuman: formatDuration(heldMs),
    runStatus: run?.status ?? null,
    runStartedAt: run?.startedAt ?? null,
    runCreatedAt: run?.createdAt ?? null,
    runTaskBinding: run ? taskBindingOf(run) : null,
    blocks: (issue.blocks ?? []).map((b) => b.identifier).filter(Boolean),
  };

  if (runFetchFailed) {
    return { ...base, stuck: false, reason: 'run_unreadable', detail: 'Could not read the run row; not treated as evidence.' };
  }

  if (!run) {
    return {
      ...base,
      stuck: true,
      reason: 'run_missing',
      detail: `Lock points at run ${issue.executionRunId}, which the API does not return.`,
    };
  }

  if (isTerminalRunStatus(run.status)) {
    return {
      ...base,
      stuck: true,
      reason: 'run_terminal',
      detail: `Run is ${run.status} (completed ${run.completedAt ?? 'unknown'}) but the lock is still held.`,
    };
  }

  if (isUndispatchedRunStatus(run.status)) {
    // A lock with no timestamp cannot be aged, so it cannot clear the grace
    // period and is left alone rather than guessed at.
    if (heldMs == null) {
      return { ...base, stuck: false, reason: 'undispatched_unknown_age', detail: 'Run is undispatched but the lock has no executionLockedAt to age.' };
    }
    if (heldMs < queuedGraceMs) {
      return {
        ...base,
        stuck: false,
        reason: 'undispatched_within_grace',
        detail: `Run is ${run.status} and the lock is only ${formatDuration(heldMs)} old — inside the ${formatDuration(queuedGraceMs)} dispatch grace.`,
      };
    }
    return {
      ...base,
      stuck: true,
      reason: 'undispatched_past_grace',
      detail: `Run is ${run.status} with startedAt=${run.startedAt ?? 'null'} and has never been claimed (controllerBootId=${run.controllerBootId ?? 'null'}); lock held ${formatDuration(heldMs)}.`,
    };
  }

  // A live run is not automatically a healthy lock: an unbound one cannot write
  // to the issue it locked, so its lock can only starve the assignee (APP-224).
  if (base.runTaskBinding === 'unbound') {
    if (heldMs == null) {
      return {
        ...base,
        stuck: false,
        reason: 'live_unbound_unknown_age',
        detail: 'Lock holder is a task-unbound run but the lock has no executionLockedAt to age.',
      };
    }
    if (heldMs < unboundHolderGraceMs) {
      return {
        ...base,
        stuck: false,
        reason: 'live_unbound_within_grace',
        detail: `Lock holder is a task-unbound ${run.status} run, but the lock is only ${formatDuration(heldMs)} old — inside the ${formatDuration(unboundHolderGraceMs)} unbound-holder grace.`,
      };
    }
    return {
      ...base,
      stuck: true,
      reason: 'live_unbound_holder',
      detail: `Run is ${run.status} but task-unbound (no contextSnapshot.taskId), so it cannot write to this issue — every PATCH and comment 403s. The lock has starved the assignee for ${formatDuration(heldMs)}; it clears on its own when the run ends.`,
    };
  }

  return {
    ...base,
    stuck: false,
    reason: 'run_live',
    detail: `Run is ${run.status}, started ${run.startedAt ?? 'unknown'}.`,
  };
}

/**
 * Severity routing, per APP-91: a lock under the escalation age is a note on
 * the routine's own issue; anything older, or any lock pinning an issue another
 * agent is waiting on, escalates to the CEO. The `blocks` edge is the "someone
 * is waiting" signal — a stuck lock on an issue that blocks other work stalls a
 * whole chain, which is worse than its age alone suggests.
 */
export function severityFor(finding, escalationAgeMs = DEFAULT_ESCALATION_AGE_MS) {
  if (finding.heldMs != null && finding.heldMs >= escalationAgeMs) return 'escalate';
  if (finding.blocks.length > 0) return 'escalate';
  return 'note';
}

/** Build the whole report from already-fetched issues and their runs. */
export function buildReport({ issues, runsById, runFetchFailures = new Set(), now, queuedGraceMs = DEFAULT_QUEUED_GRACE_MS, escalationAgeMs = DEFAULT_ESCALATION_AGE_MS, unboundHolderGraceMs = DEFAULT_UNBOUND_HOLDER_GRACE_MS }) {
  const classified = selectLockedIssues(issues).map((issue) =>
    classifyLock({
      issue,
      run: runsById.get(issue.executionRunId) ?? null,
      runFetchFailed: runFetchFailures.has(issue.executionRunId),
      now,
      queuedGraceMs,
      unboundHolderGraceMs,
    }),
  );

  const stuck = classified
    .filter((f) => f.stuck)
    .map((f) => ({ ...f, severity: severityFor(f, escalationAgeMs) }))
    .sort((a, b) => (b.heldMs ?? 0) - (a.heldMs ?? 0));

  return {
    checkedAt: new Date(now).toISOString(),
    queuedGraceMs,
    escalationAgeMs,
    unboundHolderGraceMs,
    examined: classified.length,
    healthy: classified.filter((f) => !f.stuck),
    stuck,
    escalate: stuck.filter((f) => f.severity === 'escalate'),
    notes: stuck.filter((f) => f.severity === 'note'),
  };
}

/**
 * Render the report as the markdown the routine's execution issue carries.
 * Returns an empty string for a healthy sweep: APP-91 applies the do-nothing
 * rule, and silence is the correct output when nothing is wrong. The caller
 * must not invent a "all clear" comment out of this.
 */
export function renderReport(report) {
  if (report.stuck.length === 0) return '';

  const lines = [
    `## Stuck execution lock${report.stuck.length === 1 ? '' : 's'} detected — ${report.stuck.length} of ${report.examined} locked issue${report.examined === 1 ? '' : 's'}`,
    '',
    `Swept at ${report.checkedAt}. Dispatch grace ${formatDuration(report.queuedGraceMs)}; unbound-holder grace ${formatDuration(report.unboundHolderGraceMs ?? DEFAULT_UNBOUND_HOLDER_GRACE_MS)}; escalation age ${formatDuration(report.escalationAgeMs)}.`,
    '',
  ];

  for (const f of report.stuck) {
    lines.push(`### ${f.identifier ?? f.issueId} — held ${f.heldHuman} (${f.severity === 'escalate' ? 'escalate to CEO' : 'note only'})`);
    lines.push('');
    lines.push(`- Issue: \`${f.issueId}\` (${f.issueStatus}) — ${f.title ?? 'untitled'}`);
    lines.push(`- Run: \`${f.runId}\` — status \`${f.runStatus ?? 'unreadable'}\`, startedAt \`${f.runStartedAt ?? 'null'}\`, task binding \`${f.runTaskBinding ?? 'unreadable'}\``);
    lines.push(`- Lock taken: \`${f.lockedAt ?? 'unknown'}\` — held ${f.heldHuman}`);
    lines.push(`- Classification: \`${f.reason}\` — ${f.detail}`);
    if (f.blocks.length > 0) lines.push(`- Pins work others wait on: blocks ${f.blocks.join(', ')}`);
    lines.push('');
  }

  lines.push('Detection only — no lock was cleared. Clearing requires its own board approval (CEO ruling on APP-91).');
  return lines.join('\n');
}
