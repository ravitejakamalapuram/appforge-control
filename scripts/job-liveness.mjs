#!/usr/bin/env node
// job-liveness.mjs - host-side lateness checker (infra/macos/job-liveness.sh): did every launchd job actually run? (APP-294)
//   job-liveness.mjs [--dry-run] [--self-only]
//   --dry-run    evaluate and print; open/close nothing, send nothing.
//   --self-only  only check that THIS checker ran recently (the digest gate calls this: who checks the checker).
// Exit 0: every job fresh and both drift checks clean. Exit 1: a finding or the checker is broken (ntfy sent).
// Env: PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, NTFY_TOPIC (optional), LIVENESS_ASSIGNEE, LIVENESS_PROJECT (optional),
//      HEALTHCHECKS_PING_URL_LIVENESS (optional dead-man's switch), APPFORGE_STATE_DIR, LIVENESS_PLIST_DIR,
//      LIVENESS_JOBS_CONFIG (default config/jobs.yaml), LIVENESS_LOADED (tests only: comma-separated loaded jobs
//      instead of asking `launchctl list`).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  parsePlistCadence, evaluateJobs, classifyJob, graceFor, justWoke, issueBody, planIssueSync, parseLaunchctlList, planWatch,
  CHECKER_JOB, ISSUE_PREFIX,
} from './lib/job-liveness.mjs';
import { readStamp } from './lib/job-heartbeat.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const selfOnly = args.includes('--self-only');
if (args.some((a) => !['--dry-run', '--self-only'].includes(a))) { console.error('usage: job-liveness.mjs [--dry-run] [--self-only]'); process.exit(2); }

const env = process.env;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLISTS = env.LIVENESS_PLIST_DIR ?? join(REPO_ROOT, 'infra/macos');
const JOBS_CONFIG = env.LIVENESS_JOBS_CONFIG ?? join(REPO_ROOT, 'config/jobs.yaml');
const HB_DIR = join(env.APPFORGE_STATE_DIR ?? join(REPO_ROOT, 'state'), 'heartbeats');
const CTO_ID = env.LIVENESS_ASSIGNEE ?? '3cba1fb3-21e1-4851-832b-95de5247bff1';
const PROJECT = env.LIVENESS_PROJECT ?? '';
const NODE = process.execPath;
const log = (m) => console.log(`[${new Date().toISOString()}] job-liveness: ${m}`);

