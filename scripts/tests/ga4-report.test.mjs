import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseGa4Report, buildRunReportRequest, assertNotDashboardFamily, ga4Provenance,
  EVENT_MAP, FORBIDDEN_METRICS, WITHHELD_IS_NOT_ZERO, RETENTION_DAYS, SCOPE, SOURCE,
} from '../lib/ga4-report.mjs';

const fixture = (name) =>
  fileURLToPath(new URL(`./fixtures/ga4-runreport-${name}SYNTHETIC.json`, import.meta.url));

const FULL = fixture('');
const WITHHELD = fixture('withheld-');
const ZERO = fixture('zero-');
const EMPTY = fixture('empty-');

const opts = { item_id: 'json-workbench', exported_at: '2026-09-28T09:00:00Z' };
const parse = (path = FULL, extra = {}) => parseGa4Report(readFileSync(path), { ...opts, ...extra });

// ---------------------------------------------------------------------------
// The APP-215 promise: a withheld day is `missing`, never 0.
//
// Three cases, because the distinction only means something if all three are
// held apart: a row that is absent, a row that says zero, and a response with
// no rows at all.
// ---------------------------------------------------------------------------

test('a withheld event lands as ABSENT from metrics, never as 0', () => {
  const parsed = parse(WITHHELD);
  assert.equal(parsed.as_of, '2026-09-27');
  // The as_of day carries page_view but no install row.
  assert.equal(parsed.metrics.ga4_listing_page_views, 29);
  assert.equal(
    'ga4_install_events' in parsed.metrics, false,
    'a thresholded day must not appear in `metrics` at all'
  );
  assert.notEqual(parsed.metrics.ga4_install_events, 0, 'writing 0 here would fabricate a reading');
  // ...and the omission is NAMED, so a reader does not have to notice an
  // absence to know it happened.
  const withheld = parsed.withheld_metrics.map((w) => w.metric);
  assert.deepEqual(withheld, ['ga4_install_events']);
  assert.equal(parsed.withheld_metrics[0].reason_code, WITHHELD_IS_NOT_ZERO.reason_code);
  assert.match(parsed.withheld_metrics[0].recorded_as, /NEVER 0/);
});

test('an explicit 0 from GA4 is a real reading and is recorded as 0', () => {
  const parsed = parse(ZERO);
  // The mirror image of the test above, and the reason absence cannot simply
  // be mapped to zero: both of these days exist, and they mean different
  // things.
  assert.equal(parsed.metrics.ga4_install_events, 0);
  assert.ok('ga4_install_events' in parsed.metrics);
  assert.deepEqual(parsed.withheld_metrics, []);
});

test('a response with no rows writes nothing at all, rather than zeroes', () => {
  // GA4 omits `rows` entirely when every combination was thresholded. There
  // is no manifest entry to write, and that is correct: with no entry the
  // freshness contract reports the metric `missing`.
  assert.throws(
    () => parse(EMPTY),
    (err) => {
      assert.match(err.message, /zero rows/);
      assert.match(err.message, /Recording NOTHING, on purpose/);
      assert.equal(err.reason_code, WITHHELD_IS_NOT_ZERO.reason_code);
      return true;
    }
  );
});

test('an empty eventCount string is not a zero either', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.rows[1].metricValues[0].value = '';
  const parsed = parseGa4Report(doc, opts);
  assert.equal('ga4_install_events' in parsed.metrics, false);
  assert.deepEqual(parsed.withheld_metrics.map((w) => w.metric), ['ga4_install_events']);
});

// ---------------------------------------------------------------------------
// No synthesis, no aggregation
// ---------------------------------------------------------------------------

test('values come from the as_of DAY, not from a sum across days', () => {
  const parsed = parse();
  // The fixture's daily installs are 4, 6, 3. The sum is 13 and the as_of day
  // is 3; they differ on purpose so the assertion can tell them apart.
  assert.equal(parsed.as_of, '2026-09-27');
  assert.equal(parsed.metrics.ga4_install_events, 3);
  assert.notEqual(parsed.metrics.ga4_install_events, 13, 'a three-day sum would be a fabrication');
  assert.equal(parsed.metrics.ga4_listing_page_views, 29);
  assert.notEqual(parsed.metrics.ga4_listing_page_views, 41 + 38 + 29);
  assert.deepEqual(parsed.synthesized_metrics, []);
  assert.match(parsed.aggregation, /^none —/);
});

