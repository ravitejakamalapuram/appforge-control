// The §22.1 evaluator (APP-43). Deterministic, no model call — §22.1 requires
// the recommendation be "computed by script from metrics before the CEO sees
// narrative", and that anti-sunk-cost control only works if no LLM sits
// between the metric and the verdict.
//
// `resolution.order` in config/portfolio.yaml is the contract this implements:
//
//   1. store_item_status != published      -> not_applicable / not_published
//   2. first_published is null             -> not_applicable / first_published_null
//   3. select the platform rule set
//   4. classify every rule FIRED | NOT_FIRED | UNDECIDABLE
//   5. any FIRED    -> highest-precedence fired outcome
//   6. any UNDECIDABLE -> insufficient_data + full blocking list
//   7. else         -> CONTINUE
//
// Steps 1 and 2 are reached only for products whose inputs are present at
// all; an ABSENT key is a hard error raised earlier, in portfolio-products.mjs
// (APP-86). "Absent" and "not published" are different statements.

import { evaluateMetric, STATUS } from './metrics-freshness.mjs';
import { compare, compileRules } from './portfolio-clauses.mjs';
import { precedenceRank } from './portfolio-config.mjs';

export const DISPOSITION = Object.freeze({
  FIRED: 'FIRED',
  NOT_FIRED: 'NOT_FIRED',
  UNDECIDABLE: 'UNDECIDABLE',
});

/**
 * `fixable_by` ∈ [store_ingest, telemetry, scale, build, nothing] —
 * "the actionable form" of measurability, per
 * resolution.insufficient_data_report_must_include.
 *
 * `also: NOT_MEASURABLE_AT_SCALE` wins over MEASURABLE_AFTER_TELEMETRY on
 * purpose: for retention and activation, shipping telemetry does NOT make
 * the quantity measurable — it makes it measurable once n is large enough.
 * Reporting "telemetry" for those would send someone to build the wrong fix.
 */
export function fixableBy(spec) {
  if (!spec) return 'build'; // no contract at all: something has to declare it
  if (spec.also === 'NOT_MEASURABLE_AT_SCALE') return 'scale';
  switch (spec.measurability) {
    case 'NOT_MEASURABLE': return 'nothing';
    case 'NOT_MEASURABLE_AT_SCALE': return 'scale';
    case 'MEASURABLE_AFTER_TELEMETRY': return 'telemetry';
    case 'MEASURABLE_NOW':
      if (spec.origin === 'store') return 'store_ingest';
      return 'build';
    default: return 'build';
  }
}

function reasonCodeFor(spec, status) {
  if (status === 'below_min_n') return 'metric_below_min_n';
  if (status === 'insufficient_history') return 'insufficient_history';
  if (status === STATUS.STALE) return 'metric_stale';
  // missing / no_contract
  if (spec?.measurability === 'NOT_MEASURABLE') return 'metric_not_measurable';
  if (spec?.measurability === 'MEASURABLE_AFTER_TELEMETRY') return 'metric_needs_telemetry';
  return 'metric_missing';
}

/**
 * Resolve one TERM to a value or to a named blocker.
 *
 * Terms are not all metrics. `checkpoint` is derived from the clock,
 * `acquisition_weak` is a config `definitions` entry, `marketing_spend` is
 * declared nowhere at all, and `unresolvable_policy_or_security_risk` is a
 * composite with its own partial-evaluation rule. Each gets an explicit
 * branch; nothing falls through to a default.
 */
