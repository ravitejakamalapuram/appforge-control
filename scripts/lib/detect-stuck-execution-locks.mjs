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

/** Issue statuses that can legitimately hold an execution lock. */
const LOCKABLE_ISSUE_STATUSES = new Set(['todo', 'in_progress', 'in_review', 'blocked']);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(String(status ?? '').toLowerCase());
}

export function isUndispatchedRunStatus(status) {
  return UNDISPATCHED_RUN_STATUSES.has(String(status ?? '').toLowerCase());
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
export function classifyLock({ issue, run, runFetchFailed = false, now, queuedGraceMs = DEFAULT_QUEUED_GRACE_MS }) {
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
export function buildReport({ issues, runsById, runFetchFailures = new Set(), now, queuedGraceMs = DEFAULT_QUEUED_GRACE_MS, escalationAgeMs = DEFAULT_ESCALATION_AGE_MS }) {
  const classified = selectLockedIssues(issues).map((issue) =>
    classifyLock({
      issue,
      run: runsById.get(issue.executionRunId) ?? null,
      runFetchFailed: runFetchFailures.has(issue.executionRunId),
      now,
      queuedGraceMs,
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
    `Swept at ${report.checkedAt}. Dispatch grace ${formatDuration(report.queuedGraceMs)}; escalation age ${formatDuration(report.escalationAgeMs)}.`,
    '',
  ];

  for (const f of report.stuck) {
    lines.push(`### ${f.identifier ?? f.issueId} — held ${f.heldHuman} (${f.severity === 'escalate' ? 'escalate to CEO' : 'note only'})`);
    lines.push('');
    lines.push(`- Issue: \`${f.issueId}\` (${f.issueStatus}) — ${f.title ?? 'untitled'}`);
    lines.push(`- Run: \`${f.runId}\` — status \`${f.runStatus ?? 'unreadable'}\`, startedAt \`${f.runStartedAt ?? 'null'}\``);
    lines.push(`- Lock taken: \`${f.lockedAt ?? 'unknown'}\` — held ${f.heldHuman}`);
    lines.push(`- Classification: \`${f.reason}\` — ${f.detail}`);
    if (f.blocks.length > 0) lines.push(`- Pins work others wait on: blocks ${f.blocks.join(', ')}`);
    lines.push('');
  }

  lines.push('Detection only — no lock was cleared. Clearing requires its own board approval (CEO ruling on APP-91).');
  return lines.join('\n');
}
