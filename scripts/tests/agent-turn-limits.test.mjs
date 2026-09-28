import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDesiredLimits, matchAgents, turnLimitPatchBody } from '../lib/agent-turn-limits.mjs';

test('resolveDesiredLimits falls back to defaults and honours per-agent overrides', () => {
  const limits = resolveDesiredLimits(`
defaults:
  max_turns_per_run: 40
agents:
  - name: ceo
    max_turns_per_run: 40
  - name: builder
    max_turns_per_run: 60
  - name: qa
`);
  assert.deepEqual(limits, [
    { name: 'ceo', maxTurnsPerRun: 40 },
    { name: 'builder', maxTurnsPerRun: 60 },
    { name: 'qa', maxTurnsPerRun: 40 },
  ]);
});

test('resolveDesiredLimits rejects a missing limit rather than guessing one', () => {
  assert.throws(
    () => resolveDesiredLimits('agents:\n  - name: qa\n'),
    /no usable max_turns_per_run/,
  );
});

test('the real config/agents.yaml leaves no agent at the failing 10-turn cap', () => {
  const limits = resolveDesiredLimits(readFileSync(new URL('../../config/agents.yaml', import.meta.url), 'utf8'));
  assert.equal(limits.length, 7);
  for (const { name, maxTurnsPerRun } of limits) {
    assert.ok(maxTurnsPerRun >= 30, `${name} is at ${maxTurnsPerRun}, below the APP-29 floor`);
  }
});

test('matchAgents joins case-insensitively and treats a redacted config as unknown', () => {
  const rows = matchAgents(
    [{ name: 'cto', maxTurnsPerRun: 40 }, { name: 'qa', maxTurnsPerRun: 40 }],
    [
      { id: 'cto-id', name: 'CTO', adapterConfig: { maxTurnsPerRun: 40 } },
      { id: 'qa-id', name: 'QA', adapterConfig: {} },
    ],
  );
  assert.deepEqual(rows, [
    { name: 'cto', maxTurnsPerRun: 40, id: 'cto-id', current: 40 },
    { name: 'qa', maxTurnsPerRun: 40, id: 'qa-id', current: null },
  ]);
});

test('matchAgents reports an unknown agent name instead of inventing an id', () => {
  const [row] = matchAgents([{ name: 'ghost', maxTurnsPerRun: 40 }], []);
  assert.equal(row.id, null);
});

test('turnLimitPatchBody sends only the merging field, never replaceAdapterConfig', () => {
  const body = turnLimitPatchBody(40);
  assert.deepEqual(body, { adapterConfig: { maxTurnsPerRun: 40 } });
  assert.equal('replaceAdapterConfig' in body, false);
});
