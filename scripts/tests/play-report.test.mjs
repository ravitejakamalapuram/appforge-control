import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parsePlayReport, decodeReport, assertNoWeeklySynthesis, playProvenance,
  HEADER_MAP, FORBIDDEN_METRICS, FAMILY_CHOICE, WEEKLY_DISTINCT_UNAVAILABLE, SOURCE,
} from '../lib/play-report.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/play-installs-SYNTHETIC.csv', import.meta.url));
const FIXTURE_UTF16 = fileURLToPath(new URL('./fixtures/play-installs-utf16le-SYNTHETIC.csv', import.meta.url));

const opts = { item_id: 'invtrack', exported_at: '2026-09-28T09:00:00Z' };
const load = (p = FIXTURE) => readFileSync(p);
const parse = (p = FIXTURE, extra = {}) => parsePlayReport(load(p), { ...opts, ...extra });

test('as_of is the newest date the report carries, read from its own column', () => {
  const parsed = parse();
  assert.equal(parsed.source, SOURCE);
  assert.equal(parsed.as_of, '2026-09-27');
  assert.equal(parsed.as_of_source, 'Date');
});

test('a report with no date column is refused, never dated by assumption', () => {
  assert.throws(
    () => parsePlayReport('Package Name,Daily Device Installs\nx,4\n', opts),
    /no date column found/
  );
});

// ---------------------------------------------------------------------------
// The APP-210 promise, mechanically. Three independent checks, because a
// comment saying "we do not synthesize weekly figures" is not evidence.
// ---------------------------------------------------------------------------

test('values come from the as_of ROW, not from a sum across rows', () => {
  const parsed = parse();
  // The fixture's Daily Device Installs are 4, 6, 3. The sum is 13 and the
  // as_of row is 3; these differ on purpose so the assertion can tell them
  // apart.
  assert.equal(parsed.metrics.play_installs, 3, 'the 2026-09-27 row');
  assert.notEqual(parsed.metrics.play_installs, 13, 'a three-day sum would be a fabrication');
  assert.equal(parsed.metrics.play_active_devices_30d, 26);
  assert.notEqual(parsed.metrics.play_active_devices_30d, 22 + 25 + 26);
  assert.equal(parsed.aggregation, 'none — single row, as_of');
  assert.deepEqual(parsed.synthesized_metrics, []);
});

test('no emitted metric carries a weekly-distinct name', () => {
  const parsed = parse();
  for (const name of Object.keys(parsed.metrics)) {
    assert.ok(!/weekly|wau/i.test(name), `Play emitted \`${name}\``);
    assert.ok(!FORBIDDEN_METRICS.includes(name));
  }
  assert.equal(parsed.weekly_distinct.available, false);
  assert.equal(parsed.weekly_distinct.reason_code, 'play_wau_unavailable');
});

test('the weekly guard fires on any weekly name, not just the two known ones', () => {
  for (const bad of ['cws_weekly_users', 'true_wau', 'play_weekly_active_devices', 'play_WAU']) {
    assert.throws(
      () => assertNoWeeklySynthesis({ [bad]: 7 }),
      /refusing to emit/,
      `\`${bad}\` must be refused`
    );
  }
  assert.deepEqual(assertNoWeeklySynthesis({ play_installs: 3 }), { play_installs: 3 });
});

test('HEADER_MAP cannot be edited into emitting a weekly metric without failing', () => {
  // Guards the guard: if someone adds a weekly row to HEADER_MAP, the parse of
  // a report containing that column throws rather than writing a manifest.
  const forbidden = HEADER_MAP.some((r) => /weekly|wau/i.test(r.metric));
  assert.equal(forbidden, false, 'HEADER_MAP is clean today');
  // unshift, not push: mapHeader returns on the first matching row, and
  // 'active device installs' is already claimed further down the list.
  HEADER_MAP.unshift({ metric: 'cws_weekly_users', expects: ['active device installs'], confirmed: false });
  try {
    assert.throws(() => parse(), /refusing to emit `cws_weekly_users`/);
  } finally {
    HEADER_MAP.shift();   // restored, so test order cannot matter
  }
});

