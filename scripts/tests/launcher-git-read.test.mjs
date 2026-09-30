// APP-261 (PR #53 review): the history readers behind the drift report's diff,
// exercised against a real git repository rather than stubbed output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffBetweenCommits, readBlobAtCommit } from '../lib/launcher-git-read.mjs';
import { classifyChange } from '../lib/launcher-diff-classify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_GITCONFIG = path.join(here, 'fixtures', 'gitconfig-fixture-identity');
// Identity from a file no repo writes to (APP-223); GIT_CONFIG_COUNT=0 keeps
// the launcher's exported GIT_CONFIG_KEY_n pairs out of the fixture.
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...FIXTURE_GIT_ENV } }).trim();

function fixture(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'launcher-git-read-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (rel, body, msg) => {
    writeFileSync(path.join(repo, rel), body);
    git(repo, 'add', rel);
    git(repo, 'commit', '-q', '-m', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { repo, commit };
}

test('readBlobAtCommit returns each revision from history, not the working tree', async (t) => {
  const { repo, commit } = fixture(t);
  const a = commit('run.sh', '#!/bin/bash\necho a\n', 'a');
  const b = commit('run.sh', '#!/bin/sh\necho a\n', 'b');
  writeFileSync(path.join(repo, 'run.sh'), 'uncommitted\n');
  assert.equal(await readBlobAtCommit(repo, a, 'run.sh'), '#!/bin/bash\necho a\n');
  assert.equal(await readBlobAtCommit(repo, b, 'run.sh'), '#!/bin/sh\necho a\n');
});

test('readBlobAtCommit returns null for a missing path, an unknown commit and a binary blob', async (t) => {
  const { repo, commit } = fixture(t);
  const a = commit('bin.dat', Buffer.from([0x61, 0x00, 0x62]), 'bin');
  assert.equal(await readBlobAtCommit(repo, a, 'nope.sh'), null);
  assert.equal(await readBlobAtCommit(repo, 'f'.repeat(40), 'bin.dat'), null);
  assert.equal(await readBlobAtCommit(repo, a, 'bin.dat'), null);
});

test('diffBetweenCommits yields a real unified diff scoped to the one path', async (t) => {
  const { repo, commit } = fixture(t);
  const a = commit('run.sh', '#!/bin/bash\necho a\n', 'a');
  commit('other.sh', 'echo other\n', 'unrelated');
  const b = commit('run.sh', '#!/bin/sh\necho a\n', 'b');
  const diff = await diffBetweenCommits(repo, a, b, 'run.sh');
  assert.match(diff, /^--- a\/run\.sh$/m);
  assert.match(diff, /^-#!\/bin\/bash$/m);
  assert.match(diff, /^\+#!\/bin\/sh$/m);
  assert.doesNotMatch(diff, /other/);
  assert.equal(await diffBetweenCommits(repo, a, 'no-such-ref', 'run.sh'), null);
});

test('end to end on real history: a shebang change is behavioural, a comment edit is not', async (t) => {
  const { repo, commit } = fixture(t);
  const a = commit('run.sh', '#!/bin/bash\n# old note\necho a\n', 'a');
  const b = commit('run.sh', '#!/bin/bash\n# new note\necho a\n', 'b');
  const c = commit('run.sh', '#!/bin/sh\n# new note\necho a\n', 'c');
  const verdict = async (from, to) => classifyChange({
    sourcePath: 'run.sh',
    before: await readBlobAtCommit(repo, from, 'run.sh'),
    after: await readBlobAtCommit(repo, to, 'run.sh'),
    diffText: await diffBetweenCommits(repo, from, to, 'run.sh'),
  });
  assert.equal((await verdict(a, b)).classification, 'comment_only');
  assert.equal((await verdict(b, c)).classification, 'behavioural');
});
