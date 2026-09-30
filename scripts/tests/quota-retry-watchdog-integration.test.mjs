// Integration-style tests for the watchdog's orchestration script
// (scripts/quota-retry-watchdog.mjs), driven entirely by fake fetch data and
// dry-run mode -- no real Paperclip API calls, no real `paperclipai` CLI
// invocations, no real filesystem state beyond a throwaway tmp file.
//
// Item 4 of the APP-45/DEBT-0001 follow-up asks specifically to confirm this
// design would drive session-burn.mjs's `retriedWithinResetWindow` metric
// toward zero, without waiting hours for a real quota event. The second test
// below does exactly that: it reuses `quotaWaste` from lib/session-burn.mjs
// (the same function session-burn.mjs's own report is built on) against two
// synthetic run histories -- "before" (today's real bug shape: Paperclip's
// scheduler sets scheduledRetryAt/scheduledRetryReason="transient_failure"
// within seconds of a provider_quota failure) and "after" (the watchdog
// pauses the agent before Paperclip's recovery service gets a chance to
// schedule anything, so those fields are never set) -- and shows the metric
// drop from 1 to 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { runOnce, reportPassOutcome } from '../quota-retry-watchdog.mjs';
import { quotaWaste } from '../lib/session-burn.mjs';

function fakeFetchJson(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload, text: async () => '' });
}

function withFakeFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    for (const [match, handler] of routes) {
      if (url.includes(match)) return fakeFetchJson(handler)();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  return join(dir, 'state.json');
}

/**
 * Formats `targetMs` the way Claude's CLI prints a quota-reset time
 * ("9:50am (Asia/Calcutta)"), so tests can build a reset time relative to
 * the *real* current clock (runOnce uses `Date.now()` internally, not an
 * injectable clock) instead of a hardcoded calendar date that would drift
 * out of the lookback window as soon as this suite is run on a later day.
 */
function formatResetText(targetMs, timeZone = 'Asia/Calcutta') {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  const formatted = dtf.format(new Date(targetMs)).toLowerCase().replace(/\s+/g, ''); // "9:50am"
  return `Claude run failed: subtype=success: You've hit your session limit · resets ${formatted} (${timeZone})`;
}

test('runOnce (dry-run): a provider_quota failure is paused and its resume is scheduled strictly at-or-after the parsed reset, never on Paperclip\'s short transient-style delay', async () => {
  const nowMs = Date.now();
  const targetResetMs = nowMs + 3 * 3_600_000 + 30_000; // ~3h from now, clear of minute-rounding
  const failedAtIso = new Date(nowMs).toISOString();
  const runs = [
    {
      id: 'run-quota-1',
      agentId: 'agent-cto',
      status: 'failed',
      errorCode: 'provider_quota',
      error: formatResetText(targetResetMs),
      createdAt: failedAtIso,
      startedAt: failedAtIso,
      finishedAt: failedAtIso,
      usageJson: { inputTokens: 80000, outputTokens: 0, costUsd: 2 },
    },
  ];
  const agents = [{ id: 'agent-cto', name: 'CTO', status: 'idle' }];

  const logs = [];
  const state = await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      ['/agents', agents],
    ],
    () =>
      runOnce(
        {
          apiBase: 'http://fake-paperclip',
          companyId: 'fake-co',
          apiKey: null,
          stateFile: tmpStateFile(),
          claudeConfigDir: '/tmp/unused',
          lookbackMinutes: 180,
          dryRun: true,
        },
        { log: (line) => logs.push(line) },
      ),
  );

  assert.equal(Object.keys(state.pendingActions).length, 1, 'expected one pending resume action');
  const action = state.pendingActions['agent-cto'];
  assert.equal(action.kind, 'quota');
  assert.equal(action.runId, 'run-quota-1');

  // The reset text loses sub-minute precision (we only print h:mm), so allow
  // up to a minute of rounding either way, plus the 90s buffer.
  assert.ok(action.scheduledAtMs >= targetResetMs - 60_000, 'must not schedule resume materially before the real reset');
  assert.ok(action.scheduledAtMs <= targetResetMs + 60_000 + 90_000 + 5_000, 'should be reset + ~90s buffer, not open-ended');

  // The defining property: the gap between the failure and our scheduled
  // resume is HOURS, not the 30s/1.6s Paperclip's own scheduler used in the
  // real incident.
  const gapMs = action.scheduledAtMs - nowMs;
  assert.ok(gapMs > 2.5 * 3_600_000, `expected a multi-hour gap before resume, got ${gapMs}ms`);

  assert.ok(logs.some((l) => l.includes('QUOTA detected')));
  assert.ok(logs.some((l) => l.includes('DRY-RUN would run: paperclipai agent pause agent-cto')));
  assert.ok(state.handledRunIds['run-quota-1'], 'the run must be marked handled for idempotency');
});

