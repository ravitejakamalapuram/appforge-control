import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRun,
  runUsage,
  summarizeByAgent,
  summarizeByOutcome,
  burnRate,
  peakConcurrency,
  quotaWaste,
  buildBurnReport,
} from '../lib/session-burn.mjs';

/** Minimal run record in the shape /api/companies/{id}/heartbeat-runs returns. */
function run(overrides = {}) {
  return {
    agentId: 'agent-a',
    status: 'succeeded',
    errorCode: null,
    startedAt: '2026-09-28T03:00:00.000Z',
    finishedAt: '2026-09-28T03:05:00.000Z',
    scheduledRetryAt: null,
    scheduledRetryReason: null,
    usageJson: { inputTokens: 1000, outputTokens: 100, costUsd: 1 },
    ...overrides,
  };
}

test('a ceiling death is classified by its errorCode, not flattened into "failed"', () => {
  // The whole point of APP-45 is that these two need opposite responses.
  assert.equal(classifyRun(run({ status: 'failed', errorCode: 'provider_quota' })), 'provider_quota');
  assert.equal(
    classifyRun(run({ status: 'failed', errorCode: 'max_turns_exhausted' })),
    'max_turns_exhausted',
  );
  assert.equal(classifyRun(run()), 'succeeded');
  // No errorCode and not succeeded => the status is the most specific thing known.
  assert.equal(classifyRun(run({ status: 'running', errorCode: null })), 'running');
});

test('a run with no usage recorded counts as zero, not as a crash', () => {
  assert.deepEqual(runUsage(run({ usageJson: null })), {
    inputTokens: 0,
    outputTokens: 0,
    imputedUsd: 0,
  });
});

test('an unmapped agentId stays in the totals under its raw id', () => {
  // A run we cannot attribute still consumed the shared budget. Dropping it
  // would understate the company total, which is the number that matters.
  const byAgent = summarizeByAgent([run({ agentId: 'ghost' })], { 'agent-a': 'CTO' });
  assert.equal(byAgent.ghost.runs, 1);
  assert.equal(byAgent.ghost.inputTokens, 1000);
});

test('consumption is attributed to the outcome that explains it', () => {
  const byOutcome = summarizeByOutcome([
    run({ status: 'failed', errorCode: 'provider_quota', usageJson: { inputTokens: 90000, outputTokens: 0, costUsd: 2 } }),
    run({ status: 'failed', errorCode: 'provider_quota', usageJson: { inputTokens: 10000, outputTokens: 0, costUsd: 1 } }),
    run(),
  ]);
  assert.equal(byOutcome.provider_quota.runs, 2);
  assert.equal(byOutcome.provider_quota.inputTokens, 100_000);
  assert.equal(byOutcome.provider_quota.imputedUsd, 3);
  assert.equal(byOutcome.succeeded.runs, 1);
});

test('burnRate refuses to invent a window, because a burst is not a rate', () => {
  // Inferring the window from the runs themselves would score ten runs in five
  // minutes as a sustained pace. The caller has to state the period.
  assert.throws(() => burnRate([run()], 0), /positive number/);
  assert.throws(() => burnRate([run()], undefined), /positive number/);
});

test('burnRate divides by the stated window', () => {
  const rate = burnRate([run(), run()], 2);
  assert.equal(rate.inputTokens, 2000);
  assert.equal(rate.inputTokensPerHour, 1000);
  assert.equal(rate.imputedUsdPerHour, 1);
});

test('peak concurrency is reported company-wide, not only per agent', () => {
  // The finding this guards: per-agent ceilings cannot bound a shared budget.
  // Three agents at one concurrent run each is a company peak of 3 while every
  // per-agent peak is 1 — a per-agent-only report would call this quiet.
  const runs = [
    run({ agentId: 'a', startedAt: '2026-09-28T03:00:00Z', finishedAt: '2026-09-28T03:10:00Z' }),
    run({ agentId: 'b', startedAt: '2026-09-28T03:01:00Z', finishedAt: '2026-09-28T03:09:00Z' }),
    run({ agentId: 'c', startedAt: '2026-09-28T03:02:00Z', finishedAt: '2026-09-28T03:08:00Z' }),
  ];
  const peak = peakConcurrency(runs, '2026-09-28T04:00:00Z');
  assert.equal(peak.companyPeak, 3);
  assert.deepEqual(peak.perAgent, { a: 1, b: 1, c: 1 });
});

