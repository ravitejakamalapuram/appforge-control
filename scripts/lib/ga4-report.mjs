// Chrome Web Store GA4 `runReport` response parser (APP-215, split out of APP-157).
//
// The Chrome Web Store, when the developer opts in on the Store listing tab,
// creates a GA4 property named with the extension id and emits `page_view`
// and a custom `install` event into it. See docs/metrics-ingest.md section 3.
//
// WHY THIS FILE PARSES A RESPONSE RATHER THAN MAKING THE CALL
// -----------------------------------------------------------------------
// The same reason play-report.mjs parses a downloaded file. This module opens
// no socket, reads no credential, and has no code path to one: the ingest job
// holds the OAuth refresh token, performs the POST, and hands the response
// bytes over. Sec 6.1 rule 4 ("no agent holds or requests a store
// credential") therefore holds STRUCTURALLY here, not by discipline -- the
// same property APP-210 chose for Play, and consistency across the two store
// paths is worth more than the convenience of an inlined fetch.
//
// `buildRunReportRequest` exists so the request half is still deterministic
// and testable without a credential: it emits the exact URL and body to POST.
// It takes a property id, never a token.
//
// FIVE DESIGN RULES
//
// 1. ABSENCE IS NOT ZERO. This is the rule this file exists for. CWS states
//    data "may be withheld if it doesn't meet system-defined thresholds", and
//    at single-digit install volumes that will happen routinely. GA4 signals
//    a thresholded day by OMITTING THE ROW -- there is no flag, no null, no
//    marker of any kind. So a missing row lands the metric as ABSENT from the
//    manifest entry (which the freshness contract reads as `missing`), and an
//    explicitly returned "0" lands as a real 0. Writing 0 for a withheld day
//    would be a fabricated reading.
//
// 2. NO CROSS-ROW AGGREGATION OF ONE QUANTITY. Values are read from the rows
//    whose date equals `as_of`. Two rows for the same (date, eventName) pair
//    are refused rather than summed -- if that ever happens the request shape
//    was not what we think it is, and summing would hide it.
//
// 3. `as_of` COMES FROM THE RESPONSE'S OWN `date` DIMENSION, never from the
//    requested date range. A range end is what we asked for; the dimension
//    value is what GA4 had.
//
// 4. GA4 IS NEVER THE DASHBOARD FAMILY. `assertNotDashboardFamily` throws if
//    this parser is ever made to emit `cws_installs` or
//    `cws_listing_page_views`. Those are the store's own accounting; these
//    are funnel events. `forbidden_aliases` bans both pairs downstream --
//    this is the same ban enforced at the point of emission, so a careless
//    edit to EVENT_MAP fails loudly instead of silently corrupting
//    `store_listing_conversion` (EXP-0001's primary metric).
//
// 5. THERE IS NO BACKFILL. CWS sets the property's data retention to two
//    months and Marketer cannot change it (section 3.5). Every reading is a
//    current-period reading; any history is history our own ingest
//    accumulated in durable rows.

import { sha256, utcCalendarDate } from './metrics-manifest.mjs';

export const SOURCE = 'ga4_cws_property';

/** The one scope. Widening this is a security change, not a convenience. */
export const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * CWS states "Data retention is set to two months", and changing retention is
 * a property-settings action that Marketer cannot perform. Sixty days is the
 * conservative reading of "two months" and is used to REFUSE a request window
 * that reaches further back -- GA4 answers such a request with an empty row
 * set, which is indistinguishable from total thresholding.
 */
export const RETENTION_DAYS = 60;

/**
 * Why a missing row is not a zero. Exported so the reason travels into the
 * manifest and can be quoted rather than paraphrased.
 */
export const WITHHELD_IS_NOT_ZERO = Object.freeze({
  rule: 'a day GA4 did not return is `missing`, never 0',
  reason:
    'Chrome Web Store applies de-identification thresholds and states data ' +
    '"may be withheld if it doesn\'t meet system-defined thresholds". GA4 ' +
    'signals a withheld combination by omitting the row entirely -- there is ' +
    'no flag, no null and no marker. A withheld day and a genuine zero are ' +
    'therefore distinguishable only by row PRESENCE, so this parser records a ' +
    'value only when a row exists.',
  reason_code: 'ga4_row_withheld_or_absent',
});

/**
 * Metric names this parser may never emit, whatever the events are called.
 *
 * Both are the dashboard-family counterparts of what GA4 measures. The pairs
 * are already in `forbidden_aliases`; this refuses the substitution one layer
 * earlier, at emission.
 */
export const FORBIDDEN_METRICS = Object.freeze([
  'cws_installs',              // the store's own install accounting (dashboard export)
  'cws_listing_page_views',    // the dashboard's own listing-page-views figure
  'cws_weekly_users',          // a weekly-distinct quantity; GA4 here is daily events
]);

