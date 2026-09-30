import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResetTime,
  computeBackoffDelayMs,
  classifyForWatchdog,
  emptyState,
  recordWatchdogPause,
  clearWatchdogPause,
  getWatchdogPause,
  overduePauses,
  isHandled,
  markHandled,
  pruneHandled,
  getBackoffAttempt,
  bumpBackoffAttempt,
  resetBackoffAttempt,
  setPendingAction,
  clearPendingAction,
  duePendingActions,
  RETRYABLE_TRANSIENT_ERROR_CODES,
  QUOTA_ERROR_CODE,
  readRunIssueId,
} from '../lib/quota-retry-watchdog.mjs';

// Real error text observed on APP-45's investigation:
//   "Claude run failed: subtype=success: You've hit your session limit \xb7 resets 9:50am (Asia/Calcutta)"
const REAL_ERROR_950AM = "Claude run failed: subtype=success: You've hit your session limit · resets 9:50am (Asia/Calcutta)";
const REAL_ERROR_250PM = "Claude run failed: subtype=success: You've hit your session limit · resets 2:50pm (Asia/Calcutta)";

test('parseResetTime: parses the real Claude CLI quota-failure text', () => {
  // now = 2026-09-28T05:00:00Z = 10:30am IST (Asia/Calcutta is UTC+5:30) -- before 9:50am reset would already be today's morning, so pin now BEFORE 9:50am IST local to hit the same-day branch.
  const nowMs = Date.parse('2026-09-28T02:00:00.000Z'); // 07:30am IST
  const result = parseResetTime(REAL_ERROR_950AM, nowMs);
  assert.ok(result, 'expected a match');
  assert.equal(result.hour24, 9);
  assert.equal(result.minute, 50);
  assert.equal(result.timeZone, 'Asia/Calcutta');
  assert.equal(result.rolledOverToNextDay, false);
  // 9:50am IST == 04:20 UTC same day.
  assert.equal(new Date(result.resetAtMs).toISOString(), '2026-09-28T04:20:00.000Z');
});

test('parseResetTime: handles pm times', () => {
  const nowMs = Date.parse('2026-09-28T05:36:34.000Z'); // ~11:06am IST
  const result = parseResetTime(REAL_ERROR_250PM, nowMs);
  assert.ok(result);
  assert.equal(result.hour24, 14);
  // 2:50pm IST == 09:20 UTC same day.
  assert.equal(new Date(result.resetAtMs).toISOString(), '2026-09-28T09:20:00.000Z');
});

test('parseResetTime: day rollover -- printed time already passed today, so it means tomorrow', () => {
  // now = 11pm IST on 2026-09-28 (17:30 UTC). "resets 9:50am" cannot mean the
  // 9:50am that already happened this morning; it must be tomorrow's.
  const nowMs = Date.parse('2026-09-28T17:30:00.000Z'); // 2026-09-28 23:00 IST
  const result = parseResetTime(REAL_ERROR_950AM, nowMs);
  assert.ok(result);
  assert.equal(result.rolledOverToNextDay, true);
  // Tomorrow (2026-09-29) 9:50am IST == 2026-09-29T04:20:00Z.
  assert.equal(new Date(result.resetAtMs).toISOString(), '2026-09-29T04:20:00.000Z');
  assert.ok(result.resetAtMs > nowMs, 'the parsed reset must be in the future');
});

test('parseResetTime: exactly-at-now boundary also rolls to tomorrow (candidate <= now is "already passed")', () => {
  // now is exactly the instant 9:50am IST today would fall at.
  const nowMs = Date.parse('2026-09-28T04:20:00.000Z');
  const result = parseResetTime(REAL_ERROR_950AM, nowMs);
  assert.equal(result.rolledOverToNextDay, true);
  assert.equal(new Date(result.resetAtMs).toISOString(), '2026-09-29T04:20:00.000Z');
});

