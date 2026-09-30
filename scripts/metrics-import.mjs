#!/usr/bin/env node
// Import a store export into the metrics manifest (APP-42).
//
//   node scripts/metrics-import.mjs --source cws --item json-workbench \
//        --file path/to/export.csv [--exported-at 2026-09-28T10:00:00Z] \
//        [--data-root data]
//
//   node scripts/metrics-import.mjs --source cws_listing --item json-workbench \
//        --file path/to/listing.html --exported-at 2026-09-29T04:38:52Z
//
//   node scripts/metrics-import.mjs --source cws_listing_attested \
//        --item json-workbench --file data/metrics/attested/<extract>.json
//
//   node scripts/metrics-import.mjs --source ga4 --emit-request \
//        --property <numeric property id> --start 2026-09-01 --end 2026-09-29
//
//   node scripts/metrics-import.mjs --source ga4 --item json-workbench \
//        --file <runReport-response.json> [--property <numeric property id>]
//
// `cws` is the founder-session dashboard CSV (five fields). `cws_listing` is
// the PUBLIC listing page (the two rating fields) — anonymous HTTPS, no
// credential, no founder session, so it needs nothing provisioned.
// `cws_listing_attested` is the same source recorded from another agent's
// verified capture, carrying that capture's UPSTREAM checksum, for when the
// fetching agent and the parsing agent are not the same. See APP-163.
//
// `ga4` is the CWS-created GA4 property, read through the Data API. APP-215.
// It splits into two halves, and the split is the point: `--emit-request`
// prints the exact `runReport` call to make (no credential involved, so it is
// deterministic and testable here), and the import consumes the response
// FILE the ingest job got back. This script never holds the OAuth token.
//
// `--exported-at` defaults to now, which is correct for a live pull. It is
// settable so a manually dropped file (the cycle-one fallback) can record
// when it was actually downloaded rather than when it was loaded.
//
// No store credential is read, held, or stored by this script. It consumes a
// file that an already-authenticated session produced. See §6.1 rule 4.

import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { parseCwsExport, headerProvenance } from './lib/cws-export.mjs';
import { parseCwsListing, parseAttestedListing, listingProvenance } from './lib/cws-listing.mjs';
import { parseGa4Report, ga4Provenance, buildRunReportRequest } from './lib/ga4-report.mjs';
import { createManifestEntry, appendManifest, sha256 } from './lib/metrics-manifest.mjs';

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