/**
 * eventName -> metric. SECOND-HAND, like every other mapping in this ingest:
 * no CWS-managed GA4 property has ever been read by this repository, so the
 * event names below are Analyst's reading of Google's documentation and carry
 * `confirmed: false` until real rows prove them.
 */
export const EVENT_MAP = [
  {
    metric: 'ga4_install_events',
    event_name: 'install',
    confirmed: false,
    semantic_caveat:
      'NOT `cws_installs`. Google documents this custom event as "only sent ' +
      'if a user accepts the permission prompt to complete the install" -- a ' +
      'store-listing FUNNEL event. `cws_installs` is the store\'s own install ' +
      'accounting from the dashboard export. Two instruments on one quantity; ' +
      'they will not agree, and the gap is information, not an error to ' +
      'reconcile away.',
  },
  {
    metric: 'ga4_listing_page_views',
    event_name: 'page_view',
    confirmed: false,
    semantic_caveat:
      "NOT `cws_listing_page_views`. This is GA4's `page_view` on the store " +
      "listing as the store's own GA4 integration emits it; the dashboard " +
      'reports a separate listing-page-views figure. `store_listing_conversion` ' +
      'stays defined on the DASHBOARD family -- mixing a GA4 numerator with a ' +
      'dashboard denominator is the exact error `forbidden_aliases` exists to ' +
      'stop.',
  },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GA4_DATE_RE = /^\d{8}$/;

/**
 * Build the `runReport` request for one property and one date window.
 *
 * Returns the URL and body only. It never sees, takes, or returns a token:
 * the ingest job attaches the Authorization header from the Paperclip secret
 * bound to it. Marking `install` as a key event is NOT required -- this asks
 * for `eventCount` broken out by `eventName`, which needs no conversion
 * configuration (section 3.7).
 *
 * @param {object} opts
 * @param {string|number} opts.propertyId  the NUMERIC GA4 property id. The
 *   Data API does not accept the extension id, which is what the property is
 *   NAMED with -- an easy and silent confusion.
 * @param {string} opts.startDate  YYYY-MM-DD
 * @param {string} opts.endDate    YYYY-MM-DD
 * @param {Date|string} [opts.now] for the retention check
 */
export function buildRunReportRequest({ propertyId, startDate, endDate, now = new Date() }) {
  if (propertyId === undefined || propertyId === null || `${propertyId}`.trim() === '') {
    throw new Error('buildRunReportRequest requires `propertyId` (the NUMERIC GA4 property id)');
  }
  const property = `${propertyId}`.trim();
  if (!/^\d+$/.test(property)) {
    throw new Error(
      `propertyId ${JSON.stringify(property)} is not numeric. The CWS-created property is NAMED ` +
        'with the extension id, but the Data API takes the numeric property id — see ' +
        'docs/metrics-ingest.md section 3.'
    );
  }
  for (const [label, value] of [['startDate', startDate], ['endDate', endDate]]) {
    if (!value || !DATE_RE.test(value)) {
      throw new Error(`buildRunReportRequest requires \`${label}\` as YYYY-MM-DD, got ${JSON.stringify(value)}`);
    }
  }
  if (startDate > endDate) {
    throw new Error(`startDate ${startDate} is after endDate ${endDate}`);
  }

  // Refuse a window GA4 cannot answer. Retention is two months and we cannot
  // raise it; asking for older data returns an EMPTY row set, which this
  // parser would otherwise have to treat as "everything withheld". Failing on
  // the request is far better than debugging that from the response.
  const todayUtc = utcCalendarDate(now);
  const oldest = shiftDate(todayUtc, -RETENTION_DAYS);
  if (startDate < oldest) {
    throw new Error(
      `startDate ${startDate} is older than GA4's ${RETENTION_DAYS}-day retention (oldest queryable ${oldest}). ` +
        'CWS sets retention to two months and Marketer cannot raise it — GA4 would answer with no rows, ' +
        'which is indistinguishable from total thresholding. This source never backfills.'
    );
  }

  return {
    method: 'POST',
    url: `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
    scope: SCOPE,
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      // Only the events we map. Asking for everything and filtering here
      // would pull unrelated event volume through a credentialled call for no
      // reason, and would make the thresholding picture harder to read.
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: EVENT_MAP.map((e) => e.event_name) },
        },
      },
      // Report the quota state alongside the data, so a truncated or
      // quota-limited answer is visible rather than looking like low traffic.
      returnPropertyQuota: true,
      keepEmptyRows: false,
    },
    notes: {
      // A credential is required to SEND this; none is required to BUILD it,
      // and none is present in this object.
      credential: 'the ingest job attaches the OAuth bearer token; this object carries none',
      end_date_advice:
        'end at YESTERDAY. GA4 serves the current day as a partial figure, and a ' +
        'partial day imported as a daily reading is a wrong number, not a fresh one.',
      retention: `${RETENTION_DAYS} days, not raisable — section 3.5`,
    },
  };
}

/** Add `days` to a YYYY-MM-DD date, in UTC calendar arithmetic. */
function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return utcCalendarDate(new Date(Date.UTC(y, m - 1, d + days)));
}

/** GA4 returns the `date` dimension as YYYYMMDD. */
function normaliseGa4Date(value) {
  const v = `${value}`.trim();
  if (GA4_DATE_RE.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (DATE_RE.test(v)) return v;
  return null;
}

/**
 * Throw if a metrics object carries a dashboard-family name.
 *
 * Runs on the way out of every parse, so the guarantee survives an edit to
 * EVENT_MAP by someone who has not read rule 4.
 */
export function assertNotDashboardFamily(metrics) {
  for (const name of Object.keys(metrics)) {
    if (FORBIDDEN_METRICS.includes(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from a GA4 report: GA4 measures store-listing funnel ` +
          'EVENTS, the dashboard export reports the store\'s own accounting. They are different ' +
          'instruments and `forbidden_aliases` bans the substitution (docs/metrics-ingest.md ' +
          'section 3.5). Emit the `ga4_*` name instead.'
      );
    }
  }
  return metrics;
}