test('parseResetTime: returns null for text with no reset-time shape', () => {
  assert.equal(parseResetTime('Claude run failed: subtype=error_max_turns', Date.now()), null);
  assert.equal(parseResetTime('', Date.now()), null);
  assert.equal(parseResetTime(null, Date.now()), null);
  assert.equal(parseResetTime(undefined, Date.now()), null);
});

test('parseResetTime: returns null for a garbled/invalid timezone', () => {
  const text = "You've hit your session limit · resets 9:50am (Not/AZone)";
  assert.equal(parseResetTime(text, Date.now()), null);
});

test('parseResetTime: returns null for an out-of-range hour or minute', () => {
  assert.equal(parseResetTime("resets 13:50am (Asia/Calcutta)", Date.now()), null);
  assert.equal(parseResetTime("resets 9:99am (Asia/Calcutta)", Date.now()), null);
});

test('parseResetTime: 12am / 12pm boundary (midnight and noon)', () => {
  const nowMs = Date.parse('2026-09-28T00:00:00.000Z'); // 05:30am IST
  const midnight = parseResetTime("resets 12:00am (Asia/Calcutta)", nowMs);
  // 12:00am IST today already passed (it's 05:30am IST) -> rolls to tomorrow.
  assert.equal(midnight.hour24, 0);
  assert.equal(midnight.rolledOverToNextDay, true);

  const noon = parseResetTime("resets 12:00pm (Asia/Calcutta)", nowMs);
  assert.equal(noon.hour24, 12);
  assert.equal(noon.rolledOverToNextDay, false);
});

