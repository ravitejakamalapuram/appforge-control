// Stamp file format shared by the checker and node jobs (APP-294). Shell jobs write the same shape from
// infra/macos/heartbeat.sh. A deployed standalone copy (quota-retry-watchdog) inlines this instead of importing it.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const stampPath = (dir, job) => join(dir, `${job}.json`);

export function readStamp(dir, job) {
  try { return JSON.parse(readFileSync(stampPath(dir, job), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function write(dir, job, stamp) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${stampPath(dir, job)}.tmp`;
  writeFileSync(tmp, JSON.stringify(stamp) + '\n');
  renameSync(tmp, stampPath(dir, job));
}

export function stampStart(dir, job, now = new Date()) {
  let prev = null;
  try { prev = readStamp(dir, job); } catch { /* an unreadable old stamp is replaced */ }
  write(dir, job, { job, started: now.toISOString(), finished: null, exitCode: null, lastSuccess: prev?.lastSuccess ?? null });
}

export function stampEnd(dir, job, exitCode, now = new Date()) {
  let prev = null;
  try { prev = readStamp(dir, job); } catch { /* see above */ }
  write(dir, job, {
    job, started: prev?.started ?? now.toISOString(), finished: now.toISOString(), exitCode,
    lastSuccess: exitCode === 0 ? now.toISOString() : prev?.lastSuccess ?? null,
  });
}
