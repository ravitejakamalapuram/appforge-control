// Freshness contract enforcement for the store-metrics ingest (APP-42).
//
// The controlling requirement, from the issue:
//
//   "When the newest import for a metric is older than its `max_age_days`,
//    that metric is `stale`, every rule requiring it is `undecidable`, and
//    the product returns `insufficient_data` naming the stale input. A
//    skipped export must surface as a red flag, never as last week's number
//    presented as current. This is the single most important property of the
//    ingest — if it silently serves stale data, the whole §22.1 control is
//    worse than nothing."
//
// So this module has exactly one bias: when anything is ambiguous, degrade
// to `undecidable`/`insufficient_data`. There is no code path that returns a
// value without also returning its freshness status.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { calendarDaysBetween, newestFor, utcCalendarDate } from './metrics-manifest.mjs';

export const STATUS = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  MISSING: 'missing',
  NO_CONTRACT: 'no_contract',
});

export const DECIDABILITY = Object.freeze({
  DECIDABLE: 'decidable',
  UNDECIDABLE: 'undecidable',
});

/** Load `metrics:` and `forbidden_aliases:` out of config/portfolio.yaml. */
export function loadContract(portfolioPath) {
  const doc = parseYaml(readFileSync(portfolioPath, 'utf8'));
  const metrics = doc?.metrics ?? {};
  // An ARRAY of pairs, not a Map keyed by metric name. An earlier revision
  // used a Map and silently dropped a ban when two pairs shared a first
  // element — cws_weekly_users appears in more than one pair.
  const forbiddenAliases = (doc?.forbidden_aliases ?? []).map((a) => ({
    pair: a.pair,
    why: a.why,
  }));
  return { metrics, forbiddenAliases };
}

/**
 * Freshness of one metric for one item.
 *
 * Age is measured from `as_of` — the date the DATA covers — and never from
 * `exported_at` or `recorded_at`. Importing a three-week-old export today
 * must not make the metric look fresh; that is exactly the silent-staleness
 * failure this contract exists to prevent.
 */
export function evaluateMetric({ contract, manifest, metricName, itemId = null, now = new Date(), seen = new Set() }) {
  const spec = contract.metrics?.[metricName];
  if (!spec) {
    return {
      metric: metricName,
      item_id: itemId,
      status: STATUS.NO_CONTRACT,
      value: null,
      reason: `\`${metricName}\` is not declared in config/portfolio.yaml, so it has no max_age_days and cannot be served`,
    };
  }

  // A DERIVED metric has no import of its own. Its freshness is the WORST
  // freshness of its inputs — a ratio computed from a three-week-old
  // numerator is three weeks old, however recent the denominator is. Without
  // this, every derived metric (including store_listing_conversion, which is
  // EXP-0001's primary metric) would be permanently unservable.
  if (Array.isArray(spec.inputs) && spec.inputs.length > 0) {
    return evaluateDerived({ contract, manifest, metricName, spec, itemId, now, seen });
  }

  const entry = newestFor(manifest, metricName, itemId);
  if (!entry) {
    return {
      metric: metricName,
      item_id: itemId,
      status: STATUS.MISSING,
      value: null,
      max_age_days: spec.max_age_days ?? null,
      reason: `no import has ever carried \`${metricName}\`${itemId ? ` for ${itemId}` : ''}`,
    };
  }

  const maxAge = spec.max_age_days;
  const ageDays = calendarDaysBetween(entry.as_of, utcCalendarDate(now));
  const base = {
    metric: metricName,
    item_id: entry.item_id,
    as_of: entry.as_of,
    exported_at: entry.exported_at,
    lag_days: entry.lag_days,
    age_days: ageDays,
    max_age_days: maxAge ?? null,
    source: entry.source,
    checksum: entry.checksum,
  };

  if (maxAge === undefined || maxAge === null) {
    // A metric with no declared max_age_days has no freshness contract to
    // pass. Serving it as `fresh` would be an assumption; we refuse instead.
    return {
      ...base,
      status: STATUS.NO_CONTRACT,
      value: null,
      reason: `\`${metricName}\` declares no max_age_days, so freshness cannot be established`,
    };
  }

  if (ageDays > maxAge) {
    return {
      ...base,
      status: STATUS.STALE,
      value: null, // the value is deliberately NOT served
      withheld_value: entry.metrics[metricName],
      reason:
        `newest import for \`${metricName}\` is as_of ${entry.as_of}, ${ageDays}d old, ` +
        `past its max_age_days of ${maxAge} — value withheld`,
    };
  }

  return { ...base, status: STATUS.FRESH, value: entry.metrics[metricName], reason: null };
}

/**
 * Freshness of a derived metric, resolved through its declared `inputs`.
 *
 * Degrades pessimistically: if ANY input is stale, missing, or itself has no
 * contract, the derived metric inherits that status and serves no value. The
 * offending inputs are named so `insufficient_data` can point at the real
 * cause rather than at the ratio.
 */
