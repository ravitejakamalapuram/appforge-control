// Google Play statistics-report CSV parser (APP-210, split out of APP-42).
//
// Play publishes CSV statistics reports into a Cloud Storage bucket named
// `pubsite_prod_rev_<developer_id>`, readable by a service account holding
// exactly one Play Console permission: "View app information and download
// bulk reports (read-only)". See docs/metrics-ingest.md section 4.
//
// This file reads a report FILE. It holds no credential, reads no credential,
// and has no network path: the ingest job downloads the object and hands the
// bytes over. Sec 6.1 rule 4 is structural here, not a convention.
//
// Four design rules, three inherited from cws-export.mjs and one specific to
// Play:
//
// 1. HEADERS ARE RECORDED VERBATIM. No real Play report has ever reached this
//    codebase. Every header -> metric mapping below is Analyst's SECOND-HAND
//    reading of Play's documentation, and Analyst has no store access by
//    design. Each row carries `confirmed: false` until real bytes prove it.
//
// 2. NO INFERENCE FROM VALUES. Nothing here is derived from the magnitude or
//    direction of any number. APP-58 ruled that class of reasoning circular.
//
// 3. NO CROSS-ROW AGGREGATION, EVER. Metric values are read out of the SINGLE
//    row whose date equals `as_of`. This is not a performance choice, it is
//    the mechanical half of the promise in rule 4 below.
//
// 4. PLAY HAS NO WEEKLY-DISTINCT ACTIVE FIGURE, AND THIS PARSER WILL NOT
//    INVENT ONE. Summing daily active devices across seven rows produces a
//    number with no referent -- a device active on three days is counted
//    three times -- and presenting it as a weekly distinct count would be a
//    fabrication, not an approximation. DEC-0009 D5 rejected the substitution
//    by name. `assertNoWeeklySynthesis` enforces it at parse time so a future
//    careless edit to HEADER_MAP fails loudly instead of quietly shipping a
//    synthesized figure.

import { parseCsv } from './csv.mjs';
import { sha256, utcCalendarDate } from './metrics-manifest.mjs';

export const SOURCE = 'play_reports_bucket';

/**
 * Why there is no `play_weekly_*` metric and never will be from this source.
 * Exported so the refusal can be quoted rather than paraphrased.
 */
export const WEEKLY_DISTINCT_UNAVAILABLE = Object.freeze({
  available: false,
  reason:
    "Play's statistics reports carry daily and cumulative figures only. There " +
    'is no 7-day distinct-active column, and daily active devices cannot be ' +
    'summed into one: the same device recurring across days would be counted ' +
    'once per day. Any weekly figure from this source would be synthesized, ' +
    'not measured.',
  ruling: 'DEC-0009 D5',
  reason_code: 'play_wau_unavailable',
});

/**
 * Metric names this parser may never emit, whatever the headers say.
 *
 * The first two are weekly-distinct quantities belonging to other
 * instruments; the guard is a regex as well as a list so that an invented
 * name like `play_weekly_active_devices` is caught too.
 */
export const FORBIDDEN_METRICS = Object.freeze([
  'cws_weekly_users',   // a Chrome Web Store reading; different store entirely
  'true_wau',           // sec 18b telemetry WAU; a measure of USE, not of install
]);

const WEEKLY_NAME_RE = /weekly|wau/i;

/**
 * Expected header -> metric mappings, SECOND-HAND.
 *
 * Play's bulk reports arrive as one file per dimension (installs overview,
 * ratings overview, ...), so any single file carries a subset of these. The
 * parser emits the intersection of what it mapped and what the file holds.
 *
 * `family` records the device-vs-user split described in `FAMILY_CHOICE`.
 */
export const HEADER_MAP = [
  {
    metric: 'play_installs',
    expects: ['daily device installs'],
    family: 'device',
    confirmed: false,
  },
  {
    metric: 'play_uninstalls',
    expects: ['daily device uninstalls'],
    family: 'device',
    confirmed: false,
  },
  {
    metric: 'play_active_devices_30d',
    expects: ['active device installs'],
    family: 'device',
    confirmed: false,
    semantic_caveat:
      "Play's figure counts DEVICES that have the app installed and that were " +
      'active in the trailing window -- device activity, not app usage. A ' +
      'device that has never opened the app still counts. It is therefore ' +
      'neither `true_wau` (use) nor `cws_weekly_users` (a weekly install ' +
      'reading on another store): three quantities, three names. The exact ' +
      "window length is Analyst's second-hand reading and is unconfirmed; the " +
      'metric name asserts 30 days and the real report must prove it.',
  },
  {
    metric: 'play_rating_average',
    expects: ['total average rating'],
    family: 'cumulative',
    confirmed: false,
    semantic_caveat:
      'The lifetime average, which is what the store displays. "Daily Average ' +
      'Rating" is a different quantity (that day\'s new reviews only) and is ' +
      'deliberately left unmapped rather than averaged in.',
  },
];

