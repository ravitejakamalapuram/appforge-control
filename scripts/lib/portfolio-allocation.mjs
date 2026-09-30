// §22's monthly attention budget, as ruled by DEC-0009 D3 (defect D3).
//
// The defect: score = 0.4·norm(contribution_trend) + 0.2·norm(WAU growth)
// + 0.2·norm(D30 retention) + 0.1·strategic + 0.1·(−maintenance_burden), and
// 30% of that weight is unavailable. "A script that defaults them to 0
// silently reweights the whole allocation."
//
// So this module never defaults a term to 0. An unrealised term is DROPPED
// from both numerator and denominator, and the surviving weight is reported
// as `coverage` on every score — which is what makes the reweighting visible
// rather than silent.
//
// Today this returns base-maintenance-only, and that is the SPECIFIED
// behaviour, not a failure: see allocation.expected_coverage_today.consequence.

import { allocationWithheldNotice } from './portfolio-config.mjs';

/**
 * Which §22 terms are realised for a product.
 *
 * A term counts as realised "only if its metric is present, fresh, and above
 * min_n". `terms` maps a §22 weight name to either a number (realised) or
 * null/undefined (unrealised). Callers that have no live terms at all pass
 * nothing and get the honest 0-coverage answer.
 */
export function computeCoverage(doc, terms = {}) {
  const weights = doc.allocation?.weights ?? {};
  const realised = [];
  const unrealised = [];
  for (const [name, w] of Object.entries(weights)) {
    const v = terms[name];
    if (v == null || Number.isNaN(v)) unrealised.push({ term: name, weight: w });
    else realised.push({ term: name, weight: w, value: v });
  }
  const coverage = realised.reduce((s, r) => s + r.weight, 0);
  return { coverage, realised, unrealised };
}

/**
 * Renormalised score over realised terms only.
 *
 * `maintenance_burden` enters NEGATIVELY (§22: `0.1·(−maintenance_burden)`),
 * and it is a DECLARED proxy: it excludes founder hours, so a product's
 * burden is under-stated and its score is flattered. Both facts are stamped
 * on the returned object, never left to a footnote.
 */
export function scoreProduct(doc, product, terms = {}) {
  const { coverage, realised, unrealised } = computeCoverage(doc, terms);
  if (coverage === 0) {
    return { product, score: null, coverage: 0, realised, unrealised, reason: 'no §22 term is realised for this product' };
  }
  let num = 0;
  for (const r of realised) {
    const signed = r.term === 'maintenance_burden' ? -r.value : r.value;
    num += r.weight * signed;
  }
  const proxies = doc.allocation?.proxies ?? {};
  const proxiesUsed = realised
    .filter((r) => proxies[r.term]?.proxy === true)
    .map((r) => ({ term: r.term, proxy: true, excludes: proxies[r.term].excludes ?? null }));

  return {
    product,
    score: num / coverage,
    coverage,                 // stamp_is_mandatory: true
    realised, unrealised,
    proxies_used: proxiesUsed,
  };
}

/**
 * Portfolio allocation. Withholds the growth pool ENTIRELY below the coverage
 * floor — "not scaled down in proportion to coverage. A proportionally-scaled
 * pool would still be allocated on the same degenerate arithmetic, just less
 * of it."
 */
export function computeAllocation({ doc, results, terms = {} }) {
  const alloc = doc.allocation ?? {};
  const floor = alloc.coverage?.floor ?? 0.7;
  // A product whose inputs could not support a verdict (APP-86 `input_error`)
  // is excluded from scoring and withholds the pool for the WHOLE portfolio.
  // Per-product verdicts survive one broken product.yaml because each verdict
  // stands on its own product's inputs; a share-of-pool figure does not — every
  // share is a fraction of a total, so an unenumerable portfolio makes every
  // other product's share wrong by an unknown amount. `max_share_of_growth_pool`
  // cannot be checked against a denominator nobody can compute.
  const evaluable = results.filter((r) => r.outcome !== 'input_error');
  const notEvaluable = results.filter((r) => r.outcome === 'input_error').map((r) => r.product);
  const scored = evaluable.map((r) => scoreProduct(doc, r.product, terms[r.product] ?? {}));

  // The allocation-level stamp is "the minimum coverage across scored products".
  const portfolioCoverage = scored.length === 0 ? 0 : Math.min(...scored.map((s) => s.coverage));

  const strategicWeight = alloc.weights?.strategic ?? 0;
  const strategicCap = alloc.caps?.strategic?.max_share_of_realised_weight ?? 1;
  const strategicShare = portfolioCoverage > 0 ? strategicWeight / portfolioCoverage : 0;

  const withheld = [];
  if (notEvaluable.length > 0) {
    withheld.push({
      reason: 'portfolio_not_enumerable',
      notice:
        `allocation_withheld: ${notEvaluable.length} product(s) [${notEvaluable.join(', ')}] returned ` +
        `input_error, so the portfolio total every share is a fraction of cannot be computed. ` +
        `Base maintenance is unaffected and is paid regardless.`,
    });
  }
  if (portfolioCoverage < floor) {
    withheld.push({ reason: 'coverage_below_floor', notice: allocationWithheldNotice(doc, portfolioCoverage) });
  }
  if (portfolioCoverage > 0 && strategicShare > strategicCap) {
    withheld.push({
      reason: 'strategic_share_exceeds_cap',
      notice: (alloc.caps.strategic.on_breach?.emit ?? '').replace('<X>', strategicShare.toFixed(2)),
    });
  }

  const band = alloc.base_maintenance_usd_per_product_month ?? {};
  return {
    coverage: portfolioCoverage,
    coverage_floor: floor,
    strategic_share: strategicShare,
    strategic_cap: strategicCap,
    not_evaluable: notEvaluable,
    growth_pool: withheld.length > 0 ? 'withheld_entirely' : 'allocated',
    withheld,
    base_maintenance_usd_per_product_month: band,
    per_product: scored,
  };
}

export function formatAllocation(doc, allocation) {
  const lines = ['allocation (§22 monthly attention budget, DEC-0009 D3):'];
  lines.push(`  coverage: ${allocation.coverage.toFixed(2)} (floor ${allocation.coverage_floor})`);
  lines.push(`  growth pool: ${allocation.growth_pool}`);
  for (const w of allocation.withheld) lines.push(`  ${w.notice}`);
  const b = allocation.base_maintenance_usd_per_product_month;
  lines.push(`  every product receives base maintenance $${b.min}-${b.max}/month regardless.`);
  for (const p of allocation.per_product) {
    const score = p.score == null ? 'no score' : p.score.toFixed(3);
    lines.push(`    ${p.product.padEnd(18)} score=${score}  coverage=${p.coverage.toFixed(2)}`);
    if (p.unrealised.length) {
      lines.push(`        unrealised: ${p.unrealised.map((u) => `${u.term} (${u.weight})`).join(', ')}`);
    }
    for (const px of p.proxies_used) {
      lines.push(`        proxy: ${px.term} — proxy: true, excludes: ${px.excludes}`);
    }
  }
  return lines;
}
