import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runImport } from '../metrics-import.mjs';
import { readManifest } from '../lib/metrics-manifest.mjs';
import { buildStatus } from '../metrics-status.mjs';
import { evaluateRule, loadContract, DECIDABILITY, STATUS } from '../lib/metrics-freshness.mjs';

import { fileURLToPath } from 'node:url';

// Resolve from this file, not from cwd: `npm test` runs with cwd=scripts/
// while an ad-hoc `node --test scripts/tests/...` runs from the repo root.
const PORTFOLIO = fileURLToPath(new URL('../../config/portfolio.yaml', import.meta.url));



const CSV = [
  'Date,Weekly users,Installs,Uninstalls,Listing page views,Impressions',
  '2026-09-20,4,9,1,480,5100',
  '2026-09-27,5,12,2,570,6200',
].join('\n') + '\n';

function stage(csv = CSV) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-import-'));
  const file = join(dir, 'export.csv');
  writeFileSync(file, csv);
  return { dir, file };
}

test('a full import writes a manifest entry with a derived lag', () => {
  const { dir, file } = stage();
  const { entry } = runImport({
    source: 'cws', item: 'json-workbench', file,
    data_root: dir, exported_at: '2026-09-28T10:00:00Z',
  });

  assert.equal(entry.source, 'cws_dashboard_export');
  assert.equal(entry.item_id, 'json-workbench');
  assert.equal(entry.as_of, '2026-09-27');
  assert.equal(entry.lag_days, 1, 'derived from as_of and exported_at, not configured');
  assert.equal(entry.metrics.cws_installs, 12);
  assert.ok(entry.checksum.length === 64);
  assert.equal(readManifest(dir).length, 1);
});

test('the raw export is kept alongside the manifest for later audit', () => {
  const { dir, file } = stage();
  const { entry } = runImport({
    source: 'cws', item: 'json-workbench', file,
    data_root: dir, exported_at: '2026-09-28T10:00:00Z',
  });
  assert.ok(existsSync(entry.raw_path), 'the artefact behind the numbers must survive');
  assert.equal(readFileSync(entry.raw_path, 'utf8'), CSV);
});

test('verbatim headers reach the manifest, so the question is answerable later', () => {
  const { dir, file } = stage();
  const { entry, provenance } = runImport({
    source: 'cws', item: 'json-workbench', file,
    data_root: dir, exported_at: '2026-09-28T10:00:00Z',
  });
  assert.ok(entry.notes.headers_verbatim.includes('Weekly users'));
  assert.equal(provenance.observed_headers.length, 6);
});

test('an unimplemented source fails loudly rather than writing a half entry', () => {
  const { dir, file } = stage();
  assert.throws(
    () => runImport({ source: 'play', item: 'invtrack', file, data_root: dir }),
    /Play read-only service account is not provisioned/
  );
  assert.equal(readManifest(dir).length, 0);
});

test('required arguments are enforced', () => {
  const { dir, file } = stage();
  assert.throws(() => runImport({ item: 'x', file, data_root: dir }), /--source/);
  assert.throws(() => runImport({ source: 'cws', file, data_root: dir }), /--item/);
  assert.throws(() => runImport({ source: 'cws', item: 'x', data_root: dir }), /--file/);
});

// ---- END TO END: the acceptance criterion, through both CLIs ----

test('END TO END: a fresh import reads back fresh, the same import reads stale later', () => {
  const { dir, file } = stage();
  runImport({
    source: 'cws', item: 'json-workbench', file,
    data_root: dir, exported_at: '2026-09-28T10:00:00Z',
  });

  const fresh = buildStatus({
    portfolioPath: PORTFOLIO, dataRoot: dir, itemId: 'json-workbench',
    now: new Date('2026-09-29T00:00:00Z'),
  });
  const installs = fresh.rows.find((r) => r.metric === 'cws_installs');
  assert.equal(installs.status, STATUS.FRESH);
  assert.equal(installs.value, 12);

  // Same manifest, same data. Only the clock moved past max_age_days: 14.
  const later = buildStatus({
    portfolioPath: PORTFOLIO, dataRoot: dir, itemId: 'json-workbench',
    now: new Date('2026-10-20T00:00:00Z'),
  });
  const staleInstalls = later.rows.find((r) => r.metric === 'cws_installs');
  assert.equal(staleInstalls.status, STATUS.STALE);
  assert.equal(staleInstalls.value, null, 'last week\'s number is NOT served as current');
  assert.equal(staleInstalls.withheld_value, 12);
  assert.ok(later.stale.length >= 5, 'every CWS metric from that export goes stale together');
});

test('a skipped export makes the dependent rule undecidable', () => {
  const { dir, file } = stage();
  runImport({
    source: 'cws', item: 'json-workbench', file,
    data_root: dir, exported_at: '2026-09-28T10:00:00Z',
  });

  const contract = loadContract(PORTFOLIO);
  const manifest = readManifest(dir);
  const rule = { id: 'EXP-0001-primary', requires: ['store_listing_conversion'] };

  const onTime = evaluateRule({
    contract, manifest, rule, itemId: 'json-workbench',
    now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(onTime.decidability, DECIDABILITY.DECIDABLE);

  const skipped = evaluateRule({
    contract, manifest, rule, itemId: 'json-workbench',
    now: new Date('2026-10-20T00:00:00Z'),
  });
  assert.equal(skipped.decidability, DECIDABILITY.UNDECIDABLE);
  assert.equal(skipped.verdict, 'insufficient_data');
  assert.equal(skipped.blocking_inputs[0].metric, 'store_listing_conversion');
});

// ---- the min_n / min_history_weeks gates, on a synthetic contract ----
// Real derived metrics resolve through `inputs` before these gates are
// reached, so they are exercised here directly to keep them covered.

const synthetic = {
  metrics: {
    plain_metric: { source: 'cws_dashboard_export', max_age_days: 14, min_n: 30, min_history_weeks: 12 },
  },
  forbiddenAliases: [],
};

test('min_n blocks a fresh value below the declared noise floor', () => {
  const { dir, file } = stage();
  runImport({ source: 'cws', item: 'json-workbench', file, data_root: dir,
    exported_at: '2026-09-28T10:00:00Z' });
  const manifest = readManifest(dir).map((e) => ({ ...e, metrics: { plain_metric: 5 } }));

  const r = evaluateRule({
    contract: synthetic, manifest, rule: { id: 'r', requires: ['plain_metric'] },
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
    historyWeeks: { plain_metric: 20 },
  });
  assert.equal(r.decidability, DECIDABILITY.UNDECIDABLE);
  assert.match(r.blocking_inputs.map((b) => b.reason).join(' '), /min_n=30/);
});

test('min_history_weeks blocks a value with too little export history', () => {
  const { dir, file } = stage();
  runImport({ source: 'cws', item: 'json-workbench', file, data_root: dir,
    exported_at: '2026-09-28T10:00:00Z' });
  const manifest = readManifest(dir).map((e) => ({ ...e, metrics: { plain_metric: 100 } }));

  const r = evaluateRule({
    contract: synthetic, manifest, rule: { id: 'r', requires: ['plain_metric'] },
    itemId: 'json-workbench', now: new Date('2026-09-29T00:00:00Z'),
    historyWeeks: { plain_metric: 1 },
  });
  assert.equal(r.decidability, DECIDABILITY.UNDECIDABLE);
  assert.match(r.blocking_inputs.map((b) => b.reason).join(' '), /min_history_weeks=12/);
  assert.match(r.blocking_inputs.map((b) => b.reason).join(' '), /1 week\(s\) of export history/);
});
