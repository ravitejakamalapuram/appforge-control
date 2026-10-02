import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWait, cwsReviewState, statusMdAgeMs, prMergedState, ciGreenState, decideWait, staleBlock, MIN_RECHECK_MS } from '../lib/waits.mjs';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const MIN = 60000;

test('parseWait reads the newest WAIT line and its arguments', () => {
  const w = parseWait('old\nWAIT: check=pr_merged url=https://x/pull/1 recheck=15m\nnote\nWAIT: check=cws_review_clear item=abc recheck=2h deadline=2026-10-09');
  assert.equal(w.check, 'cws_review_clear');
  assert.equal(w.args.item, 'abc');
  assert.equal(w.recheckMs, 2 * 3600000);
  assert.equal(w.deadlineMs, Date.parse('2026-10-09T23:59:59Z'));
});
test('parseWait rejects unknown checks and missing arguments instead of ignoring them', () => {
  assert.ok(parseWait('WAIT: check=magic x=1').invalid);
  assert.ok(parseWait('WAIT: check=pr_merged').invalid);
  assert.equal(parseWait('nothing here'), null);
  assert.equal(parseWait(undefined), null);
});
test('recheck never goes below the floor, and defaults to an hour', () => {
  assert.equal(parseWait('WAIT: check=ci_green url=u recheck=1m').recheckMs, MIN_RECHECK_MS);
  assert.equal(parseWait('WAIT: check=ci_green url=u').recheckMs, 3600000);
});
const md = (row, upd = '2026-10-02T11:50:00Z') => `_Updated ${upd} by [d](x)._\n| S | CWS | \`item1\` | PUBLISHED (1.2.2) | ${row} |`;
test('cws review: pending is not clear, a missing pending cell is clear, an unknown item is unknown', () => {
  assert.equal(cwsReviewState(md('PENDING_REVIEW (1.2.2 @ 100%)'), 'item1').clear, false);
  assert.equal(cwsReviewState(md(''), 'item1').clear, true);
  assert.equal(cwsReviewState(md(''), 'other').known, false);
});
test('dashboard age is measured from its Updated stamp; unreadable means stale', () => {
  assert.equal(statusMdAgeMs(md('', '2026-10-02T11:50:00Z'), NOW), 10 * MIN);
  assert.equal(statusMdAgeMs('garbage', NOW), Infinity);
});
test('pr and ci states', () => {
  assert.equal(prMergedState({ state: 'OPEN' }).clear, false);
  assert.equal(prMergedState({ state: 'MERGED' }).clear, true);
  assert.equal(prMergedState(null).known, false);
  assert.equal(ciGreenState({ statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] }).clear, false);
  assert.match(ciGreenState({ statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }] }).detail, /failures: a/);
  assert.equal(ciGreenState({ statusCheckRollup: [] }).known, false);
});
test('decideWait: check when due, none when fresh, overdue past the deadline, invalid is reported', () => {
  const wait = parseWait('WAIT: check=pr_merged url=u recheck=15m deadline=2026-10-09');
  assert.equal(decideWait({ wait, lastCheckedMs: NOW - 5 * MIN, now: NOW }).action, 'none');
  assert.equal(decideWait({ wait, lastCheckedMs: NOW - 20 * MIN, now: NOW }).action, 'check');
  assert.equal(decideWait({ wait, now: Date.parse('2026-10-10T00:00:00Z') }).action, 'overdue');
  assert.equal(decideWait({ wait: parseWait('WAIT: check=nope'), now: NOW }).action, 'invalid');
});
test('staleBlock: only when every blocker is finished', () => {
  assert.equal(staleBlock({ status: 'blocked', blockedBy: [{ status: 'done' }, { status: 'cancelled' }] }), true);
  assert.equal(staleBlock({ status: 'blocked', blockedBy: [{ status: 'done' }, { status: 'in_progress' }] }), false);
  assert.equal(staleBlock({ status: 'blocked', blockedBy: [] }), false);
  assert.equal(staleBlock({ status: 'todo', blockedBy: [{ status: 'done' }] }), false);
});
test('staleBlock can look blockers up by id when the row carries no status', () => {
  const st = { a: 'done', b: 'todo' };
  assert.equal(staleBlock({ status: 'blocked', blockedBy: [{ id: 'a' }] }, (x) => st[x.id]), true);
  assert.equal(staleBlock({ status: 'blocked', blockedBy: [{ id: 'a' }, { id: 'b' }] }, (x) => st[x.id]), false);
});
