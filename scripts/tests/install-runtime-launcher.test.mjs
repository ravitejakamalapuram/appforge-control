// Tests for scripts/install-runtime-launcher.sh (APP-161).
//
// The install itself is mostly plumbing; what is worth asserting is the set of
// things the script REFUSES to do, because each refusal is a control:
//
//   - an unnamed ref would produce a manifest whose `source_ref` the drift
//     detector cannot re-resolve, which silently disables the stale-deploy alarm
//   - a prefix inside a git work tree reproduces the APP-137 bug outright
//   - materialising from the working tree rather than the commit breaks the
//     byte-identity guarantee the whole design rests on
//
// The fixture is a synthetic repo with a zero-dependency package.json, so
// `npm ci` runs offline and these tests need no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseManifest } from '../lib/launcher-drift.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(here, '..', 'install-runtime-launcher.sh');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });

/**
 * A synthetic appforge-control: the file set the installer copies, a zero-dep
 * lockfile so `npm ci` is offline, and an unversioned private key. Committed on
 * `main`, tagged, and given an `origin` remote so `origin/main` resolves
 * without a network.
 */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'appforge-install-test-'));
  const repo = path.join(root, 'control');
  mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(path.join(repo, 'config'), { recursive: true });
  mkdirSync(path.join(repo, 'secrets'), { recursive: true });

  const w = (rel, body) => writeFileSync(path.join(repo, rel), body);
  w('scripts/agent-launch.sh', '#!/bin/bash\necho launcher v1\n');
  w('scripts/github-app-token.mjs', 'export const v = 1;\n');
  w('scripts/prune-agent-worktrees.sh', '#!/bin/bash\nexit 0\n');
  w('scripts/lib/github-app.mjs', 'export const app = 1;\n');
  w('scripts/package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2) + '\n');
  w('scripts/package-lock.json', JSON.stringify({
    name: 'fixture', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', private: true } },
  }, null, 2) + '\n');
  w('.gitconfig-appforge', '[user]\n\tname = appforge\n');
  w('config/github-apps.yaml', 'apps:\n  - name: fixture\n    private_key_path: secrets/fixture.private-key.pem\n');
  w('.gitignore', 'secrets/\nscripts/node_modules/\n');
  // Unversioned by design — present in the working tree, in no commit.
  w('secrets/fixture.private-key.pem', 'KEY-MATERIAL-V1\n');

  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'tag', 'runtime-v1');
  // A remote-tracking ref without a network: point origin at the repo itself.
  git(repo, 'remote', 'add', 'origin', repo);
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');

  return { root, repo, prefix: path.join(root, 'prefix') };
}

