// Tests for `appforge metrics digest` (APP-43).
//
// Every test here is about an HONEST READING, not a formatting detail. The
// digest's whole value is that the CEO can trust a zero, and each of these
// pins one way a zero could lie.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnomalies, buildApprovals, buildDigest, buildIncidents, buildPortfolio, buildRuns,
  buildSpend, buildStoreMetrics,
} from '../lib/metrics-digest.mjs';

const NOW = new Date('2026-09-29T12:00:00Z');
const SINCE = new Date('2026-09-28T12:00:00Z');
const BUDGETS = { monthly_cents: { company: 10000, cto: 1500, analyst: 400 }, alerts: { soft_pct: 80, hard_pct: 100 } };

// --- 1. spend ---------------------------------------------------------------

test('a subscription-only period reports 0% of cap WITH the caveat that makes it readable', () => {
  const spend = buildSpend({
    summary: { spendCents: 0, budgetCents: 10000 },
    byAgent: [{ agentName: 'CTO', costCents: 0, apiRunCount: 0, subscriptionRunCount: 12, outputTokens: 3_683_831, inputTokens: 100, cachedInputTokens: 200 }],
    budgets: BUDGETS,
  });
  assert.equal(spend.utilization, 0);
  assert.equal(spend.metered, false);
  // The number alone is a vanity metric. The caveat is the deliverable.
  assert.match(spend.metering_note, /NOT the instrument measuring this consumption/);
  assert.equal(spend.total_output_tokens, 3_683_831);
});

test('an agent with no budgets.yaml entry is named, not given a default budget', () => {
  const spend = buildSpend({
    summary: { spendCents: 0, budgetCents: 10000 },
    byAgent: [{ agentName: 'Eval', costCents: 50, apiRunCount: 3 }],
    budgets: BUDGETS,
  });
  assert.equal(spend.agents[0].budget_cents, null);
  assert.equal(spend.agents[0].utilization, null, 'utilization against an unknown budget must be null, never 0');
  assert.deepEqual(spend.unbudgeted_agents, ['Eval']);
});

// --- 2. runs ----------------------------------------------------------------

test('errorCode and scheduledRetryReason are DIFFERENT runs and are not merged', () => {
  // This is the real shape from the control plane: a run that died on quota
  // while scheduling a turn-ceiling continuation for its successor. Matching
  // /max_turns/ across both fields counted this as an APP-29 exhaustion.
  const runs = buildRuns({
    runs: [
      { id: 'a', createdAt: '2026-09-29T08:00:00Z', status: 'failed', errorCode: 'provider_quota', scheduledRetryReason: 'max_turns_continuation' },
      { id: 'b', createdAt: '2026-09-29T09:00:00Z', status: 'failed', errorCode: 'max_turns_exhausted' },
    ],
    since: SINCE, now: NOW,
  });
  assert.deepEqual(runs.max_turns.map((r) => r.run_id), ['b'], 'only a real exhaustion is an APP-29 event');
  assert.equal(runs.max_turns_continuations, 1, 'the continuation is counted, separately');
  assert.equal(runs.by_error_code.provider_quota, 1);
});

test('the error-code distribution is reported, because one failure rate hides which mode dominates', () => {
  const runs = buildRuns({
    runs: [
      { id: 'a', createdAt: '2026-09-29T08:00:00Z', status: 'failed', errorCode: 'provider_quota' },
      { id: 'b', createdAt: '2026-09-29T08:00:00Z', status: 'failed', errorCode: 'provider_quota' },
      { id: 'c', createdAt: '2026-09-29T08:00:00Z', status: 'succeeded' },
    ],
    since: SINCE, now: NOW,
  });
  assert.equal(runs.by_error_code.provider_quota, 2);
  assert.equal(runs.failure_rate, 2 / 3);
});

test('a run killed while waiting on a background task is named, not just counted as a failure (APP-338)', () => {
  // The claude_local adapter SIGTERMs the CLI 5s after its final result if a
  // Monitor / run_in_background task keeps it alive; the CLI exits 143 and the
  // server records `adapter_failed` with the bare "Adapter failed". The only
  // field that tells it apart from a real adapter failure is livenessReason.
  const runs = buildRuns({
    runs: [
      { id: 'bg', agentId: 'cto', createdAt: '2026-09-29T08:00:00Z', status: 'failed', errorCode: 'adapter_failed', livenessReason: 'unmanaged background task stopped; no durable live path' },
      { id: 'real', createdAt: '2026-09-29T08:00:00Z', status: 'failed', errorCode: 'adapter_failed', livenessReason: null },
    ],
    since: SINCE, now: NOW,
  });
  assert.deepEqual(runs.background_wait_killed.map((r) => r.run_id), ['bg'], 'only the background-kill run is in the bucket');
  assert.equal(runs.failures.length, 2, 'it stays a failure: the platform recorded it as one');
  const a = buildAnomalies({ ...QUIET, runs: { ...QUIET.runs, background_wait_killed: runs.background_wait_killed } });
  assert.ok(a.flags.some((f) => f.check === 'background_wait_killed'), 'and it raises its own flag pointing at rule 13');
});