/**
 * Play reports most quantities twice -- once counting DEVICES and once
 * counting USERS (Google accounts). They are different numbers.
 *
 * We take the DEVICE family throughout, for one reason that is not
 * aesthetic: `play_active_devices_30d` exists ONLY in the device family, and
 * a ratio built from a user-family numerator over a device-family denominator
 * would be precisely the category error `forbidden_aliases` exists to stop.
 * Consistency inside one family is the defensible choice; the user-family
 * columns are reported as unmapped, never silently discarded.
 */
export const FAMILY_CHOICE = Object.freeze({
  chosen: 'device',
  why:
    'play_active_devices_30d has no user-family counterpart, so mixing ' +
    'families would make every derived ratio incomparable with its own ' +
    'denominator.',
  unmapped_on_purpose: [
    'Daily User Installs',
    'Daily User Uninstalls',
    'Total User Installs',
    'Daily Average Rating',
    'Daily Device Upgrades',
  ],
});

const DATE_HEADERS = ['date'];
const PACKAGE_HEADERS = ['package name', 'package'];

const norm = (h) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Decode report bytes, recording the encoding OBSERVED from the byte-order
 * mark rather than assuming one.
 *
 * Play's bulk reports are widely reported to be UTF-16 with a BOM, which is
 * the single most common reason a first Play import comes out with a mangled
 * header row. That is second-hand too -- so this looks at the actual bytes and
 * says which branch it took, instead of hardcoding either encoding.
 */
export function decodeReport(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding_detected: 'utf-16le (BOM)' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new Error(
      'report is UTF-16 BIG-endian (BOM fe ff), which node cannot decode natively — ' +
        'refusing rather than reading every character transposed'
    );
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding_detected: 'utf-8 (BOM)' };
  }
  return { text: bytes.toString('utf8'), encoding_detected: 'utf-8 (no BOM)' };
}

/**
 * Throw if a metrics object carries a weekly-distinct name.
 *
 * Called on the way out of `parsePlayReport`, so the guarantee holds for every
 * caller and survives edits to HEADER_MAP by someone who has not read rule 4.
 */
