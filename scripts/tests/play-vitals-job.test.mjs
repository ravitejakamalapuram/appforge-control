import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOB = join(HERE, '..', '..', 'infra', 'macos', 'play-vitals.sh');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

/** A throwaway repo whose scripts/play-vitals.mjs is a stub, plus a fake curl that records the POST body. */
function fixture({ stubExit, stubJson }) {
  const root = mkdtempSync(join(tmpdir(), 'pv-job-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'play-vitals.mjs'),
    `console.log(${JSON.stringify(JSON.stringify(stubJson))}); process.exit(${stubExit});\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'stub'); git(repo, 'push', '-q', 'origin', 'HEAD:main');
  mkdirSync(join(repo, 'scripts', 'node_modules'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const posts = join(root, 'posts.log');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) url="$a";; esac; done\necho "$url" >> "${posts}"\ncat /dev/stdin >/dev/null 2>&1 || true\nfor a in "$@"; do echo "$a" >> "${posts}.args"; done\nexit 0\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  const key = join(root, 'key.json'); writeFileSync(key, '{}');
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: root, APPFORGE_REPO: repo, APPFORGE_NODE: process.execPath,
    APPFORGE_STATE_DIR: join(root, 'state'), PLAY_SA_KEY_FILE: key,
    PAPERCLIP_API_URL: 'http://127.0.0.1:1', PAPERCLIP_COMPANY_ID: 'co-1', PLAY_VITALS_PACKAGES: 'com.example.app',
    NTFY_TOPIC: 'test-topic',
  };
  return { root, repo, env, posts };
}

const run = (env, ...args) => spawnSync('bash', [JOB, ...args], { env, encoding: 'utf8' });

test('an alert opens exactly one Paperclip issue for the window and pushes a notification', () => {
  const f = fixture({ stubExit: 1, stubJson: { window: { end: '2026-09-28' }, crash: { reasons: ['crash 2.00% over threshold'] }, anr: { reasons: [] } } });
  const r = run(f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALERT com.example.app window_end=2026-09-28/);
  const posts = readFileSync(f.posts, 'utf8');
  assert.match(posts, /ntfy\.sh\/test-topic/, 'notification sent');
  assert.match(posts, /\/api\/companies\/co-1\/issues/, 'issue opened');
  // second run for the same window must not open another issue
  const before = readFileSync(f.posts, 'utf8').split('\n').filter((l) => l.includes('/issues')).length;
  run(f.env);
  const after = readFileSync(f.posts, 'utf8').split('\n').filter((l) => l.includes('/issues')).length;
  assert.equal(after, before, 'same window is not alerted twice');
});

test('insufficient data is logged quietly: no issue, no notification, exit 0', () => {
  const f = fixture({ stubExit: 3, stubJson: { window: { end: '2026-09-28' } } });
  const r = run(f.env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /insufficient_data/);
  assert.equal(existsSync(f.posts), false, 'nothing was POSTed');
});

test('a failed check is loud: notification sent and non-zero exit, never a quiet day', () => {
  const f = fixture({ stubExit: 2, stubJson: {} });
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL com.example.app check failed/);
  assert.match(readFileSync(f.posts, 'utf8'), /ntfy\.sh/);
});

test('missing configuration fails loudly instead of running', () => {
  const f = fixture({ stubExit: 0, stubJson: {} });
  delete f.env.PLAY_SA_KEY_FILE;
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PLAY_SA_KEY_FILE is not set/);
});

test('dry-run calls nothing and opens nothing', () => {
  const f = fixture({ stubExit: 1, stubJson: { window: { end: 'x' }, crash: { reasons: ['r'] }, anr: { reasons: [] } } });
  const r = run(f.env, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(f.posts), false);
});
