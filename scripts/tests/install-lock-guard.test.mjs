import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync, symlinkSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const INSTALLER = path.join(REPO, 'infra', 'macos', 'install-lock-guard.sh');
const GUARD = path.join(REPO, 'scripts', 'paperclip-lock-guard.sh');
const PLIST = path.join(REPO, 'infra', 'macos', 'ing.paperclip.appforge-lock-guard.plist');
const NAME = 'paperclip-lock-guard.sh';
const TOPIC = 'unit-test-topic-not-a-real-one';

/**
 * A throwaway HOME. The installer must never reach outside it in these tests:
 * every run passes --no-load, so launchd is not touched either.
 */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'appforge-installer-'));
  const envrc = path.join(home, 'envrc');
  writeFileSync(envrc, `export SOMETHING_ELSE="x"\nexport NTFY_TOPIC="${TOPIC}"\n`);
  return { home, envrc, dest: path.join(home, 'LaunchAgents') };
}

function install(h, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: h.home, ...extraEnv };
  delete env.NTFY_TOPIC;
  Object.assign(env, extraEnv);
  return spawnSync('/bin/bash', [INSTALLER, '--no-load', '--dest', h.dest, '--envrc', h.envrc, ...args], { encoding: 'utf8', env });
}

const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const plistGet = (file, key) =>
  execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();

test('deploys the guard to ~/.appforge-ops/bin (0555, identical to the repo copy) by default', () => {
  const h = makeHome();
  try {
    const r = install(h);
    assert.equal(r.status, 0, r.stderr);
    const dst = path.join(h.home, '.appforge-ops', 'bin', NAME);
    assert.ok(existsSync(dst), 'script should be deployed under ~/.appforge-ops/bin');
    assert.equal(mode(dst), '555');
    assert.equal(readFileSync(dst, 'utf8'), readFileSync(GUARD, 'utf8'));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('never creates or writes anything under ~/.appforge (the CTO installer owns that tree)', () => {
  const h = makeHome();
  try {
    const r = install(h);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(path.join(h.home, '.appforge')), '~/.appforge must not be created');
    assert.ok(!existsSync(path.join(h.home, '.appforge.prev')), '~/.appforge.prev must not be created');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('refuses --ops-dir under ~/.appforge, with a message that says why, and writes nothing', () => {
  for (const rel of ['.appforge', '.appforge/bin', '.appforge/deep/er', '.appforge.prev', '.appforge.prev/bin']) {
    const h = makeHome();
    try {
      const r = install(h, ['--ops-dir', path.join(h.home, rel)]);
      assert.notEqual(r.status, 0, `${rel} should be refused`);
      assert.match(r.stderr, /refus/i);
      assert.match(r.stderr, /\.appforge/);
      assert.match(r.stderr, /another installer|owned by|swap/i);
      assert.ok(!existsSync(path.join(h.home, rel)), `${rel} must not have been created`);
      assert.ok(!existsSync(h.dest) || readdirSync(h.dest).length === 0, 'no plist should be written on refusal');
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test('refuses a path that only reaches ~/.appforge through a symlink', () => {
  const h = makeHome();
  try {
    mkdirSync(path.join(h.home, '.appforge'));
    symlinkSync(path.join(h.home, '.appforge'), path.join(h.home, 'innocent-looking'));
    const r = install(h, ['--ops-dir', path.join(h.home, 'innocent-looking', 'bin')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refus/i);
    assert.deepEqual(readdirSync(path.join(h.home, '.appforge')), [], '~/.appforge must be left untouched');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('does not mistake the lookalike ~/.appforge-ops (or ~/.appforge-anything) for ~/.appforge', () => {
  for (const rel of ['.appforge-ops', '.appforge-ops2/x', '.appforgeish']) {
    const h = makeHome();
    try {
      const r = install(h, ['--ops-dir', path.join(h.home, rel)]);
      assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
      assert.ok(existsSync(path.join(h.home, rel, 'bin', NAME)));
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test('renders the plist: topic filled from .envrc, 0600, valid, no placeholder, points at the deployed script', () => {
  const h = makeHome();
  try {
    const opsDir = path.join(h.home, 'ops-elsewhere');
    const r = install(h, ['--ops-dir', opsDir]);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(h.dest, 'ing.paperclip.appforge-lock-guard.plist');
    assert.ok(existsSync(out));
    assert.equal(mode(out), '600');
    execFileSync('/usr/bin/plutil', ['-lint', out]);
    const text = readFileSync(out, 'utf8');
    assert.ok(!text.includes('__NTFY_TOPIC__'), 'placeholder must be substituted');
    assert.ok(text.includes(TOPIC), 'topic from .envrc should be in the rendered plist');
    assert.equal(plistGet(out, 'ProgramArguments.1'), path.join(opsDir, 'bin', NAME),
      'the plist must run the script the installer just deployed, wherever --ops-dir put it');
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOPIC), 'the topic must never be echoed');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('no topic anywhere: still installs, ntfy is disabled, and it says so', () => {
  const h = makeHome();
  try {
    writeFileSync(h.envrc, 'export UNRELATED="1"\n');
    const r = install(h);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ntfy: disabled/);
    const out = path.join(h.dest, 'ing.paperclip.appforge-lock-guard.plist');
    assert.equal(plistGet(out, 'EnvironmentVariables.NTFY_TOPIC'), '');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('re-running over an existing read-only (0555) deployment succeeds and re-locks it', () => {
  const h = makeHome();
  try {
    assert.equal(install(h).status, 0);
    const dst = path.join(h.home, '.appforge-ops', 'bin', NAME);
    assert.equal(mode(dst), '555');
    const again = install(h);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(mode(dst), '555');
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('the COMMITTED plist agrees with the installer: runs ~/.appforge-ops/bin/…, never ~/.appforge/…', () => {
  const text = readFileSync(PLIST, 'utf8');
  execFileSync('/usr/bin/plutil', ['-lint', PLIST]);
  const script = plistGet(PLIST, 'ProgramArguments.1');
  assert.ok(script.endsWith(`/.appforge-ops/bin/${NAME}`), script);
  assert.doesNotMatch(text, /\/\.appforge\//, 'no reference to the CTO-owned ~/.appforge tree');
  assert.match(text, /__NTFY_TOPIC__/, 'the committed template must carry the placeholder, not a real topic');
});

test('no file this PR ships still points at the old ~/.appforge/bin location', () => {
  const files = [INSTALLER, GUARD, PLIST, path.join(REPO, 'infra', 'macos', 'README.md')];
  for (const f of files) {
    const body = readFileSync(f, 'utf8');
    // README may *name* ~/.appforge once to explain why we avoid it; nothing may
    // tell the reader to install into, or run from, it.
    const bad = body.split('\n').filter((l) => /\.appforge\/bin\/paperclip-lock-guard/.test(l));
    assert.deepEqual(bad, [], `${path.basename(f)} still references the old path`);
  }
});
