import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStaleChange } from '../lib/launcher-diff-classify.mjs';

// False "low" verdicts were found by independent review (APP-261): a stale launcher change that is
// really behavioural was reported as comment-only, which routes it as a note nobody reads. Each test
// here is one of those inputs, plus guards that a REAL comment-only change is still low.

const dir = mkdtempSync(join(tmpdir(), 'classify-'));

/** Real unified diff of two texts, the way git/diff would hand it to the classifier. */
function classify(sourcePath, before, after) {
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  let diffText = '';
  try {
    execFileSync('diff', ['-u', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    diffText = e.stdout; // diff exits 1 when the files differ
  }
  return classifyStaleChange({ sourcePath, beforeText: before, afterText: after, diffText });
}

test('a shebang change is behavioural, never a comment (the interpreter runs on every launch)', () => {
  const r = classify('bin/agent-launch.sh', '#!/bin/bash\necho hi\n', '#!/bin/sh\necho hi\n');
  assert.equal(r.severity, 'high');
  assert.notEqual(r.verdict, 'comment_only');
});

test('a node shebang swap in a .mjs is behavioural too', () => {
  const r = classify('bin/x.mjs', '#!/usr/bin/env node\nconsole.log(1);\n', '#!/usr/bin/env bun\nconsole.log(1);\n');
  assert.equal(r.severity, 'high');
});

test('a shell heredoc body is data the script writes or runs, not comments', () => {
  const r = classify('bin/x.sh', 'cat <<E\n# a\nE\n', 'cat <<E\nE\n');
  assert.equal(r.severity, 'high');
  assert.notEqual(r.verdict, 'comment_only');
});

test('a quoted and a dash heredoc are recognised too', () => {
  assert.equal(classify('bin/x.sh', "cat <<'EOF'\n# a\nEOF\n", "cat <<'EOF'\nEOF\n").severity, 'high');
  assert.equal(classify('bin/x.sh', 'cat <<-EOF\n# a\nEOF\n', 'cat <<-EOF\nEOF\n').severity, 'high');
});

test('a YAML block scalar body is data, not comments', () => {
  assert.equal(classify('config/x.yml', 'k: |\n  # a\n  b\n', 'k: |\n  b\n').severity, 'high');
  assert.equal(classify('config/x.yml', 'k: >-\n  # a\n  b\n', 'k: >-\n  b\n').severity, 'high');
  assert.equal(classify('config/x.yml', 'list:\n  - |\n    # a\n    b\n', 'list:\n  - |\n    b\n').severity, 'high');
});

test('a REAL comment-only change in a shell script is still low (no over-correction)', () => {
  const r = classify('bin/x.sh', '#!/bin/sh\n# old note\necho hi\n', '#!/bin/sh\n# new note\necho hi\n');
  assert.equal(r.verdict, 'comment_only');
  assert.equal(r.severity, 'low');
});

test('a REAL comment-only change in a YAML file without block scalars is still low', () => {
  const r = classify('config/x.yml', 'a: 1\n# old note\nb: 2\n', 'a: 1\n# new note\nb: 2\n');
  assert.equal(r.verdict, 'comment_only');
  assert.equal(r.severity, 'low');
});

test('a shebang-free comment edit in a .mjs is still low', () => {
  const r = classify('bin/x.mjs', '// old\nconsole.log(1);\n', '// new\nconsole.log(1);\n');
  assert.equal(r.verdict, 'comment_only');
  assert.equal(r.severity, 'low');
});
