// Chrome Web Store developer-dashboard CSV export parser (APP-42).
//
// Two design rules, both learned the hard way:
//
// 1. HEADERS ARE RECORDED VERBATIM. No export has ever been seen by this
//    codebase, so every header→metric mapping below is an EXPECTATION, not
//    an observation. Each carries `confirmed: false` until a real export
//    proves it. The parser surfaces the literal headers it saw so the
//    weekly-vs-cumulative question (APP-54 deliverable 1) is answered from
//    data rather than from memory.
//
// 2. NO INFERENCE FROM VALUES. An earlier revision of this file cited the
//    json-workbench 5→3 drop as evidence that the "users" figure is
//    weekly-active ("a cumulative counter cannot decrease"). APP-58 ruled
//    that inference CIRCULAR — the 5 came off an unrecorded dashboard page —
//    and config/portfolio.yaml forbids reinstating it anywhere. Google's own
//    wording settles the direction it mattered in: "The Users stats only
//    captures installations; it doesn't monitor whether users are active or
//    not." This file therefore derives nothing from the magnitude or
//    direction of any value.

import { parseCsv } from './csv.mjs';
import { sha256, utcCalendarDate } from './metrics-manifest.mjs';

export const SOURCE = 'cws_dashboard_export';

/**
 * Expected header → metric mappings.
 *
 * `confirmed` is false on every row because no real export has landed. When
 * one does, set the matching row to true and record the verbatim header in
 * `observed_as`. Anything unmapped is REPORTED, never dropped — an
 * unrecognised column is a signal the export schema changed.
 */
export const HEADER_MAP = [
  { metric: 'cws_weekly_users',      expects: ['weekly users', 'users'],                    confirmed: false },
  { metric: 'cws_installs',          expects: ['installs', 'installations', 'total installs'], confirmed: false },
  { metric: 'cws_uninstalls',        expects: ['uninstalls', 'uninstallations'],            confirmed: false },
  { metric: 'cws_listing_page_views', expects: ['listing page views', 'page views', 'item detail page views'], confirmed: false },
  { metric: 'cws_impressions',       expects: ['impressions', 'listing impressions'],       confirmed: false },
];

// Per APP-163 (QA, 2026-09-29): rating average and rating count are NOT on
// any of the dashboard's Analytics pages. They are on the PUBLIC listing
// page — anonymous HTTPS, no credential, no founder session. They are
// therefore not this parser's business and are deliberately absent from
// HEADER_MAP. The dashboard export carries FIVE fields, not seven.
export const NOT_IN_DASHBOARD_EXPORT = Object.freeze([
  'cws_rating_average',
  'cws_rating_count',
]);

const DATE_HEADERS = ['date', 'week', 'week of', 'day', 'as of'];

// `parseCsv` moved to ./csv.mjs in APP-210 (Play needs it too). Re-exported
// here so existing importers and tests keep working.
export { parseCsv };

const norm = (h) => h.trim().toLowerCase().replace(/\s+/g, ' ');

function mapHeader(header) {
  const n = norm(header);
  for (const row of HEADER_MAP) {
    if (row.expects.includes(n)) return row.metric;
  }
  return null;
}

function looksLikeDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Parse a CWS dashboard export.
 *
 * @param {string} csvText   raw export contents
 * @param {object} opts
 * @param {string} opts.item_id    the product's `cws` id from product.yaml
 * @param {string|Date} opts.exported_at  when the export was pulled
 * @returns parsed export with VERBATIM headers preserved
 */
export function parseCwsExport(csvText, { item_id, exported_at }) {
  if (!item_id) throw new Error('parseCwsExport requires `item_id`');
  if (!exported_at) throw new Error('parseCwsExport requires `exported_at`');

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error('export has no data rows — refusing to record an empty import');
  }

  const headers = rows[0].map((h) => h.trim()); // VERBATIM, un-normalised
  const body = rows.slice(1);

  const dateIdx = headers.findIndex((h) => DATE_HEADERS.includes(norm(h)));
  if (dateIdx === -1) {
    throw new Error(
      `no date column found among headers [${headers.join(', ')}] — ` +
        '`as_of` must come from the export itself and may never be assumed'
    );
  }

  const mapped = new Map();   // metric -> column index
  const unmapped = [];
  headers.forEach((h, i) => {
    if (i === dateIdx) return;
    const metric = mapHeader(h);
    if (metric) mapped.set(metric, i);
    else unmapped.push(h);
  });

  // `as_of` is the newest data date the export actually carries.
  const dates = body
    .map((r) => (r[dateIdx] ?? '').trim())
    .filter((v) => looksLikeDate(v));
  if (dates.length === 0) {
    throw new Error(
      `date column "${headers[dateIdx]}" holds no YYYY-MM-DD values — cannot establish \`as_of\``
    );
  }
  const as_of = dates.reduce((a, b) => (b > a ? b : a));

  // Metric values are taken from the row matching `as_of`.
  const latestRow = body.find((r) => (r[dateIdx] ?? '').trim() === as_of);
  const metrics = {};
  for (const [metric, idx] of mapped) {
    const raw = (latestRow[idx] ?? '').trim();
    if (raw === '') continue;
    const num = Number(raw.replace(/,/g, ''));
    metrics[metric] = Number.isFinite(num) ? num : raw;
  }

  return {
    source: SOURCE,
    item_id,
    as_of,
    as_of_source: headers[dateIdx],   // audit trail: which column `as_of` came from
    exported_at: new Date(exported_at).toISOString(),
    exported_on: utcCalendarDate(exported_at),
    headers_verbatim: headers,        // the APP-54 deliverable, captured from data
    unmapped_headers: unmapped,       // reported, never silently dropped
    metrics,
    checksum: sha256(csvText),
    row_count: body.length,
  };
}

/**
 * Header-provenance report. Every CWS mapping is unconfirmed until a real
 * export lands, so this doubles as the record of what we still do not know.
 */
export function headerProvenance(parsed) {
  return {
    observed_headers: parsed.headers_verbatim,
    unmapped_headers: parsed.unmapped_headers,
    unconfirmed_mappings: HEADER_MAP.filter((r) => !r.confirmed).map((r) => r.metric),
    not_in_this_export: NOT_IN_DASHBOARD_EXPORT,
  };
}