test('parseResetTime: works with a DST-observing zone too (sanity, not the production case)', () => {
  // America/New_York, no DST edge involved here -- just confirms the
  // generic Intl-based conversion is not IST-special-cased.
  const nowMs = Date.parse('2026-01-15T10:00:00.000Z'); // 05:00am EST
  const result = parseResetTime('resets 6:30am (America/New_York)', nowMs);
  assert.ok(result);
  // EST = UTC-5 in January.
  assert.equal(new Date(result.resetAtMs).toISOString(), '2026-01-15T11:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Backoff with full jitter
// ---------------------------------------------------------------------------

test('computeBackoffDelayMs: is bounded between 0 and min(cap, base*2^attempt)', () => {
  const base = 1000;
  const cap = 60_000;
  for (const attempt of [0, 1, 2, 3, 10]) {
    const bound = Math.min(cap, base * 2 ** attempt);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const delay = computeBackoffDelayMs(attempt, { baseMs: base, capMs: cap, randomFn: () => r });
      assert.ok(delay >= 0, `delay ${delay} should be >= 0`);
      assert.ok(delay <= bound, `delay ${delay} should be <= ${bound} at attempt ${attempt}`);
    }
  }
});

test('computeBackoffDelayMs: respects the cap even at high attempt counts', () => {
  const delay = computeBackoffDelayMs(20, { baseMs: 1000, capMs: 30_000, randomFn: () => 0.999999 });
  assert.ok(delay <= 30_000);
});

test('computeBackoffDelayMs: jitter varies output across calls (full jitter, not fixed)', () => {
  const seen = new Set();
  let seed = 1;
  const pseudoRandom = () => {
    // deterministic LCG so the test is reproducible, but produces varying values
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 20; i += 1) {
    seen.add(computeBackoffDelayMs(4, { baseMs: 1000, capMs: 60_000, randomFn: pseudoRandom }));
  }
  assert.ok(seen.size > 1, 'expected varying delays across repeated calls, got a constant value');
});

test('computeBackoffDelayMs: rejects a negative or non-integer attempt', () => {
  assert.throws(() => computeBackoffDelayMs(-1), /non-negative integer/);
  assert.throws(() => computeBackoffDelayMs(1.5), /non-negative integer/);
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test('classifyForWatchdog: routes a provider_quota failure to "quota"', () => {
  assert.equal(classifyForWatchdog({ status: 'failed', errorCode: QUOTA_ERROR_CODE }), 'quota');
});

test('classifyForWatchdog: routes a known retryable-transient errorCode to "transient"', () => {
  for (const code of RETRYABLE_TRANSIENT_ERROR_CODES) {
    assert.equal(classifyForWatchdog({ status: 'failed', errorCode: code }), 'transient');
  }
});

test('classifyForWatchdog: routes a succeeded run to "succeeded"', () => {
  assert.equal(classifyForWatchdog({ status: 'succeeded', errorCode: null }), 'succeeded');
});

test('classifyForWatchdog: returns null for failures we deliberately do not retry on a schedule', () => {
  for (const code of ['max_turns_exhausted', 'adapter_failed', 'claude_auth_required', 'setup_failed', 'cancelled', 'issue_reassigned']) {
    assert.equal(classifyForWatchdog({ status: 'failed', errorCode: code }), null);
  }
});

test('classifyForWatchdog: returns null for a run that is not yet resolved', () => {
  assert.equal(classifyForWatchdog({ status: 'queued', errorCode: null }), null);
  assert.equal(classifyForWatchdog({ status: 'running', errorCode: null }), null);
  assert.equal(classifyForWatchdog({ status: 'cancelled', errorCode: 'cancelled' }), null);
});

// ---------------------------------------------------------------------------
// Idempotency / state
// ---------------------------------------------------------------------------

test('isHandled/markHandled: a run is not handled until marked, and stays handled after', () => {
  const state = emptyState();
  assert.equal(isHandled(state, 'run-1'), false);
  markHandled(state, 'run-1', { action: 'quota_pause_scheduled', at: '2026-09-28T05:00:00.000Z' });
  assert.equal(isHandled(state, 'run-1'), true);
  assert.equal(isHandled(state, 'run-2'), false);
});

test('markHandled: repeated watchdog passes over the same run do not double-handle it (idempotency)', () => {
  // Simulates two watchdog polling passes seeing the same failed run.
  const state = emptyState();
  const handleIfNew = (runId) => {
    if (isHandled(state, runId)) return 'skipped';
    markHandled(state, runId, { action: 'quota_pause_scheduled', at: '2026-09-28T05:00:00.000Z' });
    return 'handled';
  };
  assert.equal(handleIfNew('run-1'), 'handled');
  assert.equal(handleIfNew('run-1'), 'skipped');
  assert.equal(handleIfNew('run-1'), 'skipped');
});

test('pruneHandled: drops entries older than the retention window, keeps recent ones', () => {
  const state = emptyState();
  markHandled(state, 'old', { action: 'x', at: '2026-09-01T00:00:00.000Z' });
  markHandled(state, 'recent', { action: 'x', at: '2026-09-27T00:00:00.000Z' });
  const nowMs = Date.parse('2026-09-28T00:00:00.000Z');
  pruneHandled(state, nowMs, 7 * 86_400_000);
  assert.equal(isHandled(state, 'old'), false);
  assert.equal(isHandled(state, 'recent'), true);
});

// ---------------------------------------------------------------------------
// Per-agent backoff counter
// ---------------------------------------------------------------------------

test('backoff attempt counter: starts at 0, bumps, and resets to 0 on success', () => {
  const state = emptyState();
  assert.equal(getBackoffAttempt(state, 'agent-a'), 0);
  assert.equal(bumpBackoffAttempt(state, 'agent-a'), 1);
  assert.equal(bumpBackoffAttempt(state, 'agent-a'), 2);
  assert.equal(getBackoffAttempt(state, 'agent-a'), 2);
  resetBackoffAttempt(state, 'agent-a', { seenAt: '2026-09-28T05:00:00.000Z' });
  assert.equal(getBackoffAttempt(state, 'agent-a'), 0);
});

test('backoff attempt counter: is independent per agent', () => {
  const state = emptyState();
  bumpBackoffAttempt(state, 'agent-a');
  bumpBackoffAttempt(state, 'agent-a');
  bumpBackoffAttempt(state, 'agent-b');
  assert.equal(getBackoffAttempt(state, 'agent-a'), 2);
  assert.equal(getBackoffAttempt(state, 'agent-b'), 1);
});

// ---------------------------------------------------------------------------
// Pending scheduled actions
// ---------------------------------------------------------------------------

test('pending actions: set, list due ones, clear', () => {
  const state = emptyState();
  setPendingAction(state, 'agent-a', { kind: 'quota_resume', scheduledAtMs: 1000, runId: 'run-1' });
  setPendingAction(state, 'agent-b', { kind: 'backoff_resume', scheduledAtMs: 5000, runId: 'run-2' });

  assert.deepEqual(duePendingActions(state, 500), []);
  const dueAt1000 = duePendingActions(state, 1000);
  assert.equal(dueAt1000.length, 1);
  assert.equal(dueAt1000[0][0], 'agent-a');

  const dueAt9000 = duePendingActions(state, 9000);
  assert.equal(dueAt9000.length, 2);

  clearPendingAction(state, 'agent-a');
  assert.deepEqual(duePendingActions(state, 9000).map(([id]) => id), ['agent-b']);
});

test('pending actions: a new pending action for an agent overwrites a stale one', () => {
  const state = emptyState();
  setPendingAction(state, 'agent-a', { kind: 'quota_resume', scheduledAtMs: 1000, runId: 'run-1' });
  setPendingAction(state, 'agent-a', { kind: 'quota_resume', scheduledAtMs: 2000, runId: 'run-2' });
  const due = duePendingActions(state, 2000);
  assert.equal(due.length, 1);
  assert.equal(due[0][1].runId, 'run-2');
});

// ---------------------------------------------------------------------------
// APP-181: readRunIssueId -- the issue binding a resumed wake has to carry.
//
// The shapes below are the two real runs from the APP-181 report, read back
// from GET /api/companies/{id}/heartbeat-runs:
//   c6e25521 -- the watchdog-resumed run, whose snapshot has no issue at all;
//               its PATCH and comment calls were refused 403.
//   8fbd89d9 -- an ordinary issue_assigned run; the identical PATCH passed.
// ---------------------------------------------------------------------------

test('readRunIssueId: reads contextSnapshot.issueId from a normally-bound run', () => {
  const run = {
    id: '8fbd89d9-3fc2-4b75-acbf-10e82479fbc9',
    contextSnapshot: {
      issueId: '9e10eb61-125a-4ad1-aa67-073b64b7acc9',
      taskId: '9e10eb61-125a-4ad1-aa67-073b64b7acc9',
      taskKey: '9e10eb61-125a-4ad1-aa67-073b64b7acc9',
      wakeReason: 'issue_assigned',
    },
  };
  assert.equal(readRunIssueId(run), '9e10eb61-125a-4ad1-aa67-073b64b7acc9');
});

test('readRunIssueId: returns null for the unbound watchdog-resumed run shape that caused APP-181', () => {
  const run = {
    id: 'c6e25521-03a4-4473-aa3f-57a5ff569d4d',
    contextSnapshot: {
      wakeReason: 'resuming after provider_quota reset (watchdog)',
      wakeSource: 'automation',
      wakeTriggerDetail: 'system',
    },
  };
  assert.equal(readRunIssueId(run), null);
});

test('readRunIssueId: falls back through taskId and nativeIssueId, in the server\'s own order', () => {
  assert.equal(readRunIssueId({ contextSnapshot: { taskId: 'issue-t' } }), 'issue-t');
  assert.equal(readRunIssueId({ contextSnapshot: {}, nativeIssueId: 'issue-n' }), 'issue-n');
  // issueId wins over taskId, and both win over nativeIssueId.
  assert.equal(
    readRunIssueId({ contextSnapshot: { issueId: 'issue-i', taskId: 'issue-t' }, nativeIssueId: 'issue-n' }),
    'issue-i',
  );
});

test('readRunIssueId: tolerates the snapshot shapes that are not objects, and blank strings', () => {
  assert.equal(readRunIssueId({}), null);
  assert.equal(readRunIssueId({ contextSnapshot: null }), null);
  assert.equal(readRunIssueId({ contextSnapshot: ['issue-x'] }), null, 'an array snapshot is not a binding');
  assert.equal(readRunIssueId({ contextSnapshot: { issueId: '   ' } }), null, 'whitespace is not an issue id');
  assert.equal(readRunIssueId({ contextSnapshot: { issueId: ' issue-i ' } }), 'issue-i', 'ids are trimmed');
  assert.equal(readRunIssueId(null), null);
});

// ---------------------------------------------------------------------------
// Bounded-pause invariant (APP-103 / DEBT-0003)
// ---------------------------------------------------------------------------

const SWEEP = { overdueMarginMs: 10 * 60_000, maxPauseMs: 12 * 3_600_000, maxQuotaPauseMs: 8 * 86_400_000 };

test('a pause whose resume is not yet due is not swept', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 3_600_000, kind: 'quota', runId: 'r1' });
  assert.deepEqual(overduePauses(state, now + 60_000, SWEEP), []);
});

test('a pause still inside the overdue margin is not swept — a normal due-fire must always win the race', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 1000, kind: 'quota', runId: 'r1' });
  // 5 minutes past the scheduled resume: several polling passes have had a
  // chance, but we are still inside the 10min margin.
  assert.deepEqual(overduePauses(state, now + 1000 + 5 * 60_000, SWEEP), []);
});

