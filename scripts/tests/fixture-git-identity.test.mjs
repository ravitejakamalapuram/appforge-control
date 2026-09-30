// APP-223. The structural guarantee behind fixtures/gitconfig-fixture-identity.
//
// A host agent on macOS dev machines (Bold Agent) appends an `[include]` stanza
// to every newly created repository's .git/config with a read-modify-write, so
// any `git config` a fixture runs on itself right after `git init` can be
// silently dropped. The observable symptom was a 1-in-5 `fatal: unable to
// auto-detect email address` at a fixture's seed commit, with a .git/config that
// still held `user.name` but had lost `user.email`.
//
// The fix is not a retry and not a machine-global identity: fixture identity
// moved into a config file this suite owns and no repo ever writes to. These
// tests keep it there. Deleting them re-opens the flake silently, because a
// lost-update race does not fail on the run that introduces it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY = path.join(here, 'fixtures', 'gitconfig-fixture-identity');

const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => ({ name: f, body: readFileSync(path.join(here, f), 'utf8') }));

/** Suites that build real git repos - the ones the race can reach. */
const repoBuilding = suites.filter((s) => /git\((?:[^,]+), 'init'/.test(s.body));

test('the shared identity file gives git both halves of an ident', () => {
  const read = (key) =>
    execFileSync('git', ['config', '--file', IDENTITY, '--get', key], { encoding: 'utf8' }).trim();
  // Read through git itself, not a regex: a file git cannot parse would leave
  // every fixture commit failing the way APP-223 did.
  assert.equal(read('user.name'), 'test');
  assert.equal(read('user.email'), 'test@example.com');
});

test('at least one suite still builds git repos, so these guards stay meaningful', () => {
  // Without this, deleting the last repo-building suite would turn the two
  // guards below into vacuous truths that pass forever.
  assert.ok(
    repoBuilding.length > 0,
    'no suite matched the repo-building pattern - the detection regex has drifted, ' +
    'and the guards below are now vacuous'
  );
});

test('no suite writes an identity into a fixture .git/config', () => {
  for (const { name, body } of suites) {
    const offending = body
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /'config',\s*'user\.(name|email)'/.test(line));
    assert.deepEqual(
      offending,
      [],
      `${name} writes user.name/user.email into a fixture's own .git/config. That write races a ` +
      'host agent rewriting the same file and is dropped ~1 run in 5 (APP-223). Take the identity ' +
      `from fixtures/gitconfig-fixture-identity via GIT_CONFIG_GLOBAL instead: ${JSON.stringify(offending)}`
    );
  }
});

test('every repo-building suite points GIT_CONFIG_GLOBAL at the shared identity', () => {
  for (const { name, body } of repoBuilding) {
    assert.ok(
      /GIT_CONFIG_GLOBAL:\s*FIXTURE_GITCONFIG/.test(body),
      `${name} runs 'git init' but does not point GIT_CONFIG_GLOBAL at FIXTURE_GITCONFIG. ` +
      'Pointing it at /dev/null leaves its fixtures with no identity at all once the ' +
      'in-repo `git config` writes are gone (APP-223).'
    );
    assert.ok(
      !/GIT_CONFIG_GLOBAL:\s*'\/dev\/null'/.test(body),
      `${name} still has a GIT_CONFIG_GLOBAL: '/dev/null' - a fixture using it has no identity.`
    );
  }
});

test('a fixture repo inherits nothing ambient, including the launcher git env', () => {
  // GIT_CONFIG_COUNT=0 is what stops agent-launch.sh's exported
  // GIT_CONFIG_KEY_n/VALUE_n pairs - a credential helper and a GitHub auth
  // header - from reaching a hermetic local fixture.
  for (const { name, body } of repoBuilding) {
    assert.ok(
      /GIT_CONFIG_COUNT:\s*'0'/.test(body),
      `${name} does not neutralise GIT_CONFIG_COUNT, so ambient GIT_CONFIG_KEY_n entries ` +
      'leak into its fixtures.'
    );
  }
});
