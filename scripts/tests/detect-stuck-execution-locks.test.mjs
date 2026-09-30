import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  classifyLock,
  renderReport,
  selectLockedIssues,
  severityFor,
  formatDuration,
  taskBindingOf,
  DEFAULT_QUEUED_GRACE_MS,
  DEFAULT_ESCALATION_AGE_MS,
  DEFAULT_UNBOUND_HOLDER_GRACE_MS,
} from '../lib/detect-stuck-execution-locks.mjs';

const NOW = Date.parse('2026-09-28T14:36:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

const issue = (over = {}) => ({
  id: 'issue-1',
  identifier: 'APP-1',
  title: 'An issue',
  status: 'in_progress',
  executionRunId: 'run-1',
  executionLockedAt: minutesAgo(5),
  blocks: [],
  ...over,
});

test('only non-terminal issues that actually hold a lock are examined', () => {
  const picked = selectLockedIssues([
    issue({ id: 'a' }),
    issue({ id: 'b', executionRunId: null }),
    issue({ id: 'c', status: 'done' }),
    issue({ id: 'd', status: 'cancelled' }),
    issue({ id: 'e', status: 'blocked' }),
  ]);
  assert.deepEqual(picked.map((i) => i.id), ['a', 'e']);
});

test('a live running run is healthy no matter how long the lock is held', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(600) }),
    run: { status: 'running', startedAt: minutesAgo(599), controllerBootId: 'boot-1' },
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'run_live');
});

test('a freshly queued run is NOT reported — this is the healthy-backlog case', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(3) }),
    run: { status: 'queued', startedAt: null, controllerBootId: null },
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'undispatched_within_grace');
});

test('a queued run past the dispatch grace is stuck — the APP-26 shape', () => {
  const f = classifyLock({
    issue: issue({
      identifier: 'APP-26',
      executionRunId: '302d7d7c-4d2c-4c9b-bcd3-5bda3720c6aa',
      executionLockedAt: '2026-09-28T05:02:23.278Z',
    }),
    run: {
      status: 'queued',
      startedAt: null,
      controllerBootId: null,
      createdAt: '2026-09-28T05:02:23.278Z',
    },
    now: NOW,
  });
  assert.equal(f.stuck, true);
  assert.equal(f.reason, 'undispatched_past_grace');
  assert.equal(f.heldHuman, '9h 33m');
});

test('the grace boundary is inclusive of stuck at exactly the threshold', () => {
  const at = classifyLock({
    issue: issue({ executionLockedAt: new Date(NOW - DEFAULT_QUEUED_GRACE_MS).toISOString() }),
    run: { status: 'queued', startedAt: null },
    now: NOW,
  });
  assert.equal(at.stuck, true);
  const just_under = classifyLock({
    issue: issue({ executionLockedAt: new Date(NOW - DEFAULT_QUEUED_GRACE_MS + 1000).toISOString() }),
    run: { status: 'queued', startedAt: null },
    now: NOW,
  });
  assert.equal(just_under.stuck, false);
});

test('a lock outliving a terminal run is stuck immediately, with no grace', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'succeeded']) {
    const f = classifyLock({
      issue: issue({ executionLockedAt: minutesAgo(1) }),
      run: { status, startedAt: minutesAgo(30), completedAt: minutesAgo(2) },
      now: NOW,
    });
    assert.equal(f.stuck, true, `${status} should be stuck`);
    assert.equal(f.reason, 'run_terminal');
  }
});

test('a lock pointing at a run the API does not return is stuck', () => {
  const f = classifyLock({ issue: issue(), run: null, now: NOW });
  assert.equal(f.stuck, true);
  assert.equal(f.reason, 'run_missing');
});

test('a run we failed to fetch is never reported as stuck', () => {
  const f = classifyLock({ issue: issue(), run: null, runFetchFailed: true, now: NOW });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'run_unreadable');
});

test('an undispatched run whose lock has no timestamp is left alone, not guessed at', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: null }),
    run: { status: 'queued', startedAt: null },
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'undispatched_unknown_age');
  assert.equal(f.heldHuman, 'unknown');
});

test('severity: under the escalation age with nothing waiting is a note', () => {
  assert.equal(severityFor({ heldMs: 90 * 60000, blocks: [] }), 'note');
});

test('severity: past the escalation age escalates', () => {
  assert.equal(severityFor({ heldMs: DEFAULT_ESCALATION_AGE_MS, blocks: [] }), 'escalate');
});

test('severity: a young lock pinning work others wait on still escalates', () => {
  assert.equal(severityFor({ heldMs: 70 * 60000, blocks: ['APP-9'] }), 'escalate');
});

test('a healthy sweep renders as the empty string so the routine can stay silent', () => {
  const report = buildReport({
    issues: [issue({ executionLockedAt: minutesAgo(2) })],
    runsById: new Map([['run-1', { status: 'queued', startedAt: null }]]),
    now: NOW,
  });
  assert.equal(report.stuck.length, 0);
  assert.equal(renderReport(report), '');
});

test('a report names the issue id, the run id, and how long the lock has been held', () => {
  const report = buildReport({
    issues: [
      issue({
        id: 'b7e1',
        identifier: 'APP-26',
        executionRunId: '302d7d7c',
        executionLockedAt: '2026-09-28T05:02:23.278Z',
        blocks: [{ identifier: 'APP-61' }],
      }),
    ],
    runsById: new Map([['302d7d7c', { status: 'queued', startedAt: null, controllerBootId: null }]]),
    now: NOW,
  });
  assert.equal(report.stuck.length, 1);
  assert.equal(report.escalate.length, 1);
  const md = renderReport(report);
  assert.match(md, /APP-26/);
  assert.match(md, /b7e1/);
  assert.match(md, /302d7d7c/);
  assert.match(md, /9h 33m/);
  assert.match(md, /blocks APP-61/);
  assert.match(md, /no lock was cleared/);
});