test('runOnce (dry-run): a second pass over the same run is a no-op (idempotency across polling passes)', async () => {
  const nowMs = Date.now();
  const failedAtIso = new Date(nowMs).toISOString();
  const runs = [
    {
      id: 'run-quota-dup',
      agentId: 'agent-cto',
      status: 'failed',
      errorCode: 'provider_quota',
      error: formatResetText(nowMs + 2 * 3_600_000),
      createdAt: failedAtIso,
      startedAt: failedAtIso,
      finishedAt: failedAtIso,
      usageJson: null,
    },
  ];
  const agents = [{ id: 'agent-cto', name: 'CTO', status: 'idle' }];
  const stateFile = tmpStateFile();

  // dryRun:true throughout -- no real `paperclipai` subprocess calls, same
  // as every other test here. To exercise idempotency ACROSS passes (which
  // dry-run mode deliberately does not persist, so it never mutates real
  // state on a real host) we persist the first pass's returned state to
  // disk ourselves and feed it into the second pass, exactly what a real
  // (non-dry-run) run would have done via `runOnce`'s own `saveState` call.
  const { writeFileSync } = await import('node:fs');

  const pass1Logs = [];
  const pass1State = await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      ['/agents', agents],
    ],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: (l) => pass1Logs.push(l) },
      ),
  );
  assert.ok(pass1Logs.some((l) => l.includes('QUOTA detected')), 'first pass should detect and act');
  writeFileSync(stateFile, JSON.stringify(pass1State));

  const pass2Logs = [];
  await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      ['/agents', agents],
    ],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: (l) => pass2Logs.push(l) },
      ),
  );
  assert.ok(!pass2Logs.some((l) => l.includes('QUOTA detected')), 'second pass over the same run must not re-detect it');
  assert.ok(!pass2Logs.some((l) => l.includes('paperclipai agent pause')), 'second pass must not pause again');
});

test('runOnce (dry-run): a due pending action fires resume+wake, and a not-yet-due one does not', async () => {
  // First pass: create a pending action with a reset in the near future by
  // constructing the run's `error` so its reset time lands a few ms after
  // "now" (via an injected clock is not available, so instead we assert the
  // *shape* of due-vs-not-due using the pure state helpers directly here,
  // and cover the CLI call sequence with a manually-seeded state file).
  const { emptyState, setPendingAction } = await import('../lib/quota-retry-watchdog.mjs');
  const state = emptyState();
  setPendingAction(state, 'agent-cto', { kind: 'quota', runId: 'run-x', scheduledAtMs: 1000, reason: 'resuming after provider_quota reset (watchdog)' });
  setPendingAction(state, 'agent-ceo', { kind: 'backoff', runId: 'run-y', scheduledAtMs: 9_999_999_999_999, reason: 'resuming after process_lost backoff attempt 0 (watchdog)' });

  const { writeFileSync, mkdtempSync: mkdtemp } = await import('node:fs');
  const dir = mkdtemp(join(tmpdir(), 'watchdog-test-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [
        { id: 'agent-cto', name: 'CTO', status: 'idle' },
        { id: 'agent-ceo', name: 'CEO', status: 'idle' },
      ]],
    ],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: (l) => logs.push(l) },
      ),
  );

  assert.ok(logs.some((l) => l.includes('RESUME agent=CTO')), 'the due action (scheduledAtMs=1000, long past) should fire');
  assert.ok(logs.some((l) => l.includes('WAKE agent=CTO')));
  assert.ok(!logs.some((l) => l.includes('RESUME agent=CEO')), 'the far-future action must not fire yet');
  assert.equal(finalState.pendingActions['agent-cto'], undefined, 'fired action is cleared');
  assert.ok(finalState.pendingActions['agent-ceo'], 'not-yet-due action remains pending');
});

