import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveDesiredHeartbeats,
  matchAgents,
  isInSync,
  assessWritability,
  containsRedaction,
  heartbeatPatchBody,
  PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS,
  REDACTION_SENTINEL,
} from '../lib/agent-heartbeat.mjs';

const SAMPLE = `
defaults:
  max_concurrent: 2
agents:
  - name: ceo
    heartbeat:
      timer: false
  - name: builder
    heartbeat:
      timer: false
      max_concurrent: 1
  - name: future
    heartbeat:
      timer: true
      max_concurrent: 3
`;

test('resolveDesiredHeartbeats falls back to defaults and honours per-agent overrides', () => {
  assert.deepEqual(resolveDesiredHeartbeats(SAMPLE), [
    { name: 'ceo', enabled: false, maxConcurrentRuns: 2 },
    { name: 'builder', enabled: false, maxConcurrentRuns: 1 },
    { name: 'future', enabled: true, maxConcurrentRuns: 3 },
  ]);
});

test('resolveDesiredHeartbeats refuses to default `timer` - an omission is an error, not a silent false', () => {
  assert.throws(
    () => resolveDesiredHeartbeats('defaults:\n  max_concurrent: 2\nagents:\n  - name: qa\n'),
    /no boolean heartbeat.timer/,
  );
});

test('resolveDesiredHeartbeats rejects a concurrency outside Paperclip\'s 1-50 range', () => {
  for (const bad of [0, 51]) {
    assert.throws(
      () => resolveDesiredHeartbeats(`agents:\n  - name: qa\n    heartbeat:\n      timer: false\n      max_concurrent: ${bad}\n`),
      /outside Paperclip's 1-50 range/,
      `max_concurrent: ${bad} should be rejected`,
    );
  }
});

test('the real config/agents.yaml keeps every agent off the timer and off the default-20 ceiling', () => {
  const rows = resolveDesiredHeartbeats(
    readFileSync(new URL('../../config/agents.yaml', import.meta.url), 'utf8'),
  );
  assert.equal(rows.length, 7);
  for (const { name, enabled, maxConcurrentRuns } of rows) {
    // The APP-39 ruling: Phase 1 is wake-driven, scheduled work arrives via
    // routines. Flipping an agent to `timer: true` must be a deliberate edit
    // that trips this test and gets argued in review, not a drive-by.
    assert.equal(enabled, false, `${name} has timer heartbeats on - see the APP-39 ruling in agents.yaml`);
    assert.ok(
      maxConcurrentRuns < PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS,
      `${name} is at ${maxConcurrentRuns}, back at or above Paperclip's undefended default of ${PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS}`,
    );
  }
  // Builder and QA hold a worktree / browser session: concurrency must stay 1.
  const byName = new Map(rows.map((r) => [r.name, r.maxConcurrentRuns]));
  assert.equal(byName.get('builder'), 1);
  assert.equal(byName.get('qa'), 1);
});

test('containsRedaction finds the sentinel at any depth', () => {
  assert.equal(containsRedaction({ a: { b: [{ c: REDACTION_SENTINEL }] } }), true);
  assert.equal(containsRedaction({ heartbeat: { enabled: false } }), false);
});

test('assessWritability refuses when runtimeConfig.heartbeat is not readable', () => {
  // Paperclip stamps a heartbeat block onto every agent at creation, so `{}`
  // means "this actor lacks the peer-config read grant", not "unset".
  for (const unreadable of [{}, null, undefined, { aiConnection: {} }]) {
    const { writable, reason } = assessWritability(unreadable);
    assert.equal(writable, false);
    assert.match(reason, /not readable by this actor/);
  }
});

test('assessWritability refuses a config carrying a redaction sentinel', () => {
  const { writable, reason } = assessWritability({
    heartbeat: { enabled: false, maxConcurrentRuns: 20 },
    aiConnection: { token: REDACTION_SENTINEL },
  });
  assert.equal(writable, false);
  assert.match(reason, /would persist the sentinel/);
});