test('stuck findings are ordered oldest-lock first', () => {
  const report = buildReport({
    issues: [
      issue({ id: 'young', identifier: 'APP-2', executionRunId: 'r-young', executionLockedAt: minutesAgo(90) }),
      issue({ id: 'old', identifier: 'APP-3', executionRunId: 'r-old', executionLockedAt: minutesAgo(600) }),
    ],
    runsById: new Map([
      ['r-young', { status: 'queued', startedAt: null }],
      ['r-old', { status: 'queued', startedAt: null }],
    ]),
    now: NOW,
  });
  assert.deepEqual(report.stuck.map((f) => f.identifier), ['APP-3', 'APP-2']);
});

test('formatDuration reads as an operator would write it', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59 * 1000), '0m');
  assert.equal(formatDuration(95 * 60000), '1h 35m');
  assert.equal(formatDuration(null), 'unknown');
});

// --- APP-224: a live but task-unbound lock holder ---------------------------
//
// The shape measured on APP-217: run 47c79a69 was `running` the whole time it
// held the lock, so the old classifier called it healthy — while every write
// that run attempted to the locked issue 403d and the assignee's own bound run
// got a 409. `contextSnapshot.taskId` is what separates the two.

const unboundRun = (over = {}) => ({
  status: 'running',
  startedAt: minutesAgo(20),
  controllerBootId: 'boot-1',
  contextSnapshot: { wakeReason: 'max_turns_continuation_retry', wakeSource: 'automation' },
  ...over,
});

const boundRun = (over = {}) => ({
  status: 'running',
  startedAt: minutesAgo(20),
  controllerBootId: 'boot-1',
  contextSnapshot: { taskId: 'issue-1', issueId: 'issue-1', wakeReason: 'issue_assigned' },
  ...over,
});

test('taskBindingOf reads contextSnapshot, and says unknown when there is none', () => {
  assert.equal(taskBindingOf(boundRun()), 'bound');
  assert.equal(taskBindingOf(unboundRun()), 'unbound');
  assert.equal(taskBindingOf({ status: 'running' }), 'unknown');
  assert.equal(taskBindingOf({ status: 'running', contextSnapshot: null }), 'unknown');
  // issueId alone binds the run — the two fields carried the same value on every
  // bound run measured, but either one is enough.
  assert.equal(taskBindingOf({ contextSnapshot: { issueId: 'issue-1' } }), 'bound');
});

test('invocationSource is NOT the discriminator — a bound automation run is healthy', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(90) }),
    run: boundRun({ invocationSource: 'automation' }),
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'run_live');
  assert.equal(f.runTaskBinding, 'bound');
});

test('a live task-unbound holder past its grace is stuck — the APP-224 shape', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(16) }),
    run: unboundRun(),
    now: NOW,
  });
  assert.equal(f.stuck, true);
  assert.equal(f.reason, 'live_unbound_holder');
  assert.equal(f.runTaskBinding, 'unbound');
  assert.match(f.detail, /cannot write to this issue/);
  // It is a starvation window, not a deadlock: say so, so nobody force-releases it.
  assert.match(f.detail, /clears on its own when the run ends/);
});

test('a brief unbound touch of a lock is not reported', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(2) }),
    run: unboundRun({ startedAt: minutesAgo(2) }),
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'live_unbound_within_grace');
});

test('the unbound-holder grace boundary is stuck at exactly the threshold', () => {
  const at = classifyLock({
    issue: issue({ executionLockedAt: new Date(NOW - DEFAULT_UNBOUND_HOLDER_GRACE_MS).toISOString() }),
    run: unboundRun(),
    now: NOW,
  });
  assert.equal(at.stuck, true);
  assert.equal(at.reason, 'live_unbound_holder');
});

test('an unbound holder whose lock has no timestamp is left alone, not guessed at', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: null }),
    run: unboundRun(),
    now: NOW,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'live_unbound_unknown_age');
});

test('a terminal run is still reported as terminal, whatever its binding', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(30) }),
    run: unboundRun({ status: 'succeeded', completedAt: minutesAgo(10) }),
    now: NOW,
  });
  assert.equal(f.reason, 'run_terminal');
});

test('the unbound-holder grace is configurable per sweep', () => {
  const f = classifyLock({
    issue: issue({ executionLockedAt: minutesAgo(16) }),
    run: unboundRun(),
    now: NOW,
    unboundHolderGraceMs: 60 * 60 * 1000,
  });
  assert.equal(f.stuck, false);
  assert.equal(f.reason, 'live_unbound_within_grace');
});

test('buildReport threads the unbound grace and reports the holder', () => {
  const report = buildReport({
    issues: [issue({ id: 'issue-1', identifier: 'APP-217', executionLockedAt: minutesAgo(14) })],
    runsById: new Map([['run-1', unboundRun()]]),
    now: NOW,
    unboundHolderGraceMs: 10 * 60 * 1000,
  });
  assert.equal(report.unboundHolderGraceMs, 10 * 60 * 1000);
  assert.equal(report.stuck.length, 1);
  assert.equal(report.stuck[0].reason, 'live_unbound_holder');
  const rendered = renderReport(report);
  assert.match(rendered, /task binding `unbound`/);
  assert.match(rendered, /unbound-holder grace 10m/);
});