export function resolveTerm(ctx, term) {
  const { doc, manifest, product, now, historyWeeks, riskInputs } = ctx;

  if (term === 'checkpoint') {
    // Guaranteed non-null here: resolution.order step 2 stops before any rule
    // is scored when first_published is null.
    const days = Math.floor((now - new Date(product.first_published)) / 86400000);
    return { term, ok: true, value: days };
  }

  if (term === 'unresolvable_policy_or_security_risk') {
    return resolveRiskComposite(doc, product, riskInputs);
  }

  const definition = doc.definitions?.[term];
  if (definition) {
    // "the script must refuse to use a PROPOSED_NOT_IN_PLAN definition until
    // its status is `approved`" — and DEC-0009 did not rule on acquisition_weak,
    // so its absence from that decision is not approval by silence.
    if (definition.status !== 'approved') {
      return {
        term, ok: false, status: 'definition_not_approved',
        reason_code: 'thresholds_not_set',
        fixable_by: 'nothing',
        measurability: null,
        detail: `definition \`${term}\` has status ${definition.status}; the evaluator refuses to use it until CEO approves it`,
      };
    }
  }

  const spec = doc.metrics?.[term];
  if (!spec) {
    return {
      term, ok: false, status: 'no_contract',
      reason_code: 'metric_missing',
      fixable_by: 'build',
      measurability: null,
      detail: `\`${term}\` is not declared under \`metrics\` anywhere in the config — no contract, so no value`,
    };
  }

  const itemId = product.product;
  const ev = evaluateMetric({ doc: null, contract: { metrics: doc.metrics }, manifest, metricName: term, itemId, now });

  if (ev.status !== STATUS.FRESH) {
    return {
      term, ok: false, status: ev.status,
      reason_code: reasonCodeFor(spec, ev.status),
      fixable_by: fixableBy(spec),
      measurability: spec.measurability ?? null,
      as_of: ev.as_of ?? null,
      max_age_days: ev.max_age_days ?? null,
      age_days: ev.age_days ?? null,
      detail: ev.reason ?? `${term} is ${ev.status}`,
    };
  }

  if (spec.min_n != null && typeof ev.value === 'number' && ev.value < spec.min_n) {
    return {
      term, ok: false, status: 'below_min_n',
      reason_code: 'metric_below_min_n',
      fixable_by: fixableBy(spec),
      measurability: spec.measurability ?? null,
      n: ev.value, min_n: spec.min_n,
      detail: `n=${ev.value} is below min_n=${spec.min_n} for the comparison this rule makes`,
    };
  }

  if (spec.min_history_weeks != null) {
    const have = historyWeeks[term] ?? 0;
    if (have < spec.min_history_weeks) {
      return {
        term, ok: false, status: 'insufficient_history',
        reason_code: 'insufficient_history',
        fixable_by: fixableBy(spec),
        measurability: spec.measurability ?? null,
        have_weeks: have, need_weeks: spec.min_history_weeks,
        detail: `${have} week(s) of export history, need ${spec.min_history_weeks}`,
      };
    }
  }

  return { term, ok: true, value: ev.value, as_of: ev.as_of ?? null };
}

/**
 * `unresolvable_policy_or_security_risk` — the one metric with
 * `partial_evaluation.allowed: true`.
 *
 *   "This metric evaluates TRUE if ANY available input shows an unresolvable
 *    risk, even when another input is missing. It evaluates FALSE only when
 *    EVERY input is available and none shows risk."
 *
 * A disjunction is the one shape where partial data is still decisive in one
 * direction: a missing store feed cannot make an open SEV1 not exist. So this
 * returns TRUE or undecidable, never FALSE, while store_review_status is
 * missing. Being unable to CLEAR a product is not the same as finding it at
 * risk, and DEC-0009 D2 requires the two be reported differently.
 */
export function resolveRiskComposite(doc, product, riskInputs = {}) {
  const term = 'unresolvable_policy_or_security_risk';
  const spec = doc.metrics?.[term] ?? {};
  const declared = spec.inputs ?? {};
  const unavailable = [];
  let anyRisk = null;

  for (const [name, decl] of Object.entries(declared)) {
    const supplied = riskInputs[name];
    if (supplied === undefined) {
      // Not supplied by the caller: fall back to what the config says about
      // whether a mechanism even exists today.
      if (decl.available_today === true) {
        unavailable.push({ input: name, detail: 'input is live but was not supplied to this run' });
      } else {
        unavailable.push({ input: name, detail: decl.note ? String(decl.note).split('\n')[0] : 'no feed exists yet' });
      }
      continue;
    }
    if (supplied.risk === true) anyRisk = { input: name, evidence: supplied.evidence ?? null };
  }

  if (anyRisk) {
    return { term, ok: true, value: true, decisive_input: anyRisk };
  }
  if (unavailable.length > 0) {
    return {
      term, ok: false, status: 'partially_available',
      reason_code: 'metric_missing',
      fixable_by: 'store_ingest',
      measurability: spec.measurability ?? null,
      unavailable_inputs: unavailable,
      detail:
        `no available input shows risk, but [${unavailable.map((u) => u.input).join(', ')}] ` +
        `could not be read — the product is NOT cleared and NOT flagged`,
    };
  }
  return { term, ok: true, value: false };
}

