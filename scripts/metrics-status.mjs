#!/usr/bin/env node
// `appforge metrics` reader — the only sanctioned way to read store metrics.
//
//   node scripts/metrics-status.mjs [--item json-workbench] [--data-root data]
//        [--portfolio config/portfolio.yaml] [--now 2026-10-20] [--json]
//
// Exit code is 1 when anything is stale or missing. A skipped export must be
// loud: it fails the command, it is not a warning buried in output.

import { evaluateMetric, loadContract, STATUS } from './lib/metrics-freshness.mjs';
import { readManifest } from './lib/metrics-manifest.mjs';

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

const STORE_SOURCES = new Set([
  'cws_dashboard_export',
  'play_reports_bucket',
  'play_developer_reporting_api',
  'cws_public_listing',
]);

export function buildStatus({ portfolioPath, dataRoot, itemId = null, now = new Date() }) {
  const contract = loadContract(portfolioPath);
  const manifest = readManifest(dataRoot);

  const storeMetrics = Object.entries(contract.metrics)
    .filter(([, spec]) => STORE_SOURCES.has(spec.source))
    .map(([name]) => name);

  const rows = storeMetrics.map((metric) =>
    evaluateMetric({ contract, manifest, metricName: metric, itemId, now })
  );

  const stale = rows.filter((r) => r.status === STATUS.STALE);
  const missing = rows.filter((r) => r.status === STATUS.MISSING);

  return { rows, stale, missing, imports: manifest.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const portfolioPath = args.portfolio ?? 'config/portfolio.yaml';
  const dataRoot = args.data_root ?? 'data';
  const itemId = args.item ?? null;
  const now = args.now ? new Date(args.now) : new Date();

  const status = buildStatus({ portfolioPath, dataRoot, itemId, now });

  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`store metrics${itemId ? ` for ${itemId}` : ''} — ${status.imports} import(s) in manifest, evaluated at ${now.toISOString()}`);
    console.log('');
    for (const r of status.rows) {
      const mark = { fresh: 'OK  ', stale: 'STALE', missing: 'MISS', no_contract: '????' }[r.status];
      const age = r.age_days == null ? '' : `  age ${r.age_days}d / max ${r.max_age_days}d`;
      const val = r.status === STATUS.FRESH ? `= ${r.value}` : '(no value served)';
      console.log(`  ${mark}  ${r.metric.padEnd(26)} ${val}${age}`);
      if (r.status === STATUS.STALE) console.log(`         ${r.reason}`);
    }
    console.log('');
    if (status.stale.length || status.missing.length) {
      const names = [...status.stale, ...status.missing].map((r) => r.metric).sort();
      console.log(`insufficient_data: ${names.join(', ')}`);
      console.log('Every rule requiring these inputs is undecidable. No stale value was served.');
    } else {
      console.log('all store metrics fresh');
    }
  }

  process.exit(status.stale.length || status.missing.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (err) { console.error(`error: ${err.message}`); process.exit(2); }
}
