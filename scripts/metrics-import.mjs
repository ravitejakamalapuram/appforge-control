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
//   node scripts/metrics-import.mjs --source play --item invtrack \
//        --file <installs_overview.csv> [--package com.example.invtrack]
//
// `cws` is the founder-session dashboard CSV (five fields). `cws_listing` is
// the PUBLIC listing page (the two rating fields) — anonymous HTTPS, no
// credential, no founder session, so it needs nothing provisioned.
// `cws_listing_attested` is the same source recorded from another agent's
// verified capture, carrying that capture's UPSTREAM checksum, for when the
// fetching agent and the parsing agent are not the same. See APP-163.
//
// `play` is a Google Play statistics report, as downloaded from the
// `pubsite_prod_rev_<developer_id>` bucket by the ingest job. APP-210. It
// consumes a FILE: the read-only service-account key is bound to the ingest
// job and is never seen here.
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
import { parsePlayReport, playProvenance } from './lib/play-report.mjs';
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
  if (source === 'ga4') {
    // APP-157: named explicitly so the failure explains itself. The read path
    // is decided and documented, but it is NOT a service account — the CWS
    // property grants the developer Marketer, which cannot manage users, so
    // only OAuth USER credentials can read it. Nothing is provisioned: the
    // Store-listing opt-in has not been clicked, so no property and no
    // property id exist, and no refresh token is bound.
    throw new Error(
      'source "ga4" has no importer yet, and it is blocked on founder access, ' +
        'not on code. Requires: (1) Store listing -> Additional metrics -> ' +
        '"Opt in to Google Analytics"; (2) an OAuth client whose consent screen ' +
        'is "In production" (a "Testing" client issues a refresh token that ' +
        'expires in 7 days, which would put the founder back in the loop every ' +
        'week); (3) the refresh token bound as a Paperclip secret to the ingest ' +
        'job only. A GA4 service account can NEVER work here. ' +
        'See docs/metrics-ingest.md section 3.'
    );
  }
  if (!itemId) throw new Error('--item is required (the store item id)');
  if (!file) throw new Error('--file is required');

  // Read BYTES. The existing sources are utf8 text, but Play reports carry a
  // byte-order mark that decides their encoding, and reading them as utf8 up
  // front would destroy the evidence the parser needs.
  const rawBytes = readFileSync(file);

  const LISTING_SOURCES = new Set(['cws_listing', 'cws_listing_attested']);
  const IMPLEMENTED = new Set(['cws', 'play', ...LISTING_SOURCES]);
  if (!IMPLEMENTED.has(source)) {
    throw new Error(
      `source "${source}" has no importer yet. Implemented: ` +
        `${[...IMPLEMENTED].join(', ')} (docs/metrics-ingest.md).`
    );
  }

  let parsed;
  if (source === 'play') {
    parsed = parsePlayReport(rawBytes, {
      item_id: itemId,
      exported_at: exportedAt,
      package: args.package ?? null,
    });
  } else if (source === 'cws_listing_attested') {
    // `exported_at` comes from the attestation, not from the clock or a flag:
    // the reading is as of when it was CAPTURED, not when it was loaded here.
    parsed = parseAttestedListing(JSON.parse(rawBytes.toString('utf8')), { item_id: itemId });
  } else if (source === 'cws_listing') {
    parsed = parseCwsListing(rawBytes.toString('utf8'), { item_id: itemId, fetched_at: exportedAt, scope: args.scope ?? null });
  } else {
    parsed = parseCwsExport(rawBytes.toString('utf8'), { item_id: itemId, exported_at: exportedAt });
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
      source === 'play'
        ? {
            headers_verbatim: parsed.headers_verbatim,
            unmapped_headers: parsed.unmapped_headers,
            row_count: parsed.row_count,
            // The three fields that keep a later reader from having to trust
            // this run: what was read rather than computed, which family of
            // Play's duplicated columns was taken, and why there is no weekly
            // figure here.
            aggregation: parsed.aggregation,
            synthesized_metrics: parsed.synthesized_metrics,
            weekly_distinct: parsed.weekly_distinct,
            semantic_caveats: parsed.semantic_caveats,
            family_choice: parsed.family_choice,
            package_names_verbatim: parsed.package_names_verbatim,
            encoding_detected: parsed.encoding_detected,
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
      source === 'play'
        ? playProvenance(parsed)
        : LISTING_SOURCES.has(source)
          ? listingProvenance(parsed)
          : headerProvenance(parsed),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { entry, provenance } = runImport(args);

  console.log(`imported ${entry.source} / ${entry.item_id}`);
  // "from column" only makes sense for the CSV export; the listing has no
  // column to name, and saying it does would misdescribe the provenance.
  const asOfLabel = entry.source === 'cws_public_listing' ? 'from' : 'from column';
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
  if (args.source === 'play') {
    console.log('Play report provenance (APP-210) — no credential read by this script:');
    console.log(`  verbatim headers : ${JSON.stringify(provenance.observed_headers)}`);
    console.log(`  encoding         : ${provenance.encoding_detected}  <- detected from the BOM, not assumed`);
    if (provenance.unmapped_headers.length) {
      console.log(`  UNMAPPED         : ${JSON.stringify(provenance.unmapped_headers)}`);
      console.log(`    family taken   : ${provenance.family_choice.chosen} — ${provenance.family_choice.why}`);
    }
    console.log(`  package name(s)  : ${JSON.stringify(provenance.package_names_verbatim)}`);
    console.log(`  still unconfirmed: ${provenance.unconfirmed_mappings.join(', ')}  <- second-hand until real bytes land`);
    console.log(`  aggregation      : ${entry.notes.aggregation}`);
    console.log(`  synthesized      : ${JSON.stringify(provenance.synthesized_metrics)}  <- nothing computed; every value read from one row`);
    console.log(`  weekly distinct  : unavailable — ${provenance.weekly_distinct.reason_code} (${provenance.weekly_distinct.ruling})`);
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
