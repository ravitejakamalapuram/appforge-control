// APP-103 / DEBT-0003: what the watchdog does when the `paperclipai` CLI
// itself fails.
//
// This is the failure mode the issue calls "the `resume` call itself fails
// persistently", and it used to be worse than it looked. `runOnce` awaited
// each pause/resume/wake with no try/catch, so the FIRST failing call threw
// straight out of the pass. That meant two things at once: nothing after it
// ran (a second parked agent stayed parked because the first one's resume
// failed), and `saveState` was never reached, so the pass threw away its own
// bookkeeping. The only symptom was a line in a log nobody reads.
//
// These tests run in NON-dry-run mode against a `PAPERCLIPAI_BIN` that does
// not exist, so every CLI call really does fail (ENOENT) — no mocking of the
// script's internals. That env var is read at module load, so it is set here
// before the dynamic import below; `node --test` gives each test file its own
// process, so this cannot leak into the other suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.PAPERCLIPAI_BIN = join(tmpdir(), 'definitely-not-a-real-paperclipai-binary');

const { runOnce } = await import('../quota-retry-watchdog.mjs');
const { emptyState, setPendingAction, recordWatchdogPause } = await import('../lib/quota-retry-watchdog.mjs');

function withFakeFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [match, payload] of routes) {
      if (url.includes(match)) return { ok: true, status: 200, json: async () => payload, text: async () => '' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function seed(mutate) {
  const state = emptyState();
  mutate(state);
  const stateFile = join(mkdtempSync(join(tmpdir(), 'watchdog-resilience-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));
  return stateFile;
}

const BASE = { apiBase: 'http://fake', companyId: 'fake-co', apiKey: null, claudeConfigDir: '/tmp', lookbackMinutes: 180, dryRun: false };

test('a failing resume for one agent does not stop the pass from resuming the next one', async () => {
  // Due a second ago: the ordinary resume path fires, but the pause is not
  // yet overdue enough for the sweep to also act, so each agent is attempted
  // exactly once and the error count is unambiguous.
  const dueMs = Date.now() - 1000;
  const stateFile = seed((state) => {
    setPendingAction(state, 'agent-a', { kind: 'quota', runId: 'run-a', scheduledAtMs: dueMs, reason: 'r-a' });
    setPendingAction(state, 'agent-b', { kind: 'quota', runId: 'run-b', scheduledAtMs: dueMs, reason: 'r-b' });
    recordWatchdogPause(state, 'agent-a', { pausedAtMs: dueMs - 60_000, scheduledResumeAtMs: dueMs, kind: 'quota', runId: 'run-a' });
    recordWatchdogPause(state, 'agent-b', { pausedAtMs: dueMs - 60_000, scheduledResumeAtMs: dueMs, kind: 'quota', runId: 'run-b' });
  });

  const errors = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [
        { id: 'agent-a', name: 'A', status: 'paused' },
        { id: 'agent-b', name: 'B', status: 'paused' },
      ]],
    ],
    () => runOnce({ ...BASE, stateFile }, { log: () => {}, recordError: (m) => errors.push(m) }),
  );

  // Both were attempted. Before APP-103 the first ENOENT threw out of
  // runOnce and agent-b was never touched.
  assert.equal(errors.length, 2, `expected one recorded error per agent, got: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => e.includes('resume A')));
  assert.ok(errors.some((e) => e.includes('resume B')));

  // Both stay pending and both keep their pause claim: the next pass must
  // try again, and the claim is the only thing that remembers they are
  // parked.
  assert.ok(finalState.pendingActions['agent-a'] && finalState.pendingActions['agent-b']);
  assert.ok(finalState.pausedAgents['agent-a'] && finalState.pausedAgents['agent-b']);
});

test('a pass with failing CLI calls still persists its state file', async () => {
  const dueMs = Date.now() - 1000;
  const stateFile = seed((state) => {
    setPendingAction(state, 'agent-a', { kind: 'quota', runId: 'run-a', scheduledAtMs: dueMs, reason: 'r-a' });
    recordWatchdogPause(state, 'agent-a', { pausedAtMs: dueMs - 60_000, scheduledResumeAtMs: dueMs, kind: 'quota', runId: 'run-a' });
  });

  await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-a', name: 'A', status: 'paused' }]],
    ],
    () => runOnce({ ...BASE, stateFile }, { log: () => {}, recordError: () => {} }),
  );

  assert.ok(existsSync(stateFile));
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.pausedAgents['agent-a'], 'the pause claim must survive to the next pass');
  assert.ok(!existsSync(`${stateFile}.tmp`), 'the atomic-write temp file is renamed away, not left behind');
});

test('a failing force-resume is reported as an error, so the liveness alert fires on a genuinely stuck agent', async () => {
  const nowMs = Date.now();
  const stateFile = seed((state) => {
    recordWatchdogPause(state, 'agent-a', {
      pausedAtMs: nowMs - 3 * 3_600_000,
      scheduledResumeAtMs: nowMs - 40 * 60_000,
      kind: 'quota',
      runId: 'run-stuck',
    });
  });

  const errors = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', []],
      ['/agents', [{ id: 'agent-a', name: 'A', status: 'paused' }]],
    ],
    () => runOnce({ ...BASE, stateFile }, { log: () => {}, recordError: (m) => errors.push(m) }),
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /FORCE-RESUME of paused agent A failed/);
  assert.ok(finalState.pausedAgents['agent-a'], 'the claim is kept so the next pass retries');
});

test('a failing pause leaves the run unhandled, so the next pass retries it instead of losing the failure', async () => {
  const nowMs = Date.now();
  const iso = new Date(nowMs).toISOString();
  const resetText = (() => {
    const t = nowMs + 2 * 3_600_000;
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Calcutta', hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(t))
      .toLowerCase()
      .replace(/\s+/g, '');
    return `Claude run failed: subtype=success: You've hit your session limit · resets ${f} (Asia/Calcutta)`;
  })();

  const stateFile = seed(() => {});
  const errors = [];
  const finalState = await withFakeFetch(
    [
      ['/heartbeat-runs', [
        { id: 'run-p', agentId: 'agent-a', status: 'failed', errorCode: 'provider_quota', error: resetText, createdAt: iso, startedAt: iso, finishedAt: iso, usageJson: null },
      ]],
      ['/agents', [{ id: 'agent-a', name: 'A', status: 'idle' }]],
    ],
    () => runOnce({ ...BASE, stateFile }, { log: () => {}, recordError: (m) => errors.push(m) }),
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0], /pause A \(quota run=run-p\) failed/);
  assert.equal(finalState.handledRunIds['run-p'], undefined, 'a failure we could not act on must not be marked handled');
  assert.equal(finalState.pendingActions['agent-a'], undefined, 'and no resume is scheduled for a pause that never happened');
  assert.equal(finalState.pausedAgents['agent-a'], undefined, 'nor a pause claimed');
});