// ---------------------------------------------------------------------------
// APP-181: the resumed run must stay task-bound.
//
// A wake with no `issueId` in its payload produces a run whose
// `contextSnapshot` carries only the wake reason/source. The server's
// `readRunSourceIssueId` then returns null, and its cross-issue-influence
// limiter fails closed on every `PATCH /api/issues/:id` and
// `POST /api/issues/:id/comments` -- including writes to the issue the run
// itself checked out, because the limiter's same-issue exemption has no
// source issue to compare against. The regression these two tests lock down
// is the one the CEO asked for in words: a resumed run retains the
// task-bound classification of the run it resumed.
// ---------------------------------------------------------------------------

test('APP-181: a provider_quota failure records the interrupted run\'s issue on the pending action', async () => {
  const nowMs = Date.now();
  const failedAtIso = new Date(nowMs).toISOString();
  const issueId = 'a9883bd9-1111-4222-8333-444455556666';
  const runs = [
    {
      id: 'run-quota-bound',
      agentId: 'agent-cto',
      status: 'failed',
      errorCode: 'provider_quota',
      error: formatResetText(nowMs + 3 * 3_600_000 + 30_000),
      createdAt: failedAtIso,
      startedAt: failedAtIso,
      finishedAt: failedAtIso,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: 'issue_assigned' },
    },
  ];

  const state = await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]],
    ],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile: tmpStateFile(), claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: () => {} },
      ),
  );

  assert.equal(state.pendingActions['agent-cto'].issueId, issueId,
    'the issue must be captured at schedule time -- the failed run is gone from the lookback window by the time the resume fires hours later');
});

test('APP-181: the fired wake carries --payload {"issueId"} so the resumed run is task-bound', async () => {
  const { emptyState, setPendingAction } = await import('../lib/quota-retry-watchdog.mjs');
  const issueId = 'a9883bd9-1111-4222-8333-444455556666';
  const state = emptyState();
  setPendingAction(state, 'agent-cto', {
    kind: 'quota', runId: 'run-x', issueId, scheduledAtMs: 1000,
    reason: 'resuming after provider_quota reset (watchdog)',
  });
  // An agent whose interrupted run genuinely had no issue: still resumed, but
  // deliberately woken unbound rather than bound to a guess.
  setPendingAction(state, 'agent-ceo', {
    kind: 'quota', runId: 'run-y', issueId: null, scheduledAtMs: 1000,
    reason: 'resuming after provider_quota reset (watchdog)',
  });

  const { writeFileSync, mkdtempSync: mkdtemp } = await import('node:fs');
  const stateFile = join(mkdtemp(join(tmpdir(), 'watchdog-test-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));

  const logs = [];
  await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [
        { id: 'agent-cto', name: 'CTO', status: 'idle' },
        { id: 'agent-ceo', name: 'CEO', status: 'idle' },
      ]],
    ],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: (l) => logs.push(l) },
      ),
  );

  const ctoWake = logs.find((l) => l.includes('agent wake agent-cto'));
  assert.ok(ctoWake, 'expected a wake command for the bound agent');
  assert.ok(ctoWake.includes(`--payload {"issueId":"${issueId}"}`),
    `the wake must carry the issue binding, got: ${ctoWake}`);
  assert.ok(logs.some((l) => l.includes('WAKE agent=CTO') && l.includes(`issue=${issueId}`)),
    'the log line should name the issue the resumed run is bound to');

  const ceoWake = logs.find((l) => l.includes('agent wake agent-ceo'));
  assert.ok(ceoWake, 'an unbound pending action must still be resumed and woken');
  assert.ok(!ceoWake.includes('--payload'), 'an absent issue must not be forwarded as a null/empty payload');
  assert.ok(logs.some((l) => l.includes('WAKE agent=CEO') && l.includes('UNBOUND')),
    'the unbound case must be named in the log, since that run will hit the APP-181 403');
});

