// APP-42 / APP-163: the public-listing reader.
//
// The two tests that matter most are the refusals: an unrated item must not
// become "rated 0", and the listing's user count must never reach
// `cws_weekly_users`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCwsListing, listingProvenance, SOURCE } from '../lib/cws-listing.mjs';

const FETCHED = '2026-09-29T04:38:52Z';

// QA's verbatim 2026-09-29 capture of the json-workbench listing.
const QA_CAPTURE =
  '<div><h1>JSON Workbench</h1><span>5.0 ( 1 rating )</span><span>3 users</span>' +
  '<p>Ratings are updated daily and may not reflect the most recent reviews.</p></div>';

// What the REAL page looks like: our item, then a recommended-extensions
// carousel carrying other extensions' ratings. QA recorded 4.5 / 4.6 / 4.2.
const QA_CAPTURE_WITH_CAROUSEL =
  QA_CAPTURE +
  '<section>Recommended<span>4.5 ( 120 ratings )</span>' +
  '<span>4.6 ( 98 ratings )</span><span>4.2 ( 40 ratings )</span></section>';

test('parses QA\'s verbatim json-workbench capture', () => {
  const p = parseCwsListing(QA_CAPTURE, { item_id: 'json-workbench', fetched_at: FETCHED });
  assert.equal(p.source, SOURCE);
  assert.equal(p.metrics.cws_rating_average, 5.0);
  assert.equal(p.metrics.cws_rating_count, 1);
  assert.equal(p.rating_block_verbatim, '5.0 ( 1 rating )');
});

test('the listing user count is REFUSED, never mapped to cws_weekly_users', () => {
  const p = parseCwsListing(QA_CAPTURE, { item_id: 'json-workbench', fetched_at: FETCHED });
  // The trap: the listing says "3 users" and the dashboard said 5. Mapping
  // this would answer the open APP-54 question with the wrong instrument.
  assert.equal(p.metrics.cws_weekly_users, undefined);
  assert.ok(!Object.keys(p.metrics).some((k) => k.includes('user')));
  assert.equal(p.refused_fields.length, 1);
  assert.equal(p.refused_fields[0].field, 'users');
  assert.equal(p.refused_fields[0].observed, '3 users');
  assert.match(p.refused_fields[0].reason, /different instrument/);
});

test('an unrated item yields ABSENT ratings, not zero', () => {
  const p = parseCwsListing('<div><h1>Brand New Item</h1><span>0 users</span></div>', {
    item_id: 'fresh-item',
    fetched_at: FETCHED,
  });
  // "Not yet rated" is a different fact from "rated 0". A fabricated zero
  // would silently drag any portfolio-level average down.
  assert.equal(p.metrics.cws_rating_average, undefined);
  assert.equal(p.metrics.cws_rating_count, undefined);
  assert.deepEqual(p.absent_metrics, ['cws_rating_average', 'cws_rating_count']);
});

test('as_of comes from fetch time and says so, because the listing carries no date', () => {
  const p = parseCwsListing(QA_CAPTURE, { item_id: 'json-workbench', fetched_at: FETCHED });
  assert.equal(p.as_of, '2026-09-29');
  assert.match(p.as_of_source, /carries no as-of date/);
  // lag_days will be 0 downstream; this flag records that the zero is
  // structural (unobservable lag), not a measured refresh delay.
  assert.equal(p.lag_observable, false);
});

test('plural ratings and thousands separators parse', () => {
  const p = parseCwsListing('<span>4.7 ( 1,284 ratings )</span>', {
    item_id: 'popular',
    fetched_at: FETCHED,
  });
  assert.equal(p.metrics.cws_rating_average, 4.7);
  assert.equal(p.metrics.cws_rating_count, 1284);
});

test('an average above the 5-point scale is refused, not stored', () => {
  assert.throws(
    () => parseCwsListing('<span>9.1 ( 4 ratings )</span>', { item_id: 'x', fetched_at: FETCHED }),
    /exceeds the Chrome Web Store 5-point scale/
  );
});

test('an empty capture is refused rather than recorded as an empty import', () => {
  assert.throws(
    () => parseCwsListing('   ', { item_id: 'x', fetched_at: FETCHED }),
    /refusing to record an empty import/
  );
});

test('item_id and fetched_at are required', () => {
  assert.throws(() => parseCwsListing(QA_CAPTURE, { fetched_at: FETCHED }), /requires `item_id`/);
  assert.throws(() => parseCwsListing(QA_CAPTURE, { item_id: 'x' }), /requires `fetched_at`/);
});

test('a script tag cannot smuggle a rating block', () => {
  const html = '<script>var fake = "5.0 ( 999 ratings )";</script><div>Unrated Item</div>';
  const p = parseCwsListing(html, { item_id: 'x', fetched_at: FETCHED });
  assert.equal(p.metrics.cws_rating_count, undefined);
  assert.deepEqual(p.absent_metrics, ['cws_rating_average', 'cws_rating_count']);
});

test('provenance reports refusals and absences, not just what was mapped', () => {
  const prov = listingProvenance(
    parseCwsListing(QA_CAPTURE, { item_id: 'json-workbench', fetched_at: FETCHED })
  );
  assert.deepEqual(prov.mapped, ['cws_rating_average', 'cws_rating_count']);
  assert.equal(prov.refused.length, 1);
  assert.equal(prov.lag_observable, false);
});

