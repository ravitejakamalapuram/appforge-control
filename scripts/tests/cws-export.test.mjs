import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCwsExport, parseCsv, headerProvenance, HEADER_MAP, NOT_IN_DASHBOARD_EXPORT, SOURCE,
} from '../lib/cws-export.mjs';
import { sha256 } from '../lib/metrics-manifest.mjs';

const CSV = [
  'Date,Weekly users,Installs,Uninstalls,Listing page views,Impressions',
  '2026-09-20,4,9,1,480,5100',
  '2026-09-27,5,12,2,570,6200',
].join('\n') + '\n';

const opts = { item_id: 'json-workbench', exported_at: '2026-09-28T10:00:00Z' };

test('csv parsing handles quoted fields containing commas', () => {
  const rows = parseCsv('a,b\n"x,y",2\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,y', '2']]);
});

test('as_of comes from the export, never from the clock', () => {
  const p = parseCwsExport(CSV, opts);
  assert.equal(p.as_of, '2026-09-27', 'the newest data date the file carries');
  assert.equal(p.as_of_source, 'Date', 'which column it was read out of, for audit');
  assert.equal(p.exported_on, '2026-09-28');
});

test('an export with no date column is refused rather than dated by assumption', () => {
  assert.throws(
    () => parseCwsExport('Weekly users,Installs\n5,12\n', opts),
    /no date column found/
  );
});

test('an export whose date column holds no dates is refused', () => {
  assert.throws(
    () => parseCwsExport('Date,Installs\nlast week,12\n', opts),
    /cannot establish `as_of`/
  );
});

test('an empty export is refused rather than recorded as zeroes', () => {
  assert.throws(() => parseCwsExport('Date,Installs\n', opts), /no data rows/);
});

test('headers are preserved verbatim — this is the APP-54 deliverable', () => {
  const p = parseCwsExport(CSV, opts);
  assert.deepEqual(p.headers_verbatim,
    ['Date', 'Weekly users', 'Installs', 'Uninstalls', 'Listing page views', 'Impressions']);
  // Case and spacing are NOT normalised away: the literal string is the answer
  // to "is the users figure weekly-active or cumulative".
  assert.ok(p.headers_verbatim.includes('Weekly users'));
});

test('values are taken from the as_of row, not the first or last row', () => {
  const p = parseCwsExport(CSV, opts);
  assert.equal(p.metrics.cws_weekly_users, 5);
  assert.equal(p.metrics.cws_installs, 12);
  assert.equal(p.metrics.cws_uninstalls, 2);
  assert.equal(p.metrics.cws_listing_page_views, 570);
  assert.equal(p.metrics.cws_impressions, 6200);
});

test('rows out of order still resolve to the newest date', () => {
  const shuffled = [
    'Date,Installs',
    '2026-09-27,12',
    '2026-09-13,3',
    '2026-09-20,9',
  ].join('\n') + '\n';
  const p = parseCwsExport(shuffled, opts);
  assert.equal(p.as_of, '2026-09-27');
  assert.equal(p.metrics.cws_installs, 12);
});

test('thousands separators parse as numbers', () => {
  const p = parseCwsExport('Date,Impressions\n2026-09-27,"12,400"\n', opts);
  assert.equal(p.metrics.cws_impressions, 12400);
});

test('unrecognised columns are reported, never silently dropped', () => {
  const p = parseCwsExport('Date,Installs,Some New Column\n2026-09-27,12,7\n', opts);
  assert.deepEqual(p.unmapped_headers, ['Some New Column'],
    'an unknown column means the export schema changed and must be visible');
});

test('the checksum is over the raw bytes', () => {
  assert.equal(parseCwsExport(CSV, opts).checksum, sha256(CSV));
});

test('APP-163: the dashboard export carries five fields, not seven', () => {
  assert.equal(HEADER_MAP.length, 5);
  const mapped = HEADER_MAP.map((r) => r.metric);
  assert.ok(!mapped.includes('cws_rating_average'));
  assert.ok(!mapped.includes('cws_rating_count'));
  assert.deepEqual(NOT_IN_DASHBOARD_EXPORT, ['cws_rating_average', 'cws_rating_count']);
});

test('every header mapping is flagged unconfirmed until a real export lands', () => {
  assert.ok(HEADER_MAP.every((r) => r.confirmed === false),
    'no CWS export has ever been seen; every mapping is an expectation');
  const p = headerProvenance(parseCwsExport(CSV, opts));
  assert.equal(p.unconfirmed_mappings.length, 5);
  assert.deepEqual(p.not_in_this_export, ['cws_rating_average', 'cws_rating_count']);
});

test('item_id and exported_at are required, not inferred', () => {
  assert.throws(() => parseCwsExport(CSV, { exported_at: opts.exported_at }), /item_id/);
  assert.throws(() => parseCwsExport(CSV, { item_id: 'x' }), /exported_at/);
});

test('the parser derives nothing from the magnitude or direction of a value', () => {
  // APP-58 ruled the 5->3 drop circular evidence. A decreasing series must
  // parse identically to an increasing one and set no interpretive field.
  const falling = 'Date,Weekly users\n2026-09-20,5\n2026-09-27,3\n';
  const rising  = 'Date,Weekly users\n2026-09-20,3\n2026-09-27,5\n';
  const a = parseCwsExport(falling, opts);
  const b = parseCwsExport(rising, opts);
  assert.equal(a.source, SOURCE);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
    'no field may appear only when the series falls');
  for (const p of [a, b]) {
    assert.ok(!('cumulative' in p) && !('weekly_active' in p) && !('interpretation' in p));
  }
});