function curl(a, input) { return execFileSync('curl', ['-fsS', '-m', '15', ...a], { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function notify(msg) {
  if (!env.NTFY_TOPIC || dry) return;
  try { curl(['-H', 'Title: appforge job-liveness', '-d', msg, `https://ntfy.sh/${env.NTFY_TOPIC}`]); } catch { /* best effort */ }
}
const fail = (msg) => { log(`FAIL ${msg}`); notify(`BROKEN: ${msg}`); process.exit(1); };

// Cadence comes from each committed plist template; WHICH jobs are watched comes from the reviewed list in
// config/jobs.yaml, so a template that is deliberately not loaded on this host never raises a false alarm.
let jobs;
try {
  jobs = readdirSync(PLISTS).filter((f) => /^ing\.paperclip\.appforge-.+\.plist$/.test(f)).map((f) => ({
    job: f.replace(/^ing\.paperclip\.appforge-/, '').replace(/\.plist$/, ''),
    cadenceSec: parsePlistCadence(readFileSync(join(PLISTS, f), 'utf8')),
  }));
  if (jobs.length === 0) throw new Error(`no ing.paperclip.appforge-*.plist in ${PLISTS}`);
} catch (e) { fail(`cannot read the plists: ${e.message}`); }

const self = jobs.find((j) => j.job === CHECKER_JOB);
if (!self) fail(`no plist for ${CHECKER_JOB}: the checker's own cadence is unknown`);
let prevSelf = null;
try { prevSelf = readStamp(HB_DIR, CHECKER_JOB); } catch { /* unreadable: treated as never-ran below */ }

if (selfOnly) {
  const r = classifyJob({ job: CHECKER_JOB, cadenceSec: self.cadenceSec, graceSec: graceFor(self.cadenceSec), stamp: prevSelf });
  log(`self-check: ${r.state} - ${r.detail}`);
  if (r.state !== 'ok') { notify(`the schedule-liveness checker is ${r.state}: ${r.detail}`); process.exit(1); }
  process.exit(0);
}

let config;
try { config = YAML.parse(readFileSync(JOBS_CONFIG, 'utf8')); } catch (e) { fail(`cannot read ${JOBS_CONFIG}: ${e.message}`); }
let loaded;
if (env.LIVENESS_LOADED != null) loaded = new Set(env.LIVENESS_LOADED.split(',').map((x) => x.trim()).filter(Boolean));
else {
  try { loaded = parseLaunchctlList(execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { fail(`launchctl list failed, so it is unknown which jobs are loaded: ${e.message}`); }
}
const watch = planWatch({ config, templates: new Map(jobs.map((j) => [j.job, j.cadenceSec])), loaded });
if (watch.errors.length) fail(`config/jobs.yaml does not match the plist templates: ${watch.errors.join('; ')}`);

const woke = justWoke({ prevCheckerSuccess: prevSelf?.lastSuccess ?? null, checkerCadenceSec: self.cadenceSec });
const results = [
  ...watch.notLoaded,
  ...evaluateJobs({ jobs: watch.jobs.filter((j) => j.job !== CHECKER_JOB), readStamp: (j) => readStamp(HB_DIR, j) }),
];

// Drift checks folded in (APP-294): exit 0 clean, 1 drift, anything else = the check itself is broken. Never "fine".
const CHECKS = [
  { key: 'instructions-sync', script: 'scripts/sync-agent-instructions.mjs', args: [] },
  { key: 'launcher-drift', script: 'scripts/detect-launcher-drift.mjs', args: [] },
];
for (const c of CHECKS) {
  try {
    execFileSync(NODE, [join(REPO_ROOT, c.script), ...c.args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    results.push({ job: c.key, state: 'ok', detail: 'clean' });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(0, 40).join('\n');
    results.push(e.status === 1
      ? { job: c.key, state: 'drift', detail: `${c.script} reported drift (exit 1):\n${out}` }
      : { job: c.key, state: 'broken', detail: `${c.script} could not run (exit ${e.status ?? e.code ?? 'signal'}): ${out}` });
  }
}

const findings = results.filter((r) => r.state !== 'ok').map((r) => ({ ...r, key: r.job }));
const healthyKeys = results.filter((r) => r.state === 'ok').map((r) => r.job);
for (const r of results) log(`${r.state.padEnd(10)} ${r.job}: ${String(r.detail).split('\n')[0]}`);
if (dry) { log(`dry-run: ${findings.length} finding(s); nothing opened, closed or sent`); process.exit(findings.length ? 1 : 0); }
if (woke) { log('the checker itself was not run for over 2 cycles (Mac asleep?): holding alerts one pass so jobs can catch up'); process.exit(0); }

for (const v of ['PAPERCLIP_API_URL', 'PAPERCLIP_COMPANY_ID']) if (!env[v]) fail(`${v} is not set - check did not run. This is NOT a quiet day.`);
const API = `${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}`;
const json = (a, input) => JSON.parse(curl(a, input) || 'null');
let broken = 0;
try {
  const listed = json([`${API}/issues?limit=1000`]);
  const issues = Array.isArray(listed) ? listed : listed?.issues ?? listed?.items ?? [];
  const plan = planIssueSync({ findings, healthyKeys, issues });
  for (const f of plan.open) {
    json(['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '@-', `${API}/issues`], JSON.stringify(issueBody(f, CTO_ID, PROJECT)));
    notify(`${f.key} ${f.state}: ${String(f.detail).split('\n')[0]}`);
    log(`opened ${ISSUE_PREFIX} ${f.key}`);
  }
  for (const i of plan.close) {
    json(['-X', 'PATCH', '-H', 'Content-Type: application/json', '-d', '@-', `${env.PAPERCLIP_API_URL}/api/issues/${i.id}`],
      JSON.stringify({ status: 'done', comment: 'Fresh again: the checker saw a successful run inside cadence + grace. Closed automatically.' }));
    log(`closed ${i.title}`);
  }
} catch (e) { broken += 1; log(`FAIL could not reconcile Paperclip issues: ${e.message}`); notify(`BROKEN: liveness could not reach Paperclip: ${e.message}`); }

// Dead-man's switch for "who checks the checker": ping only when the pass completed and the company is healthy.
if (!broken && env.HEALTHCHECKS_PING_URL_LIVENESS) { try { curl([env.HEALTHCHECKS_PING_URL_LIVENESS]); } catch { /* best effort */ } }
log(`checked ${results.length}: ${findings.length} finding(s), ${broken} broken`);
process.exit(findings.length || broken ? 1 : 0);
