import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calendarDaysBetween, createManifestEntry, appendManifest, readManifest,
  newestFor, utcCalendarDate, sha256,
} from '../lib/metrics-manifest.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'metrics-manifest-'));

test('lag is calendar-day arithmetic, not elapsed hours', () => {
  // Data through the 27th, pulled five minutes after midnight on the 28th.
  // Elapsed-hours division would call this 0 days of lag. It is 1.
  assert.equal(calendarDaysBetween('2026-09-27', '2026-09-28'), 1);
  assert.equal(utcCalendarDate('2026-09-28T00:05:00Z'), '2026-09-28');

  const entry = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-27', exported_at: '2026-09-28T00:05:00Z', checksum: 'abc',
  });
  assert.equal(entry.lag_days, 1);
});

test('lag is derived on every entry and never supplied', () => {
  const entry = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-20', exported_at: '2026-09-28T10:00:00Z',
    checksum: 'abc', lag_days: 99,   // an attempt to hardcode it
  });
  assert.equal(entry.lag_days, 8, 'a supplied lag_days must be ignored in favour of the derived value');
});

test('an export cannot carry data from the future', () => {
  assert.throws(() => createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'x',
    as_of: '2026-09-30', exported_at: '2026-09-28T10:00:00Z', checksum: 'abc',
  }), /after `exported_at`/);
});

test('every load-bearing field is required, not defaulted', () => {
  const base = {
    source: 'cws_dashboard_export', item_id: 'x',
    as_of: '2026-09-27', exported_at: '2026-09-28T10:00:00Z', checksum: 'abc',
  };
  for (const field of ['source', 'item_id', 'as_of', 'exported_at', 'checksum']) {
    const bad = { ...base };
    delete bad[field];
    assert.throws(() => createManifestEntry(bad), new RegExp(field),
      `${field} must be required rather than defaulted`);
  }
  assert.throws(() => createManifestEntry({ ...base, as_of: '09/27/2026' }), /YYYY-MM-DD/);
});

test('manifest round-trips as jsonl', () => {
  const dir = root();
  const a = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-20', exported_at: '2026-09-21T10:00:00Z',
    checksum: sha256('one'), metrics: { cws_installs: 10 },
  });
  const b = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-27', exported_at: '2026-09-28T10:00:00Z',
    checksum: sha256('two'), metrics: { cws_installs: 12 },
  });
  appendManifest(dir, a);
  appendManifest(dir, b);
  assert.equal(readManifest(dir).length, 2);
});

test('newest is by as_of, not by when it was loaded', () => {
  const dir = root();
  // The OLD export is appended LAST — as if someone backfilled it today.
  const fresh = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-27', exported_at: '2026-09-28T10:00:00Z',
    checksum: 'b', metrics: { cws_installs: 12 },
  });
  const old = createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-08-01', exported_at: '2026-09-29T10:00:00Z',
    checksum: 'a', metrics: { cws_installs: 3 },
  });
  appendManifest(dir, fresh);
  appendManifest(dir, old);

  const newest = newestFor(readManifest(dir), 'cws_installs', 'json-workbench');
  assert.equal(newest.as_of, '2026-09-27',
    'backfilling an old export must not become the newest reading');
});

test('newest is scoped per item', () => {
  const dir = root();
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'other-item',
    as_of: '2026-09-28', exported_at: '2026-09-28T10:00:00Z',
    checksum: 'a', metrics: { cws_installs: 99 },
  }));
  appendManifest(dir, createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'json-workbench',
    as_of: '2026-09-01', exported_at: '2026-09-02T10:00:00Z',
    checksum: 'b', metrics: { cws_installs: 4 },
  }));
  const n = newestFor(readManifest(dir), 'cws_installs', 'json-workbench');
  assert.equal(n.item_id, 'json-workbench');
  assert.equal(n.metrics.cws_installs, 4);
});

test('missing manifest reads as empty rather than throwing', () => {
  assert.deepEqual(readManifest(root()), []);
});
