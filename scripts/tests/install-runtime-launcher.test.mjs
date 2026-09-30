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
//
// APP-217: the fixture's file list is PARSED OUT OF the installer rather than
// restated here. It was restated here once, and #31 (APP-164) then added two
// hard dependencies to the installer without the fixture learning about them.
// Both PRs were green against the main of their day; their merge was red, and
// every install path in this suite failed for a week. Adding a hard dependency
// now either updates this fixture automatically or fails with a message naming
// the file, which is the difference between a caught desync and a silent one.
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
 * The installer's hard-dependency set, read out of install-runtime-launcher.sh
 * itself: the `VERSIONED=( "<repo path>:<install path>:<mode>" ... )` array is
 * the single place that list exists, and it is the same array the installer
 * loops over to refuse a ref that is missing a file.
 *
 * Throws rather than returning a short list if the array cannot be found or an
 * entry does not parse. A silently-truncated dependency set is exactly the
 * failure this replaces, so a format change must be loud.
 */
function parseVersionedSet(scriptPath) {
  const block = /^VERSIONED=\(\n([\s\S]*?)^\)$/m.exec(readFileSync(scriptPath, 'utf8'));
  if (!block) throw new Error(`no VERSIONED=( ... ) array in ${scriptPath}; the installer's format changed`);

  const entries = block[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const specs = entries.map((line) => {
    const m = /^\s*"([^":]+):([^":]+):([0-7]{4})"\s*$/.exec(line);
    if (!m) throw new Error(`cannot parse VERSIONED entry ${JSON.stringify(line)} in ${scriptPath}`);
    return { source: m[1], install: m[2], mode: parseInt(m[3], 8) };
  });
  if (specs.length === 0) throw new Error(`VERSIONED is empty in ${scriptPath}`);
  return specs;
}

const VERSIONED = parseVersionedSet(INSTALL);

/**
 * Synthetic bodies for each versioned path, keyed by the repo path the
 * installer names. Keyed rather than positional so a reordering of VERSIONED
 * cannot silently swap two files' contents.
 *
 * The bodies are not arbitrary: the installer runs `bash -n` / `node --check`
 * over the staged copies, and it imports the staged watchdog from bin/ to prove
 * bin/lib/ landed beside it. The watchdog fixture therefore imports BOTH libs
 * the real one does — a stub with no imports would let that layout check pass
 * on an install that never shipped bin/lib/.
 */
const FIXTURE_BODIES = {
  'scripts/agent-launch.sh': '#!/bin/bash\necho launcher v1\n',
  'scripts/github-app-token.mjs': 'export const v = 1;\n',
  'scripts/prune-agent-worktrees.sh': '#!/bin/bash\nexit 0\n',
  'scripts/lib/github-app.mjs': 'export const app = 1;\n',
  'scripts/quota-retry-watchdog.mjs':
    "import { tick } from './lib/quota-retry-watchdog.mjs';\n" +
    "import { collateral } from './lib/quota-pause-collateral.mjs';\n" +
    'export const watchdog = { tick, collateral };\n',
  'scripts/lib/quota-retry-watchdog.mjs': 'export const tick = () => 1;\n',
  'scripts/lib/quota-pause-collateral.mjs': 'export const collateral = () => 1;\n',
  'scripts/package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2) + '\n',
  'scripts/package-lock.json': JSON.stringify({
    name: 'fixture', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', private: true } },
  }, null, 2) + '\n',
  '.gitconfig-appforge': '[user]\n\tname = appforge\n',
  'config/github-apps.yaml': 'apps:\n  - name: fixture\n    private_key_path: secrets/fixture.private-key.pem\n',
};

/**
 * A synthetic appforge-control: every file the installer hard-depends on, a
 * zero-dep lockfile so `npm ci` is offline, and an unversioned private key.
 * Committed on `main`, tagged, and given an `origin` remote so `origin/main`
 * resolves without a network.
 */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'appforge-install-test-'));
  const repo = path.join(root, 'control');
  mkdirSync(path.join(repo, 'secrets'), { recursive: true });

  const w = (rel, body) => {
    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  for (const { source } of VERSIONED) {
    const body = FIXTURE_BODIES[source];
    if (body === undefined) {
      throw new Error(
        `install-runtime-launcher.sh hard-depends on ${source}, which this fixture does not provision. ` +
        'Add a body for it to FIXTURE_BODIES — the installer will refuse to install a ref that is ' +
        'missing the file, so leaving it out fails every install path in this suite (APP-217).');
    }
    w(source, body);
  }
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
  assert.equal(manifest.files.length, VERSIONED.length);

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

  // Every versioned file, at the install path and mode the installer declares.
  // Asserting the whole VERSIONED set rather than a sample is what makes an
  // added hard dependency land somewhere this test actually looks (APP-217).
  for (const { install: rel, mode } of VERSIONED) {
    const abs = path.join(fx.prefix, rel);
    assert.ok(existsSync(abs), `${rel} is missing from the install`);
    assert.equal(lstatSync(abs).mode & 0o777, mode, `${rel} has the wrong mode`);
  }
  // The four resolutions the LAYOUT INVARIANT comment names, spelled out so a
  // flattening shows up as a named failure rather than a mode mismatch.
  for (const rel of [
    '.gitconfig-appforge',          // one level above bin/, per REPO_ROOT=$SCRIPT_DIR/..
    'bin/agent-launch.sh',
    'bin/lib/github-app.mjs',
    'bin/lib/quota-pause-collateral.mjs',  // per the watchdog's $SCRIPT_DIR/lib/
    'config/github-apps.yaml',      // per CONTROL_ROOT=<minter dir>/..
    'secrets/fixture.private-key.pem',
  ]) {
    assert.ok(existsSync(path.join(fx.prefix, rel)), `${rel} is missing from the install`);
  }
});

test('the fixture provisions exactly the installer\'s hard-dependency set', () => {
  // Guards the guard: if parseVersionedSet ever silently returns a short list,
  // every other test in this file would pass against a fixture the installer no
  // longer matches. Compare both directions.
  const declared = VERSIONED.map((v) => v.source).sort();
  const provisioned = Object.keys(FIXTURE_BODIES).sort();
  assert.deepEqual(provisioned, declared,
    'FIXTURE_BODIES and install-runtime-launcher.sh VERSIONED have diverged');
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
