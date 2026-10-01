import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOB = join(HERE, '..', '..', 'infra', 'macos', 'repo-refresh.sh');

// Fixture git identity and isolation (APP-223): identity comes from a file no repo writes to, and nothing
// ambient (the launcher's GIT_CONFIG_KEY_n pairs, system config) reaches a hermetic local repo.
const FIXTURE_GITCONFIG = join(HERE, 'fixtures', 'gitconfig-fixture-identity');
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...FIXTURE_GIT_ENV } });

/** A bare origin plus a checkout of it under `root/<name>`, and a second clone used to push new commits. */
function repo(root, name) {
  const origin = join(root, `${name}.origin.git`);
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  const pusher = join(root, `${name}.pusher`);
  git(root, 'clone', '-q', origin, pusher);
  writeFileSync(join(pusher, 'README.md'), 'one\n');
  git(pusher, 'add', '-A'); git(pusher, 'commit', '-q', '-m', 'one'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'clone', '-q', origin, join(root, name));
  return { origin, pusher, dir: join(root, name) };
}
const push = (pusher, text) => {
  writeFileSync(join(pusher, 'README.md'), text);
  git(pusher, 'add', '-A'); git(pusher, 'commit', '-q', '-m', text.trim()); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
};
const run = (env) => spawnSync('bash', [JOB], { env: { ...process.env, ...FIXTURE_GIT_ENV, ...env }, encoding: 'utf8' });

test('a refresh advances origin/main without touching the checked-out branch or working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const a = repo(root, 'alpha');
  const before = git(a.dir, 'rev-parse', 'origin/main').trim();
  const head = git(a.dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(a.dir, 'wip.txt'), 'uncommitted work\n'); // a human's in-progress change
  push(a.pusher, 'two\n');
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'alpha' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.notEqual(git(a.dir, 'rev-parse', 'origin/main').trim(), before, 'origin/main moved');
  assert.equal(git(a.dir, 'rev-parse', 'HEAD').trim(), head, 'the checked-out branch did not move');
  assert.match(git(a.dir, 'status', '--porcelain'), /wip\.txt/, 'uncommitted work is untouched');
  assert.match(r.stdout, /1 refreshed, 0 failed/);
});

test('a missing checkout is skipped and one broken repo does not stop the others', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const good = repo(root, 'good');
  const bad = repo(root, 'bad');
  git(bad.dir, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
  push(good.pusher, 'two\n');
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'bad ghost good' });
  assert.equal(r.status, 0, 'one working repo means the job itself is healthy');
  assert.match(r.stdout, /FAIL bad/);
  assert.match(r.stdout, /skip ghost/);
  assert.match(r.stdout, /ok   good/);
  assert.match(r.stdout, /1 refreshed, 1 failed, 1 skipped/);
});

test('nothing refreshing at all fails the job loudly', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const bad = repo(root, 'bad');
  git(bad.dir, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'bad' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /0 refreshed, 1 failed/);
});

test('a failed anonymous fetch retries ONCE with a repo-scoped token, and the token is never printed', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const priv = repo(root, 'priv');
  git(priv.dir, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git')); // fetch cannot succeed either way
  const argsLog = join(root, 'minter.args');
  const minter = join(root, 'minter.sh');
  writeFileSync(minter, `#!/bin/sh\necho "$@" >> "${argsLog}"\necho '{"token":"SECRET-TOKEN-VALUE","expires_at":"x"}'\n`);
  chmodSync(minter, 0o755);
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'priv', REPO_REFRESH_TOKEN_CMD: minter });
  assert.equal(readFileSync(argsLog, 'utf8').trim(), '--repos priv', 'the minter is scoped to exactly the failing repo');
  assert.match(r.stdout, /authenticated retry also failed/);
  assert.ok(!(r.stdout + r.stderr).includes('SECRET-TOKEN-VALUE'), 'the token must never appear in output');
});

test('a repo that fetches anonymously never mints a token', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  repo(root, 'pub');
  const argsLog = join(root, 'minter.args');
  const minter = join(root, 'minter.sh');
  writeFileSync(minter, `#!/bin/sh\necho "$@" >> "${argsLog}"\necho '{"token":"t"}'\n`);
  chmodSync(minter, 0o755);
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'pub', REPO_REFRESH_TOKEN_CMD: minter });
  assert.equal(r.status, 0);
  assert.equal(existsSync(argsLog), false, 'no credential is touched when none is needed');
});

test('a minter that fails does not crash the job; the repo is just reported as failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-'));
  const priv = repo(root, 'priv');
  git(priv.dir, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
  const minter = join(root, 'minter.sh');
  writeFileSync(minter, '#!/bin/sh\nexit 1\n');
  chmodSync(minter, 0o755);
  const r = run({ APPFORGE_PRODUCTS_ROOT: root, REPO_REFRESH_REPOS: 'priv', REPO_REFRESH_TOKEN_CMD: minter });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL priv/);
});
