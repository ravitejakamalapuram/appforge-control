#!/usr/bin/env node
// Import a store export into the metrics manifest (APP-42).
//
//   node scripts/metrics-import.mjs --source cws --item json-workbench \
//        --file path/to/export.csv [--exported-at 2026-09-28T10:00:00Z] \
//        [--data-root data]
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

  if (!source) throw new Error('--source is required (cws | play)');
  if (!itemId) throw new Error('--item is required (the store item id)');
  if (!file) throw new Error('--file is required');

  const raw = readFileSync(file, 'utf8');

  if (source !== 'cws') {
    // Play lands through the service-account bucket reader, which is not yet
    // provisioned — see docs/metrics-ingest.md §Google Play. Failing loudly
    // beats writing a half-formed manifest entry.
    throw new Error(
      `source "${source}" has no importer yet. Only "cws" is implemented; ` +
        'the Play read-only service account is not provisioned (docs/metrics-ingest.md).'
    );
  }

  const parsed = parseCwsExport(raw, { item_id: itemId, exported_at: exportedAt });

  // Keep the raw export next to the manifest, checksummed, so any later
  // question about a column can be answered from the artefact.
  const rawDir = join(dataRoot, 'metrics', 'raw', source, itemId);
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
    notes: {
      headers_verbatim: parsed.headers_verbatim,
      unmapped_headers: parsed.unmapped_headers,
      row_count: parsed.row_count,
    },
  });

  appendManifest(dataRoot, entry);
  return { entry, provenance: headerProvenance(parsed) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { entry, provenance } = runImport(args);

  console.log(`imported ${entry.source} / ${entry.item_id}`);
  console.log(`  as_of       ${entry.as_of}   (from column "${entry.as_of_source}")`);
  console.log(`  exported_at ${entry.exported_at}`);
  console.log(`  lag_days    ${entry.lag_days}   (derived, not configured)`);
  console.log(`  checksum    ${entry.checksum}`);
  console.log(`  metrics     ${Object.keys(entry.metrics).join(', ') || '(none mapped)'}`);
  console.log('');
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