test('a pause past its scheduled resume + margin is swept, and says how late it is', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 1000, kind: 'quota', runId: 'r1' });
  const swept = overduePauses(state, now + 1000 + 25 * 60_000, SWEEP);
  assert.equal(swept.length, 1);
  const [agentId, entry, why] = swept[0];
  assert.equal(agentId, 'agent-cto');
  assert.equal(entry.runId, 'r1');
  assert.match(why, /25min ago/);
});

test('a pause with an unusable scheduled resume is swept immediately — the ceiling cannot trust the number that is wrong', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  for (const bad of [undefined, null, NaN, 'soon']) {
    const s = emptyState();
    recordWatchdogPause(s, 'agent-x', { pausedAtMs: now, scheduledResumeAtMs: bad, kind: 'quota', runId: 'r' });
    const swept = overduePauses(s, now + 1000, SWEEP);
    assert.equal(swept.length, 1, `expected a sweep for scheduledResumeAtMs=${String(bad)}`);
    assert.match(swept[0][2], /no usable scheduled resume time/);
  }
  assert.ok(now);
});

test('the absolute maximum-pause ceiling fires on a backoff pause even when the schedule claims the resume is still in the future', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  // A mangled reset parse that landed a week out: the first ceiling never
  // triggers, because it believes the schedule. This is what the second one
  // is for.
  recordWatchdogPause(state, 'agent-cto', {
    pausedAtMs: now,
    scheduledResumeAtMs: now + 7 * 86_400_000,
    kind: 'backoff',
    runId: 'r1',
  });
  assert.deepEqual(overduePauses(state, now + 11 * 3_600_000, SWEEP), [], 'inside 12h: still trusted');
  const swept = overduePauses(state, now + 13 * 3_600_000, SWEEP);
  assert.equal(swept.length, 1);
  assert.match(swept[0][2], /maximum-pause ceiling/);
});