test('two rows for the same (date, event) are refused, not summed', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.rows.push({
    dimensionValues: [{ value: '20260927' }, { value: 'install' }],
    metricValues: [{ value: '5' }],
  });
  assert.throws(() => parseGa4Report(doc, opts), /refusing to sum them/);
});

test('`as_of` comes from the response, and GA4 YYYYMMDD is normalised', () => {
  const parsed = parse();
  assert.equal(parsed.as_of, '2026-09-27');
  assert.equal(parsed.as_of_source, 'runReport `date` dimension');
  assert.equal(parsed.source, SOURCE);
});

test('rows GA4 could not date — `(other)` — are reported, never counted', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.rows.push({
    dimensionValues: [{ value: '(other)' }, { value: 'install' }],
    metricValues: [{ value: '99' }],
  });
  const parsed = parseGa4Report(doc, opts);
  assert.equal(parsed.metrics.ga4_install_events, 0, 'the (other) row must not contribute');
  assert.deepEqual(parsed.undated_rows, ['(other)']);
});

// ---------------------------------------------------------------------------
// GA4 is never the dashboard family
// ---------------------------------------------------------------------------

test('the dashboard-family guard fires on every banned name', () => {
  for (const bad of FORBIDDEN_METRICS) {
    assert.throws(
      () => assertNotDashboardFamily({ [bad]: 7 }),
      /refusing to emit/,
      `\`${bad}\` must be refused`
    );
  }
  assert.deepEqual(assertNotDashboardFamily({ ga4_install_events: 3 }), { ga4_install_events: 3 });
});

test('EVENT_MAP cannot be edited into emitting a dashboard metric without failing', () => {
  // Guards the guard: if someone remaps `install` onto `cws_installs` to make
  // store_listing_conversion "work", the parse throws rather than writing a
  // manifest entry that silently mixes instruments.
  const original = EVENT_MAP[0].metric;
  assert.equal(EVENT_MAP.some((e) => FORBIDDEN_METRICS.includes(e.metric)), false, 'clean today');
  EVENT_MAP[0].metric = 'cws_installs';
  try {
    assert.throws(() => parse(), /refusing to emit `cws_installs`/);
  } finally {
    EVENT_MAP[0].metric = original;   // restored, so test order cannot matter
  }
});

// ---------------------------------------------------------------------------
// Second-hand-schema honesty, and the things the response has to tell us
// ---------------------------------------------------------------------------

test('every mapping is unconfirmed, and the provenance says so', () => {
  assert.ok(EVENT_MAP.length > 0);
  assert.ok(EVENT_MAP.every((e) => e.confirmed === false), 'no real GA4 property has been read');
  const prov = ga4Provenance(parse());
  assert.deepEqual(
    [...prov.unconfirmed_mappings].sort(),
    ['ga4_install_events', 'ga4_listing_page_views']
  );
});

test('unmapped event names are reported, never silently dropped', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.rows.push({
    dimensionValues: [{ value: '20260927' }, { value: 'session_start' }],
    metricValues: [{ value: '17' }],
  });
  const parsed = parseGa4Report(doc, opts);
  assert.deepEqual(parsed.unmapped_events, ['session_start']);
  assert.ok(parsed.events_verbatim.includes('session_start'));
});

test('the property timezone is carried through, because lag_days is UTC', () => {
  const parsed = parse();
  assert.equal(parsed.property_time_zone, 'America/Los_Angeles');
});

test('both metrics carry their "this is not the dashboard figure" caveat', () => {
  const parsed = parse();
  assert.match(parsed.semantic_caveats.ga4_install_events, /NOT `cws_installs`/);
  assert.match(parsed.semantic_caveats.ga4_listing_page_views, /NOT `cws_listing_page_views`/);
  assert.match(parsed.semantic_caveats.ga4_listing_page_views, /store_listing_conversion/);
});