function eventSpec(eventName) {
  return EVENT_MAP.find((e) => e.event_name === eventName) ?? null;
}

/**
 * Parse one GA4 Data API `runReport` response.
 *
 * @param {Buffer|string|object} payload  the response body, as received
 * @param {object} opts
 * @param {string} opts.item_id       portfolio item id
 * @param {string|Date} opts.exported_at  when the call was made
 * @param {string} [opts.property_id] numeric property id, recorded for audit
 */
export function parseGa4Report(payload, { item_id, exported_at, property_id = null }) {
  if (!item_id) throw new Error('parseGa4Report requires `item_id`');
  if (!exported_at) throw new Error('parseGa4Report requires `exported_at`');

  const rawBytes = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  let doc;
  try {
    doc = typeof payload === 'object' && !Buffer.isBuffer(payload)
      ? payload
      : JSON.parse(rawBytes.toString('utf8'));
  } catch (err) {
    throw new Error(`runReport response is not valid JSON: ${err.message}`);
  }

  // An API error body is JSON too, and it has no rows. Naming it beats
  // reporting it as "everything was withheld".
  if (doc?.error) {
    throw new Error(
      `runReport returned an API error (${doc.error.code ?? '?'} ${doc.error.status ?? ''}): ` +
        `${doc.error.message ?? '(no message)'} — nothing recorded`
    );
  }

  const dimensionHeaders = (doc.dimensionHeaders ?? []).map((h) => h.name);
  const metricHeaders = (doc.metricHeaders ?? []).map((h) => h.name);
  const dateIdx = dimensionHeaders.indexOf('date');
  const eventIdx = dimensionHeaders.indexOf('eventName');
  const countIdx = metricHeaders.indexOf('eventCount');

  // The parser understands exactly the shape `buildRunReportRequest` asks
  // for. Guessing at a different shape is how a wrong column gets read as the
  // right one.
  if (dateIdx === -1 || eventIdx === -1) {
    throw new Error(
      `response dimensions [${dimensionHeaders.join(', ')}] must include \`date\` and \`eventName\` — ` +
        'use buildRunReportRequest to construct the query'
    );
  }
  if (countIdx === -1) {
    throw new Error(
      `response metrics [${metricHeaders.join(', ')}] must include \`eventCount\` — ` +
        'use buildRunReportRequest to construct the query'
    );
  }

  const rows = doc.rows ?? [];

  // RULE 1, the total case. GA4 omits `rows` entirely when everything in the
  // window was thresholded (or when the property has no data yet). Refusing
  // here writes NO manifest entry, which is precisely right: with no entry,
  // the freshness contract reports the metric `missing`. Inventing an entry
  // with zeroes, or with an assumed date, is the fabrication this refuses.
  if (rows.length === 0) {
    const err = new Error(
      'runReport returned zero rows — every requested day was withheld, or the property has no data yet. ' +
        'Recording NOTHING, on purpose: with no manifest entry the metric reads `missing`, which is true. ' +
        `Writing 0 would be a fabricated reading (${WITHHELD_IS_NOT_ZERO.reason_code}).`
    );
    err.reason_code = WITHHELD_IS_NOT_ZERO.reason_code;
    err.rows_returned = 0;
    throw err;
  }

  // RULE 3: `as_of` is the newest date GA4 actually returned.
  const dated = [];
  const undatedRows = [];
  for (const row of rows) {
    const rawDate = row.dimensionValues?.[dateIdx]?.value ?? '';
    const date = normaliseGa4Date(rawDate);
    // GA4 emits `(other)` for rows collapsed past a cardinality limit, and
    // `date_range_0` when a range is requested without the `date` dimension.
    // Neither can be dated, so neither may contribute a value.
    if (date === null) { undatedRows.push(rawDate); continue; }
    dated.push({ date, row });
  }
  if (dated.length === 0) {
    throw new Error(
      `no row carried a parseable date (saw ${JSON.stringify([...new Set(undatedRows)])}) — ` +
        '`as_of` must come from the response and may never be assumed'
    );
  }
  const as_of = dated.reduce((a, b) => (b.date > a.date ? b : a)).date;

  // RULE 2: the as_of day only. Each eventName is a DIFFERENT quantity, so
  // reading one row per event is not aggregation; two rows for the SAME
  // (date, eventName) would be, and are refused.
  const metrics = {};
  const caveats = {};
  const eventsVerbatim = [];
  const unmappedEvents = [];
  const seen = new Map();
  for (const { date, row } of dated) {
    if (date !== as_of) continue;
    const eventName = row.dimensionValues?.[eventIdx]?.value ?? '';
    eventsVerbatim.push(eventName);
    if (seen.has(eventName)) {
      throw new Error(
        `response carries two rows for (${as_of}, "${eventName}") — refusing to sum them. ` +
          'The query shape is not what buildRunReportRequest produces; fix the request rather ' +
          'than aggregating here.'
      );
    }
    seen.set(eventName, row);

    const spec = eventSpec(eventName);
    if (!spec) { unmappedEvents.push(eventName); continue; }

    const raw = (row.metricValues?.[countIdx]?.value ?? '').trim();
    // An empty string is not a number and is not a zero. Same rule as a
    // missing row: no value recorded.
    if (raw === '') continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new Error(
        `eventCount for (${as_of}, "${eventName}") is ${JSON.stringify(raw)}, which is not a number — ` +
          'refusing to record it'
      );
    }
    metrics[spec.metric] = num;
    if (spec.semantic_caveat) caveats[spec.metric] = spec.semantic_caveat;
  }

  // RULE 1, the per-event case. Every mapped event with no row on `as_of` is
  // named here and left OUT of `metrics`. The manifest therefore records
  // which metrics were withheld, and the freshness contract reads them
  // `missing` rather than 0.
  const withheld = EVENT_MAP
    .filter((e) => !(e.metric in metrics))
    .map((e) => ({
      metric: e.metric,
      event_name: e.event_name,
      reason_code: WITHHELD_IS_NOT_ZERO.reason_code,
      recorded_as: 'missing (absent from `metrics`) — NEVER 0',
    }));

  assertNotDashboardFamily(metrics);

  return {
    source: SOURCE,
    item_id,
    as_of,
    as_of_source: 'runReport `date` dimension',
    exported_at: new Date(exported_at).toISOString(),
    exported_on: utcCalendarDate(exported_at),
    property_id: property_id === null ? null : `${property_id}`,
    metrics,
    semantic_caveats: caveats,
    withheld_metrics: withheld,
    withheld_rule: WITHHELD_IS_NOT_ZERO,
    events_verbatim: [...new Set(eventsVerbatim)],
    unmapped_events: [...new Set(unmappedEvents)],
    undated_rows: [...new Set(undatedRows)],
    // GA4 dates are in the PROPERTY's reporting timezone, which the store set
    // and Marketer cannot change. Recorded verbatim because `lag_days` is
    // calendar arithmetic against a UTC export date: a property ahead of UTC
    // can legitimately produce as_of == tomorrow-in-UTC. Unconfirmed until a
    // real response lands.
    property_time_zone: doc.metadata?.timeZone ?? null,
    property_quota: doc.propertyQuota ?? null,
    row_count: rows.length,
    rows_on_as_of: seen.size,
    aggregation: 'none — one row per event on the as_of date',
    synthesized_metrics: [],
    retention_days: RETENTION_DAYS,
    backfillable: false,
    checksum: sha256(rawBytes),
  };
}

/**
 * Provenance report. Every mapping is unconfirmed, so this doubles as the
 * list of what the first real response has to settle.
 */
export function ga4Provenance(parsed) {
  return {
    property_id: parsed.property_id,
    property_time_zone: parsed.property_time_zone,
    observed_events: parsed.events_verbatim,
    unmapped_events: parsed.unmapped_events,
    unconfirmed_mappings: EVENT_MAP.filter((e) => !e.confirmed).map((e) => e.metric),
    withheld_metrics: parsed.withheld_metrics,
    withheld_rule: parsed.withheld_rule,
    semantic_caveats: parsed.semantic_caveats,
    synthesized_metrics: parsed.synthesized_metrics,
    retention_days: parsed.retention_days,
    property_quota: parsed.property_quota,
  };
}