test('re-recording a pause refreshes the schedule but keeps the original pausedAtMs, so repeated failures cannot push the ceiling out forever', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 1000, kind: 'backoff', runId: 'r1' });
  recordWatchdogPause(state, 'agent-cto', {
    pausedAtMs: now + 11 * 3_600_000,
    scheduledResumeAtMs: now + 30 * 86_400_000,
    kind: 'backoff',
    runId: 'r2',
  });
  const entry = getWatchdogPause(state, 'agent-cto');
  assert.equal(entry.pausedAtMs, now, 'the ceiling measures real time parked, not time since the latest failure');
  assert.equal(entry.runId, 'r2', 'but the rest of the entry is refreshed');
  assert.equal(overduePauses(state, now + 13 * 3_600_000, SWEEP).length, 1);
});

test('clearWatchdogPause removes the claim, and a state with no pausedAgents key at all is handled', () => {
  const state = emptyState();
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: 1, scheduledResumeAtMs: 2, kind: 'quota', runId: 'r' });
  clearWatchdogPause(state, 'agent-cto');
  assert.equal(getWatchdogPause(state, 'agent-cto'), null);
  // A state file written by the pre-APP-103 watchdog has no pausedAgents key.
  const legacy = { handledRunIds: {}, agents: {}, pendingActions: {} };
  assert.deepEqual(overduePauses(legacy, Date.now(), SWEEP), []);
  assert.doesNotThrow(() => clearWatchdogPause(legacy, 'agent-cto'));
  assert.equal(getWatchdogPause(legacy, 'agent-cto'), null);
});

