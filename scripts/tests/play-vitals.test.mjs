import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAY_TIMEZONE, vitalsWindow, buildQuery, metricSetPath, parseRows, assessVitals, isoDate,
} from '../lib/play-vitals.mjs';

const day = (date, rate, users = 500, metric = 'userPerceivedCrashRate') => {
  const [year, month, d] = date.split('-').map(Number);
  return {
    startTime: { year, month, day: d },
    metrics: [
      { metric, decimalValue: { value: String(rate) } },
      { metric: 'distinctUsers', decimalValue: { value: String(users) } },
    ],
  };
};

test('window ends lagDays before today and spans `days` whole days', () => {
  const w = vitalsWindow(new Date('2026-10-01T12:00:00Z'), { days: 14, lagDays: 2 });
  assert.equal(isoDate(w.end), '2026-09-29');
  assert.equal(isoDate(w.start), '2026-09-16');
});

test('window rejects nonsense input instead of returning a bad range', () => {
  assert.throws(() => vitalsWindow(new Date(), { days: 0 }), /days must be/);
  assert.throws(() => vitalsWindow(new Date(), { days: 7, lagDays: -1 }), /lagDays/);
});

test('query is DAILY in Play\'s timezone with the right metrics per kind', () => {
  const w = vitalsWindow(new Date('2026-10-01T00:00:00Z'));
  const crash = buildQuery('crash', w);
  assert.equal(crash.timelineSpec.aggregationPeriod, 'DAILY');
  assert.equal(crash.timelineSpec.startTime.timeZone.id, PLAY_TIMEZONE);
  assert.ok(crash.metrics.includes('userPerceivedCrashRate'));
  assert.ok(buildQuery('anr', w).metrics.includes('userPerceivedAnrRate'));
  assert.throws(() => buildQuery('bogus', w), /crash" or "anr/);
});

test('metric set path validates the package name (no path injection)', () => {
  assert.equal(metricSetPath('com.invtracker.inv_tracker', 'crash'), '/v1beta1/apps/com.invtracker.inv_tracker/crashRateMetricSet:query');
  assert.equal(metricSetPath('com.invtracker.inv_tracker', 'anr'), '/v1beta1/apps/com.invtracker.inv_tracker/anrRateMetricSet:query');
  assert.throws(() => metricSetPath('../../etc', 'crash'), /not a valid Android package/);
  assert.throws(() => metricSetPath('com.x/../y', 'crash'), /not a valid Android package/);
});

test('parseRows flattens, sorts by date, and drops rows without a date', () => {
  const rows = parseRows({ rows: [day('2026-09-20', 0.01), { metrics: [] }, day('2026-09-19', 0.02)] });
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-19', '2026-09-20']);
  assert.equal(rows[0].metrics.userPerceivedCrashRate, 0.02);
});

test('parseRows tolerates an empty or malformed response', () => {
  assert.deepEqual(parseRows({}), []);
  assert.deepEqual(parseRows(null), []);
  assert.deepEqual(parseRows({ rows: 'nope' }), []);
});

test('parseRows ignores non-numeric metric values rather than storing NaN', () => {
  const rows = parseRows({ rows: [{ startTime: { year: 2026, month: 9, day: 1 }, metrics: [{ metric: 'crashRate', decimalValue: { value: 'abc' } }] }] });
  assert.deepEqual(rows[0].metrics, {});
});

test('healthy series is ok', () => {
  const s = parseRows({ rows: ['01', '02', '03', '04', '05'].map((d) => day(`2026-09-${d}`, 0.002)) });
  const r = assessVitals(s, 'userPerceivedCrashRate');
  assert.equal(r.status, 'ok');
  assert.equal(r.latest.users, 500);
});

test('a breach of the Play bad-behaviour threshold alerts', () => {
  const s = parseRows({ rows: [...['01', '02', '03', '04'].map((d) => day(`2026-09-${d}`, 0.01)), day('2026-09-05', 0.0125)] });
  const r = assessVitals(s, 'userPerceivedCrashRate');
  assert.equal(r.status, 'alert');
  assert.match(r.reasons[0], /bad-behaviour threshold/);
});

test('a 2x regression below the threshold still alerts', () => {
  const s = parseRows({ rows: [...['01', '02', '03', '04'].map((d) => day(`2026-09-${d}`, 0.002)), day('2026-09-05', 0.005)] });
  const r = assessVitals(s, 'userPerceivedCrashRate');
  assert.equal(r.status, 'alert');
  assert.match(r.reasons.join(' '), /x the trailing median/);
});

test('too few users is insufficient_data, never a false "ok"', () => {
  const s = parseRows({ rows: ['01', '02', '03', '04', '05'].map((d) => day(`2026-09-${d}`, 0.5, 12)) });
  const r = assessVitals(s, 'userPerceivedCrashRate');
  assert.equal(r.status, 'insufficient_data');
  assert.match(r.reasons[0], /12 users/);
});

test('too few days is insufficient_data', () => {
  const s = parseRows({ rows: [day('2026-09-01', 0.001), day('2026-09-02', 0.001)] });
  assert.equal(assessVitals(s, 'userPerceivedCrashRate').status, 'insufficient_data');
});

test('ANR uses its own threshold', () => {
  const rows = [...['01', '02', '03', '04'].map((d) => day(`2026-09-${d}`, 0.001, 500, 'userPerceivedAnrRate')), day('2026-09-05', 0.006, 500, 'userPerceivedAnrRate')];
  const r = assessVitals(parseRows({ rows }), 'userPerceivedAnrRate');
  assert.equal(r.status, 'alert');
});