function scoreAtom(atom, values) {
  switch (atom.kind) {
    case 'checkpoint': return compare(atom.op, values.checkpoint, atom.days);
    case 'numeric': return compare(atom.op, values[atom.metric], atom.value);
    case 'bool': return compare(atom.op, values[atom.metric], atom.value);
    case 'scaled': return compare(atom.op, values[atom.metric], atom.factor * values[atom.against]);
    case 'sustained': return compare(atom.op, values[atom.metric], atom.value);
    default: throw new Error(`unscorable atom kind ${atom.kind}`);
  }
}

/**
 * Classify one rule.
 *
 * The sufficiency gate runs over `requires` UNION every term the clauses
 * read, and it runs BEFORE any clause is scored. That ordering is the config's
 * own: "if ANY listed metric is missing, stale, or below min_n, the rule is
 * undecidable. It is never silently false." No short-circuit can make a rule
 * not-fire on data we do not have.
 */
export function classifyRule(ctx, compiledRule) {
  const { rule, clauses, terms } = compiledRule;
  const { doc } = ctx;

  const needed = [...new Set([...(rule.requires ?? []), ...terms])];
  const resolved = needed.map((t) => resolveTerm(ctx, t));
  const blocking = resolved.filter((r) => !r.ok);

  if (blocking.length > 0) {
    return {
      rule_id: rule.id,
      outcome: rule.outcome,
      disposition: DISPOSITION.UNDECIDABLE,
      blocking,
      reason_codes: [...new Set(blocking.map((b) => b.reason_code))],
    };
  }

  const values = Object.fromEntries(resolved.map((r) => [r.term, r.value]));
  const perClause = clauses.map((c) => ({
    text: c.text,
    satisfied: c.atoms.some((a) => scoreAtom(a, values)),
  }));
  const fired = perClause.every((c) => c.satisfied);

  return {
    rule_id: rule.id,
    outcome: rule.outcome,
    disposition: fired ? DISPOSITION.FIRED : DISPOSITION.NOT_FIRED,
    blocking: [],
    reason_codes: [],
    clauses: perClause,
    values,
    _doc: doc && undefined,
  };
}

/**
 * Which rules run for a product, per `platform_rule_sets` (DEC-0009 D5).
 *
 * Android does NOT borrow Chrome's thresholds through an aliased metric.
 * WAU-written rules return insufficient_data / play_wau_unavailable, and any
 * rule that claims android but appears in neither android list is reported as
 * thresholds_not_set rather than silently skipped.
 */
export function rulesForPlatform(doc, platform) {
  const set = doc.platform_rule_sets?.[platform];
  if (!set) {
    return { platform, unknown_platform: true, run: [], forced: [] };
  }
  if (set.status === 'ACTIVE') {
    return { platform, run: set.rules ?? [], forced: [] };
  }
  // THRESHOLDS_NOT_SET (android today)
  const inherited = set.rules_inherited_unchanged ?? [];
  const wau = set.wau_written_rules ?? {};
  const forced = (wau.affected ?? []).map((id) => ({
    rule_id: id,
    outcome: wau.outcome ?? 'insufficient_data',
    reason_code: wau.reason_code ?? 'play_wau_unavailable',
  }));
  const covered = new Set([...inherited, ...(wau.affected ?? [])]);
  const claimed = (doc.rules ?? [])
    .filter((r) => (r.platforms ?? []).includes(platform))
    .map((r) => r.id);
  const uncovered = claimed
    .filter((id) => !covered.has(id))
    .map((id) => ({ rule_id: id, outcome: 'insufficient_data', reason_code: 'thresholds_not_set' }));
  return { platform, run: inherited, forced: [...forced, ...uncovered] };
}