test('a NEW pause on an agent that was running restarts the ceiling clock, so a stale claim cannot get it force-resumed immediately', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  // A claim left over from a force-resume that kept failing: 20h old, so
  // already past the 12h ceiling.
  recordWatchdogPause(state, 'agent-cto', {
    pausedAtMs: now - 20 * 3_600_000,
    scheduledResumeAtMs: now - 19 * 3_600_000,
    kind: 'quota',
    runId: 'old',
  });
  assert.equal(overduePauses(state, now, SWEEP).length, 1, 'sanity: the stale claim is sweepable');

  // The agent is observed *running*, then hits a fresh quota limit and is
  // newly paused with a legitimate 3h wait. Carrying the old pausedAtMs
  // forward would make this brand-new pause instantly overdue.
  recordWatchdogPause(state, 'agent-cto', {
    pausedAtMs: now,
    scheduledResumeAtMs: now + 3 * 3_600_000,
    kind: 'quota',
    runId: 'new',
    stillPaused: false,
  });
  assert.equal(getWatchdogPause(state, 'agent-cto').pausedAtMs, now);
  assert.deepEqual(overduePauses(state, now + 1000, SWEEP), [], 'the fresh pause must be allowed to run its course');
});

// Review finding on PR #14: a quota reset is not bounded by 12h. A weekly
// limit resets days out, and even a daily reset that rolled over to tomorrow
// can be ~24h away. With the 12h ceiling applied to those, the agent is
// force-resumed, fails on the same limit, and is re-paused every 12h.
test('a quota pause with a valid multi-day schedule (weekly limit) is NOT force-resumed by the 12h ceiling', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 5 * 86_400_000, kind: 'quota', runId: 'r1' });
  assert.deepEqual(overduePauses(state, now + 13 * 3_600_000, SWEEP), [], '13h into a 5-day weekly wait');
  assert.deepEqual(overduePauses(state, now + 4 * 86_400_000, SWEEP), [], '4 days into a 5-day weekly wait');
  // ...and the ordinary overdue rule still gets it out once the reset has passed.
  assert.equal(overduePauses(state, now + 5 * 86_400_000 + 11 * 60_000, SWEEP).length, 1);
});

test('a quota pause still has an absolute bound: the longer quota ceiling catches a schedule mangled weeks out', () => {
  const state = emptyState();
  const now = 1_000_000_000;
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: now, scheduledResumeAtMs: now + 30 * 86_400_000, kind: 'quota', runId: 'r1' });
  assert.deepEqual(overduePauses(state, now + 7 * 86_400_000, SWEEP), []);
  const swept = overduePauses(state, now + 9 * 86_400_000, SWEEP);
  assert.equal(swept.length, 1);
  assert.match(swept[0][2], /maximum-pause ceiling/);
});
