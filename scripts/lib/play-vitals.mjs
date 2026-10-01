/**
 * Google Play Developer Reporting API - crash and ANR rates (AI-1 step 1, "Detect").
 *
 * Pure functions only. The runner (scripts/play-vitals.mjs) does auth and HTTP; nothing in
 * this file touches a credential or the network, so it is fully testable and, per
 * docs/metrics-ingest.md section 4, no agent ever needs the service-account key.
 *
 * Play's daily vitals are reported in America/Los_Angeles and lag about two days, so the
 * window always ends `lagDays` before today.
 */

export const PLAY_TIMEZONE = 'America/Los_Angeles';

/** Google Play "bad behaviour" thresholds (overall, user-perceived). */
export const PLAY_BAD_BEHAVIOUR = Object.freeze({
  userPerceivedCrashRate: 0.0109,
  userPerceivedAnrRate: 0.0047,
});

const pad = (n) => String(n).padStart(2, '0');

/** {year, month, day} for a Date, in UTC (the runner passes already-shifted dates). */
export function toDateParts(d) {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function isoDate(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Window [start, end] of whole days ending `lagDays` before `now`, `days` long. */
export function vitalsWindow(now, { days = 14, lagDays = 2 } = {}) {
  if (!(days >= 1) || !(lagDays >= 0)) throw new Error('vitalsWindow: days must be >= 1 and lagDays >= 0');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: toDateParts(start), end: toDateParts(end) };
}

/** Request body for `apps/{package}/{crashRate|anrRate}MetricSet:query`. */
export function buildQuery(kind, window, { dimensions = [] } = {}) {
  const metrics =
    kind === 'crash'
      ? ['userPerceivedCrashRate', 'crashRate', 'distinctUsers']
      : kind === 'anr'
        ? ['userPerceivedAnrRate', 'anrRate', 'distinctUsers']
        : null;
  if (!metrics) throw new Error(`buildQuery: kind must be "crash" or "anr", got ${kind}`);
  const edge = (p) => ({ year: p.year, month: p.month, day: p.day, timeZone: { id: PLAY_TIMEZONE } });
  return {
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: edge(window.start),
      endTime: edge(window.end),
    },
    dimensions,
    metrics,
    pageSize: 1000,
  };
}

export function metricSetPath(packageName, kind) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new Error(`metricSetPath: "${packageName}" is not a valid Android package name`);
  }
  const set = kind === 'crash' ? 'crashRateMetricSet' : 'anrRateMetricSet';
  return `/v1beta1/apps/${packageName}/${set}:query`;
}

/**
 * Flatten an API response into [{date, dimensions:{...}, metrics:{name:number}}].
 * Rows without a usable date are dropped rather than guessed at.
 */