/** Full resolution order for one product. */
export function evaluateProduct(ctx, product) {
  const { doc, compiled } = ctx;
  const base = { product: product.product, platforms: product.platforms };

  // --- resolution.order step 0 (APP-86): inputs that cannot support a verdict
  //
  // NOT an outcome. `input_error` is deliberately absent from `outcomes` in the
  // config, so it can never be mistaken for one of the seven — and absent from
  // `reason_codes` too, because a reason code explains a verdict and there is
  // no verdict here. An ABSENT `store_item_status` is not `!= published`: for
  // InvTrack, whose Play listing is live with real users and real financial
  // data, emitting `not_applicable/not_published` would read as "nothing to see
  // here" about the most sensitive product in the portfolio.
  if (product.ok === false) {
    return {
      product: product.product,
      platforms: product.platforms ?? null,
      outcome: 'input_error',
      reason_codes: [],
      input_problems: product.problems.map((x) => x.detail),
      path: product.path ?? null,
      detail: 'product.yaml inputs cannot support a verdict; no outcome emitted for this product',
      rules: [],
    };
  }

  // --- resolution.order step 1
  if (product.store_item_status !== 'published') {
    return {
      ...base,
      outcome: 'not_applicable',
      reason_codes: ['not_published'],
      detail: `store_item_status is \`${product.store_item_status}\`; §22.1 is a post-launch policy`,
      rules: [],
    };
  }

  // --- resolution.order step 2
  if (product.first_published == null) {
    return {
      ...base,
      outcome: 'not_applicable',
      reason_codes: ['first_published_null'],
      detail: 'the day-30/60/90 clock has no origin for this product',
      rules: [],
    };
  }

  // --- steps 3 & 4
  const evaluated = [];
  for (const platform of product.platforms) {
    const set = rulesForPlatform(doc, platform);
    if (set.unknown_platform) {
      evaluated.push({
        rule_id: '(platform)', platform, outcome: 'insufficient_data',
        disposition: DISPOSITION.UNDECIDABLE, reason_codes: ['thresholds_not_set'],
        blocking: [{ term: platform, reason_code: 'thresholds_not_set', fixable_by: 'nothing', detail: `no rule set is declared for platform \`${platform}\`` }],
      });
      continue;
    }
    for (const id of set.run) {
      const cr = compiled.get(id);
      if (!cr) continue;
      evaluated.push({ ...classifyRule(ctx, cr), platform });
    }
    for (const f of set.forced) {
      evaluated.push({
        rule_id: f.rule_id, platform, outcome: f.outcome,
        disposition: DISPOSITION.UNDECIDABLE,
        reason_codes: [f.reason_code],
        blocking: [{
          term: f.rule_id, reason_code: f.reason_code,
          fixable_by: f.reason_code === 'play_wau_unavailable' ? 'nothing' : 'build',
          measurability: null,
          detail: doc.reason_codes?.[f.reason_code] ?? f.reason_code,
        }],
      });
    }
  }

  // --- step 5: any FIRED wins, highest precedence first
  const fired = evaluated.filter((r) => r.disposition === DISPOSITION.FIRED);
  if (fired.length > 0) {
    fired.sort((a, b) => precedenceRank(doc, a.outcome) - precedenceRank(doc, b.outcome));
    return {
      ...base,
      outcome: fired[0].outcome,
      reason_codes: [],
      fired_rule: fired[0].rule_id,
      rules: evaluated,
    };
  }

  // --- step 6: any UNDECIDABLE -> insufficient_data with the full blocking list
  const undecidable = evaluated.filter((r) => r.disposition === DISPOSITION.UNDECIDABLE);
  if (undecidable.length > 0) {
    return {
      ...base,
      outcome: 'insufficient_data',
      reason_codes: [...new Set(undecidable.flatMap((r) => r.reason_codes))].sort(),
      blocking: undecidable.map((r) => ({
        rule_id: r.rule_id,
        platform: r.platform,
        reason_codes: r.reason_codes,
        missing_metrics: r.blocking.filter((b) => b.status === 'missing' || b.status === 'no_contract').map((b) => b.term),
        stale_metrics: r.blocking.filter((b) => b.status === 'stale').map((b) => ({ metric: b.term, as_of: b.as_of, age_days: b.age_days, max_age_days: b.max_age_days })),
        below_min_n_metrics: r.blocking.filter((b) => b.status === 'below_min_n').map((b) => ({ metric: b.term, n: b.n, min_n: b.min_n })),
        inputs: r.blocking.map((b) => ({
          term: b.term, status: b.status, reason_code: b.reason_code,
          measurability_class: b.measurability ?? null, fixable_by: b.fixable_by, detail: b.detail,
        })),
      })),
      rules: evaluated,
    };
  }

  // --- step 7
  return { ...base, outcome: 'CONTINUE', reason_codes: [], rules: evaluated };
}

/**
 * Evaluate every product. `compiled` is built once; clause parsing is fail-closed.
 *
 * `products` is the ordered array `loadProductInputs` returns — elements with
 * `ok: false` become `input_error` records in place, so the declared portfolio
 * order survives and the count of rows always equals the count of products.
 */
export function evaluatePortfolio({ doc, manifest, products, now = new Date(), historyWeeks = {}, riskInputs = {} }) {
  const compiled = compileRules(doc);
  const ctx = { doc, compiled, manifest, now, historyWeeks, riskInputs, product: null };
  return products.map((product) => evaluateProduct({ ...ctx, product }, product));
}