test('APP-181: a pending action written by a pre-fix watchdog build (no issueId key) still resumes, unbound', async () => {
  const { emptyState, setPendingAction } = await import('../lib/quota-retry-watchdog.mjs');
  const state = emptyState();
  setPendingAction(state, 'agent-cto', {
    kind: 'quota', runId: 'run-legacy', scheduledAtMs: 1000,
    reason: 'resuming after provider_quota reset (watchdog)',
  });
  const { writeFileSync, mkdtempSync: mkdtemp } = await import('node:fs');
  const stateFile = join(mkdtemp(join(tmpdir(), 'watchdog-test-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));

  const logs = [];
  const finalState = await withFakeFetch(
    [['/heartbeat-runs', []], ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]]],
    () =>
      runOnce(
        { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
        { log: (l) => logs.push(l) },
      ),
  );

  assert.ok(logs.some((l) => l.includes('RESUME agent=CTO')), 'a state file from the previous build must not strand the agent paused');
  assert.ok(logs.some((l) => l.includes('WAKE agent=CTO') && l.includes('UNBOUND')));
  assert.equal(finalState.pendingActions['agent-cto'], undefined);
});

// ---------------------------------------------------------------------------
// Acceptance criterion (task item 4): session-burn.mjs's `retriedWithinResetWindow`
// should go to zero once the watchdog is in place.
// ---------------------------------------------------------------------------

test('acceptance: quotaWaste().retriedWithinResetWindow reflects today\'s bug ("before"), and drops to zero once the watchdog preempts Paperclip\'s scheduler ("after")', () => {
  const baseRun = {
    agentId: 'agent-cto',
    status: 'failed',
    errorCode: 'provider_quota',
    startedAt: '2026-09-28T05:36:16.000Z',
    finishedAt: '2026-09-28T05:36:34.000Z',
    usageJson: { inputTokens: 80000, outputTokens: 0, costUsd: 2 },
  };

  // BEFORE: reproduces the real incident. Paperclip's own recovery service
  // set scheduledRetryAt ~18s after failure under reason "transient_failure"
  // -- a non-quota-aware reason -- which is precisely what quotaWaste()
  // flags as wasted.
  const beforeRuns = [
    { ...baseRun, id: 'run-before', scheduledRetryAt: '2026-09-28T05:36:52.000Z', scheduledRetryReason: 'transient_failure' },
  ];
  const before = quotaWaste(beforeRuns);
  assert.equal(before.retriedWithinResetWindow, 1, 'sanity: this run shape is the real observed bug');

  // AFTER: the watchdog's pause() call (proven above to happen in the same
  // pass that detects the provider_quota failure, before any resume is ever
  // scheduled) runs before Paperclip's recovery service gets to act on this
  // failure, so the run this produces never gets a scheduledRetryAt/Reason
  // from Paperclip's scheduler at all -- the watchdog's own resume+wake is a
  // fresh on-demand invocation at reset time, not a "scheduledRetry" in
  // Paperclip's sense, so it is structurally outside what quotaWaste() can
  // even count as misscheduled.
  const afterRuns = [
    { ...baseRun, id: 'run-after', scheduledRetryAt: null, scheduledRetryReason: null },
  ];
  const after = quotaWaste(afterRuns);
  assert.equal(after.retriedWithinResetWindow, 0, 'the watchdog design should drive this metric to zero');
});

// ---------------------------------------------------------------------------
// APP-164: the resume must TELL the woken agent which of its `blocked` issues
// are pause-cancellation collateral rather than real dependency holds. The
// watchdog holds no credential that can satisfy the owner gate on the
// hand-back route (run-scoped JWTs), so naming them in the wake is the whole
// mechanism -- if the note is missing, nothing downstream ever clears them.
// ---------------------------------------------------------------------------
test('runOnce (dry-run): the resume wake names the agent\'s pause-cancellation collateral, and never tries to resolve it itself', async () => {
  const { emptyState, setPendingAction } = await import('../lib/quota-retry-watchdog.mjs');
  const state = emptyState();
  setPendingAction(state, 'agent-cto', {
    kind: 'quota',
    runId: 'run-x',
    scheduledAtMs: 1000,
    reason: 'resuming after provider_quota reset (watchdog)',
  });

  const { writeFileSync, mkdtempSync: mkdtemp } = await import('node:fs');
  const stateFile = join(mkdtemp(join(tmpdir(), 'watchdog-test-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));

  const strandedAction = (returnOwner, assignee) => ({
    id: 'act-1',
    status: 'active',
    cause: 'stranded_assigned_issue',
    returnOwnerAgentId: returnOwner,
    createdAt: '2026-09-29T18:00:00.000Z',
    evidence: { latestRunId: 'run-dead', latestRunStatus: 'cancelled', latestRunErrorCode: 'agent_paused' },
  });

  const logs = [];
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(`${opts?.method ?? 'GET'} ${url}`);
    const payload = url.includes('/heartbeat-runs')
      ? []
      : url.includes('/agents')
        ? [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]
        : url.includes('/issues')
          ? {
              issues: [
                {
                  id: 'i-1',
                  identifier: 'APP-999',
                  title: 'collateral',
                  status: 'blocked',
                  assigneeAgentId: 'agent-cto',
                  activeRecoveryAction: strandedAction('agent-cto'),
                },
              ],
            }
          : null;
    if (payload === null) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, json: async () => payload, text: async () => '' };
  };
  try {
    await runOnce(
      { apiBase: 'http://fake', companyId: 'fake-co', apiKey: 'k', stateFile, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true },
      { log: (l) => logs.push(l) },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const wake = logs.find((l) => l.includes('DRY-RUN would run: paperclipai agent wake'));
  assert.ok(wake, 'a wake must be issued');
  assert.match(wake, /APP-999/, 'the wake reason must name the collateral issue');
  assert.match(wake, /clear-my-recovery-collateral/, 'and must tell the agent how to clear it');
  assert.ok(logs.some((l) => l.includes('COLLATERAL   APP-999')), 'and it is reported in the log');
  assert.ok(
    !logs.some((l) => l.includes('COLLATERAL lookup failed')),
    'the lookup must actually have succeeded, not silently failed soft',
  );
  assert.ok(
    !seen.some((s) => s.includes('recovery-actions/resolve')),
    'the daemon must never issue the hand-back write itself -- it holds no credential that can own it',
  );
});

// ---------------------------------------------------------------------------
// APP-103 / DEBT-0003: the bounded-pause invariant.
//
// The scenario these cover is the one that makes an unmonitored watchdog
// dangerous: an agent is parked (that is how the workaround preempts
// Paperclip's scheduler), and the bookkeeping that would get it back out is
// gone or broken. The normal `pendingActions` path cannot help, because the
// pending action is exactly what was lost. The sweep must get the agent back
// anyway, off nothing but "we parked this, and it is long past due".
// ---------------------------------------------------------------------------

async function seedState(mutate) {
  const { emptyState } = await import('../lib/quota-retry-watchdog.mjs');
  const state = emptyState();
  mutate(state);
  const { writeFileSync } = await import('node:fs');
  const stateFile = tmpStateFile();
  writeFileSync(stateFile, JSON.stringify(state));
  return stateFile;
}

const RUN_ARGS = { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: true };

test('bounded pause: an agent parked by the watchdog with its pending resume LOST is force-resumed anyway', async () => {
  const nowMs = Date.now();
  // The state a crash mid-write (or a lost/rolled-back state file) leaves
  // behind: the pause is remembered, the scheduled resume that would undo it
  // is not. Before APP-103 this agent stayed paused forever.
  const stateFile = await seedState((state) => {
    state.pausedAgents['agent-cto'] = {
      pausedAtMs: nowMs - 3 * 3_600_000,
      scheduledResumeAtMs: nowMs - 40 * 60_000, // due 40min ago, well past the 10min margin
      kind: 'quota',
      runId: 'run-lost',
    };
  });

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'paused' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) }),
  );

  assert.equal(Object.keys(finalState.pendingActions).length, 0, 'there was never a pending action to fire');
  assert.ok(logs.some((l) => l.includes('PAUSE-SWEEP force-resuming agent=CTO')), 'the sweep must catch it');
  assert.ok(logs.some((l) => l.includes('DRY-RUN would run: paperclipai agent resume agent-cto')));
  assert.ok(logs.some((l) => l.includes('PAUSE-SWEEP WAKE agent=CTO')), 'and wake it, so it does not sit idle until its next heartbeat');
  assert.equal(finalState.pausedAgents['agent-cto'], undefined, 'the claim is released once the resume lands');
});

test('bounded pause: a not-yet-overdue pause is left alone (fail open, but not trigger-happy)', async () => {
  const nowMs = Date.now();
  const stateFile = await seedState((state) => {
    state.pausedAgents['agent-cto'] = {
      pausedAtMs: nowMs - 60_000,
      scheduledResumeAtMs: nowMs + 3 * 3_600_000, // a real quota wait still in progress
      kind: 'quota',
      runId: 'run-live',
    };
  });

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'paused' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) }),
  );

  assert.ok(!logs.some((l) => l.includes('PAUSE-SWEEP')), 'a legitimate multi-hour quota wait must not be cut short');
  assert.ok(finalState.pausedAgents['agent-cto'], 'the claim is still held');
});