export function runImport(args) {
  const source = args.source;
  const itemId = args.item;
  const file = args.file;
  const dataRoot = args.data_root ?? 'data';
  const exportedAt = args.exported_at ?? new Date().toISOString();

  if (!source) throw new Error('--source is required (cws | cws_listing | play | ga4)');
  if (!itemId) throw new Error('--item is required (the store item id)');
  if (!file) throw new Error('--file is required');

  const raw = readFileSync(file, 'utf8');

  const LISTING_SOURCES = new Set(['cws_listing', 'cws_listing_attested']);
  const IMPLEMENTED = new Set(['cws', 'ga4', ...LISTING_SOURCES]);
  if (!IMPLEMENTED.has(source)) {
    // Play lands through the service-account bucket reader, which is not yet
    // provisioned — see docs/metrics-ingest.md §Google Play. Failing loudly
    // beats writing a half-formed manifest entry.
    throw new Error(
      `source "${source}" has no importer yet. Implemented: ` +
        `${[...IMPLEMENTED].join(', ')}; the Play read-only service account is ` +
        'not provisioned (docs/metrics-ingest.md).'
    );
  }

  let parsed;
  if (source === 'ga4') {
    parsed = parseGa4Report(raw, {
      item_id: itemId,
      exported_at: exportedAt,
      property_id: args.property ?? null,
    });
  } else if (source === 'cws_listing_attested') {
    // `exported_at` comes from the attestation, not from the clock or a flag:
    // the reading is as of when it was CAPTURED, not when it was loaded here.
    parsed = parseAttestedListing(JSON.parse(raw), { item_id: itemId });
  } else if (source === 'cws_listing') {
    parsed = parseCwsListing(raw, { item_id: itemId, fetched_at: exportedAt, scope: args.scope ?? null });
  } else {
    parsed = parseCwsExport(raw, { item_id: itemId, exported_at: exportedAt });
  }

  // Keep the raw export next to the manifest, checksummed, so any later
  // question about a column can be answered from the artefact.
  const rawDir = join(dataRoot, 'metrics', 'raw', parsed.source, itemId);
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, `${parsed.as_of}--${basename(file)}`);
  copyFileSync(file, rawPath);

  const entry = createManifestEntry({
    source: parsed.source,
    item_id: parsed.item_id,
    as_of: parsed.as_of,
    exported_at: parsed.exported_at,
    checksum: parsed.checksum,
    as_of_source: parsed.as_of_source,
    metrics: parsed.metrics,
    raw_path: rawPath,
    notes:
      source === 'ga4'
        ? {
            property_id: parsed.property_id,
            // The store set this and Marketer cannot change it. `lag_days` is
            // UTC calendar arithmetic, so a property ahead of UTC can
            // legitimately date a row "in the future" — recorded so that is
            // diagnosable rather than mysterious.
            property_time_zone: parsed.property_time_zone,
            events_verbatim: parsed.events_verbatim,
            unmapped_events: parsed.unmapped_events,
            undated_rows: parsed.undated_rows,
            row_count: parsed.row_count,
            rows_on_as_of: parsed.rows_on_as_of,
            aggregation: parsed.aggregation,
            synthesized_metrics: parsed.synthesized_metrics,
            semantic_caveats: parsed.semantic_caveats,
            // The whole point of this source's importer: which metrics GA4
            // did NOT return, named, so a reader can tell a withheld day from
            // a zero without re-deriving it.
            withheld_metrics: parsed.withheld_metrics,
            withheld_rule: parsed.withheld_rule,
            // Two months, not raisable. A reader must never treat a gap in
            // this series as backfillable.
            retention_days: parsed.retention_days,
            backfillable: parsed.backfillable,
            property_quota: parsed.property_quota,
          }
        : LISTING_SOURCES.has(source)
        ? {
            // A structural zero, not a measured one — the listing carries no
            // date, so its lag cannot be observed. Recorded so a future reader
            // does not mistake lag_days:0 for "confirmed current".
            lag_observable: parsed.lag_observable,
            rating_block_verbatim: parsed.rating_block_verbatim,
            absent_metrics: parsed.absent_metrics,
            refused_fields: parsed.refused_fields,
            declared_freshness: parsed.declared_freshness,
            scope_applied: parsed.scope_applied,
            rating_blocks_in_range: parsed.rating_blocks_in_range,
            attestation: parsed.attestation ?? null,
          }
        : {
            headers_verbatim: parsed.headers_verbatim,
            unmapped_headers: parsed.unmapped_headers,
            row_count: parsed.row_count,
          },
  });

  appendManifest(dataRoot, entry);
  return {
    entry,
    provenance:
      source === 'ga4'
        ? ga4Provenance(parsed)
        : LISTING_SOURCES.has(source)
          ? listingProvenance(parsed)
          : headerProvenance(parsed),
  };
}

/**
 * Print the `runReport` call to make, without making it.
 *
 * Kept separate from `runImport` because it writes no manifest entry and
 * needs no item: it is the request half of the GA4 path, and it exists so the
 * one live call APP-215 asks for is a copy-paste rather than a reconstruction
 * from prose. It takes a property id and returns a body. It does not take, see
 * or return a credential — the ingest job attaches the bearer token.
 */
