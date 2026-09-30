#!/usr/bin/env node
// Play reviews ingest job (APP-210).
//
//   node scripts/play-reviews-ingest.mjs [--item invtrack] [--data-root data]
//                                        [--key-file PATH] [--dry-run]
//
// Runs as a launchd job on the founder's Mac, NOT as an agent run. The board
// ruled this on APP-210 (2026-09-30): ingest is plumbing, not judgement, so it
// is a deterministic script and no LLM touches the key. Nothing here is
// reachable from an agent run — `scripts/agent-launch.sh` does not invoke it
// and its credential is addressed by a path that exists only on that machine.
//
// The key is NEVER a value in this process's environment.
// `PLAY_READONLY_INGEST_KEY_FILE` holds a PATH. See lib/play-reviews.mjs for
// why that distinction is the whole security design and not a style choice.
//
// What this job can and cannot see is fixed by Google, not by us:
//   * seven-day rolling window, so nothing cumulative comes out of here;
//   * commented reviews only, so no rating average comes out of here;
//   * production versions only, so TelePort (internal track) yields `missing`
//     and never `0`.
// All three are quoted verbatim in lib/play-reviews.mjs and enforced there.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import {
  SOURCE,
  loadServiceAccountKey,
  fetchAccessToken,
  listReviews,
  summariseReviews,
  redactForStorage,
} from './lib/play-reviews.mjs';
import { createManifestEntry, appendManifest, sha256 } from './lib/metrics-manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The read-only ingest identity. Not a secret — it is an address, and writing
// it down is what lets the job REFUSE a key that is not this account. The
// publisher identity (`release-bot`) is a different account and must never be
// accepted here: read paths do not carry release authority.
export const EXPECTED_CLIENT_EMAIL = 'play-readonly-ingest@rk-release-platform.iam.gserviceaccount.com';

export function parseArgs(argv) {
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

/**
 * Android products with a Play package id, straight out of portfolio.yaml.
 *
 * `store_item_status` is read from the same place the evaluator reads it, so
 * the missing-vs-zero decision cannot drift away from the config that states
 * whether the app is published at all.
 */
export function playTargets(configPath) {
  const doc = parseYaml(readFileSync(configPath, 'utf8'));
  const targets = [];
  for (const [id, spec] of Object.entries(doc.products ?? {})) {
    if (spec?.platform !== 'android') continue;
    if (!spec?.play_package) {
      throw new Error(
        `product \`${id}\` is platform android but declares no \`play_package\` in ${configPath}. ` +
          'The package id is how this job addresses the app; guessing one would query a stranger.'
      );
    }
    targets.push({ item_id: id, package_name: spec.play_package, store_item_status: spec.store_item_status });
  }
  return targets;
}

export async function ingest({
  targets,
  keyFile,
  dataRoot,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  log = console.log,
}) {
  const key = loadServiceAccountKey(keyFile, {
    expectClientEmail: EXPECTED_CLIENT_EMAIL,
    repoRoot: REPO_ROOT,
  });
  log(`key      ${key.key_path} (mode 0600, ${key.client_email})`);

  const { access_token } = await fetchAccessToken(key, { fetchImpl });
  log('token    exchanged (read-only androidpublisher scope)');

  const results = [];
  for (const t of targets) {
    const fetchedAt = now();
    const { reviews, pages } = await listReviews(t.package_name, access_token, { fetchImpl });
    const upstream = sha256(JSON.stringify(reviews));

    const summary = summariseReviews({
      packageName: t.package_name,
      itemId: t.item_id,
      reviews,
      storeItemStatus: t.store_item_status,
      fetchedAt,
      upstreamSha256: upstream,
    });

    const { bytes, checksum } = redactForStorage({
      packageName: t.package_name,
      itemId: t.item_id,
      reviews,
      fetchedAt,
    });

    const rawDir = join(dataRoot, 'metrics', 'raw', SOURCE, t.item_id);
    mkdirSync(rawDir, { recursive: true });
    const rawPath = join(rawDir, `${summary.as_of}--reviews-redacted.json`);
    writeFileSync(rawPath, bytes, { mode: 0o600 });

    const entry = createManifestEntry({
      source: summary.source,
      item_id: summary.item_id,
      as_of: summary.as_of,
      exported_at: summary.exported_at,
      checksum,
      as_of_source: 'fetched_at (this endpoint has no as-of field: it returns a rolling window, not a dated report)',
      metrics: summary.metrics,
      raw_path: rawPath,
      notes: {
        package_name: summary.package_name,
        missing: summary.missing,
        pages_fetched: pages,
        ...summary.provenance,
      },
    });
    appendManifest(dataRoot, entry);

    const missingNames = Object.keys(summary.missing);
    log(
      `${t.item_id.padEnd(10)} ${t.store_item_status.padEnd(14)} ` +
        `metrics=${Object.keys(summary.metrics).length} missing=${missingNames.length}` +
        (missingNames.length ? ` (${[...new Set(Object.values(summary.missing))].join(', ')})` : '') +
        `  lag_days=${entry.lag_days}`
    );
    if (summary.provenance.window_anomaly) log(`  ! ${summary.provenance.window_anomaly}`);

    results.push({ entry, summary });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = args.data_root ?? join(REPO_ROOT, 'data');
  const configPath = args.config ?? join(REPO_ROOT, 'config', 'portfolio.yaml');
  const keyFile = args.key_file ?? process.env.PLAY_READONLY_INGEST_KEY_FILE;

  if (!keyFile) {
    throw new Error(
      'PLAY_READONLY_INGEST_KEY_FILE is not set. It holds the PATH to the service-account JSON ' +
        'key on this machine (mode 0600), never the key itself. The founder places that file; ' +
        'no agent requests, receives, or transmits its contents. ' +
        'See docs/metrics-ingest.md §4.5.'
    );
  }

  let targets = playTargets(configPath);
  if (typeof args.item === 'string') {
    targets = targets.filter((t) => t.item_id === args.item);
    if (targets.length === 0) throw new Error(`no android product \`${args.item}\` in ${configPath}`);
  }

  if (args.dry_run) {
    // Resolves and validates the credential and the targets, opens no socket.
    const key = loadServiceAccountKey(keyFile, { expectClientEmail: EXPECTED_CLIENT_EMAIL, repoRoot: REPO_ROOT });
    console.log(`dry-run: key ${key.key_path} is readable, mode-0600 and belongs to ${key.client_email}`);
    for (const t of targets) {
      const verdict = t.store_item_status === 'published'
        ? 'would query; an empty list is a real 0'
        : `would query; an empty list is MISSING (store_item_status=${t.store_item_status}, production-only endpoint)`;
      console.log(`dry-run: ${t.item_id.padEnd(10)} ${t.package_name.padEnd(30)} ${verdict}`);
    }
    console.log('dry-run: nothing written, no request made.');
    return;
  }

  await ingest({ targets, keyFile, dataRoot });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Message only. A stack from this file can carry a key path but never a
    // key value; the message is still the right amount of detail for a log
    // that launchd keeps forever.
    console.error(`play-reviews-ingest: ${err.message}`);
    process.exit(1);
  });
}