/** Runs the installer. Returns { code, stdout, stderr } and never throws. */
function install(fx, args = []) {
  try {
    const stdout = execFileSync('bash', [INSTALL, '--repo', fx.repo, '--prefix', fx.prefix, '--no-fetch', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const release = (fx) => readFileSync(path.join(fx.prefix, 'RELEASE'), 'utf8');

test('installs from a tag and writes a manifest the drift detector can parse', () => {
  const fx = makeFixture();
  const res = install(fx, ['--ref', 'refs/tags/runtime-v1']);
  assert.equal(res.code, 0, res.stderr);

  const manifest = parseReleaseManifest(release(fx));
  assert.equal(manifest.sourceRef, 'refs/tags/runtime-v1');
  assert.equal(manifest.sourceCommit, git(fx.repo, 'rev-parse', 'refs/tags/runtime-v1^{commit}').trim());
  assert.equal(manifest.files.length, 8);

  // Every entry must carry its own source path. Without the fourth column the
  // detector falls back to a hard-coded table and anything missing from it goes
  // unmonitored.
  for (const f of manifest.files) {
    assert.equal(f.sourcePathFrom, 'manifest', `${f.installPath} has no source_path`);
    assert.ok(f.versioned);
  }
});

test('the layout is mirrored, not flattened — Control A depends on it', () => {
  const fx = makeFixture();
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);
  for (const rel of [
    '.gitconfig-appforge',          // one level above bin/, per REPO_ROOT=$SCRIPT_DIR/..
    'bin/agent-launch.sh',
    'bin/lib/github-app.mjs',
    'config/github-apps.yaml',      // per CONTROL_ROOT=<minter dir>/..
    'secrets/fixture.private-key.pem',
  ]) {
    assert.ok(existsSync(path.join(fx.prefix, rel)), `${rel} is missing from the install`);
  }
});

test('versioned files come from the commit, never from the working tree', () => {
  const fx = makeFixture();
  // Dirty the working copy with content that must NOT reach the install.
  writeFileSync(path.join(fx.repo, 'scripts/agent-launch.sh'), '#!/bin/bash\necho WORKING TREE EDIT\n');

  assert.equal(install(fx, ['--ref', 'origin/main', '--allow-dirty']).code, 0);
  const installed = readFileSync(path.join(fx.prefix, 'bin/agent-launch.sh'), 'utf8');
  assert.equal(installed, '#!/bin/bash\necho launcher v1\n');
  assert.doesNotMatch(installed, /WORKING TREE EDIT/);
});

test('refuses a ref that is not named, so the stale-deploy alarm keeps working', () => {
  const fx = makeFixture();
  const sha = git(fx.repo, 'rev-parse', 'HEAD').trim();
  for (const ref of [sha, 'HEAD', 'main~1']) {
    const res = install(fx, ['--ref', ref]);
    assert.equal(res.code, 1, `${ref} should have been refused`);
    assert.match(res.stderr, /not a named ref/);
    assert.ok(!existsSync(fx.prefix), `${ref} was refused but still wrote to the prefix`);
  }
});

test('refuses a local branch, which nobody else can resolve or review', () => {
  const fx = makeFixture();
  const res = install(fx, ['--ref', 'main']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /LOCAL branch/);
});

test('refuses a dirty source tree unless --allow-dirty, which is then recorded', () => {
  const fx = makeFixture();
  writeFileSync(path.join(fx.repo, 'scripts/agent-launch.sh'), '#!/bin/bash\necho edited\n');

  const refused = install(fx, ['--ref', 'origin/main']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /uncommitted changes/);

  const allowed = install(fx, ['--ref', 'origin/main', '--allow-dirty']);
  assert.equal(allowed.code, 0, allowed.stderr);
  // The escape hatch must leave evidence rather than quietly pass.
  assert.match(release(fx), /^source_tree_state: dirty$/m);
  assert.match(release(fx), /^source_dirty_paths: .*scripts\/agent-launch\.sh/m);
});

test('a clean tree is recorded as clean', () => {
  const fx = makeFixture();
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);
  assert.match(release(fx), /^source_tree_state: clean$/m);
});

test('refuses a prefix inside a git work tree — that is the APP-137 bug itself', () => {
  const fx = makeFixture();
  const inside = path.join(fx.repo, 'inside');
  let code = 0;
  let stderr = '';
  try {
    execFileSync('bash', [INSTALL, '--repo', fx.repo, '--no-fetch', '--ref', 'origin/main', '--prefix', inside],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = err.status ?? 1;
    stderr = err.stderr ?? '';
  }
  assert.equal(code, 1, 'installing into a git work tree must be refused');
  assert.match(stderr, /inside a git working tree/);
  assert.ok(!existsSync(inside));
});

test('the private key is copied, not symlinked, and is 0400', () => {
  const fx = makeFixture();
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);

  const key = path.join(fx.prefix, 'secrets/fixture.private-key.pem');
  assert.equal(readFileSync(key, 'utf8'), 'KEY-MATERIAL-V1\n');
  // A symlink would be deleted by `git clean -xdf` in the source checkout,
  // taking every agent launch on the box with it.
  assert.ok(!lstatSync(key).isSymbolicLink(), 'the key must be a real copy, not a symlink');
  assert.equal(lstatSync(key).mode & 0o777, 0o400);
});

test('--secrets-only rotates the key without touching the installed code', () => {
  const fx = makeFixture();
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);
  const before = release(fx);

  writeFileSync(path.join(fx.repo, 'secrets/fixture.private-key.pem'), 'KEY-MATERIAL-V2\n');
  const res = install(fx, ['--secrets-only']);
  assert.equal(res.code, 0, res.stderr);

  assert.equal(readFileSync(path.join(fx.prefix, 'secrets/fixture.private-key.pem'), 'utf8'), 'KEY-MATERIAL-V2\n');
  // RELEASE must not be rewritten: the code did not change, and claiming a
  // fresh install would falsify the provenance it exists to carry.
  assert.equal(release(fx), before);
});

test('the rolled-aside generation keeps no copy of the private key', () => {
  const fx = makeFixture();
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);
  assert.equal(install(fx, ['--ref', 'origin/main']).code, 0);

  assert.ok(existsSync(`${fx.prefix}.prev/RELEASE`), 'previous generation should be kept for rollback');
  // After a rotation the stale copy would be the REVOKED key.
  assert.ok(!existsSync(`${fx.prefix}.prev/secrets`), '.prev must not retain secrets');
});

test('--secrets-only refuses when there is no install to rotate into', () => {
  const fx = makeFixture();
  const res = install(fx, ['--secrets-only']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /needs an existing install/);
});

test('--dry-run prints the manifest and writes nothing', () => {
  const fx = makeFixture();
  const res = install(fx, ['--ref', 'origin/main', '--dry-run']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^source_commit: [0-9a-f]{40}$/m);
  assert.ok(!existsSync(fx.prefix), 'dry-run must not create the prefix');
});

test('refuses an unknown argument rather than guessing', () => {
  const fx = makeFixture();
  const res = install(fx, ['--nope']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown argument/);
});
