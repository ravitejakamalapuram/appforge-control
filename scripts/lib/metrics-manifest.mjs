// Per-import manifest for the store-metrics ingest (APP-42).
//
// Every import records the `as_of` date the export itself carries and the
// `exported_at` timestamp at which it was pulled. `lag_days` is DERIVED from
// those two and is never configured, defaulted, or assumed. A hardcoded
// dashboard-refresh delay would become folklore and be wrong by a day
// forever; §"The part that matters most" of APP-42 forbids it explicitly.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MANIFEST_RELPATH = join('metrics', 'manifest.jsonl');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Calendar-day difference between two UTC calendar dates.
 *
 * Deliberately calendar arithmetic, not elapsed-milliseconds arithmetic.
 * "Data through 2026-09-27, exported 2026-09-28T00:05Z" is a lag of one day,
 * and elapsed-hours division would call it zero. An earlier revision of this
 * file anchored on end-of-day and was off by one for exports pulled just
 * after midnight.
 */
export function calendarDaysBetween(fromDate, toDate) {
  const a = Date.UTC(...utcParts(fromDate));
  const b = Date.UTC(...utcParts(toDate));
  return Math.round((b - a) / 86400000);
}

function utcParts(value) {
  if (value instanceof Date) {
    return [value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()];
  }
  if (typeof value === 'string' && DATE_RE.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return [y, m - 1, d];
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`not a date: ${JSON.stringify(value)}`);
  }
  return [parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()];
}

/** The UTC calendar date (YYYY-MM-DD) that an instant falls on. */
export function utcCalendarDate(instant) {
  const [y, m, d] = utcParts(instant);
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Build one manifest entry. Throws rather than defaulting on anything
 * load-bearing — a manifest with a guessed `as_of` is worse than no manifest,
 * because freshness is computed from it.
 */
export function createManifestEntry({
  source,
  item_id,
  as_of,
  exported_at,
  checksum,
  metrics = {},
  as_of_source = null,
  raw_path = null,
  notes = null,
}) {
  if (!source) throw new Error('manifest entry requires `source`');
  if (!item_id) throw new Error('manifest entry requires `item_id`');
  if (!as_of) throw new Error('manifest entry requires `as_of` (the date the export itself carries)');
  if (!DATE_RE.test(as_of)) throw new Error(`\`as_of\` must be YYYY-MM-DD, got ${JSON.stringify(as_of)}`);
  if (!exported_at) throw new Error('manifest entry requires `exported_at`');
  if (!checksum) throw new Error('manifest entry requires `checksum`');

  const exportedDate = utcCalendarDate(exported_at);
  const lag_days = calendarDaysBetween(as_of, exportedDate);
  if (lag_days < 0) {
    throw new Error(
      `\`as_of\` (${as_of}) is after \`exported_at\` (${exportedDate}): an export cannot carry data from the future`
    );
  }

  return {
    source,
    item_id,
    as_of,
    exported_at: new Date(exported_at).toISOString(),
    lag_days,          // DERIVED. Never read from config.
    checksum,
    as_of_source,      // which column/field `as_of` was read out of, for audit
    raw_path,
    metrics,
    notes,
    recorded_at: new Date().toISOString(),
  };
}

export function manifestPath(dataRoot) {
  return join(dataRoot, MANIFEST_RELPATH);
}

export function appendManifest(dataRoot, entry) {
  const path = manifestPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry) + '\n', { flag: 'a' });
  return path;
}

export function readManifest(dataRoot) {
  const path = manifestPath(dataRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`manifest line ${i + 1} is not valid JSON: ${err.message}`);
      }
    });
}

/**
 * The newest import carrying `metricName` for `itemId`, by `as_of` — NOT by
 * `recorded_at`. Re-importing an old export must not make a metric look
 * fresh; freshness is a property of the data's date, not of when somebody
 * got around to loading it.
 */
export function newestFor(manifest, metricName, itemId = null) {
  const candidates = manifest.filter(
    (e) =>
      Object.prototype.hasOwnProperty.call(e.metrics ?? {}, metricName) &&
      (itemId === null || e.item_id === itemId)
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, e) => (e.as_of > best.as_of ? e : best));
}