// ---------------------------------------------------------------------------
// Second-hand-schema honesty
// ---------------------------------------------------------------------------

test('every mapping is unconfirmed, and says so in the provenance', () => {
  assert.ok(HEADER_MAP.length > 0);
  assert.ok(HEADER_MAP.every((r) => r.confirmed === false), 'no real Play report has landed');
  const prov = playProvenance(parse());
  assert.deepEqual(
    [...prov.unconfirmed_mappings].sort(),
    ['play_active_devices_30d', 'play_installs', 'play_rating_average', 'play_uninstalls']
  );
});

test('headers are recorded verbatim and unmapped columns are reported', () => {
  const parsed = parse();
  assert.ok(parsed.headers_verbatim.includes('Active Device Installs'));
  // The user-family columns are a deliberate non-mapping, not an oversight,
  // and they must still show up somewhere a reader will see them.
  for (const h of ['Daily User Installs', 'Daily User Uninstalls', 'Total User Installs']) {
    assert.ok(parsed.unmapped_headers.includes(h), `${h} must be reported, not dropped`);
  }
  assert.equal(parsed.family_choice, FAMILY_CHOICE.chosen);
});

test('the 30-day-active metric carries its semantic caveat into the manifest', () => {
  const parsed = parse();
  assert.match(parsed.semantic_caveats.play_active_devices_30d, /device activity, not app usage/);
  assert.match(parsed.semantic_caveats.play_active_devices_30d, /unconfirmed/);
});

// ---------------------------------------------------------------------------
// Encoding and attribution
// ---------------------------------------------------------------------------

test('encoding is detected from the BOM and recorded, not assumed', () => {
  assert.equal(decodeReport(Buffer.from('Date\n')).encoding_detected, 'utf-8 (no BOM)');
  assert.equal(
    decodeReport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Date\n', 'utf16le')])).encoding_detected,
    'utf-16le (BOM)'
  );
  assert.throws(
    () => decodeReport(Buffer.from([0xfe, 0xff, 0x00, 0x44])),
    /BIG-endian/,
    'reading big-endian as little-endian would transpose every character'
  );
});

test('a UTF-16LE report parses to the same numbers as its UTF-8 twin', () => {
  const utf8 = parse();
  const utf16 = parse(FIXTURE_UTF16);
  assert.equal(utf16.encoding_detected, 'utf-16le (BOM)');
  assert.deepEqual(utf16.metrics, utf8.metrics);
  assert.deepEqual(utf16.headers_verbatim, utf8.headers_verbatim);
  // Different bytes, so necessarily a different checksum: the checksum attests
  // to the artefact, not to the reading.
  assert.notEqual(utf16.checksum, utf8.checksum);
});

test('the package name is recorded verbatim — config does not know it yet', () => {
  assert.deepEqual(parse().package_names_verbatim, ['com.appforge.invtrack.SYNTHETIC']);
});

test('--package mismatch refuses rather than filing another app under this item', () => {
  assert.throws(
    () => parse(FIXTURE, { package: 'com.appforge.teleport' }),
    /refusing to file another app's numbers/
  );
  assert.ok(parse(FIXTURE, { package: 'com.appforge.invtrack.SYNTHETIC' }));
});

test('a report covering two packages cannot be attributed to one item', () => {
  const csv = [
    'Date,Package Name,Daily Device Installs',
    '2026-09-27,com.a,1',
    '2026-09-27,com.b,2',
  ].join('\n') + '\n';
  assert.throws(() => parsePlayReport(csv, opts), /covers 2 packages/);
});

test('the checksum is over the raw bytes, and the reason is quotable', () => {
  assert.equal(parse().checksum.length, 64);
  assert.match(WEEKLY_DISTINCT_UNAVAILABLE.reason, /counted\s+once per day/);
  assert.equal(WEEKLY_DISTINCT_UNAVAILABLE.ruling, 'DEC-0009 D5');
});