test('a run outside the window is excluded, and an empty window has a NULL failure rate not 0', () => {
  const runs = buildRuns({ runs: [{ id: 'old', createdAt: '2026-09-01T00:00:00Z', status: 'failed' }], since: SINCE, now: NOW });
  assert.equal(runs.total, 0);
  assert.equal(runs.failure_rate, null, '0/0 is not 0% failure — it is unmeasured');
});

// --- 3. approvals -----------------------------------------------------------

test('only open approvals are queued, sorted oldest first', () => {
  const a = buildApprovals({
    approvals: [
      { id: 'x', type: 't', status: 'approved', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'y', type: 't', status: 'pending', createdAt: '2026-09-20T00:00:00Z' },
      { id: 'z', type: 't', status: 'pending', createdAt: '2026-09-28T00:00:00Z' },
    ],
    now: NOW,
  });
  assert.equal(a.open, 2);
  assert.deepEqual(a.rows.map((r) => r.id), ['y', 'z']);
  assert.equal(a.oldest_age_days, 9);
});

// --- 4. incidents -----------------------------------------------------------

test('zero incidents on a convention NOTHING writes says so, instead of claiming all-clear', () => {
  const inc = buildIncidents({ issues: [{ identifier: 'APP-1', title: 't', status: 'todo', labels: [{ name: 'type:approval' }] }], now: NOW });
  assert.equal(inc.open, 0);
  assert.equal(inc.convention_in_use, false);
  assert.match(inc.convention_note, /NOT ONE carries the `type:incident` label/);
});

test('once the convention IS used, a zero is a real all-clear and carries no caveat', () => {
  const inc = buildIncidents({
    issues: [{ identifier: 'APP-1', title: 't', status: 'done', labels: [{ name: 'type:incident' }, { name: 'sev1' }] }],
    now: NOW,
  });
  assert.equal(inc.open, 0, 'a done incident is not open');
  assert.equal(inc.convention_in_use, true);
  assert.equal(inc.convention_note, null);
});

test('an open incident carries its SEV and age; an unlabelled one is UNLABELLED, not SEV4', () => {
  const inc = buildIncidents({
    issues: [
      { identifier: 'APP-2', title: 'a', status: 'in_progress', createdAt: '2026-09-27T12:00:00Z', labels: [{ name: 'type:incident' }, { name: 'SEV0' }] },
      { identifier: 'APP-3', title: 'b', status: 'todo', createdAt: '2026-09-29T12:00:00Z', labels: [{ name: 'type:incident' }] },
    ],
    now: NOW,
  });
  assert.equal(inc.open, 2);
  assert.deepEqual(inc.by_sev, { SEV0: 1, UNLABELLED: 1 });
  assert.equal(inc.rows[0].sev, 'SEV0');
  assert.equal(inc.rows[0].age_days, 2);
});

// --- 5. store metrics -------------------------------------------------------

test('on a day with no fresh export the digest states the last as_of and emits NO figure', () => {
  const store = buildStoreMetrics({
    manifest: [{ item_id: 'jw', as_of: '2026-09-20', recorded_at: '2026-09-20T00:00:00Z', metrics: { cws_weekly_users: 5 } }],
    since: SINCE, now: NOW,
  });
  assert.equal(store.fresh_import_today, false);
  assert.equal(store.message, 'no new store data (last import as_of 2026-09-20)');
  assert.deepEqual(store.deltas, [], 'restating last week\'s 5 users as today\'s is the failure this prevents');
});

test('a delta is only emitted against a real prior reading; the first reading has a NULL delta', () => {
  const store = buildStoreMetrics({
    manifest: [{ item_id: 'jw', as_of: '2026-09-29', recorded_at: '2026-09-29T06:00:00Z', metrics: { cws_weekly_users: 5 } }],
    since: SINCE, now: NOW,
  });
  assert.equal(store.fresh_import_today, true);
  assert.equal(store.deltas[0].delta, null, 'a first reading is not a +5 delta from zero');
  assert.equal(store.deltas[0].prior_as_of, null);
});

test('a second reading on the same surface DOES produce a delta', () => {
  const store = buildStoreMetrics({
    manifest: [
      { item_id: 'jw', as_of: '2026-09-22', recorded_at: '2026-09-22T06:00:00Z', metrics: { cws_weekly_users: 3 } },
      { item_id: 'jw', as_of: '2026-09-29', recorded_at: '2026-09-29T06:00:00Z', metrics: { cws_weekly_users: 5 } },
    ],
    since: SINCE, now: NOW,
  });
  assert.equal(store.deltas[0].delta, 2);
  assert.equal(store.deltas[0].prior_as_of, '2026-09-22');
});

