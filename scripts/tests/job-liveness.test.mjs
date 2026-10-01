// APP-294 mutation tests: break the intended state, the verifier must fail. A verifier that cannot fail is not one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlistCadence, classifyJob, evaluateJobs, graceFor, justWoke, planIssueSync, issueTitle, parseLaunchctlList, planWatch } from '../lib/job-liveness.mjs';
import YAML from 'yaml';
import { stampStart, stampEnd, readStamp } from '../lib/job-heartbeat.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const MAC = path.join(REPO, 'infra/macos');
const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const okStamp = (sec) => ({ job: 'x', started: ago(sec + 5), finished: ago(sec), exitCode: 0, lastSuccess: ago(sec) });

test('cadence is read from every committed plist (StartInterval and StartCalendarInterval)', () => {
  const want = { 'play-vitals': 86400, 'repo-refresh': 3600, backup: 86400, 'digest-gate': 86400, sync: 1800, 'lock-guard': 60, 'quota-watchdog': 90, 'release-bridge': 3600, 'job-liveness': 600 };
  for (const [job, sec] of Object.entries(want)) {
    assert.equal(parsePlistCadence(readFileSync(path.join(MAC, `ing.paperclip.appforge-${job}.plist`), 'utf8')), sec, job);
  }
  assert.equal(parsePlistCadence('<dict><key>Label</key><string>x</string></dict>'), null);
  assert.equal(parsePlistCadence('<!-- <key>StartInterval</key><integer>5</integer> --><dict/>'), null, 'commented-out keys do not count');
});

test('MUTATION: a stamp older than cadence + grace is overdue; inside the window it is ok', () => {
  const cadenceSec = 1800, graceSec = graceFor(1800);
  const fresh = classifyJob({ job: 'sync', cadenceSec, graceSec, stamp: okStamp(cadenceSec + graceSec - 10), now: NOW });
  assert.equal(fresh.state, 'ok');
  const late = classifyJob({ job: 'sync', cadenceSec, graceSec, stamp: okStamp(cadenceSec + graceSec + 10), now: NOW });
  assert.equal(late.state, 'overdue');
});

test('MUTATION: a missing stamp is never-ran, not fine', () => {
  assert.equal(classifyJob({ job: 'backup', cadenceSec: 86400, graceSec: 10800, stamp: null, now: NOW }).state, 'never-ran');
  const [r] = evaluateJobs({ jobs: [{ job: 'backup', cadenceSec: 86400 }], readStamp: () => null, now: NOW });
  assert.equal(r.state, 'never-ran');
});

test('MUTATION: a last run that failed is reported even when its last success is fresh', () => {
  const stamp = { job: 'x', started: ago(60), finished: ago(55), exitCode: 2, lastSuccess: ago(300) };
  assert.equal(classifyJob({ job: 'play-vitals', cadenceSec: 86400, graceSec: 10800, stamp, now: NOW }).state, 'failed');
});

test('MUTATION: a run that started and never finished does not renew the job', () => {
  const stamp = { job: 'x', started: ago(7200), finished: null, exitCode: null, lastSuccess: ago(7300) };
  assert.equal(classifyJob({ job: 'repo-refresh', cadenceSec: 3600, graceSec: graceFor(3600), stamp, now: NOW }).state, 'overdue');
  const neverOk = { job: 'x', started: ago(100000), finished: null, exitCode: null, lastSuccess: null };
  assert.equal(classifyJob({ job: 'backup', cadenceSec: 86400, graceSec: 10800, stamp: neverOk, now: NOW }).state, 'overdue');
});

test('an unreadable stamp, or a plist with no schedule, is a finding, never ok', () => {
  const [a] = evaluateJobs({ jobs: [{ job: 'x', cadenceSec: 60 }], readStamp: () => { throw new Error('bad json'); }, now: NOW });
  assert.equal(a.state, 'unreadable');
  assert.equal(classifyJob({ job: 'x', cadenceSec: 60, graceSec: 300, stamp: { started: 'garbage' }, now: NOW }).state, 'unreadable');
  assert.equal(classifyJob({ job: 'x', cadenceSec: null, graceSec: 0, stamp: okStamp(1), now: NOW }).state, 'no-cadence');
});

