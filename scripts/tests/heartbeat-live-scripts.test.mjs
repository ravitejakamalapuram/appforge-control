// Review of PR #72: hb_wrap re-runs the job script as a child, so a wrapper bug could silently break the REAL jobs
// (a backup that never runs, or runs twice, or reports the wrong exit code). These tests run the real backup.sh and
// repo-refresh.sh exactly as launchd does (the script path, no `bash` in front) and check the exit code, the stamp
// and that the body ran once. Nothing here reaches the network: backup.sh stops at its env check or its dry-run,
// and repo-refresh.sh fetches from a local bare repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra/macos');
const BACKUP_VARS = ['CLOUDFLARE_R2_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'HEALTHCHECKS_PING_URL_BACKUP', 'NTFY_TOPIC'];

function stateDir() { return mkdtempSync(path.join(tmpdir(), 'hb-live-')); }
const stampPath = (state, job) => path.join(state, 'heartbeats', `${job}.json`);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
function seedStamp(state, job, lastSuccess) {
  mkdirSync(path.join(state, 'heartbeats'), { recursive: true });
  writeFileSync(stampPath(state, job), JSON.stringify({ job, started: lastSuccess, finished: lastSuccess, exitCode: 0, lastSuccess }));
}
function run(script, args, env) {
  const clean = { ...process.env };
  for (const v of [...BACKUP_VARS, 'HB_ACTIVE']) delete clean[v]; // never inherit real secrets into a test run
  return spawnSync(path.join(MAC, script), args, { env: { ...clean, ...env }, encoding: 'utf8', timeout: 60000 });
}
const count = (text, re) => (text.match(new RegExp(re, 'g')) ?? []).length;

test('real backup.sh --dry-run through hb_wrap: exit 0, nothing done, no stamp', () => {
  const state = stateDir();
  const fake = { CLOUDFLARE_R2_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'x', HEALTHCHECKS_PING_URL_BACKUP: 'http://127.0.0.1:9/never', NTFY_TOPIC: 'never-sent' };
  const r = run('backup.sh', ['--dry-run'], { APPFORGE_STATE_DIR: state, ...fake });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.stdout, 'backup.sh: dry-run'), 1, r.stdout);
  assert.doesNotMatch(r.stdout + r.stderr, /uploaded|FAILED/);
  assert.equal(existsSync(stampPath(state, 'backup')), false, 'a dry-run is not a run');
});

test('real backup.sh, FIRST run on a host (no stamp yet) under set -euo pipefail: the body runs and is stamped', () => {
  // Regression: hb_last_success's sed on a missing stamp failed the pipeline, and set -e killed backup.sh with exit 1
  // before it ran or stamped anything, on every run.
  const state = stateDir();
  const r = run('backup.sh', [], { APPFORGE_STATE_DIR: state });
  assert.equal(r.status, 90, `the real env check must run and give its own exit code: ${r.stderr}`);
  assert.equal(count(r.stderr, 'missing required env var'), 1);
  const s = readJson(stampPath(state, 'backup'));
  assert.equal(s.exitCode, 90);
  assert.equal(s.lastSuccess, null);
});

test('MUTATION real backup.sh through hb_wrap: a failing run keeps its exit code, is stamped failed, keeps lastSuccess', () => {
  const state = stateDir();
  seedStamp(state, 'backup', '2026-09-30T03:00:00Z');
  const r = run('backup.sh', [], { APPFORGE_STATE_DIR: state }); // no env -> the real script's own exit 90
  assert.equal(r.status, 90, r.stderr);
  assert.equal(count(r.stderr, 'missing required env var'), 1, 'the body ran exactly once');
  const s = readJson(stampPath(state, 'backup'));
  assert.equal(s.exitCode, 90);
  assert.ok(s.finished);
  assert.equal(s.lastSuccess, '2026-09-30T03:00:00Z', 'a failure must not renew lastSuccess');
  assert.equal(run('backup.sh', ['--bogus'], { APPFORGE_STATE_DIR: stateDir() }).status, 2, 'unknown arguments are refused');
});

// Only the temp repo: no Paperclip workspace base clones, no App-token minting.
const ISOLATED = { REPO_REFRESH_WS_REPOS: '', REPO_REFRESH_TOKEN_CMD: 'false', NTFY_TOPIC: '' };
function productsRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'hb-repos-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { stdio: 'pipe' });
  g('init', '--bare', '-q', path.join(root, 'origin.git'));
  g('clone', '-q', path.join(root, 'origin.git'), path.join(root, 'seed'));
  g('-C', path.join(root, 'seed'), 'commit', '-q', '--allow-empty', '-m', 'init');
  g('-C', path.join(root, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
  g('clone', '-q', path.join(root, 'origin.git'), path.join(root, 'demo'));
  return { root, g };
}

test('real repo-refresh.sh through hb_wrap: success exits 0 and stamps lastSuccess; the body runs once', () => {
  const { root } = productsRoot();
  const state = stateDir();
  const r = run('repo-refresh.sh', [], { APPFORGE_STATE_DIR: state, APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'demo', ...ISOLATED });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(count(r.stdout, 'repo-refresh: done: 1 refreshed, 0 failed'), 1, r.stdout);
  const s = readJson(stampPath(state, 'repo-refresh'));
  assert.equal(s.exitCode, 0);
  assert.equal(s.lastSuccess, s.finished);
});

test('MUTATION real repo-refresh.sh through hb_wrap: a failing run exits 1, is stamped failed, keeps lastSuccess', () => {
  const { root, g } = productsRoot();
  g('-C', path.join(root, 'demo'), 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
  const state = stateDir();
  seedStamp(state, 'repo-refresh', '2026-10-01T00:00:00Z');
  const r = run('repo-refresh.sh', [], { APPFORGE_STATE_DIR: state, APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'demo', ...ISOLATED });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(count(r.stdout, 'repo-refresh: done: 0 refreshed, 1 failed'), 1, r.stdout);
  const s = readJson(stampPath(state, 'repo-refresh'));
  assert.equal(s.exitCode, 1);
  assert.equal(s.lastSuccess, '2026-10-01T00:00:00Z');
});