// --- 6. anomalies -----------------------------------------------------------

const QUIET = {
  spend: { agents: [], utilization: 0, metered: true, cap_cents: 10000, unbudgeted_agents: [] },
  runs: { max_turns: [], max_turns_continuations: 0, failures: [], escalations: [], background_wait_killed: [], total: 3 },
  approvals: { oldest_age_days: 0, rows: [] },
  incidents: { rows: [] },
  store: { fresh_import_today: true, last_import_as_of: '2026-09-29' },
  portfolio: { available: true, refused: false, actionable: [] },
  budgets: BUDGETS,
  now: NOW,
};

test('a quiet day raises NO flag — Analyst\'s 06:30 wake must be able to stay silent', () => {
  const a = buildAnomalies(QUIET);
  assert.equal(a.any, false);
  assert.deepEqual(a.flags, []);
});

test('a check that cannot be computed is `unavailable`, never a silent absence of a flag', () => {
  const a = buildAnomalies({ ...QUIET, spend: { ...QUIET.spend, metered: false } });
  assert.equal(a.any, false, 'an uncomputable check does not fire the wake');
  assert.ok(a.unavailable.some((u) => u.check === 'company_budget'), 'but it IS reported, so the gate is not quietly starved');
});

test('a missing alerts.soft_pct makes the budget check unavailable, not silently 80', () => {
  const a = buildAnomalies({ ...QUIET, budgets: { monthly_cents: { company: 10000 } } });
  assert.ok(a.unavailable.some((u) => u.check === 'agent_budget'));
});

test('an agent past hard_pct is a breach, distinct from a warn', () => {
  const a = buildAnomalies({
    ...QUIET,
    spend: { ...QUIET.spend, agents: [{ agent: 'Analyst', utilization: 1.2, budget_cents: 400 }] },
  });
  assert.equal(a.flags[0].severity, 'breach');
  assert.match(a.flags[0].detail, /past hard_pct 100/);
});

test('the evaluator refusing to emit a verdict is itself a flag, not a missing section', () => {
  const a = buildAnomalies({ ...QUIET, portfolio: { available: false, refused: true, reason: 'bad inputs', actionable: [] } });
  assert.ok(a.flags.some((f) => f.check === 'portfolio_refused'));
});

test('an actionable §22.1 outcome reaches the CEO as a flag', () => {
  const a = buildAnomalies({
    ...QUIET,
    portfolio: { available: true, refused: false, actionable: [{ product: 'json-workbench', outcome: 'SUNSET', reason_codes: ['r1'] }] },
  });
  assert.match(a.flags.find((f) => f.check === 'portfolio_outcome').detail, /json-workbench → SUNSET/);
});

// --- 7. portfolio -----------------------------------------------------------

test('a refusal is REPORTED with its reason, not collapsed to "unavailable"', () => {
  const p = buildPortfolio({ error: 'invtrack: no `store_item_status` key' });
  assert.equal(p.refused, true);
  assert.match(p.reason, /store_item_status/);
  assert.match(p.note, /designed behaviour for unjustifiable inputs/);
});

test('not_applicable and insufficient_data are tallied separately and NEITHER is actionable', () => {
  const p = buildPortfolio({
    results: [
      { product: 'a', outcome: 'not_applicable', reason_codes: ['first_published_null'] },
      { product: 'b', outcome: 'insufficient_data', blocking: [{ rule_id: 'R1' }] },
      { product: 'c', outcome: 'CONTINUE' },
    ],
  });
  assert.deepEqual(p.by_outcome, { not_applicable: 1, insufficient_data: 1, CONTINUE: 1 });
  assert.deepEqual(p.actionable, [], 'none of these three authorizes or stops work');
  assert.deepEqual(p.rows[1].blocking_rules, ['R1']);
});

// --- assembly ---------------------------------------------------------------

test('buildDigest ships all seven sections even when 5-7 have nothing to report', () => {
  const d = buildDigest({
    now: NOW, since: SINCE, budgets: BUDGETS,
    summary: { spendCents: 0, budgetCents: 10000 }, byAgent: [], approvals: [], issues: [], runs: [],
    manifest: [], portfolio: {},
  });
  for (const k of ['spend', 'runs', 'approvals', 'incidents', 'store', 'anomalies', 'portfolio']) {
    assert.ok(k in d, `section ${k} must be present even when empty — a silently absent section reads as a healthy one`);
  }
  assert.equal(d.store.message, 'no store export has ever landed — no store data exists to delta against');
  assert.equal(d.portfolio.available, false);
});