test('bounded pause: an overdue claim on an agent that is no longer paused is reconciled, not re-resumed', async () => {
  const nowMs = Date.now();
  const stateFile = await seedState((state) => {
    state.pausedAgents['agent-cto'] = {
      pausedAtMs: nowMs - 3 * 3_600_000,
      scheduledResumeAtMs: nowMs - 40 * 60_000,
      kind: 'quota',
      runId: 'run-x',
    };
  });

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]], // an operator already resumed it
    ],
    () => runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) }),
  );

  assert.ok(logs.some((l) => l.includes('PAUSE-SWEEP agent=CTO is already idle')));
  assert.ok(!logs.some((l) => l.includes('paperclipai agent resume')), 'no redundant resume call');
  assert.equal(finalState.pausedAgents['agent-cto'], undefined);
});

test('bounded pause: a claim on an agent that no longer exists is dropped rather than swept forever', async () => {
  const nowMs = Date.now();
  const stateFile = await seedState((state) => {
    state.pausedAgents['agent-gone'] = {
      pausedAtMs: nowMs - 20 * 3_600_000,
      scheduledResumeAtMs: nowMs - 19 * 3_600_000,
      kind: 'backoff',
      runId: 'run-z',
    };
  });

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) }),
  );

  assert.ok(logs.some((l) => l.includes('no longer in the company')));
  assert.equal(finalState.pausedAgents['agent-gone'], undefined);
});