test('a clean handoff is not counted as an overlap', () => {
  const runs = [
    run({ agentId: 'a', startedAt: '2026-09-28T03:00:00Z', finishedAt: '2026-09-28T03:05:00Z' }),
    run({ agentId: 'a', startedAt: '2026-09-28T03:05:00Z', finishedAt: '2026-09-28T03:10:00Z' }),
  ];
  assert.equal(peakConcurrency(runs, '2026-09-28T04:00:00Z').companyPeak, 1);
});

test('unfinished runs extend only to the supplied `now`, not to wall-clock time', () => {
  // Analysing a historical export must not stretch every open run to today and
  // invent concurrency that never happened.
  const runs = [
    run({ agentId: 'a', status: 'running', finishedAt: null, startedAt: '2026-09-28T03:00:00Z' }),
    run({ agentId: 'b', startedAt: '2026-09-28T03:30:00Z', finishedAt: '2026-09-28T03:40:00Z' }),
  ];
  assert.equal(peakConcurrency(runs, '2026-09-28T03:10:00Z').companyPeak, 1);
  assert.equal(peakConcurrency(runs, '2026-09-28T04:00:00Z').companyPeak, 2);
});

test('a run that never started never held a session slot', () => {
  const runs = [run({ startedAt: null, finishedAt: null, status: 'queued' })];
  assert.equal(peakConcurrency(runs, '2026-09-28T04:00:00Z').companyPeak, 0);
});

test('quotaWaste counts the tokens spent buying nothing', () => {
  // A quota-failed run re-reads its whole context before the provider rejects
  // it, so it is not a free no-op.
  const runs = [
    run({
      status: 'failed',
      errorCode: 'provider_quota',
      usageJson: { inputTokens: 98_337, outputTokens: 0, costUsd: 2.5 },
    }),
    run(),
  ];
  const waste = quotaWaste(runs);
  assert.equal(waste.runs, 1);
  assert.equal(waste.inputTokens, 98_337);
  assert.equal(waste.imputedUsd, 2.5);
});

test('a quota failure re-queued under a non-quota reason is flagged as misscheduled', () => {
  // Observed on 2026-09-28: a session-limit failure filed as `transient_failure`
  // and retried 30s later, into a window that did not reopen for six hours.
  const runs = [
    run({
      status: 'failed',
      errorCode: 'provider_quota',
      scheduledRetryAt: '2026-09-28T03:45:47.432Z',
      scheduledRetryReason: 'transient_failure',
    }),
    run({
      status: 'failed',
      errorCode: 'provider_quota',
      scheduledRetryAt: '2026-09-28T03:48:15.800Z',
      scheduledRetryReason: 'max_turns_continuation',
    }),
    // Not re-queued at all => not waste attributable to the scheduler.
    run({ status: 'failed', errorCode: 'provider_quota' }),
  ];
  const waste = quotaWaste(runs);
  assert.equal(waste.runs, 3);
  assert.equal(waste.retriedWithinResetWindow, 2);
  assert.deepEqual(waste.misclassifiedAs, ['max_turns_continuation', 'transient_failure']);
});

test('a quota-aware retry is not counted against the scheduler', () => {
  const runs = [
    run({
      status: 'failed',
      errorCode: 'provider_quota',
      scheduledRetryAt: '2026-09-28T09:50:00Z',
      scheduledRetryReason: 'provider_quota',
    }),
  ];
  assert.equal(quotaWaste(runs).retriedWithinResetWindow, 0);
});

test('queued and scheduled_retry runs are excluded from consumption totals', () => {
  // They have not reached the provider, so counting them would dilute the rate.
  const report = buildBurnReport(
    [run(), run({ status: 'queued', usageJson: null }), run({ status: 'scheduled_retry', usageJson: null })],
    { windowHours: 1, now: '2026-09-28T04:00:00Z', names: { 'agent-a': 'CTO' } },
  );
  assert.equal(report.runsConsidered, 1);
  assert.equal(report.runsIgnored, 2);
  assert.equal(report.rate.inputTokensPerHour, 1000);
  assert.equal(report.byAgent.CTO.runs, 1);
});