function evaluateDerived({ contract, manifest, metricName, spec, itemId, now, seen }) {
  if (seen.has(metricName)) {
    return {
      metric: metricName, item_id: itemId, status: STATUS.NO_CONTRACT, value: null,
      reason: `\`${metricName}\` is cyclically derived (via ${[...seen].join(' -> ')})`,
    };
  }
  const nextSeen = new Set(seen).add(metricName);

  const inputs = spec.inputs.map((name) =>
    evaluateMetric({ contract, manifest, metricName: name, itemId, now, seen: nextSeen })
  );
  const bad = inputs.filter((i) => i.status !== STATUS.FRESH);

  const ages = inputs.map((i) => i.age_days).filter((a) => typeof a === 'number');
  const base = {
    metric: metricName,
    item_id: itemId,
    derived_from: spec.inputs,
    age_days: ages.length ? Math.max(...ages) : null,   // the worst input's age
    max_age_days: null,
    input_statuses: inputs.map((i) => ({ metric: i.metric, status: i.status })),
  };

  if (bad.length > 0) {
    // Inherit the most severe input status so callers can branch on it.
    const status = bad.some((b) => b.status === STATUS.STALE)
      ? STATUS.STALE
      : bad.some((b) => b.status === STATUS.MISSING)
        ? STATUS.MISSING
        : STATUS.NO_CONTRACT;
    return {
      ...base,
      status,
      value: null,
      reason:
        `derived metric \`${metricName}\` cannot be served: ` +
        bad.map((b) => `${b.metric} is ${b.status}`).join('; '),
    };
  }

  return {
    ...base,
    status: STATUS.FRESH,
    value: null,           // this module gates freshness; it does not compute
    inputs_fresh: true,    // the arithmetic. The caller computes the value.
    input_values: Object.fromEntries(inputs.map((i) => [i.metric, i.value])),
    reason: null,
  };
}

/**
 * A rule is decidable only if every metric it requires is `fresh` AND meets
 * the declared `min_n` / `min_history_weeks` floors. Anything else is
 * `undecidable`, with the offending inputs named.
 */
export function evaluateRule({ contract, manifest, rule, itemId = null, now = new Date(), historyWeeks = {} }) {
  const inputs = (rule.requires ?? []).map((metricName) =>
    evaluateMetric({ contract, manifest, metricName, itemId, now })
  );

  const blocking = [];
  for (const input of inputs) {
    if (input.status !== STATUS.FRESH) {
      blocking.push({ metric: input.metric, status: input.status, reason: input.reason });
      continue;
    }
    const spec = contract.metrics[input.metric] ?? {};
    if (spec.min_n != null && typeof input.value === 'number' && input.value < spec.min_n) {
      blocking.push({
        metric: input.metric,
        status: 'below_min_n',
        reason: `value ${input.value} is below the declared noise floor min_n=${spec.min_n}`,
      });
    }
    if (spec.min_history_weeks != null) {
      const have = historyWeeks[input.metric] ?? 0;
      if (have < spec.min_history_weeks) {
        blocking.push({
          metric: input.metric,
          status: 'insufficient_history',
          reason: `${have} week(s) of export history, need min_history_weeks=${spec.min_history_weeks}`,
        });
      }
    }
  }

  if (blocking.length > 0) {
    return {
      rule: rule.id ?? rule.name ?? '(unnamed rule)',
      item_id: itemId,
      decidability: DECIDABILITY.UNDECIDABLE,
      verdict: 'insufficient_data',
      blocking_inputs: blocking,
      inputs,
    };
  }

  return {
    rule: rule.id ?? rule.name ?? '(unnamed rule)',
    item_id: itemId,
    decidability: DECIDABILITY.DECIDABLE,
    verdict: null, // the caller scores it; this module only gates on data quality
    blocking_inputs: [],
    inputs,
  };
}

/**
 * Product-level verdict. `insufficient_data` names every stale or missing
 * input by metric name, so a skipped export reads as a red flag rather than
 * as a number.
 */
export function productVerdict({ contract, manifest, rules, itemId, now = new Date(), historyWeeks = {} }) {
  const evaluated = rules.map((rule) =>
    evaluateRule({ contract, manifest, rule, itemId, now, historyWeeks })
  );
  const undecidable = evaluated.filter((r) => r.decidability === DECIDABILITY.UNDECIDABLE);

  if (undecidable.length > 0) {
    const names = [
      ...new Set(undecidable.flatMap((r) => r.blocking_inputs.map((b) => b.metric))),
    ].sort();
    return {
      item_id: itemId,
      verdict: 'insufficient_data',
      stale_or_missing_inputs: names,
      detail: undecidable,
      message: `insufficient_data: ${names.join(', ')}`,
    };
  }

  return { item_id: itemId, verdict: 'decidable', stale_or_missing_inputs: [], detail: evaluated };
}

/**
 * Refuse a read that would alias two quantities the config bans aliasing.
 * Checked in both directions; `forbiddenAliases` is an array precisely so
 * that a metric appearing in several pairs keeps all of its bans.
 */
export function assertNotAliased(contract, metricA, metricB) {
  for (const { pair, why } of contract.forbiddenAliases) {
    const [x, y] = pair;
    if ((x === metricA && y === metricB) || (x === metricB && y === metricA)) {
      throw new Error(`forbidden alias: \`${metricA}\` may not stand in for \`${metricB}\` — ${why}`);
    }
  }
}