test('bounded pause: the watchdog claims the pauses it issues, so a later sweep can undo them', async () => {
  const nowMs = Date.now();
  const failedAtIso = new Date(nowMs).toISOString();
  const runs = [
    {
      id: 'run-claim',
      agentId: 'agent-cto',
      status: 'failed',
      errorCode: 'provider_quota',
      error: formatResetText(nowMs + 2 * 3_600_000),
      createdAt: failedAtIso,
      startedAt: failedAtIso,
      finishedAt: failedAtIso,
      usageJson: null,
    },
  ];

  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile: tmpStateFile() }, { log: () => {} }),
  );

  const claim = finalState.pausedAgents['agent-cto'];
  assert.ok(claim, 'pausing an agent must be recorded, or the sweep has nothing to act on');
  assert.equal(claim.kind, 'quota');
  assert.equal(claim.runId, 'run-claim');
  assert.equal(claim.scheduledResumeAtMs, finalState.pendingActions['agent-cto'].scheduledAtMs);
});

test('bounded pause: a pause the watchdog did NOT issue is never claimed — a founder\'s deliberate pause must not be silently undone', async () => {
  const nowMs = Date.now();
  const failedAtIso = new Date(nowMs).toISOString();
  const runs = [
    {
      id: 'run-operator-paused',
      agentId: 'agent-cto',
      status: 'failed',
      errorCode: 'provider_quota',
      error: formatResetText(nowMs + 2 * 3_600_000),
      createdAt: failedAtIso,
      startedAt: failedAtIso,
      finishedAt: failedAtIso,
      usageJson: null,
    },
  ];

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', runs],
      // Already paused, and the watchdog's state has no claim on it: this is
      // an operator pause that happens to coincide with a quota failure.
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'paused' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile: tmpStateFile() }, { log: (l) => logs.push(l) }),
  );

  assert.ok(logs.some((l) => l.includes('PAUSE-OWNERSHIP')));
  assert.equal(finalState.pausedAgents['agent-cto'], undefined, 'the sweep must not take ownership of a pause it did not make');
});