test('the checker holds alerts one pass after the Mac slept, but not when it ran recently', () => {
  assert.equal(justWoke({ prevCheckerSuccess: ago(3600), checkerCadenceSec: 600, now: NOW }), true);
  assert.equal(justWoke({ prevCheckerSuccess: ago(700), checkerCadenceSec: 600, now: NOW }), false);
  assert.equal(justWoke({ prevCheckerSuccess: null, checkerCadenceSec: 600, now: NOW }), false);
});

test('ONE issue per key: an open issue is kept, not duplicated; a healthy key closes its issue; closed issues do not count', () => {
  const issues = [{ id: 'a', title: issueTitle('sync'), status: 'todo' }, { id: 'b', title: issueTitle('backup'), status: 'in_progress' }, { id: 'c', title: issueTitle('lock-guard'), status: 'done' }];
  const plan = planIssueSync({ findings: [{ key: 'sync' }, { key: 'lock-guard' }], healthyKeys: ['backup', 'repo-refresh'], issues });
  assert.deepEqual(plan.keep.map((f) => f.key), ['sync']);
  assert.deepEqual(plan.open.map((f) => f.key), ['lock-guard']);
  assert.deepEqual(plan.close.map((i) => i.id), ['b']);
});

test('stamp writers: success sets lastSuccess, failure keeps the old one, a start never claims success', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-'));
  stampStart(dir, 'j', new Date(NOW));
  assert.equal(readStamp(dir, 'j').lastSuccess, null);
  stampEnd(dir, 'j', 0, new Date(NOW + 1000));
  assert.equal(readStamp(dir, 'j').lastSuccess, new Date(NOW + 1000).toISOString());
  stampStart(dir, 'j', new Date(NOW + 5000));
  stampEnd(dir, 'j', 1, new Date(NOW + 6000));
  const s = readStamp(dir, 'j');
  assert.equal(s.exitCode, 1);
  assert.equal(s.lastSuccess, new Date(NOW + 1000).toISOString());
});

// ---- the real shell wrapper, run as a launchd job would run it ----
function shellJob(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hbsh-'));
  copyFileSync(path.join(MAC, 'heartbeat.sh'), path.join(dir, 'heartbeat.sh'));
  const script = path.join(dir, 'job.sh');
  writeFileSync(script, `#!/usr/bin/env bash\nset -uo pipefail\n. "$(dirname "\${BASH_SOURCE[0]}")/heartbeat.sh"; hb_wrap demo "$@"\n${body}\n`, { mode: 0o755 });
  const state = path.join(dir, 'state');
  const run = (...a) => spawnSync('/bin/bash', [script, ...a], { env: { ...process.env, APPFORGE_STATE_DIR: state }, encoding: 'utf8' });
  return { run, stamp: () => JSON.parse(readFileSync(path.join(state, 'heartbeats', 'demo.json'), 'utf8')), state };
}

test('heartbeat.sh stamps the real exit code (0, non-zero, set -e, exec) and never changes it', () => {
  const ok = shellJob('echo hi; exit 0');
  assert.equal(ok.run().status, 0);
  assert.equal(ok.stamp().exitCode, 0);
  assert.ok(ok.stamp().lastSuccess);

  const bad = shellJob('exit 7');
  assert.equal(bad.run().status, 7);
  assert.equal(bad.stamp().exitCode, 7);
  assert.equal(bad.stamp().lastSuccess, null);

  const trapped = shellJob('trap "echo cleanup" EXIT\nexec /bin/sh -c "exit 3"');
  assert.equal(trapped.run().status, 3);
  assert.equal(trapped.stamp().exitCode, 3);

  const sete = shellJob('set -e\nfalse\necho unreachable');
  assert.equal(sete.run().status, 1);
  assert.equal(sete.stamp().exitCode, 1);
});

test('heartbeat.sh: --dry-run is not a run and leaves no stamp', () => {
  const j = shellJob('exit 0');
  assert.equal(j.run('--dry-run').status, 0);
  assert.equal(existsSync(path.join(j.state, 'heartbeats', 'demo.json')), false);
});

test('MUTATION: a stamp written by the real wrapper turns overdue once it is older than cadence + grace', () => {
  const j = shellJob('exit 0');
  j.run();
  const stamp = j.stamp();
  const at = Date.parse(stamp.finished);
  assert.equal(classifyJob({ job: 'demo', cadenceSec: 60, graceSec: 300, stamp, now: at + 359e3 }).state, 'ok');
  assert.equal(classifyJob({ job: 'demo', cadenceSec: 60, graceSec: 300, stamp, now: at + 361e3 }).state, 'overdue');
});