export function runEmitRequest(args) {
  return buildRunReportRequest({
    propertyId: args.property,
    startDate: args.start,
    endDate: args.end,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.emit_request) {
    if (args.source !== 'ga4') {
      throw new Error('--emit-request is only meaningful for --source ga4');
    }
    const req = runEmitRequest(args);
    console.log(`${req.method} ${req.url}`);
    console.log(`scope: ${req.scope}   <- exactly this, and nothing else`);
    console.log('');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('');
    console.log(`credential: ${req.notes.credential}`);
    console.log(`end date  : ${req.notes.end_date_advice}`);
    console.log(`retention : ${req.notes.retention}`);
    return;
  }

  const { entry, provenance } = runImport(args);

  console.log(`imported ${entry.source} / ${entry.item_id}`);
  // "from column" only makes sense for the CSV export; the listing has no
  // column to name and GA4 returns a dimension, not a column, so saying
  // "column" for either would misdescribe the provenance.
  const NO_COLUMNS = new Set(['cws_public_listing', 'ga4_cws_property']);
  const asOfLabel = NO_COLUMNS.has(entry.source) ? 'from' : 'from column';
  console.log(`  as_of       ${entry.as_of}   (${asOfLabel} "${entry.as_of_source}")`);
  console.log(`  exported_at ${entry.exported_at}`);
  console.log(`  lag_days    ${entry.lag_days}   (derived, not configured)`);
  console.log(`  checksum    ${entry.checksum}`);
  console.log(`  metrics     ${Object.keys(entry.metrics).join(', ') || '(none mapped)'}`);
  console.log('');
  if (args.source === 'cws_listing' || args.source === 'cws_listing_attested') {
    console.log('public-listing provenance (APP-163) — no credential, no founder session:');
    console.log(`  rating block     : ${JSON.stringify(provenance.rating_block)}`);
    console.log(`  mapped           : ${provenance.mapped.join(', ') || '(none)'}`);
    if (provenance.absent.length) {
      console.log(`  ABSENT           : ${provenance.absent.join(', ')}  <- not yet rated; NOT recorded as zero`);
    }
    for (const r of provenance.refused) {
      console.log(`  REFUSED "${r.field}" = ${JSON.stringify(r.observed)}`);
      console.log(`    reason: ${r.reason}`);
    }
    console.log(`  lag observable   : ${provenance.lag_observable}  <- lag_days 0 is structural, not measured`);
    if (provenance.declared_freshness) {
      console.log(`  page says        : "${provenance.declared_freshness}"  <- kept verbatim, NOT turned into a lag constant`);
    }
    if (entry.notes?.attestation) {
      const a = entry.notes.attestation;
      console.log(`  attested by      : ${a.captured_by}`);
      console.log(`  upstream sha256  : ${entry.checksum}  <- hash of the bytes the CAPTURING agent received`);
      console.log(`  raw artifact here: ${a.raw_artifact_present}  (${a.artifact_ref})`);
    }
    return;
  }
  if (args.source === 'ga4') {
    console.log('GA4 provenance (APP-215) — no credential read by this script:');
    console.log(`  property id      : ${provenance.property_id ?? '(not asserted)'}`);
    console.log(`  property tz      : ${provenance.property_time_zone ?? '(absent from response)'}  <- the store set it; lag_days is UTC`);
    console.log(`  events returned  : ${JSON.stringify(provenance.observed_events)}`);
    if (provenance.unmapped_events.length) {
      console.log(`  UNMAPPED events  : ${JSON.stringify(provenance.unmapped_events)}  <- reported, never dropped`);
    }
    console.log(`  still unconfirmed: ${provenance.unconfirmed_mappings.join(', ')}  <- second-hand until a real property answers`);
    console.log(`  aggregation      : none — one row per event on the as_of date`);
    console.log(`  synthesized      : ${JSON.stringify(provenance.synthesized_metrics)}`);
    console.log(`  retention        : ${provenance.retention_days} days, NOT raisable — this source never backfills`);
    if (provenance.withheld_metrics.length) {
      console.log('  WITHHELD (recorded as `missing`, never 0):');
      for (const w of provenance.withheld_metrics) {
        console.log(`    ${w.metric}  (no "${w.event_name}" row on this date; ${w.reason_code})`);
      }
      console.log(`    why: ${provenance.withheld_rule.reason}`);
    }
    for (const [metric, caveat] of Object.entries(provenance.semantic_caveats)) {
      console.log(`  CAVEAT ${metric}:`);
      console.log(`    ${caveat}`);
    }
    return;
  }
  console.log('header provenance — the APP-54 question, answered from this file:');
  console.log(`  verbatim headers : ${JSON.stringify(provenance.observed_headers)}`);
  if (provenance.unmapped_headers.length) {
    console.log(`  UNMAPPED         : ${JSON.stringify(provenance.unmapped_headers)}  <- schema drift or a new field`);
  }
  console.log(`  still unconfirmed: ${provenance.unconfirmed_mappings.join(', ')}`);
  console.log(`  not in this export: ${provenance.not_in_this_export.join(', ')} (public listing page — APP-163)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (err) { console.error(`error: ${err.message}`); process.exit(1); }
}
