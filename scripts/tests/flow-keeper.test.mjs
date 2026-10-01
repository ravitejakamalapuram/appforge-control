import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsToResume, decide, wakeBody, wakeKey, pruneKicks, STALE_MS, BLOCKED_STALE_MS, COOLDOWN_MS, MAX_KICKS, WINDOW_MS } from '../lib/flow-keeper.mjs';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const agent = { id: 'a1', name: 'Builder', status: 'idle' };
const issue = (o = {}) => ({ id: 'i1', identifier: 'APP-1', status: 'todo', assigneeAgentId: 'a1', updatedAt: ago(30 * MIN), lastActivityAt: ago(30 * MIN), activeRun: null,
  reviewAttention: { state: 'none' }, blockerAttention: { unresolvedBlockerCount: 0, blockingTreeLive: false }, ...o });
const run = (o = {}) => decide({ issue: issue(), agent, busyAgents: new Set(), lastComment: null, kicks: [], now: NOW, ...o });

test('an assigned todo that nobody started after the idle threshold is woken', () => {
  assert.equal(run().action, 'wake');
  assert.equal(run({ issue: issue({ updatedAt: ago(STALE_MS - MIN), lastActivityAt: ago(STALE_MS - MIN) }) }).action, 'none', 'still fresh');
});

test('an agent that is already working on it is left alone', () => {
  assert.equal(run({ busyAgents: new Set(['a1']) }).action, 'none');
  assert.equal(run({ issue: issue({ activeRun: { status: 'running' } }) }).action, 'none');
});

test('in_progress with no run is woken; a fresh comment resets the clock', () => {
  assert.equal(run({ issue: issue({ status: 'in_progress' }) }).action, 'wake');
  assert.equal(run({ issue: issue({ status: 'in_progress' }), lastComment: { authorType: 'agent', body: 'working', createdAt: ago(2 * MIN) } }).action, 'none');
});

test('in_review with no owner of the next step is woken; one covered by a card, reviewer or monitor is not', () => {
  assert.equal(run({ issue: issue({ status: 'in_review', reviewAttention: { state: 'stalled' } }) }).action, 'wake');
  assert.equal(run({ issue: issue({ status: 'in_review', reviewAttention: { state: 'covered' } }) }).action, 'none');
});

test('blocked: a live blocker holds it, no blocker for 30 minutes means a disposition is needed', () => {
  assert.equal(run({ issue: issue({ status: 'blocked', blockerAttention: { unresolvedBlockerCount: 1, blockingTreeLive: true } }) }).action, 'none');
  assert.equal(run({ issue: issue({ status: 'blocked' }) }).action, 'wake');
  assert.equal(run({ issue: issue({ status: 'blocked', updatedAt: ago(BLOCKED_STALE_MS - MIN), lastActivityAt: ago(BLOCKED_STALE_MS - MIN) }) }).action, 'none');
});

test('waiting on the board assistant is reported, never woken (waking an agent cannot help)', () => {
  const r = run({ lastComment: { authorType: 'agent', body: "@board's assistant please push the workflow file", createdAt: ago(20 * MIN) } });
  assert.equal(r.action, 'assistant');
});

test('a person-owned or unassigned issue is not the keeper\'s business, a paused agent is not woken', () => {
  assert.equal(run({ issue: issue({ assigneeAgentId: null }) }).action, 'none');
  assert.equal(run({ agent: { ...agent, status: 'paused' } }).action, 'none');
});

test('nudges are rate limited: cooldown between them, and past the budget it ESCALATES instead of looping', () => {
  assert.equal(run({ kicks: [NOW - 5 * MIN] }).action, 'none', 'cooldown');
  assert.equal(run({ kicks: [NOW - COOLDOWN_MS - MIN] }).action, 'wake');
  const spent = Array.from({ length: MAX_KICKS }, (_, i) => NOW - (i + 1) * (COOLDOWN_MS + MIN));
  assert.equal(run({ kicks: spent }).action, 'escalate');
  assert.equal(run({ kicks: spent.map((t) => t - WINDOW_MS) }).action, 'wake', 'old nudges expire');
});

test('errored agents resume only for transient causes and within the hourly budget', () => {
  const agents = [
    { id: 'x', name: 'QA', status: 'error', errorReason: 'Adapter failed' },
    { id: 'y', name: 'CTO', status: 'error', errorReason: "github-app-token: repo(s) not in this App's installed_on list" },
    { id: 'z', name: 'CEO', status: 'idle' },
  ];
  assert.deepEqual(agentsToResume({ agents, now: NOW }).map((a) => a.name), ['QA']);
  assert.deepEqual(agentsToResume({ agents, resumes: { x: [NOW - 5 * MIN, NOW - 9 * MIN] }, now: NOW }), [], 'budget spent');
});

test('the wake carries the issue, a stable idempotency key per bucket, and tells the agent not to end unchanged', () => {
  const b = wakeBody(issue(), 'todo: idle', NOW);
  assert.equal(b.payload.issueId, 'i1');
  assert.equal(b.source, 'automation');
  assert.match(b.reason, /Do not end the run with the issue in the same state/);
  assert.equal(wakeKey('i1', NOW), wakeKey('i1', NOW + MIN), 'same bucket, same key: no double wake');
  assert.notEqual(wakeKey('i1', NOW), wakeKey('i1', NOW + COOLDOWN_MS));
  assert.deepEqual(pruneKicks({ i1: [NOW - WINDOW_MS - 1, NOW - MIN] }, NOW), { i1: [NOW - MIN] });
});