test('every committed LaunchAgent either sources heartbeat.sh or stamps itself (so no job is un-checkable)', () => {
  const self = { 'lock-guard': path.join(REPO, 'scripts/paperclip-lock-guard.sh'), 'quota-watchdog': path.join(REPO, 'scripts/quota-retry-watchdog.mjs') };
  const jobs = readdirSync(MAC).filter((f) => /^ing\.paperclip\.appforge-.+\.plist$/.test(f)).map((f) => f.replace(/^ing\.paperclip\.appforge-|\.plist$/g, ''));
  assert.ok(jobs.length >= 9);
  for (const job of jobs) {
    const file = self[job] ?? path.join(MAC, `${job}.sh`);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(`hb_wrap ${job} `) || (self[job] && /heartbeat|lastSuccess/.test(text) && text.includes(job)), `${job} does not write a stamp`);
  }
});

// ---- the checker end to end, against a fake Paperclip API ----
import http from 'node:http';
async function fakeApi(issues = []) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify(issues));
      res.end('{"id":"new"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const JOBS_CFG = YAML.parse(readFileSync(path.join(REPO, 'config/jobs.yaml'), 'utf8'));
const TEMPLATES = new Map(readdirSync(MAC).filter((f) => /^ing\.paperclip\.appforge-.+\.plist$/.test(f))
  .map((f) => [f.replace(/^ing\.paperclip\.appforge-|\.plist$/g, ''), 1]));

test('config/jobs.yaml: every plist template is reviewed into exactly one of expected / not_installed', () => {
  const r = planWatch({ config: JOBS_CFG, templates: TEMPLATES, loaded: new Set(JOBS_CFG.expected) });
  assert.deepEqual(r.errors, []);
  for (const j of ['sync', 'quota-watchdog', 'digest-gate']) assert.ok(j in JOBS_CFG.not_installed, `${j} is deliberately not loaded`);
  // MUTATION: a new template nobody reviewed, or a job in both sections, is a config error (the checker fails loud).
  const extra = new Map([...TEMPLATES, ['new-job', 60]]);
  assert.match(planWatch({ config: JOBS_CFG, templates: extra, loaded: new Set() }).errors.join(), /new-job is in neither/);
  const both = { ...JOBS_CFG, expected: [...JOBS_CFG.expected, 'sync'] };
  assert.match(planWatch({ config: both, templates: TEMPLATES, loaded: new Set() }).errors.join(), /sync is listed both/);
  assert.match(planWatch({ config: { expected: ['ghost'], not_installed: {} }, templates: new Map(), loaded: new Set() }).errors.join(), /ghost has no plist/);
});

test('planWatch: an unloaded not_installed job is not watched; an expected job that is not loaded is a finding', () => {
  const loaded = new Set(JOBS_CFG.expected.filter((j) => j !== 'backup'));
  const r = planWatch({ config: JOBS_CFG, templates: TEMPLATES, loaded });
  assert.deepEqual(r.jobs.map((j) => j.job).sort(), [...loaded].sort());
  assert.ok(!r.jobs.some((j) => j.job === 'sync') && !r.notLoaded.some((f) => f.job === 'sync'), 'sync is deliberately not loaded: no finding');
  assert.deepEqual(r.notLoaded.map((f) => [f.job, f.state]), [['backup', 'not-loaded']]);
});

test('parseLaunchctlList reads the appforge labels and nothing else', () => {
  const out = 'PID\tStatus\tLabel\n-\t1\ting.paperclip.appforge-play-vitals\n123\t0\ting.paperclip.appforge-backup\n-\t0\tcom.apple.foo\n-\t0\ting.paperclip.other\n';
  assert.deepEqual([...parseLaunchctlList(out)].sort(), ['backup', 'play-vitals']);
});

async function runChecker(env) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => execFile(process.execPath, [path.join(REPO, 'scripts/job-liveness.mjs')], { env }, (err, stdout) => resolve({ code: err?.code ?? 0, stdout })));
}
function stateWithFreshStamps(except) {
  const state = mkdtempSync(path.join(tmpdir(), 'live-'));
  const hb = path.join(state, 'heartbeats'); mkdirSync(hb, { recursive: true });
  const fresh = new Date().toISOString();
  for (const j of JOBS_CFG.expected) if (!except.includes(j)) writeFileSync(path.join(hb, `${j}.json`), JSON.stringify({ job: j, started: fresh, finished: fresh, exitCode: 0, lastSuccess: fresh }));
  return state;
}