export function assertNoWeeklySynthesis(metrics) {
  for (const name of Object.keys(metrics)) {
    if (FORBIDDEN_METRICS.includes(name) || WEEKLY_NAME_RE.test(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from a Play report: ${WEEKLY_DISTINCT_UNAVAILABLE.reason} ` +
          `(${WEEKLY_DISTINCT_UNAVAILABLE.ruling}, reason_code ${WEEKLY_DISTINCT_UNAVAILABLE.reason_code})`
      );
    }
  }
  return metrics;
}

function mapHeader(header) {
  const n = norm(header);
  for (const row of HEADER_MAP) {
    if (row.expects.includes(n)) return row;
  }
  return null;
}

function looksLikeDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Parse one Play statistics report.
 *
 * @param {Buffer|string} bytes  the report object's raw bytes, as downloaded
 * @param {object} opts
 * @param {string} opts.item_id      portfolio item id (`invtrack`, `teleport`)
 * @param {string|Date} opts.exported_at  when the object was pulled
 * @param {string} [opts.package]    Android package name to assert against
 * @returns parsed report with VERBATIM headers preserved
 */
export function parsePlayReport(bytes, { item_id, exported_at, package: expectedPackage = null }) {
  if (!item_id) throw new Error('parsePlayReport requires `item_id`');
  if (!exported_at) throw new Error('parsePlayReport requires `exported_at`');

  const { text, encoding_detected } = decodeReport(bytes);
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error('report has no data rows — refusing to record an empty import');
  }

  const headers = rows[0].map((h) => h.trim()); // VERBATIM, un-normalised
  const body = rows.slice(1);

  const dateIdx = headers.findIndex((h) => DATE_HEADERS.includes(norm(h)));
  if (dateIdx === -1) {
    throw new Error(
      `no date column found among headers [${headers.join(', ')}] — ` +
        '`as_of` must come from the report itself and may never be assumed'
    );
  }

  const pkgIdx = headers.findIndex((h) => PACKAGE_HEADERS.includes(norm(h)));
  const packages = pkgIdx === -1
    ? []
    : [...new Set(body.map((r) => (r[pkgIdx] ?? '').trim()).filter((v) => v !== ''))];

  // A file covering two packages cannot be attributed to one portfolio item,
  // and picking a row would be a guess about which app the numbers describe.
  if (packages.length > 1) {
    throw new Error(
      `report covers ${packages.length} packages [${packages.join(', ')}] — ` +
        `cannot attribute it to the single item "${item_id}"`
    );
  }
  if (expectedPackage && packages.length === 1 && packages[0] !== expectedPackage) {
    throw new Error(
      `report is for package "${packages[0]}" but --package asserted ` +
        `"${expectedPackage}" — refusing to file another app's numbers under "${item_id}"`
    );
  }

  const mapped = new Map();   // metric -> { idx, row }
  const unmapped = [];
  headers.forEach((h, i) => {
    if (i === dateIdx || i === pkgIdx) return;
    const row = mapHeader(h);
    if (row) mapped.set(row.metric, { idx: i, spec: row });
    else unmapped.push(h);
  });

  // `as_of` is the newest data date the report actually carries.
  const dates = body
    .map((r) => (r[dateIdx] ?? '').trim())
    .filter((v) => looksLikeDate(v));
  if (dates.length === 0) {
    throw new Error(
      `date column "${headers[dateIdx]}" holds no YYYY-MM-DD values — cannot establish \`as_of\``
    );
  }
  const as_of = dates.reduce((a, b) => (b > a ? b : a));

  // RULE 3: one row. Values are read from the row matching `as_of` and from
  // nowhere else. No sum, no mean, no rolling window, no fill-forward.
  const latestRow = body.find((r) => (r[dateIdx] ?? '').trim() === as_of);
  const metrics = {};
  const caveats = {};
  for (const [metric, { idx, spec }] of mapped) {
    const raw = (latestRow[idx] ?? '').trim();
    if (raw === '') continue;
    const num = Number(raw.replace(/,/g, ''));
    metrics[metric] = Number.isFinite(num) ? num : raw;
    if (spec.semantic_caveat) caveats[metric] = spec.semantic_caveat;
  }

  assertNoWeeklySynthesis(metrics);

  return {
    source: SOURCE,
    item_id,
    as_of,
    as_of_source: headers[dateIdx],
    exported_at: new Date(exported_at).toISOString(),
    exported_on: utcCalendarDate(exported_at),
    headers_verbatim: headers,
    unmapped_headers: unmapped,
    metrics,
    semantic_caveats: caveats,
    // Recorded so the first real report answers the package-id question that
    // config/portfolio.yaml currently cannot: it holds no package names.
    package_names_verbatim: packages,
    encoding_detected,
    family_choice: FAMILY_CHOICE.chosen,
    weekly_distinct: WEEKLY_DISTINCT_UNAVAILABLE,
    // Explicit and always empty. A reader asking "did anything here get
    // computed rather than read?" gets an answer from the manifest.
    synthesized_metrics: [],
    aggregation: 'none — single row, as_of',
    checksum: sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
    row_count: body.length,
  };
}

/**
 * Header-provenance report. Every Play mapping is unconfirmed, so this
 * doubles as the list of what the first real report has to settle.
 */
export function playProvenance(parsed) {
  return {
    observed_headers: parsed.headers_verbatim,
    unmapped_headers: parsed.unmapped_headers,
    unconfirmed_mappings: HEADER_MAP.filter((r) => !r.confirmed).map((r) => r.metric),
    semantic_caveats: parsed.semantic_caveats,
    encoding_detected: parsed.encoding_detected,
    package_names_verbatim: parsed.package_names_verbatim,
    family_choice: FAMILY_CHOICE,
    weekly_distinct: parsed.weekly_distinct,
    synthesized_metrics: parsed.synthesized_metrics,
  };
}

