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
// `cws` is the founder-session dashboard CSV (five fields). `cws_listing` is
// the PUBLIC listing page (the two rating fields) — anonymous HTTPS, no
// credential, no founder session, so it needs nothing provisioned.
// `cws_listing_attested` is the same source recorded from another agent's
// verified capture, carrying that capture's UPSTREAM checksum, for when the
// fetching agent and the parsing agent are not the same. See APP-163.
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

  const raw = readFileSync(file, 'utf8');

  const LISTING_SOURCES = new Set(['cws_listing', 'cws_listing_attested']);
  if (source !== 'cws' && !LISTING_SOURCES.has(source)) {
    // Play lands through the service-account bucket reader, which is not yet
    // provisioned — see docs/metrics-ingest.md §Google Play. Failing loudly
    // beats writing a half-formed manifest entry.
    throw new Error(
      `source "${source}" has no importer yet. Only "cws", "cws_listing" and ` +
        '"cws_listing_attested" are ' +
        'implemented; the Play read-only service account is not provisioned ' +
        '(docs/metrics-ingest.md).'
    );
  }

  let parsed;
  if (source === 'cws_listing_attested') {
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
      LISTING_SOURCES.has(source)
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
    provenance: LISTING_SOURCES.has(source)
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