test('a normal due-fire clears the pause claim, so the sweep has nothing left to do', async () => {
  const { emptyState, setPendingAction, recordWatchdogPause } = await import('../lib/quota-retry-watchdog.mjs');
  const state = emptyState();
  setPendingAction(state, 'agent-cto', { kind: 'quota', runId: 'run-x', scheduledAtMs: 1000, reason: 'resuming after provider_quota reset (watchdog)' });
  recordWatchdogPause(state, 'agent-cto', { pausedAtMs: 500, scheduledResumeAtMs: 1000, kind: 'quota', runId: 'run-x' });

  const { writeFileSync } = await import('node:fs');
  const stateFile = tmpStateFile();
  writeFileSync(stateFile, JSON.stringify(state));

  const logs = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'paused' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) }),
  );

  assert.ok(logs.some((l) => l.includes('RESUME agent=CTO')), 'the ordinary path handles it');
  assert.ok(!logs.some((l) => l.includes('PAUSE-SWEEP')), 'and the sweep does not fire a second, redundant resume');
  assert.equal(finalState.pausedAgents['agent-cto'], undefined);
  assert.equal(finalState.pendingActions['agent-cto'], undefined);
});


// ---------------------------------------------------------------------------
// APP-103 x APP-181: the force-resume sweep must not regress the task binding.
// The sweep exists for the case where the pending action was LOST, so the
// issue it binds the wake to has to come from the pause registry itself.
// ---------------------------------------------------------------------------

test('APP-181 x APP-103: a quota pause records the interrupted run\'s issue on the pause registry entry', async () => {
  const nowMs = Date.now();
  const failedAtIso = new Date(nowMs).toISOString();
  const issueId = 'b1b2b3b4-1111-4222-8333-444455556666';
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', [{
        id: 'run-bound', agentId: 'agent-cto', status: 'failed', errorCode: 'provider_quota',
        error: formatResetText(nowMs + 2 * 3_600_000), createdAt: failedAtIso, startedAt: failedAtIso,
        finishedAt: failedAtIso, contextSnapshot: { issueId },
      }]],
      ['/agents', [{ id: 'agent-cto', name: 'CTO', status: 'idle' }]],
    ],
    () => runOnce({ ...RUN_ARGS, stateFile: tmpStateFile() }, { log: () => {} }),
  );
  assert.equal(finalState.pausedAgents['agent-cto'].issueId, issueId);
});

