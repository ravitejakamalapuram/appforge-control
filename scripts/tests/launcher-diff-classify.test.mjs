import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLASSIFICATIONS,
  blankStrings,
  changedDiffLines,
  changedLinesLookInert,
  classifyChange,
  isProseLiteral,
  stripComments,
  syntaxFor,
} from '../lib/launcher-diff-classify.mjs';
import { FALLBACK_SOURCE_PATHS } from '../lib/launcher-drift.mjs';

const run = promisify(execFile);
const JS = syntaxFor('x.mjs');
const YAML = syntaxFor('x.yaml');
const SH = syntaxFor('x.sh');

/** A unified diff whose changed lines are the ones given, for corroboration. */
const diffOf = (removed, added) => [
  '--- a/x', '+++ b/x', '@@ -1 +1 @@',
  ...removed.map((l) => `-${l}`),
  ...added.map((l) => `+${l}`),
].join('\n');

const classify = (sourcePath, before, after) => classifyChange({
  sourcePath,
  before,
  after,
  // Corroboration needs the real changed lines, so derive them from the texts.
  diffText: diffOf(
    before.split('\n').filter((l) => !after.split('\n').includes(l)),
    after.split('\n').filter((l) => !before.split('\n').includes(l)),
  ),
});

test('the syntax table covers every versioned launcher file type', () => {
  // A file type that falls off the table classifies as behavioural, which is
  // safe but silently gives up the whole feature for that file. Assert the
  // coverage question is answered here rather than discovered in production.
  const modelled = Object.values(FALLBACK_SOURCE_PATHS).map((p) => [p, syntaxFor(p)]);
  for (const [p, syntax] of modelled) {
    assert.ok(syntax !== undefined || p.endsWith('.json'), `${p} has no entry in the syntax table`);
  }
  assert.equal(syntaxFor('scripts/package.json'), null, 'JSON has no comments, so any change is content');
  assert.equal(syntaxFor('.gitconfig-appforge')?.line[0], '#');
  assert.equal(syntaxFor('scripts/opaque.bin'), undefined);
});

test('a comment marker inside a string is not a comment', () => {
  // The bug a naive line-prefix stripper has: it truncates the URL and then
  // reports two different files as identical, or vice versa.
  assert.equal(stripComments("const u = 'https://x/y'; // trailing\n", JS), "const u = 'https://x/y';");
  assert.equal(stripComments('password: "a#b" # real comment\n', YAML), 'password: "a#b"');
  assert.equal(stripComments('echo "it\'s #1"  # note\n', SH), 'echo "it\'s #1"');
});

test('block comments and blank lines are stripped; code is not', () => {
  assert.equal(stripComments('/** doc */\nconst a = 1;\n\n/*\n multi\n*/\nconst b = 2;\n', JS),
    'const a = 1;\nconst b = 2;');
});

test('an unterminated literal throws rather than guessing', () => {
  assert.throws(() => stripComments("const a = 'open\n", JS), /unterminated string/);
  assert.throws(() => stripComments('/* never closed\n', JS), /unterminated block/);
});

test('string blanking keeps the code skeleton and collects the literals', () => {
  const { skeleton, literals } = blankStrings("run('git', ['push', '--force']);");
  assert.deepEqual(literals, ['git', 'push', '--force']);
  assert.equal(skeleton.replaceAll('\u0000STR\u0000', 'S'), 'run(S, [S, S]);');
});

test('template literals are passed through untouched, so a change in one is behavioural', () => {
  const before = 'const m = `run ${cmd} now`;\n';
  const after = 'const m = `run ${other} now`;\n';
  assert.equal(classify('x.mjs', before, after).classification, 'behavioural');
});

test('prose is four words or more, and never a flag, path, URL or command', () => {
  assert.ok(isProseLiteral('This wake is task-bound, so you can clear them here.'));
  assert.ok(!isProseLiteral('--force'));
  assert.ok(!isProseLiteral('blocked'));
  assert.ok(!isProseLiteral('scripts/agent-launch.sh'));
  assert.ok(!isProseLiteral('cross_issue_influence_run_context_required'));
  assert.ok(!isProseLiteral('https://api.github.com/app/installations'));
  assert.ok(!isProseLiteral('SELECT id FROM runs WHERE agent_id = ?'));
  assert.ok(!isProseLiteral('rm -rf the thing'));
  assert.ok(!isProseLiteral('one two three'), 'three tokens is where flags and keys live');
});

