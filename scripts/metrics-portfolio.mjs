#!/usr/bin/env node
// `appforge metrics portfolio` — the deterministic §22.1 evaluator (APP-43).
//
//   node scripts/metrics-portfolio.mjs [--products-root ~/git-personal]
//        [--portfolio config/portfolio.yaml] [--data-root data]
//        [--now 2026-10-20] [--json] [--allocation]
//
// No model call anywhere in this path. §22.1 requires the recommendation be
// "computed by script from metrics before the CEO sees narrative"; that
// anti-sunk-cost control only works if no LLM sits between metric and verdict.
//
// Exit codes:
//   0  every product resolved to an outcome (including insufficient_data)
//   1  at least one product returned `input_error` — its product.yaml inputs
//      cannot support a verdict (APP-86). Every other product is still
//      evaluated and printed; only the named product gets no outcome.
//   2  a config invariant failed. No outcome is printed for ANYONE — that
//      fail-closed scope is per `validator.fail_closed` in the config, and it
//      is deliberately wider than a bad product.yaml, because a broken
//      invariant makes every verdict suspect rather than one of them.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { readManifest } from './lib/metrics-manifest.mjs';
import {
  PortfolioConfigError, allocationWithheldNotice, insufficientDataNotice, loadPortfolio,
} from './lib/portfolio-config.mjs';
import { PRODUCT_REPOS, loadProductInputs } from './lib/portfolio-products.mjs';
import { evaluatePortfolio } from './lib/portfolio-eval.mjs';
import { computeAllocation, formatAllocation } from './lib/portfolio-allocation.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

const OUTCOME_MARK = {
  SCALE: 'SCALE           ',
  ITERATE: 'ITERATE         ',
  PAUSE: 'PAUSE           ',
  SUNSET: 'SUNSET          ',
  CONTINUE: 'CONTINUE        ',
  insufficient_data: 'insufficient_data',
  not_applicable: 'not_applicable  ',
  // NOT one of the seven outcomes. Rendered in the same column so it cannot be
  // scrolled past, and named so it cannot be read as one of them.
  input_error: 'INPUT_ERROR     ',
};

export function runPortfolio({ portfolioPath, productsRoot, dataRoot, now, repoDirs = PRODUCT_REPOS, historyWeeks = {}, riskInputs = {} }) {
  const doc = loadPortfolio(portfolioPath);
  const products = loadProductInputs(productsRoot, repoDirs);
  const manifest = readManifest(dataRoot);
  const results = evaluatePortfolio({ doc, manifest, products, now, historyWeeks, riskInputs });
  return { doc, products, manifest, results };
}

function render(doc, results, { allocation }) {
  const lines = [];
  lines.push(`appforge metrics portfolio — ${results.length} product(s), evaluated at ${new Date().toISOString()}`);
  lines.push('');
  // output_contract: "once per evaluator run, in the run header". Read from
  // the config, never a copy embedded here.
  lines.push(insufficientDataNotice(doc));
  lines.push('');

  for (const r of results) {
    lines.push(`  ${OUTCOME_MARK[r.outcome] ?? r.outcome}  ${r.product}`);
    if (r.reason_codes?.length) {
      lines.push(`      reason: ${r.reason_codes.join(', ')}`);
    }
    if (r.detail) lines.push(`      ${r.detail}`);
    for (const ip of r.input_problems ?? []) lines.push(`      product.yaml: ${ip}`);
    for (const b of r.blocking ?? []) {
      lines.push(`      rule ${b.rule_id}${b.platform ? ` [${b.platform}]` : ''} — ${b.reason_codes.join(', ')}`);
      for (const i of b.inputs) {
        const extra = i.measurability_class ? ` (${i.measurability_class})` : '';
        lines.push(`          ${i.term}: ${i.status}${extra} — fixable_by=${i.fixable_by}`);
      }
    }
    if (r.outcome === 'insufficient_data') {
      // "attached to every product whose outcome is insufficient_data"
      lines.push(`      ${insufficientDataNotice(doc)}`);
    }
    lines.push('');
  }

  const tally = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
  lines.push(`summary: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  if (tally.input_error) {
    lines.push(
      `${tally.input_error} product(s) produced NO outcome because their product.yaml inputs ` +
      `cannot support one. Exit code 1. Fix the named files; nothing else here is affected.`
    );
  }

  if (allocation) {
    lines.push('');
    lines.push(...formatAllocation(doc, allocation));
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const portfolioPath = args.portfolio ?? 'config/portfolio.yaml';
  const dataRoot = args.data_root ?? 'data';
  const productsRoot = resolve((args.products_root ?? `${homedir()}/git-personal`).replace(/^~/, homedir()));
  const now = args.now ? new Date(args.now) : new Date();
  // Scope the run to named repo dirs. NOT a bypass of the APP-86 hard error:
  // any product in scope with absent inputs still fails the whole run, and the
  // default scope is all nine.
  const repoDirs = typeof args.products === 'string' ? args.products.split(',').map((s) => s.trim()) : PRODUCT_REPOS;

  const { doc, results } = runPortfolio({ portfolioPath, productsRoot, dataRoot, now, repoDirs });
  const allocation = args.allocation ? computeAllocation({ doc, results }) : null;

  if (args.json) {
    console.log(JSON.stringify({
      evaluated_at: now.toISOString(),
      insufficient_data_notice: insufficientDataNotice(doc),
      results,
      allocation,
    }, null, 2));
  } else {
    console.log(render(doc, results, { allocation }));
  }
  process.exit(results.some((r) => r.outcome === 'input_error') ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    if (err instanceof PortfolioConfigError) {
      console.error(`config invariant failure — no verdict produced for any product.\n${err.message}`);
      process.exit(2);
    }
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}