test('REFUSES rather than attributing a recommended extension\'s rating to our item', () => {
  // The page-wide-first-match bug this guards: on the real capture the
  // carousel's 4.5 would have been recorded as json-workbench's score and
  // would have looked completely plausible in the manifest.
  assert.throws(
    () =>
      parseCwsListing(QA_CAPTURE_WITH_CAROUSEL, {
        item_id: 'json-workbench',
        fetched_at: FETCHED,
      }),
    /found 4 rating blocks .* and no `scope` to tell them apart/s
  );
});

test('an explicit scope narrows to the item block and reads the right rating', () => {
  const p = parseCwsListing(QA_CAPTURE_WITH_CAROUSEL, {
    item_id: 'json-workbench',
    fetched_at: FETCHED,
    scope: 'JSON Workbench 5.0',
  });
  assert.equal(p.metrics.cws_rating_average, 5.0);
  assert.equal(p.metrics.cws_rating_count, 1);
  // The anchor did not exclude the carousel, and that stays visible rather
  // than passing as a clean single-block read.
  assert.equal(p.rating_blocks_in_range, 4);
  assert.equal(p.scope_applied, 'JSON Workbench 5.0');
});

test('a scope that is not present refuses instead of falling back to a page scan', () => {
  assert.throws(
    () =>
      parseCwsListing(QA_CAPTURE_WITH_CAROUSEL, {
        item_id: 'json-workbench',
        fetched_at: FETCHED,
        scope: 'Some Other Extension',
      }),
    /refusing to fall back to a page-wide scan/
  );
});

test('the page\'s own freshness sentence is kept verbatim, not converted to days', () => {
  const p = parseCwsListing(QA_CAPTURE, { item_id: 'json-workbench', fetched_at: FETCHED });
  assert.equal(
    p.declared_freshness,
    'Ratings are updated daily and may not reflect the most recent reviews.'
  );
  // "updated daily" must NOT have become a lag constant anywhere.
  assert.equal(p.lag_observable, false);
  assert.equal(p.metrics.lag_days, undefined);
});

// ---------------------------------------------------------------------------
// Attested extracts — the cycle-one path, made auditable
// ---------------------------------------------------------------------------

import { parseAttestedListing } from '../lib/cws-listing.mjs';

const ATTESTED = {
  captured_by: 'QA (APP-156)',
  captured_at: '2026-09-29T04:38:52Z',
  artifact_ref: 'APP-156 attachments',
  upstream_sha256: '04c8d1ff8151bea3be6586a43f2af54fef9c6a79a1b292b5fe64bb57f36422e5',
  rating_block_verbatim: '5.0 ( 1 rating )',
  declared_freshness: 'Ratings are updated daily and may not reflect the most recent reviews.',
  refused_observations: { users: '3 users' },
  http_status: 200,
  byte_length: 648234,
};

test('an attested extract carries the UPSTREAM checksum, not a local hash', () => {
  const p = parseAttestedListing(ATTESTED, { item_id: 'json-workbench' });
  // The checksum must attest to bytes somebody actually fetched. Hashing a
  // local reconstruction would put a checksum in the manifest for a file that
  // was never downloaded.
  assert.equal(p.checksum, ATTESTED.upstream_sha256);
  assert.equal(p.attestation.raw_artifact_present, false);
  assert.equal(p.attestation.captured_by, 'QA (APP-156)');
  assert.equal(p.metrics.cws_rating_average, 5.0);
  assert.equal(p.metrics.cws_rating_count, 1);
});

test('as_of is the CAPTURE date, so loading it later cannot make it look fresh', () => {
  const p = parseAttestedListing(ATTESTED, { item_id: 'json-workbench' });
  assert.equal(p.as_of, '2026-09-29');
  assert.equal(p.exported_at, '2026-09-29T04:38:52.000Z');
});

test('an extract without provenance is refused as an unsourced number', () => {
  for (const field of ['captured_by', 'captured_at', 'upstream_sha256', 'artifact_ref']) {
    const bad = { ...ATTESTED };
    delete bad[field];
    assert.throws(
      () => parseAttestedListing(bad, { item_id: 'x' }),
      (err) =>
        err.message.includes('missing provenance field') && err.message.includes(field),
      `expected refusal when ${field} is absent`
    );
  }
});

test('a non-sha256 upstream checksum is refused', () => {
  assert.throws(
    () => parseAttestedListing({ ...ATTESTED, upstream_sha256: 'deadbeef' }, { item_id: 'x' }),
    /is not a sha256 hex digest/
  );
});

test('values are parsed from the verbatim block so they cannot drift from it', () => {
  assert.throws(
    () => parseAttestedListing({ ...ATTESTED, rating_block_verbatim: 'five stars' }, { item_id: 'x' }),
    /does not match the listing rating format/
  );
});

test('an attested extract with no rating block yields absent, not zero', () => {
  const bare = { ...ATTESTED };
  delete bare.rating_block_verbatim;
  const p = parseAttestedListing(bare, { item_id: 'fresh' });
  assert.equal(p.metrics.cws_rating_average, undefined);
  assert.deepEqual(p.absent_metrics, ['cws_rating_average', 'cws_rating_count']);
});

test('the attested path refuses the users figure for the same reason as the HTML path', () => {
  const p = parseAttestedListing(ATTESTED, { item_id: 'json-workbench' });
  assert.equal(p.metrics.cws_weekly_users, undefined);
  assert.equal(p.refused_fields[0].field, 'users');
  assert.match(p.refused_fields[0].reason, /different instrument/);
});