test('the raw-line veto downgrades a comment-only verdict the diff does not support', () => {
  // `stripComments` is a hand-written scanner. Its one dangerous failure is
  // losing quote state and stripping a code line from both revisions, which
  // would read as "identical" and produce a false `low`. The veto shares no
  // code with the scanner, so a scanner bug alone cannot reach `low`.
  assert.ok(changedLinesLookInert('--- a/x\n+++ b/x\n@@\n+# a note\n+\n', YAML));
  assert.ok(changedLinesLookInert('--- a/x\n+++ b/x\n@@\n+/**\n+ * doc\n+ */\n', JS));
  assert.ok(!changedLinesLookInert('--- a/x\n+++ b/x\n@@\n+const a = 1;\n', JS));

  const verdict = classifyChange({
    sourcePath: 'x.yaml',
    before: 'a: 1\n',
    after: '# note\na: 1\n',
    diffText: '--- a/x\n+++ b/x\n@@\n+a: 2\n', // a diff that contradicts the texts
  });
  assert.equal(verdict.classification, 'behavioural');
  assert.match(verdict.note, /not trusted/);
});

test('`+++` and `---` headers are not counted as changed content', () => {
  assert.deepEqual(changedDiffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n'), ['old', 'new']);
});

test('every classification declares whether it is behavioural, and only two are not', () => {
  const inert = Object.entries(CLASSIFICATIONS).filter(([, v]) => !v.behavioural).map(([k]) => k);
  assert.deepEqual(inert.sort(), ['comment_only', 'prose_string_only'],
    'widening this set widens the blind spot; it needs a deliberate change, not a drive-by one');
});

test('shell and YAML get comments but not strings, on purpose', () => {
  // Shell quoting and YAML unquoted scalars are both easy to model wrongly,
  // and a wrong model here produces a false `low`.
  assert.equal(SH.strings, false);
  assert.equal(YAML.strings, false);
  assert.equal(classify('x.sh', "MSG='a b c d e'\n", "MSG='f g h i j'\n").classification, 'behavioural');
});

test('every real versioned launcher source parses without throwing', async () => {
  // A scanner that throws on this tree turns the whole feature into a
  // permanent `unparseable`/`high`, which is safe but useless. Catch that
  // here rather than in the sweep's report.
  const repo = new URL('../../', import.meta.url).pathname;
  for (const sourcePath of Object.values(FALLBACK_SOURCE_PATHS)) {
    const syntax = syntaxFor(sourcePath);
    if (!syntax) continue;
    const text = await readFile(new URL(`../../${sourcePath}`, import.meta.url), 'utf8').catch(() => null);
    if (text === null) continue;
    assert.doesNotThrow(() => stripComments(text, syntax), `${sourcePath} in ${repo}`);
  }
});

// The live evidence this issue was raised on: three `stale` findings on
// 2026-09-30, two behavioural and one pure documentation. Pinned to the two
// commits so the classifier is measured against the real thing, not a fixture
// written to agree with it.
test('the three live 2026-09-30 findings classify as measured', async (t) => {
  const repo = new URL('../../', import.meta.url).pathname;
  const FROM = '86c2259f3ab9a6a8287b45f92fc58731f223efc0';
  const TO = 'c8ddd57f6d176b63575045e197f5730df8fffc04';
  const expected = {
    'config/github-apps.yaml': 'comment_only',
    'scripts/quota-retry-watchdog.mjs': 'behavioural',
    'scripts/lib/quota-retry-watchdog.mjs': 'behavioural',
  };

  const reachable = await run('git', ['-C', repo, 'cat-file', '-e', `${FROM}^{commit}`]).then(() => true, () => false);
  if (!reachable) return t.skip(`${FROM} is not in this clone (shallow checkout)`);

  for (const [sourcePath, want] of Object.entries(expected)) {
    const show = async (commit) => (await run('git', ['-C', repo, 'show', `${commit}:${sourcePath}`], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    const { stdout: diffText } = await run('git', ['-C', repo, 'diff', '--no-color', `${FROM}..${TO}`, '--', sourcePath], { maxBuffer: 32 * 1024 * 1024 });
    const verdict = classifyChange({ sourcePath, before: await show(FROM), after: await show(TO), diffText });
    assert.equal(verdict.classification, want, sourcePath);
  }
});

// ---------------------------------------------------------------------------
// Independent review of PR #53 (2026-10-01): three reproduced false `low`
// verdicts, plus a normalisation bug. Each test below failed before its fix.
// ---------------------------------------------------------------------------

test('a changed shebang is behavioural, never a comment', () => {
  const v = classify('x.sh', '#!/bin/bash\necho hi\n', '#!/bin/sh\necho hi\n');
  assert.equal(v.classification, 'behavioural');
  assert.equal(v.behavioural, true);
  // And the raw-line veto does not count a `#!` line as a comment either.
  assert.equal(changedLinesLookInert(diffOf(['#!/bin/bash'], ['#!/bin/sh']), SH), false);
  // A `#!` anywhere but byte 0 is still an ordinary comment.
  assert.equal(stripComments('echo a\n#!/not/a/shebang\n', SH), 'echo a');
});

test('`#` mid-word is not a shell or YAML comment', () => {
  assert.equal(stripComments('echo a#b\n', SH), 'echo a#b');
  assert.equal(stripComments('url: http://x/#frag\n', YAML), 'url: http://x/#frag');
  assert.equal(stripComments('echo a # note\n', SH), 'echo a');
});

test('a `#` line inside a shell heredoc is data, so a heredoc makes the file unmodelled', () => {
  for (const [a, b] of [
    ['cat <<E\n#one\nE\n', 'cat <<E\n#two\nE\n'],
    ["cat <<-'EOF'\n\t# one\nEOF\n", "cat <<-'EOF'\n\t# two\nEOF\n"],
  ]) {
    const v = classify('x.sh', a, b);
    assert.equal(v.classification, 'unmodelled_construct', a);
    assert.equal(v.behavioural, true);
  }
});

test('a `#` line inside a YAML block scalar is data, so a block scalar makes the file unmodelled', () => {
  for (const [a, b] of [
    ['k: |\n  #one\n  x\n', 'k: |\n  #two\n  x\n'],
    ['k: >-\n  #one\n', 'k: >-\n  #two\n'],
    ['- |\n  #one\n', '- |\n  #two\n'],
  ]) {
    const v = classify('x.yaml', a, b);
    assert.equal(v.classification, 'unmodelled_construct', a);
    assert.equal(v.behavioural, true);
  }
});

test('a changed match key is never prose, however many words it has', () => {
  // The quota watchdog shape: the literal is what gets matched, not printed.
  const direct = classify('x.mjs',
    "if (s.includes('usage limit reached today')) stop();\n",
    "if (s.includes('usage limit hit now please')) stop();\n");
  assert.equal(direct.classification, 'string_only');
  assert.equal(direct.behavioural, true);
  // Indirect use through a pattern list is invisible at the literal, so a
  // literal outside a message sink is never prose either.
  const listed = classify('x.mjs',
    "const P = ['usage limit reached today'];\nif (P.some((p) => s.includes(p))) stop();\n",
    "const P = ['usage limit hit now please'];\nif (P.some((p) => s.includes(p))) stop();\n");
  assert.equal(listed.classification, 'string_only');
  const compared = classify('x.mjs',
    "if (msg === 'the job has already finished') x();\n",
    "if (msg === 'the job is already finished now') x();\n");
  assert.equal(compared.classification, 'string_only');
});

test('prose passes only as a direct argument to a known message sink', () => {
  for (const sink of ['console.log(', 'console.error(', 'console.warn(', 'new Error(', 'process.stderr.write(']) {
    const v = classify('x.mjs',
      `${sink}'the quota pause has been cleared for you');\n`,
      `${sink}'the quota pause was cleared by the watchdog');\n`);
    assert.equal(v.classification, 'prose_string_only', sink);
    assert.equal(v.behavioural, false);
  }
  // A concatenation continuation inside the sink call still counts.
  const concat = classify('x.mjs',
    "console.log('first part of the message ' + 'and the second part here');\n",
    "console.log('first part of the message ' + 'and a changed second part');\n");
  assert.equal(concat.classification, 'prose_string_only');
  // A sink-shaped name that is not a sink does not.
  const lookalike = classify('x.mjs',
    "notconsole.log('the quota pause has been cleared for you');\n",
    "notconsole.log('the quota pause was cleared by the watchdog');\n");
  assert.equal(lookalike.classification, 'string_only');
});

test('newlines and blank lines inside a quote are content, not normalised away', () => {
  const blank = classify('x.mjs', 'const t = `a\nb`;\n', 'const t = `a\n\nb`;\n');
  assert.equal(blank.behavioural, true, 'a blank line added inside a template changes the value');
  assert.equal(stripComments('const t = `a\n\n  b  \n`;\n', JS), 'const t = `a\n\n  b  \n`;');
  const sh = classify('x.sh', 'echo "a\nb"\n', 'echo "a\n\nb"\n');
  assert.equal(sh.behavioural, true);
});