test('the entry declares that this source never backfills', () => {
  const parsed = parse();
  assert.equal(parsed.backfillable, false);
  assert.equal(parsed.retention_days, RETENTION_DAYS);
});

// ---------------------------------------------------------------------------
// Responses that are not what we asked for
// ---------------------------------------------------------------------------

test('an API error body is named as an error, not read as "all withheld"', () => {
  const doc = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'caller lacks permission' } };
  assert.throws(() => parseGa4Report(doc, opts), /API error \(403 PERMISSION_DENIED\).*caller lacks permission/s);
});

test('a response missing the date or eventName dimension is refused', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.dimensionHeaders = [{ name: 'eventName' }];
  assert.throws(() => parseGa4Report(doc, opts), /must include `date` and `eventName`/);
});

test('a response without eventCount is refused', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.metricHeaders = [{ name: 'activeUsers' }];
  assert.throws(() => parseGa4Report(doc, opts), /must include `eventCount`/);
});

test('a non-numeric eventCount is refused rather than coerced', () => {
  const doc = JSON.parse(readFileSync(ZERO, 'utf8'));
  doc.rows[1].metricValues[0].value = 'n/a';
  assert.throws(() => parseGa4Report(doc, opts), /not a number/);
});

// ---------------------------------------------------------------------------
// The request half — deterministic, and holds no credential
// ---------------------------------------------------------------------------

const REQ = { propertyId: '123456789', startDate: '2026-09-01', endDate: '2026-09-29', now: '2026-09-30T00:00:00Z' };

test('the request asks for exactly the two events, on the one scope', () => {
  const req = buildRunReportRequest(REQ);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport');
  assert.equal(req.scope, SCOPE);
  assert.equal(req.scope, 'https://www.googleapis.com/auth/analytics.readonly');
  assert.deepEqual(req.body.dimensions, [{ name: 'date' }, { name: 'eventName' }]);
  assert.deepEqual(req.body.metrics, [{ name: 'eventCount' }]);
  assert.deepEqual(
    req.body.dimensionFilter.filter.inListFilter.values,
    EVENT_MAP.map((e) => e.event_name)
  );
});

test('the request object carries no credential of any kind', () => {
  const req = buildRunReportRequest(REQ);
  const serialised = JSON.stringify(req);
  for (const smell of ['token', 'refresh', 'client_secret', 'Authorization', 'Bearer', 'assertion']) {
    assert.ok(
      !new RegExp(smell, 'i').test(serialised.replace(/attaches the OAuth bearer token[^"]*/i, '')),
      `the request must not carry anything matching /${smell}/i`
    );
  }
});

test('the extension id is refused where the NUMERIC property id belongs', () => {
  // The CWS-created property is NAMED with the extension id, which makes this
  // the single most likely first-attempt mistake.
  assert.throws(
    () => buildRunReportRequest({ ...REQ, propertyId: 'abcdefghijklmnopabcdefghijklmnop' }),
    /is not numeric.*NAMED\s+with the extension id/s
  );
});

test('a window older than retention is refused, not sent', () => {
  // GA4 answers an out-of-retention window with an empty row set, which is
  // indistinguishable from total thresholding. Failing on the request is far
  // better than debugging that from the response.
  assert.throws(
    () => buildRunReportRequest({ ...REQ, startDate: '2026-01-01' }),
    /older than GA4's 60-day retention/
  );
  // and the boundary is inclusive, not off by one
  assert.ok(buildRunReportRequest({ ...REQ, startDate: '2026-08-01' }));
});

test('a reversed or malformed window is refused', () => {
  assert.throws(() => buildRunReportRequest({ ...REQ, startDate: '2026-09-29', endDate: '2026-09-01' }), /is after/);
  assert.throws(() => buildRunReportRequest({ ...REQ, startDate: '09/01/2026' }), /YYYY-MM-DD/);
  assert.throws(() => buildRunReportRequest({ ...REQ, propertyId: '' }), /requires `propertyId`/);
});
