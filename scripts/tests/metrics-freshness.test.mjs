import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadContract, evaluateMetric, evaluateRule, productVerdict,
  assertNotAliased, STATUS, DECIDABILITY,
} from '../lib/metrics-freshness.mjs';
import { createManifestEntry, appendManifest, readManifest } from '../lib/metrics-manifest.mjs';

import { fileURLToPath } from 'node:url';

// Resolve from this file, not from cwd: `npm test` runs with cwd=scripts/
// while an ad-hoc `node --test scripts/tests/...` runs from the repo root.
const PORTFOLIO = fileURLToPath(new URL('../../config/portfolio.yaml', import.meta.url));


const contract = loadContract(PORTFOLIO);

function withImport({ as_of, metrics, item_id = 'json-workbench', exported_at }) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-fresh-'));
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id, as_of,
    exported_at: exported_at ?? `${as_of}T12:00:00Z`,
    checksum: 'deadbeef', metrics,
  }));
  return readManifest(dir);
}

test('the contract loads real max_age_days out of portfolio.yaml', () => {
  assert.equal(contract.metrics.cws_weekly_users.max_age_days, 14);
  assert.equal(contract.metrics.cws_rating_average.max_age_days, 30);
});

test('a fresh import serves its value', () => {
  const manifest = withImport({ as_of: '2026-09-27', metrics: { cws_installs: 12 } });
  const r = evaluateMetric({
    contract, manifest, metricName: 'cws_installs',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, STATUS.FRESH);
  assert.equal(r.value, 12);
  assert.equal(r.age_days, 2);
});

// ---- THE ACCEPTANCE CRITERION ----
test('STALENESS: an import past max_age_days yields `stale` and withholds the value', () => {
  // cws_installs has max_age_days: 14. This import is 20 days old.
  const manifest = withImport({ as_of: '2026-09-09', metrics: { cws_installs: 12 } });
  const r = evaluateMetric({
    contract, manifest, metricName: 'cws_installs',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });

  assert.equal(r.status, STATUS.STALE);
  assert.equal(r.age_days, 20);
  assert.equal(r.max_age_days, 14);
  assert.equal(r.value, null, 'a stale metric must serve NO value');
  assert.equal(r.withheld_value, 12, 'the withheld value is visible as such, not as the reading');
  assert.match(r.reason, /past its max_age_days/);
});

test('the boundary is exclusive: exactly max_age_days old is still fresh', () => {
  const manifest = withImport({ as_of: '2026-09-15', metrics: { cws_installs: 12 } });
  const at = (d) => evaluateMetric({
    contract, manifest, metricName: 'cws_installs',
    itemId: 'json-workbench', now: new Date(d),
  });
  assert.equal(at('2026-09-29T00:00:00Z').status, STATUS.FRESH, '14d old — at the limit');
  assert.equal(at('2026-09-30T00:00:00Z').status, STATUS.STALE, '15d old — past it');
});

test('re-importing an old export does NOT refresh the metric', () => {
  // Downloaded today, but the data only covers up to 2026-08-01.
  const manifest = withImport({
    as_of: '2026-08-01', metrics: { cws_installs: 12 },
    exported_at: '2026-09-29T10:00:00Z',
  });
  const r = evaluateMetric({
    contract, manifest, metricName: 'cws_installs',
    itemId: 'json-workbench', now: new Date('2026-09-29T12:00:00Z'),
  });
  assert.equal(r.status, STATUS.STALE,
    'age must be measured from as_of, not from exported_at or recorded_at');
  assert.equal(r.lag_days, 59);
});

test('a metric never imported is `missing`, not zero', () => {
  const r = evaluateMetric({
    contract, manifest: [], metricName: 'cws_weekly_users',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, STATUS.MISSING);
  assert.equal(r.value, null);
});

test('an undeclared metric cannot be served at all', () => {
  const r = evaluateMetric({
    contract, manifest: [], metricName: 'cws_invented_metric',
    now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, STATUS.NO_CONTRACT);
  assert.match(r.reason, /not declared in config\/portfolio.yaml/);
});

test('a rule requiring a stale input is undecidable and names it', () => {
  const manifest = withImport({ as_of: '2026-09-01', metrics: { cws_installs: 12 } });
  const r = evaluateRule({
    contract, manifest,
    rule: { id: 'EXP-0001-guardrail', requires: ['cws_installs', 'cws_listing_page_views'] },
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });

  assert.equal(r.decidability, DECIDABILITY.UNDECIDABLE);
  assert.equal(r.verdict, 'insufficient_data');
  const named = r.blocking_inputs.map((b) => b.metric);
  assert.ok(named.includes('cws_installs'), 'the stale input is named');
  assert.ok(named.includes('cws_listing_page_views'), 'the missing input is named');
});

test('the product verdict is insufficient_data naming every stale input', () => {
  const manifest = withImport({ as_of: '2026-09-01', metrics: { cws_installs: 12 } });
  const v = productVerdict({
    contract, manifest,
    rules: [{ id: 'r1', requires: ['cws_installs'] }, { id: 'r2', requires: ['cws_impressions'] }],
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });

  assert.equal(v.verdict, 'insufficient_data');
  assert.deepEqual(v.stale_or_missing_inputs, ['cws_impressions', 'cws_installs']);
  assert.equal(v.message, 'insufficient_data: cws_impressions, cws_installs');
});

test('wau_growth_monthly is undecidable while its source metric has no import', () => {
  const manifest = withImport({ as_of: '2026-09-27', metrics: { wau_growth_monthly: 40 } });
  const r = evaluateRule({
    contract, manifest, rule: { id: 'growth', requires: ['wau_growth_monthly'] },
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
    historyWeeks: { wau_growth_monthly: 1 },
  });
  assert.equal(r.decidability, DECIDABILITY.UNDECIDABLE);
  // wau_growth_monthly derives from cws_weekly_users, which has no import
  // here, so the input gate fires before the history gate. Both block.
  assert.match(r.blocking_inputs[0].reason, /cws_weekly_users is missing/);
});

test('wau_growth_monthly stays undecidable even with ample declared history', () => {
  const manifest = withImport({ as_of: '2026-09-27', metrics: { wau_growth_monthly: 5 } });
  const r = evaluateRule({
    contract, manifest, rule: { id: 'growth', requires: ['wau_growth_monthly'] },
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
    historyWeeks: { wau_growth_monthly: 20 },
  });
  assert.equal(r.decidability, DECIDABILITY.UNDECIDABLE);
  assert.match(r.blocking_inputs.map((b) => b.reason).join(' '), /cws_weekly_users is missing/);
});

test('every forbidden alias in portfolio.yaml is enforced, in both directions', () => {
  // An array, not a Map: cws_weekly_users appears in more than one pair and a
  // Map keyed on the first element silently dropped one of its bans.
  assert.ok(contract.forbiddenAliases.length >= 6);
  for (const { pair } of contract.forbiddenAliases) {
    const [a, b] = pair;
    assert.throws(() => assertNotAliased(contract, a, b), /forbidden alias/, `${a} -> ${b}`);
    assert.throws(() => assertNotAliased(contract, b, a), /forbidden alias/, `${b} -> ${a}`);
  }
});

test('the two aliases that matter most are banned by name', () => {
  assert.throws(() => assertNotAliased(contract, 'cws_weekly_users', 'true_wau'), /reads higher/);
  assert.throws(() => assertNotAliased(contract, 'play_active_devices_30d', 'cws_weekly_users'), /forbidden alias/);
  // Three quantities, three names — and unrelated pairs stay legal.
  assert.doesNotThrow(() => assertNotAliased(contract, 'cws_installs', 'cws_impressions'));
});

// ---- derived metrics resolve freshness through their inputs ----

test('a derived metric is fresh only when all its inputs are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-derived-'));
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-27', exported_at: '2026-09-28T10:00:00Z', checksum: 'a',
    metrics: { cws_installs: 12, cws_listing_page_views: 570 },
  }));
  const r = evaluateMetric({
    contract, manifest: readManifest(dir), metricName: 'store_listing_conversion',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, STATUS.FRESH);
  assert.deepEqual(r.derived_from, ['cws_installs', 'cws_listing_page_views']);
  assert.deepEqual(r.input_values, { cws_installs: 12, cws_listing_page_views: 570 });
});

