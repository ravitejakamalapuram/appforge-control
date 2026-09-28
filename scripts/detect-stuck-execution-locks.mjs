#!/usr/bin/env node
// detect-stuck-execution-locks.mjs — APP-53 (diagnosis) / APP-91 (wired hourly).
//
// Reads the Paperclip control plane and reports issues whose execution lock is
// not backed by a live run. Exit 0 = nothing stuck (print nothing; the routine
// applies the do-nothing rule). Exit 1 = at least one stuck lock, with the
// diagnosis on stdout for the routine's execution issue to carry verbatim.
// Exit 2 = the detector itself could not run.
//
// DETECTION ONLY. It issues GETs and nothing else. Do not add a release,
// cancel, or force-release call here — CEO ruling on APP-91 is that automated
// remediation needs its own approval with a stated false-positive rate. The
// classification rules and the reasoning behind the dispatch grace live in
// lib/detect-stuck-execution-locks.mjs; read that before changing thresholds.
//
// Usage:
//   node scripts/detect-stuck-execution-locks.mjs
//   node scripts/detect-stuck-execution-locks.mjs --json
//   node scripts/detect-stuck-execution-locks.mjs --grace-minutes 60 --escalate-hours 2
//
// Auth: PAPERCLIP_API_URL + PAPERCLIP_API_KEY + PAPERCLIP_COMPANY_ID, which a
// heartbeat run already has injected. No extra credential is needed, and the
// script must never request one — an agent run JWT is sufficient for every GET
// it makes.
import {
  buildReport,
  renderReport,
  selectLockedIssues,
  DEFAULT_QUEUED_GRACE_MS,
  DEFAULT_ESCALATION_AGE_MS,
} from './lib/detect-stuck-execution-locks.mjs';

const LOCKABLE_STATUSES = 'todo,in_progress,in_review,blocked';

function parseArgs(argv) {
  const args = { json: false, graceMs: DEFAULT_QUEUED_GRACE_MS, escalateMs: DEFAULT_ESCALATION_AGE_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--grace-minutes') args.graceMs = Number(argv[++i]) * 60 * 1000;
    else if (arg === '--escalate-hours') args.escalateMs = Number(argv[++i]) * 60 * 60 * 1000;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.graceMs) || args.graceMs < 0) throw new Error('--grace-minutes must be a non-negative number');
  if (!Number.isFinite(args.escalateMs) || args.escalateMs < 0) throw new Error('--escalate-hours must be a non-negative number');
  return args;
}

function apiBase() {
  const raw = process.env.PAPERCLIP_API_URL;
  if (!raw) throw new Error('PAPERCLIP_API_URL is not set');
  return raw.replace(/\/$/, '').replace(/\/api$/, '');
}

async function getJson(path) {
  const key = process.env.PAPERCLIP_API_KEY;
  if (!key) throw new Error('PAPERCLIP_API_KEY is not set');
  const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GET ${path} -> ${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** The issues list endpoint has returned both a bare array and {issues:[…]}. Tolerate both. */
function unwrapIssues(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.issues)) return payload.issues;
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error('PAPERCLIP_COMPANY_ID is not set');

  const issues = unwrapIssues(
    await getJson(`/api/companies/${companyId}/issues?status=${LOCKABLE_STATUSES}&limit=200`),
  );
  const locked = selectLockedIssues(issues);

  // Each locked issue's own run row. A fetch failure is recorded separately so a
  // flaky call is never read as "the run is gone".
  const runsById = new Map();
  const runFetchFailures = new Set();
  for (const issue of locked) {
    const runId = issue.executionRunId;
    if (runsById.has(runId) || runFetchFailures.has(runId)) continue;
    try {
      const payload = await getJson(`/api/heartbeat-runs/${runId}`);
      runsById.set(runId, payload?.run ?? payload);
    } catch (err) {
      // 404 is a real finding (the lock points at a run that does not exist);
      // anything else is our own blindness and must not be reported as stuck.
      if (err.status === 404) runsById.set(runId, null);
      else runFetchFailures.add(runId);
    }
  }

  const report = buildReport({
    issues,
    runsById,
    runFetchFailures,
    now: Date.now(),
    queuedGraceMs: args.graceMs,
    escalationAgeMs: args.escalateMs,
  });

  // Exclude this run's own lock: the detector necessarily holds a lock on the
  // routine's execution issue while it sweeps, and reporting itself would be a
  // guaranteed false positive on every pass.
  const selfRunId = process.env.PAPERCLIP_RUN_ID;
  if (selfRunId) {
    report.stuck = report.stuck.filter((f) => f.runId !== selfRunId);
    report.escalate = report.escalate.filter((f) => f.runId !== selfRunId);
    report.notes = report.notes.filter((f) => f.runId !== selfRunId);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const rendered = renderReport(report);
    if (rendered) process.stdout.write(`${rendered}\n`);
  }

  process.exit(report.stuck.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`detect-stuck-execution-locks: ${err.message}\n`);
  process.exit(2);
});