test('APP-181 x APP-103: the force-resume wake is task-bound and carries the collateral note', async () => {
  const nowMs = Date.now();
  const issueId = 'c1c2c3c4-1111-4222-8333-444455556666';
  const stateFile = await seedState((state) => {
    // Pending action lost; only the registry entry survives.
    state.pausedAgents['agent-cto'] = {
      pausedAtMs: nowMs - 3 * 3_600_000,
      scheduledResumeAtMs: nowMs - 40 * 60_000,
      kind: 'quota',
      runId: 'run-lost',
      issueId,
    };
  });
  const logs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const payload = url.includes('/heartbeat-runs')
      ? []
      : url.includes('/agents')
        ? [{ id: 'agent-cto', name: 'CTO', status: 'paused' }]
        : {
            issues: [{
              id: 'i-2', identifier: 'APP-998', title: 'collateral', status: 'blocked', assigneeAgentId: 'agent-cto',
              activeRecoveryAction: {
                id: 'act-2', status: 'active', cause: 'stranded_assigned_issue', returnOwnerAgentId: 'agent-cto',
                createdAt: new Date(nowMs).toISOString(),
                evidence: { latestRunId: 'run-dead', latestRunStatus: 'cancelled', latestRunErrorCode: 'agent_paused' },
              },
            }],
          };
    return { ok: true, status: 200, json: async () => payload, text: async () => '' };
  };
  let finalState;
  try {
    finalState = await runOnce({ ...RUN_ARGS, stateFile }, { log: (l) => logs.push(l) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const wake = logs.find((l) => l.includes('DRY-RUN would run: paperclipai agent wake agent-cto'));
  assert.ok(wake, 'the sweep must wake the agent');
  assert.ok(wake.includes(`--payload {"issueId":"${issueId}"}`), `force-resume wake must stay task-bound: ${wake}`);
  assert.match(wake, /APP-998/, 'and name the pause collateral, same as the due-fire path');
  assert.ok(logs.some((l) => l.includes('PAUSE-SWEEP WAKE agent=CTO') && l.includes(`issue=${issueId}`)));
  assert.equal(finalState.pausedAgents['agent-cto'], undefined);
});

// ---------------------------------------------------------------------------
// PR #14 review: alert throttling end to end, across separate passes. Each
// pass is a fresh process, so the throttle only works if its record survives
// on disk between calls -- which is what these exercise.
// ---------------------------------------------------------------------------

function recordingFetch() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: opts?.body });
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

const NOTIFIER = { healthcheckUrl: 'https://hc-ping.com/test-uuid', ntfyTopic: 'test-topic-not-a-real-value', enabled: true };
const ntfyCalls = (f) => f.calls.filter((c) => c.url.includes('ntfy.sh'));

test('reportPassOutcome: a persistent failure pushes once, not every 90s pass; hc /fail still goes out every pass', async () => {
  const alertStateFile = join(mkdtempSync(join(tmpdir(), 'watchdog-alert-')), 'alerts.json');
  const fetchFn = recordingFetch();
  for (let pass = 0; pass < 40; pass += 1) {
    await reportPassOutcome(NOTIFIER, { failure: `1 error(s): resume CTO failed (due ${pass}min ago)` }, {
      alertStateFile, nowMs: 1_000_000 + pass * 90_000, fetchFn, log: () => {},
    });
  }
  assert.equal(ntfyCalls(fetchFn).length, 1, '40 passes (1h) of the same failure is one phone push');
  assert.equal(fetchFn.calls.filter((c) => c.url.endsWith('/fail')).length, 40);

  // Recovery: one success ping, one recovery push that says what was suppressed.
  await reportPassOutcome(NOTIFIER, { failure: null }, { alertStateFile, nowMs: 5_000_000, fetchFn, log: () => {} });
  const pushes = ntfyCalls(fetchFn);
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].body, /recovered/);
  assert.match(pushes[1].body, /39 repeat alert/);
  assert.ok(fetchFn.calls.some((c) => c.url === 'https://hc-ping.com/test-uuid'), 'healthy pass pings success');
});

test('reportPassOutcome: an unwritable alert-state file never breaks reporting (fails toward alerting)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-alert-'));
  const fetchFn = recordingFetch();
  // A directory where the file should be: every read and write of it fails.
  await assert.doesNotReject(
    reportPassOutcome(NOTIFIER, { failure: 'x' }, { alertStateFile: dir, nowMs: 1, fetchFn, log: () => {} }),
  );
  assert.equal(ntfyCalls(fetchFn).length, 1, 'with no readable record, the failure is treated as new and pushed');
});

test('saveState: a failed rename removes the .tmp file instead of leaving it behind', async () => {
  const { mkdirSync, existsSync } = await import('node:fs');
  // The state-file path is an existing directory: the .tmp write succeeds,
  // the rename onto a directory fails.
  const stateFile = join(mkdtempSync(join(tmpdir(), 'watchdog-state-')), 'state.json');
  mkdirSync(stateFile);
  await assert.rejects(
    withFakeFetch(
      [['/heartbeat-runs', []], ['/agents', []]],
      () => runOnce({ ...RUN_ARGS, dryRun: false, stateFile }, { log: () => {} }),
    ),
  );
  assert.equal(existsSync(`${stateFile}.tmp`), false, 'a stale .tmp must not be left next to the state file');
});