test('a derived metric inherits the WORST input age, not the best', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-derived-'));
  // Page views fresh, installs three weeks stale. The ratio is as old as the
  // numerator; serving it as current would be exactly the silent-staleness bug.
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-05', exported_at: '2026-09-06T10:00:00Z', checksum: 'a',
    metrics: { cws_installs: 12 },
  }));
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-28', exported_at: '2026-09-28T10:00:00Z', checksum: 'b',
    metrics: { cws_listing_page_views: 570 },
  }));
  const r = evaluateMetric({
    contract, manifest: readManifest(dir), metricName: 'store_listing_conversion',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, STATUS.STALE);
  assert.equal(r.value, null);
  assert.equal(r.age_days, 24, 'the worst input governs');
  assert.match(r.reason, /cws_installs is stale/);
});

test('contribution surfaces its undeclared terms instead of treating them as zero', () => {
  const r = evaluateMetric({
    contract, manifest: [], metricName: 'contribution',
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.notEqual(r.status, STATUS.FRESH);
  const undeclared = r.input_statuses
    .filter((i) => i.status === STATUS.NO_CONTRACT).map((i) => i.metric);
  assert.ok(undeclared.includes('marketing'), '`marketing` is referenced but never declared');
  assert.ok(undeclared.includes('other'), '`other` is referenced but never declared');
});

test('APP-163: rating fields come from the public listing, not the dashboard export', () => {
  assert.equal(contract.metrics.cws_rating_average.source, 'cws_public_listing');
  assert.equal(contract.metrics.cws_rating_count.source, 'cws_public_listing');
  assert.equal(contract.metrics.cws_rating_average.available_today, true,
    'nothing has to be provisioned to read an anonymous public page');
});

test('the CWS "Weekly users" header is flagged unconfirmed until a real export lands', () => {
  assert.equal(contract.metrics.cws_weekly_users.field_confirmed, false);
  assert.match(contract.metrics.cws_weekly_users.definition_warning,
    /doesn't monitor whether users are active/);
  assert.match(contract.metrics.cws_weekly_users.definition_warning,
    /DO NOT feed the public listing page's "users" figure/);
});