test('assessWritability allows a fully readable config', () => {
  assert.deepEqual(
    assessWritability({ heartbeat: { enabled: false, maxConcurrentRuns: 20 } }),
    { writable: true, reason: null },
  );
});

test('matchAgents joins case-insensitively and marks a redacted peer unreadable', () => {
  const rows = matchAgents(
    [
      { name: 'cto', enabled: false, maxConcurrentRuns: 2 },
      { name: 'qa', enabled: false, maxConcurrentRuns: 1 },
    ],
    [
      { id: 'cto-id', name: 'CTO', runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 20 } } },
      { id: 'qa-id', name: 'QA', runtimeConfig: {} },
    ],
  );
  assert.equal(rows[0].id, 'cto-id');
  assert.equal(rows[0].currentEnabled, false);
  assert.equal(rows[0].currentMaxConcurrentRuns, 20);
  assert.equal(rows[0].writable, true);
  assert.equal(isInSync(rows[0]), false, 'concurrency 20 -> 2 is drift');

  assert.equal(rows[1].currentEnabled, null, 'unreadable must be null, never a guessed false');
  assert.equal(rows[1].currentMaxConcurrentRuns, null);
  assert.equal(rows[1].writable, false);
});

test('matchAgents treats an absent maxConcurrentRuns as Paperclip\'s default, not as unset', () => {
  const [row] = matchAgents(
    [{ name: 'cto', enabled: false, maxConcurrentRuns: 2 }],
    [{ id: 'cto-id', name: 'CTO', runtimeConfig: { heartbeat: { enabled: false } } }],
  );
  assert.equal(row.currentMaxConcurrentRuns, PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS);
});

test('matchAgents reports an unknown agent name instead of inventing an id', () => {
  const [row] = matchAgents([{ name: 'ghost', enabled: false, maxConcurrentRuns: 2 }], []);
  assert.equal(row.id, null);
});

test('isInSync requires both fields to match', () => {
  const base = { enabled: false, maxConcurrentRuns: 2, currentEnabled: false, currentMaxConcurrentRuns: 2 };
  assert.equal(isInSync(base), true);
  assert.equal(isInSync({ ...base, currentEnabled: true }), false);
  assert.equal(isInSync({ ...base, currentMaxConcurrentRuns: 20 }), false);
});

test('heartbeatPatchBody sends the COMPLETE runtimeConfig, since the server replaces it wholesale', () => {
  const live = {
    aiConnection: { kind: 'unmanaged' },
    heartbeat: { enabled: false, maxConcurrentRuns: 20, wakeOnDemand: true, intervalSec: 0 },
  };
  const body = heartbeatPatchBody(live, { enabled: false, maxConcurrentRuns: 1 });
  assert.deepEqual(body, {
    runtimeConfig: {
      // The sibling key survives: dropping it would disable the AI binding.
      aiConnection: { kind: 'unmanaged' },
      heartbeat: {
        enabled: false,
        maxConcurrentRuns: 1,
        // wakeOnDemand survives. It defaults to true when absent, but writing
        // it away and back is how a reconciler accidentally kills every
        // non-timer wake in the company.
        wakeOnDemand: true,
        intervalSec: 0,
      },
    },
  });
  assert.equal('replaceRuntimeConfig' in body, false);
});

test('heartbeatPatchBody refuses to build a blind write', () => {
  assert.throws(
    () => heartbeatPatchBody({}, { enabled: false, maxConcurrentRuns: 1 }),
    /refusing to build a wholesale write/,
  );
  assert.throws(
    () => heartbeatPatchBody(
      { heartbeat: { enabled: false }, aiConnection: REDACTION_SENTINEL },
      { enabled: false, maxConcurrentRuns: 1 },
    ),
    /refusing to build a wholesale write/,
  );
});
