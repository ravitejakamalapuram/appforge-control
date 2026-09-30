#!/usr/bin/env node
// Fetch Google Play crash + ANR rates for one app and say whether it needs attention.
// AI-1 step 1 ("Detect"). Run by the ingest job / launchd, NOT by an agent: the read-only
// service-account key is bound to this job only (docs/metrics-ingest.md section 4).
//
//   node scripts/play-vitals.mjs --package com.invtracker.inv_tracker --dry-run
//   PLAY_SA_KEY_FILE=/path/key.json node scripts/play-vitals.mjs --package com.invtracker.inv_tracker
//
// Exit codes: 0 ok, 1 alert (crash/ANR breach or regression), 3 insufficient data, 2 error.
// The key is read from PLAY_SA_KEY_FILE, used to mint a short-lived token, and never printed or
// written anywhere. Output (no secrets) goes to stdout and data/metrics/raw/play-vitals-*.json.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { vitalsWindow, buildQuery, metricSetPath, parseRows, assessVitals, isoDate } from './lib/play-vitals.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting';
const API = 'https://playdeveloperreporting.googleapis.com';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const pkg = arg('--package');
const dryRun = process.argv.includes('--dry-run');
if (!pkg) {
  console.error('play-vitals: --package <android package name> is required');
  process.exit(2);
}

const window = vitalsWindow(new Date());
const queries = { crash: buildQuery('crash', window), anr: buildQuery('anr', window) };

if (dryRun) {
  for (const kind of ['crash', 'anr']) {
    console.log(`POST ${API}${metricSetPath(pkg, kind)}`);
    console.log(JSON.stringify(queries[kind], null, 2));
  }
  process.exit(0);
}

const keyFile = process.env.PLAY_SA_KEY_FILE;
if (!keyFile) {
  console.error('play-vitals: PLAY_SA_KEY_FILE is not set (path to the read-only service-account JSON)');
  process.exit(2);
}

async function accessToken() {
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: key.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    key.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    // Print Google's error code/description only - never the assertion or key.
    throw new Error(`token exchange failed: HTTP ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  }
  return body.access_token;
}

async function query(token, kind) {
  const res = await fetch(`${API}${metricSetPath(pkg, kind)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queries[kind]),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = body?.error?.message ?? JSON.stringify(body).slice(0, 300);
    throw new Error(`${kind} query failed: HTTP ${res.status} ${msg}`);
  }
  return body;
}

try {
  const token = await accessToken();
  const results = {};
  for (const [kind, metric] of [['crash', 'userPerceivedCrashRate'], ['anr', 'userPerceivedAnrRate']]) {
    const series = parseRows(await query(token, kind));
    results[kind] = assessVitals(series, metric);
    results[kind].days = series.length;
  }
  const out = {
    package: pkg,
    window: { start: isoDate(window.start), end: isoDate(window.end) },
    fetched_at: new Date().toISOString(),
    crash: results.crash,
    anr: results.anr,
  };
  const dir = join(REPO_ROOT, 'data', 'metrics', 'raw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `play-vitals-${pkg}-${out.window.end}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  const statuses = [results.crash.status, results.anr.status];
  process.exit(statuses.includes('alert') ? 1 : statuses.includes('insufficient_data') ? 3 : 0);
} catch (err) {
  console.error(`play-vitals: ${err.message}`);
  process.exit(2);
}