test('checker CLI: missing stamps open ONE issue each and exit 1; unloaded not_installed jobs (no stamp) open nothing', async () => {
  const state = stateWithFreshStamps(['backup']); // and no stamp at all for sync / quota-watchdog / digest-gate
  const api = await fakeApi();
  const r = await runChecker({ ...process.env, APPFORGE_STATE_DIR: state, PAPERCLIP_API_URL: api.url, PAPERCLIP_COMPANY_ID: 'co', NTFY_TOPIC: '', LIVENESS_LOADED: JOBS_CFG.expected.join(',') });
  api.close();
  const titles = api.calls.filter((c) => c.method === 'POST').map((p) => JSON.parse(p.body).title);
  assert.ok(titles.includes(issueTitle('backup')), r.stdout);
  assert.equal(titles.filter((t) => t === issueTitle('backup')).length, 1);
  for (const j of Object.keys(JOBS_CFG.not_installed)) assert.ok(!titles.includes(issueTitle(j)), `${j} must not raise a finding`);
  assert.match(r.stdout, /never-ran\s+backup/);
  assert.doesNotMatch(r.stdout, /never-ran\s+(sync|quota-watchdog|digest-gate)/);
  assert.equal(r.code, 1);
});

test('MUTATION checker CLI: an expected job that launchd has not loaded is reported, even with a fresh stamp', async () => {
  const state = stateWithFreshStamps([]);
  const api = await fakeApi();
  const r = await runChecker({ ...process.env, APPFORGE_STATE_DIR: state, PAPERCLIP_API_URL: api.url, PAPERCLIP_COMPANY_ID: 'co', NTFY_TOPIC: '', LIVENESS_LOADED: JOBS_CFG.expected.filter((j) => j !== 'repo-refresh').join(',') });
  api.close();
  const titles = api.calls.filter((c) => c.method === 'POST').map((p) => JSON.parse(p.body).title);
  assert.deepEqual(titles.filter((t) => t.includes('repo-refresh')), [issueTitle('repo-refresh')], r.stdout);
  assert.match(r.stdout, /not-loaded\s+repo-refresh/);
  assert.equal(r.code, 1);
});

test('MUTATION checker CLI: a config that does not match the templates fails loud and opens nothing', async () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), 'cfg-')), 'jobs.yaml');
  writeFileSync(cfg, 'expected: [backup, job-liveness]\nnot_installed: {}\n');
  const api = await fakeApi();
  const r = await runChecker({ ...process.env, APPFORGE_STATE_DIR: stateWithFreshStamps([]), PAPERCLIP_API_URL: api.url, PAPERCLIP_COMPANY_ID: 'co', NTFY_TOPIC: '', LIVENESS_LOADED: 'backup,job-liveness', LIVENESS_JOBS_CONFIG: cfg });
  api.close();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL config\/jobs.yaml does not match/);
  assert.equal(api.calls.length, 0);
});

test('--self-only: a missing or stale checker stamp exits 1, a fresh one exits 0 (who checks the checker)', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'self-')); const hb = path.join(state, 'heartbeats'); mkdirSync(hb, { recursive: true });
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'scripts/job-liveness.mjs'), '--self-only'], { env: { ...process.env, APPFORGE_STATE_DIR: state }, encoding: 'utf8' });
  assert.equal(run().status, 1, 'no stamp');
  const old = new Date(Date.now() - 3600e3).toISOString();
  writeFileSync(path.join(hb, 'job-liveness.json'), JSON.stringify({ job: 'job-liveness', started: old, finished: old, exitCode: 0, lastSuccess: old }));
  assert.equal(run().status, 1, 'stale stamp');
  const now = new Date().toISOString();
  writeFileSync(path.join(hb, 'job-liveness.json'), JSON.stringify({ job: 'job-liveness', started: now, finished: now, exitCode: 0, lastSuccess: now }));
  assert.equal(run().status, 0, 'fresh stamp');
});