export function parseRows(response) {
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  const out = [];
  for (const row of rows) {
    const t = row.startTime;
    if (!t || !t.year || !t.month || !t.day) continue;
    const metrics = {};
    for (const m of row.metrics ?? []) {
      const raw = m.decimalValue?.value ?? m.value;
      const num = Number(raw);
      if (m.metric && raw !== undefined && Number.isFinite(num)) metrics[m.metric] = num;
    }
    const dimensions = {};
    for (const d of row.dimensions ?? []) {
      if (d.dimension) dimensions[d.dimension] = d.stringValue ?? d.int64Value ?? null;
    }
    out.push({ date: isoDate(t), dimensions, metrics });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Decide whether a vitals series needs attention.
 *  - alert:  the latest day breaches Play's bad-behaviour threshold, OR is at least
 *            `regressionFactor` x the trailing median (and the median is non-zero) with
 *            enough users to mean something.
 *  - insufficient_data: too few users or days to judge - never reported as "ok".
 *  - ok: otherwise.
 * `series` is parseRows() output for ONE metric family, overall (no dimensions).
 */
export function assessVitals(series, metricName, opts = {}) {
  const {
    threshold = metricName === 'userPerceivedCrashRate'
      ? PLAY_BAD_BEHAVIOUR.userPerceivedCrashRate
      : PLAY_BAD_BEHAVIOUR.userPerceivedAnrRate,
    minUsers = 100,
    minDays = 4,
    regressionFactor = 2,
  } = opts;
  const points = series.filter((r) => Number.isFinite(r.metrics[metricName]));
  if (points.length < minDays) {
    return { status: 'insufficient_data', metric: metricName, reasons: [`only ${points.length} day(s) of data, need ${minDays}`], latest: null };
  }
  const latest = points[points.length - 1];
  const users = latest.metrics.distinctUsers ?? 0;
  const value = latest.metrics[metricName];
  if (users < minUsers) {
    return {
      status: 'insufficient_data',
      metric: metricName,
      reasons: [`latest day ${latest.date} has ${users} users, need ${minUsers}`],
      latest: { date: latest.date, value, users },
    };
  }
  const reasons = [];
  if (value >= threshold) {
    reasons.push(`${metricName} ${(value * 100).toFixed(2)}% on ${latest.date} is at or above Play's bad-behaviour threshold ${(threshold * 100).toFixed(2)}%`);
  }
  const base = median(points.slice(0, -1).map((p) => p.metrics[metricName]));
  if (base && base > 0 && value >= base * regressionFactor) {
    reasons.push(`${metricName} ${(value * 100).toFixed(2)}% on ${latest.date} is ${(value / base).toFixed(1)}x the trailing median ${(base * 100).toFixed(2)}%`);
  }
  return {
    status: reasons.length ? 'alert' : 'ok',
    metric: metricName,
    reasons,
    latest: { date: latest.date, value, users },
  };
}

// ---- Import half (APP-283): runner output -> metrics manifest ----------------

export const SOURCE = 'play_developer_reporting_api';

/** Manifest metric name for each runner result, and the API metric it carries. */
export const VITALS_METRICS = Object.freeze({
  crash: { manifest: 'play_crash_rate', api: 'userPerceivedCrashRate' },
  anr: { manifest: 'play_anr_rate', api: 'userPerceivedAnrRate' },
});

/**
 * The daily points of one metric, as the runner writes them next to its verdict.
 * Kept because the verdict alone discards the value whenever it says
 * insufficient_data, and the ingest needs the value regardless of the verdict.
 */
export function seriesFor(rows, metricName) {
  return rows
    .filter((r) => Number.isFinite(r.metrics[metricName]))
    .map((r) => ({ date: r.date, value: r.metrics[metricName], users: r.metrics.distinctUsers ?? null }));
}

/**
 * Turn one play-vitals run file into a manifest-ready reading.
 *
 * `as_of` is the newest day BOTH rates carry, so one entry never mixes two
 * days. If they share no day, the newer rate is taken alone and the other is
 * named in `absent_metrics`. A run with no rows at all throws: an empty window
 * is "Play reported nothing", never a rate of zero.
 */
export function parseVitalsRun(run, { item_id }) {
  if (!run || typeof run !== 'object') throw new Error('play_vitals: file is not a play-vitals run (expected a JSON object)');
  if (!run.fetched_at) throw new Error('play_vitals: run has no `fetched_at`; cannot date the pull');
  const kinds = Object.keys(VITALS_METRICS);
  // A pre-APP-283 file that saw zero rows lost nothing by lacking `series`.
  const seriesOf = (k) => (Array.isArray(run[k]?.series) ? run[k].series : run[k]?.days === 0 ? [] : null);
  for (const kind of kinds) {
    if (!seriesOf(kind)) {
      throw new Error(
        `play_vitals: run has no \`${kind}.series\` - it predates APP-283. Re-run scripts/play-vitals.mjs to produce an importable file`
      );
    }
  }
  const byDate = Object.fromEntries(kinds.map((k) => [k, new Map(seriesOf(k).map((p) => [p.date, p]))]));
  if (kinds.every((k) => byDate[k].size === 0)) {
    const w = run.window ? `${run.window.start}..${run.window.end}` : 'the queried window';
    throw new Error(`play_vitals: Play returned no crash or ANR rows for ${run.package ?? 'this app'} in ${w}; nothing imported (an empty window is not a rate of zero)`);
  }

  const common = [...byDate.crash.keys()].filter((d) => byDate.anr.has(d)).sort();
  let asOf;
  let taken;
  if (common.length) {
    asOf = common[common.length - 1];
    taken = kinds;
  } else {
    const newest = (k) => [...byDate[k].keys()].sort().pop() ?? '';
    const kind = newest('crash') >= newest('anr') ? 'crash' : 'anr';
    asOf = newest(kind);
    taken = [kind];
  }

  const metrics = {};
  const distinct_users = {};
  for (const kind of taken) {
    const p = byDate[kind].get(asOf);
    metrics[VITALS_METRICS[kind].manifest] = p.value;
    distinct_users[VITALS_METRICS[kind].manifest] = p.users;
  }
  return {
    source: SOURCE,
    item_id,
    as_of: asOf,
    exported_at: run.fetched_at,
    as_of_source: `daily row startTime (${PLAY_TIMEZONE})`,
    metrics,
    package: run.package ?? null,
    window: run.window ?? null,
    api_metrics: Object.fromEntries(taken.map((k) => [VITALS_METRICS[k].manifest, VITALS_METRICS[k].api])),
    distinct_users,
    absent_metrics: kinds.filter((k) => !taken.includes(k)).map((k) => VITALS_METRICS[k].manifest),
    verdicts: Object.fromEntries(kinds.map((k) => [VITALS_METRICS[k].manifest, run[k].status ?? null])),
    unit: 'fraction of distinct users (0.0109 = 1.09%)',
  };
}
