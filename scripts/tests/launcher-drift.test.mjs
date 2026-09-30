import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FALLBACK_SOURCE_PATHS,
  LAUNCH_PATH_INSTALL_PATHS,
  blastRadiusFor,
  buildReport,
  isUnversionedPath,
  parseReleaseManifest,
  renderProvenance,
  renderReport,
} from '../lib/launcher-drift.mjs';
import {
  boundDiff,
  classifyStaleChange,
  commentFamilyFor,
  parseUnifiedDiff,
  scanSource,
} from '../lib/launcher-diff-classify.mjs';

const DIGEST = (seed) => seed.repeat(64).slice(0, 64);
const INSTALLED = DIGEST('a');
const MERGED = DIGEST('b');
const EDITED = DIGEST('c');

const COMMIT = '6df0f76c70c6ce8b085fd44d8e84011b6aad59c0';
const TIP = 'b1fd7560000000000000000000000000000000ff';

/** The real hand-written step-1 manifest shape, digests shortened for legibility. */
const MANIFEST_TEXT = `# AppForge runtime launcher install manifest (APP-137 step 1)
source_repo: /Users/x/git-personal/appforge-control
source_ref: origin/main
source_commit: ${COMMIT}
installed_at: 2026-09-29T04:36:51Z
installed_by_run: 547c16ce-a8f8-4354-934b-2b336ef99124
files:
  ${INSTALLED}  bin/agent-launch.sh  versioned
  ${DIGEST('d')}  config/github-apps.yaml  versioned
  (bin/node_modules, secrets/) UNVERSIONED - gitignored, copied from working tree
`;

const manifest = () => parseReleaseManifest(MANIFEST_TEXT);

/** A world where everything agrees: disk == manifest == install commit == ref tip. */
function cleanWorld(over = {}) {
  const m = over.manifest ?? manifest();
  const installDigests = {};
  const commitDigests = {};
  const refTipDigests = {};
  for (const f of m.files) {
    installDigests[f.installPath] = f.sha256;
    commitDigests[f.sourcePath] = f.sha256;
    refTipDigests[f.sourcePath] = f.sha256;
  }
  return {
    manifest: m,
    installDigests,
    commitDigests,
    refTipDigests,
    refTipCommit: COMMIT,
    installDir: '/home/x/.appforge',
    checkedAt: '2026-09-29T19:00:00.000Z',
    ...over,
  };
}

const kinds = (report) => report.findings.map((f) => f.kind).sort();

test('the hand-written step-1 manifest parses, prose line and all', () => {
  const m = manifest();
  assert.equal(m.sourceCommit, COMMIT);
  assert.equal(m.sourceRef, 'origin/main');
  assert.equal(m.installedByRun, '547c16ce-a8f8-4354-934b-2b336ef99124');
  assert.equal(m.files.length, 2, 'the UNVERSIONED prose line is documentation, not an entry');
  assert.deepEqual(m.files.map((f) => f.installPath), ['bin/agent-launch.sh', 'config/github-apps.yaml']);
});

test('a manifest with no source-path column falls back to the mapping table', () => {
  const entry = manifest().files[0];
  assert.equal(entry.sourcePath, 'scripts/agent-launch.sh');
  assert.equal(entry.sourcePathFrom, 'fallback-table');
});

test('a source path recorded in the manifest wins over the fallback table', () => {
  const text = MANIFEST_TEXT.replace(
    `${INSTALLED}  bin/agent-launch.sh  versioned`,
    `${INSTALLED}  bin/agent-launch.sh  versioned  tools/launch.sh`);
  const entry = parseReleaseManifest(text).files[0];
  assert.equal(entry.sourcePath, 'tools/launch.sh');
  assert.equal(entry.sourcePathFrom, 'manifest');
});

test('every fallback mapping points into the repo, never into the install tree', () => {
  for (const [installPath, sourcePath] of Object.entries(FALLBACK_SOURCE_PATHS)) {
    assert.ok(!sourcePath.startsWith('bin/'), `${installPath} maps to an install path, not a repo path`);
  }
});

test('an unreadable manifest throws rather than reporting clean', () => {
  assert.throws(() => parseReleaseManifest(''), /empty/);
  assert.throws(() => parseReleaseManifest('source_repo: /x\nfiles:\n'), /source_ref/);
  assert.throws(() => parseReleaseManifest(`source_repo: /x\nsource_ref: origin/main\nsource_commit: ${COMMIT}\nfiles:\n`), /lists no files/);
});

test('everything in agreement produces no findings and exits quiet', () => {
  const report = buildReport(cleanWorld());
  assert.deepEqual(report.findings, []);
  assert.equal(report.behind, false);
  assert.equal(report.shouldEscalate, false);
  assert.equal(renderReport(report), '', 'a clean run must print nothing for the sweep to carry');
});

// APP-137 acceptance criterion: "Given a merged-but-not-deployed launcher
// change, the drift check reports it within one sweep interval."
test('a merged-but-not-deployed change is reported as stale', () => {
  const world = cleanWorld({ refTipCommit: TIP });
  world.refTipDigests['scripts/agent-launch.sh'] = MERGED;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['stale']);

  const [f] = report.findings;
  assert.equal(f.installPath, 'bin/agent-launch.sh');
  assert.equal(f.severity, 'high');
  assert.equal(f.deployedDigest, INSTALLED);
  assert.equal(f.mergedDigest, MERGED);
  assert.equal(report.behind, true);
  assert.equal(report.shouldEscalate, true, 'a stale deploy must escalate, not sit as a note');
  assert.match(renderReport(report), /merged but not deployed/);
});

test('a ref that has moved without touching a versioned file is not drift', () => {
  // This is the common case — most merges do not touch the launcher. Reporting
  // them would train the operator to ignore the alarm, which is the one outcome
  // that makes this check worse than useless.
  const report = buildReport(cleanWorld({ refTipCommit: TIP }));
  assert.deepEqual(report.findings, []);
  assert.equal(report.behind, true, 'still recorded as behind in the provenance line');
  assert.match(renderProvenance(report), /deploy=BEHIND-REF-TIP/);
});

// APP-137 acceptance criterion: "Given a hand-edited
// `~/.appforge/bin/agent-launch.sh`, the check reports it."
test('a hand-edited live file is reported as tampered', () => {
  const world = cleanWorld();
  world.installDigests['bin/agent-launch.sh'] = EDITED;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['tampered']);
  assert.equal(report.findings[0].severity, 'critical');
  assert.equal(report.findings[0].expected, INSTALLED);
  assert.equal(report.findings[0].actual, EDITED);
  assert.equal(report.shouldEscalate, true);
});

test('a deleted live file is reported as missing, not silently skipped', () => {
  const world = cleanWorld();
  world.installDigests['bin/agent-launch.sh'] = null;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['missing']);
  assert.equal(report.findings[0].severity, 'critical');
});

test('a manifest rewritten to match a hand-edited file is still caught', () => {
  // The attack the commit comparison exists for: edit the live file, then edit
  // RELEASE so the digests agree. Disk and manifest now match each other and
  // the install looks clean — but neither matches the blob at the commit
  // RELEASE names, and rewriting that would mean rewriting git history.
  const world = cleanWorld();
  world.installDigests['bin/agent-launch.sh'] = EDITED;
  world.manifest.files[0].sha256 = EDITED;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['manifest_mismatch']);
  assert.equal(report.findings[0].severity, 'critical');
  assert.equal(report.findings[0].commitDigest, INSTALLED);
  assert.equal(report.findings[0].manifestDigest, EDITED);
});

test('a manifest naming a path that is not in the commit is reported', () => {
  const world = cleanWorld();
  world.commitDigests['scripts/agent-launch.sh'] = null;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['source_missing']);
});

test('a versioned file deleted upstream is reported while it is still live', () => {
  const world = cleanWorld({ refTipCommit: TIP });
  world.refTipDigests['scripts/agent-launch.sh'] = null;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['source_removed']);
});

test('a file with no source path anywhere is reported as unmonitored', () => {
  const world = cleanWorld();
  world.manifest.files[0].sourcePath = null;

  const report = buildReport(world);
  assert.deepEqual(kinds(report), ['unmapped']);
  assert.equal(report.findings[0].severity, 'high');
  assert.match(renderReport(report), /unmonitored/);
});

test('a file added to the install tree after deploy is reported as unmanaged', () => {
  const report = buildReport(cleanWorld({ installExtras: ['bin/backdoor.sh'] }));
  assert.deepEqual(kinds(report), ['unmanaged']);
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.shouldEscalate, false, 'medium alone is a note, not an escalation');
  assert.match(renderReport(report), /Routing: note only/);
});

test('findings sort worst first so the sweep reads the critical one', () => {
  const world = cleanWorld({ installExtras: ['bin/extra.sh'], refTipCommit: TIP });
  world.installDigests['bin/agent-launch.sh'] = EDITED;
  world.refTipDigests['config/github-apps.yaml'] = MERGED;

  const report = buildReport(world);
  assert.deepEqual(report.findings.map((f) => f.severity), ['critical', 'high', 'medium']);
  assert.equal(report.worstSeverity, 'critical');
});

test('node_modules and secrets are exempt; nothing else is', () => {
  assert.ok(isUnversionedPath('bin/node_modules/yaml/index.js'));
  assert.ok(isUnversionedPath('secrets/appforge-agents.private-key.pem'));
  assert.ok(!isUnversionedPath('bin/agent-launch.sh'));
  assert.ok(!isUnversionedPath('config/github-apps.yaml'));
  assert.ok(!isUnversionedPath('bin/node_modules.sh'), 'a prefix match must not swallow a sibling file');
});

test('the provenance line names the source commit on a clean run too', () => {
  // APP-137 criterion 2. The do-nothing rule governs what the sweep posts, not
  // what it logs — a clean sweep still has to leave the commit in the run log,
  // or "what was production running at 14:00?" stays unanswerable.
  const line = renderProvenance(buildReport(cleanWorld()));
  assert.match(line, new RegExp(`source_commit=${COMMIT}`));
  assert.match(line, /source_ref=origin\/main/);
  assert.match(line, /installed_by_run=547c16ce/);
  assert.match(line, /findings=0/);
  assert.match(line, /deploy=at-ref-tip/);
});

test('the report says in writing that nothing was remediated', () => {
  const world = cleanWorld();
  world.installDigests['bin/agent-launch.sh'] = EDITED;
  assert.match(renderReport(buildReport(world)), /Detection only/);
});

// APP-137 acceptance criterion: "The check cannot itself prevent an agent run
// from starting." The only structural guarantee of that is that the launcher
// never calls the check, so assert it against the launcher's real source.
test('agent-launch.sh does not invoke the drift check', async () => {
  const launcher = await readFile(new URL('../agent-launch.sh', import.meta.url), 'utf8');
  assert.ok(!launcher.includes('detect-launcher-drift'),
    'wiring the drift check into launch would make one bad check kill every agent run (APP-132)');
});

// ---------------------------------------------------------------------------
// APP-261 — the report carries the diff, and classifies behavioural vs not.
//
// The defect these cover: any content change to a versioned launcher file was
// `stale`/`high` and went to the CEO with blob hashes and no diff. It escalated
// a 5-line advice string (APP-226) and a comment-only `config/github-apps.yaml`
// edit (APP-260). An operator who sees documentation escalated as `high` learns
// to discount the check, which is how the APP-72 blind spot returns.
// ---------------------------------------------------------------------------

/** A real unified diff for `before` -> `after`, built without touching a repo. */
function unifiedDiff(sourcePath, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  return [
    `diff --git a/${sourcePath} b/${sourcePath}`,
    'index 1111111..2222222 100644',
    `--- a/${sourcePath}`,
    `+++ b/${sourcePath}`,
    `@@ -1,${a.length} +1,${b.length} @@`,
    ...a.map((l) => `-${l}`),
    ...b.map((l) => `+${l}`),
  ].join('\n');
}

/** A world where `scripts/agent-launch.sh` is stale with the given delta. */
function staleWorld(sourcePath, before, after, over = {}) {
  const text = MANIFEST_TEXT.replace(
    `${INSTALLED}  bin/agent-launch.sh  versioned`,
    `${INSTALLED}  bin/agent-launch.sh  versioned  ${sourcePath}`);
  const world = cleanWorld({ manifest: parseReleaseManifest(text), refTipCommit: TIP, ...over });
  world.refTipDigests[sourcePath] = MERGED;
  world.sourceDiffs = {
    [sourcePath]: {
      diffText: unifiedDiff(sourcePath, before, after),
      beforeText: before,
      afterText: after,
    },
    ...(over.sourceDiffs ?? {}),
  };
  return world;
}

const onlyFinding = (world) => {
  const report = buildReport(world);
  assert.equal(report.findings.length, 1, `expected exactly one finding, got ${JSON.stringify(report.findings.map((f) => f.kind))}`);
  return { report, f: report.findings[0] };
};

// Acceptance criterion 1.
test('a stale finding carries the diff hunks so severity is judgeable in place', () => {
  const { f } = onlyFinding(staleWorld('scripts/x.mjs', 'if (a) run();\n', 'if (a || b) run();\n'));
  assert.equal(f.kind, 'stale');
  assert.ok(f.diff, 'the whole point of APP-261 is that the diff is in the report');
  assert.match(f.diff.text, /\+if \(a \|\| b\) run\(\);/);
  assert.equal(f.diff.truncated, false);
  assert.match(renderReport(buildReport(staleWorld('scripts/x.mjs', 'if (a) run();\n', 'if (a || b) run();\n'))),
    /```diff[\s\S]*\+if \(a \|\| b\)/);
});

// Acceptance criterion 4, case 1: a comment-only change is `low`.
test('a comment-only change is low and routes as a note, not a CEO escalation', () => {
  const before = '// old note\nconst a = 1;\n';
  const after = '/*\n * new note, several lines\n * of it\n */\nconst a = 1;\n';
  const { report, f } = onlyFinding(staleWorld('scripts/x.mjs', before, after));
  assert.equal(f.severity, 'low');
  assert.equal(f.classification.verdict, 'comment_only');
  assert.equal(report.shouldEscalate, false, 'a documentation edit must not consume a CEO ruling');
  assert.match(renderReport(report), /Routing: note only/);
  assert.match(renderReport(report), /never drops a finding/);
});

// The measured APP-260 case, as a regression fixture rather than a paraphrase:
// the real `config/github-apps.yaml` delta was comment-only with a provably
// zero effective change, and the detector rated it `high` with escalate=true.
test('the APP-260 github-apps.yaml shape classifies comment_only', () => {
  const before = [
    'apps:',
    '  appforge-agents:',
    '    deliberately_excluded:',
    '      - release-platform # separate App',
    '      - InvTrack # hands-off per founder policy',
    '',
  ].join('\n');
  const after = [
    'apps:',
    '  appforge-agents:',
    '    # CAUTION (APP-251): this list is NOT symmetric with `installed_on`.',
    '    # release-platform is enforced SERVER-SIDE by GitHub.',
    '    # InvTrack is a client-side pre-check; do not read it as containment.',
    '    deliberately_excluded:',
    '      - release-platform # separate App',
    '      - InvTrack # hands-off per founder policy',
    '',
  ].join('\n');
  const c = classifyStaleChange({
    sourcePath: 'config/github-apps.yaml', beforeText: before, afterText: after,
    diffText: unifiedDiff('config/github-apps.yaml', before, after),
  });
  assert.equal(c.verdict, 'comment_only');
  assert.equal(c.severity, 'low');
});

// Acceptance criterion 4, case 2: a logic change stays `high`.
test('a logic change stays high and still escalates', () => {
  const { report, f } = onlyFinding(staleWorld('scripts/x.mjs',
    '// note\nif (allowed) mint();\n',
    '// note\nif (allowed || override) mint();\n'));
  assert.equal(f.severity, 'high');
  assert.equal(f.classification.verdict, 'behavioural');
  assert.equal(report.shouldEscalate, true, 'a merged-but-inert code change is the APP-72 failure class');
});

test('a change mixing comments and code is behavioural, never comment_only', () => {
  const { f } = onlyFinding(staleWorld('scripts/x.mjs',
    'const a = 1;\n',
    '// explaining the change\nconst a = 2;\n'));
  assert.equal(f.severity, 'high');
  assert.equal(f.classification.verdict, 'behavioural');
});

// Acceptance criterion 4, case 3: an unparseable diff is `high`.
test('an unparseable diff fails toward high rather than toward clean', () => {
  const world = staleWorld('scripts/x.mjs', '// a\nconst a = 1;\n', '// b\nconst a = 1;\n');
  world.sourceDiffs['scripts/x.mjs'].diffText = 'this is not a unified diff at all';
  const { report, f } = onlyFinding(world);
  assert.equal(f.severity, 'high', 'a classifier that cannot read the diff must not grant low');
  assert.equal(f.classification.verdict, 'unparseable');
  assert.equal(report.shouldEscalate, true);
});

test('a file type with no known comment grammar fails toward high', () => {
  const { f } = onlyFinding(staleWorld('scripts/x.conf', 'a=1\n', 'a=2\n'));
  assert.equal(f.severity, 'high');
  assert.equal(f.classification.verdict, 'unparseable');
  assert.equal(commentFamilyFor('scripts/x.conf'), null);
});

test('a stale finding with no diff supplied at all stays high', () => {
  // The CLI can fail to produce a diff — a shallow clone, a gc'd object, git
  // refusing for any reason. Absence of evidence must not lower severity.
  const world = staleWorld('scripts/x.mjs', '// a\n', '// b\n');
  world.sourceDiffs = {};
  const { f } = onlyFinding(world);
  assert.equal(f.severity, 'high');
  assert.equal(f.classification.verdict, 'unparseable');
  assert.equal(f.diff, null);
});

test('a binary blob is not classified as comment-only', () => {
  const c = classifyStaleChange({
    sourcePath: 'scripts/x.mjs', beforeText: 'a\u0000b', afterText: 'a\u0000c',
    diffText: 'diff --git a/x b/x\nBinary files a/x and b/x differ',
  });
  assert.equal(c.verdict, 'unparseable');
  assert.equal(c.severity, 'high');
});

// Acceptance criterion 4, case 4: `critical` is untouched by the classifier.
test('a tampered finding stays critical even when the merged delta is comment-only', () => {
  // The two facts are independent. `tampered` says the live file was edited
  // after deploy; the delta between two commits says nothing about that edit.
  // An unexplained hand-edit to the credential-bearing launcher tree is
  // critical for being unexplained.
  const world = staleWorld('scripts/agent-launch.sh', '# old note\nexec "$@"\n', '# new note\nexec "$@"\n');
  world.installDigests['bin/agent-launch.sh'] = EDITED;

  const report = buildReport(world);
  const tampered = report.findings.find((f) => f.kind === 'tampered');
  assert.ok(tampered, 'the classifier must never suppress a finding');
  assert.equal(tampered.severity, 'critical');
  assert.equal(tampered.classification, undefined, 'critical kinds are not classified at all');
  assert.equal(report.worstSeverity, 'critical');
  assert.equal(report.shouldEscalate, true);

  const stale = report.findings.find((f) => f.kind === 'stale');
  assert.equal(stale.severity, 'low', 'the stale half may still be low; that does not soften the tampered half');
});

test('missing and manifest_mismatch are likewise never classified', () => {
  for (const [label, mutate] of [
    ['missing', (w) => { w.installDigests['bin/agent-launch.sh'] = null; }],
    ['manifest_mismatch', (w) => { w.manifest.files[0].sha256 = EDITED; w.installDigests['bin/agent-launch.sh'] = EDITED; }],
  ]) {
    const world = staleWorld('scripts/agent-launch.sh', '# old\n', '# new\n');
    mutate(world);
    const found = buildReport(world).findings.find((f) => f.kind === label);
    assert.ok(found, `${label} must still be reported`);
    assert.equal(found.severity, 'critical');
    assert.equal(found.classification, undefined);
  }
});

test('string-literal-only changes keep high by default, labelled so the reader sees why', () => {
  // APP-261's text groups string literals with comments. It is narrowed here on
  // purpose: the repo allowlists and `deliberately_excluded` entries that keep
  // agents off release-platform and InvTrack are string data, so a
  // strings-are-free rule would route a containment change as a note. The
  // verdict is surfaced instead, which is what APP-226 actually cost.
  const { f } = onlyFinding(staleWorld('scripts/x.mjs',
    "const advice = 'run --resolve here';\nwake(advice);\n",
    "const advice = 'this wake is unbound; run it report-only';\nwake(advice);\n"));
  assert.equal(f.classification.verdict, 'strings_only');
  assert.equal(f.severity, 'high');

  const opted = classifyStaleChange({
    sourcePath: 'scripts/x.mjs',
    beforeText: "const a = 'x';\n", afterText: "const a = 'yy';\n",
    diffText: unifiedDiff('scripts/x.mjs', "const a = 'x';\n", "const a = 'yy';\n"),
    treatStringsAsNonBehavioural: true,
  });
  assert.equal(opted.verdict, 'strings_only');
  assert.equal(opted.severity, 'low', 'the looser rule is available, but nothing in this repo opts into it');
});

test('a comment-looking line added inside a template literal is behavioural', () => {
  // The line-prefix test alone would pass this: the added line starts with
  // `//`. The whole-file strip-and-compare is what catches it, which is why the
  // verdict needs both checks and not either one.
  const before = 'const s = `\nkept\n`;\n';
  const after = 'const s = `\n// not a comment\nkept\n`;\n';
  const c = classifyStaleChange({
    sourcePath: 'scripts/x.mjs', beforeText: before, afterText: after,
    diffText: unifiedDiff('scripts/x.mjs', before, after),
  });
  assert.equal(c.verdict, 'behavioural');
  assert.equal(c.severity, 'high');
});

test('a `//` inside a string is not mistaken for a comment', () => {
  // Naive `s|//.*||` stripping would cut both revisions to `fetch('https:` and
  // call a changed host comment-only. That is a false low on a URL.
  const before = "fetch('https://a.example/mint');\n";
  const after = "fetch('https://b.example/mint');\n";
  assert.notEqual(scanSource(before, 'c_like').code, scanSource(after, 'c_like').code);
  const c = classifyStaleChange({
    sourcePath: 'scripts/x.mjs', beforeText: before, afterText: after,
    diffText: unifiedDiff('scripts/x.mjs', before, after),
  });
  assert.notEqual(c.severity, 'low');
});

test('a `#` inside a quoted shell or YAML scalar is not a comment', () => {
  assert.equal(scanSource("k: 'a#b'\n", 'hash').code, "k: 'a#b'");
  assert.equal(scanSource('k: v # trailing\n', 'hash').code, 'k: v');
  assert.equal(scanSource('echo "${x#prefix}"\n', 'hash').code, 'echo "${x#prefix}"');
});

test('a whitespace-only or reindent change is low', () => {
  const { f } = onlyFinding(staleWorld('scripts/x.mjs', 'const a = 1;\n', '  const a = 1;   \n\n'));
  assert.equal(f.severity, 'low');
  assert.equal(f.classification.verdict, 'comment_only');
});

test('JSON has no comment syntax, so any change to it is behavioural', () => {
  const { f } = onlyFinding(staleWorld('scripts/package-lock.json', '{"a":1}\n', '{"a":2}\n'));
  assert.equal(f.severity, 'high');
  assert.equal(f.classification.family, 'none');
});

test('strict diff parsing rejects hunks whose body disagrees with their header', () => {
  assert.throws(() => parseUnifiedDiff('@@ -1,1 +1,1 @@\n-a\n-b\n+c\n'), /longer than/);
  assert.throws(() => parseUnifiedDiff('@@ -1,5 +1,5 @@\n-a\n+b\n'), /shorter than/);
  assert.throws(() => parseUnifiedDiff('-a\n+b\n'), /before any @@/);
  assert.throws(() => parseUnifiedDiff('diff --git a/x b/x\n'), /no @@ hunk header/);
  assert.throws(() => parseUnifiedDiff(''), /empty/);
  const ok = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  assert.deepEqual(ok, { hunks: 1, added: ['c'], removed: ['b'] });
});

test('diffs are bounded with an explicit count rather than silently cut', () => {
  const long = ['@@ -1,1 +1,1 @@', ...Array.from({ length: 50 }, (_, i) => `+line ${i}`)].join('\n');
  const bound = boundDiff(long, 10);
  assert.equal(bound.truncated, true);
  assert.equal(bound.shownLines, 10);
  assert.equal(bound.totalLines, 51);
  assert.match(bound.text, /\.\.\. 41 more diff lines truncated \(51 total\)/);
  assert.ok(!bound.text.includes('line 20'));

  const short = boundDiff('@@ -1,1 +1,1 @@\n+one\n', 10);
  assert.equal(short.truncated, false);
  assert.ok(!short.text.includes('truncated'));
});

test('the bounded diff drops git file headers, which the report already names', () => {
  const bound = boundDiff([
    'diff --git a/x b/x', 'index 1111111..2222222 100644', '--- a/x', '+++ b/x',
    '@@ -1,1 +1,1 @@', '-a', '+b',
  ].join('\n'), 100);
  assert.equal(bound.totalLines, 3);
  assert.ok(!bound.text.includes('diff --git'));
  assert.match(bound.text, /^@@ /);
});

test('low sorts below medium so the report still reads worst-first', () => {
  const world = staleWorld('scripts/x.mjs', '// a\n', '// b\n', { installExtras: ['bin/extra.sh'] });
  const report = buildReport(world);
  assert.deepEqual(report.findings.map((f) => f.severity), ['medium', 'low']);
  assert.equal(report.worstSeverity, 'medium');
  assert.equal(report.shouldEscalate, false);
});

test('the provenance line records the routing decision, not just the count', () => {
  const line = renderProvenance(buildReport(staleWorld('scripts/x.mjs', '// a\n', '// b\n')));
  assert.match(line, /findings=1/);
  assert.match(line, /worst=low/);
  assert.match(line, /escalate=no/);
});

// APP-260 asked for severity to distinguish the launch path from the sweep
// path. It is reported and deliberately does NOT move severity: APP-72 — the
// blind spot this whole check exists for — was a stale *sweep* backstop, so
// downgrading sweep-path staleness would reinstall the gap.
test('blast radius is reported for stale findings and does not change severity', () => {
  const launch = onlyFinding(staleWorld('scripts/agent-launch.sh',
    '#!/bin/sh\nexec "$@"\n', '#!/bin/sh\nexec env FOO=1 "$@"\n'));
  assert.equal(launch.f.blastRadius, 'launch-path');
  assert.equal(launch.f.severity, 'high');
  assert.match(renderReport(launch.report), /Blast radius: \*\*launch path\*\*/);

  assert.equal(blastRadiusFor('bin/quota-retry-watchdog.mjs'), 'sweep-path');
  assert.equal(blastRadiusFor('bin/lib/quota-pause-collateral.mjs'), 'sweep-path');
  assert.equal(blastRadiusFor('bin/agent-launch.sh'), 'launch-path');
});

// The launch-path table is a hand-maintained claim about what agent-launch.sh
// touches. Assert it against the launcher's real source so it cannot rot into a
// comforting lie the way a stale config comment does.
// Asserted in the direction where a stale table is dangerous. Claiming a file
// is `sweep-path` when launch actually execs it understates its blast radius;
// the reverse only overstates it. So: everything agent-launch.sh invokes, and
// everything the minter it invokes reads, must be in the table.
test('nothing agent-launch.sh invokes is left out of the launch-path table', async () => {
  const launcher = await readFile(new URL('../agent-launch.sh', import.meta.url), 'utf8');

  // Script names only: `$SCRIPT_DIR/..` is the repo-root computation, not a file.
  const invoked = [...launcher.matchAll(/\$SCRIPT_DIR\/([A-Za-z0-9._-]+\.(?:sh|mjs|js))/g)].map((m) => m[1]);
  assert.ok(invoked.length > 0, 'the launcher must still invoke something, or this test asserts nothing');
  for (const name of new Set(invoked)) {
    assert.ok(LAUNCH_PATH_INSTALL_PATHS.has(`bin/${name}`),
      `agent-launch.sh invokes ${name}, so bin/${name} is on the launch path and must be in LAUNCH_PATH_INSTALL_PATHS`);
  }

  assert.ok(launcher.includes('.gitconfig-appforge'));
  assert.ok(LAUNCH_PATH_INSTALL_PATHS.has('.gitconfig-appforge'));

  // The two indirect entries the minter itself names.
  const minter = await readFile(new URL('../github-app-token.mjs', import.meta.url), 'utf8');
  for (const [needle, installPath] of [['github-app.mjs', 'bin/lib/github-app.mjs'], ['github-apps.yaml', 'config/github-apps.yaml']]) {
    assert.ok(minter.includes(needle), `github-app-token.mjs no longer references ${needle}`);
    assert.ok(LAUNCH_PATH_INSTALL_PATHS.has(installPath));
  }
});

// ---------------------------------------------------------------------------
// APP-263 — the manifest's own `source_tree_state` / `source_dirty_paths`.
//
// The premise the drift check rests on is "the installed bytes came from
// `source_commit`". These tests hold both halves of what the manifest can say
// about that: that a dirty baseline is stated in the report, and that a dirty
// path whose bytes are in no commit cannot be the evidence for a downgrade.
// ---------------------------------------------------------------------------

/** `staleWorld`, plus a `source_tree_state` / `source_dirty_paths` header. */
function dirtyStaleWorld(sourcePath, before, after, { dirtyPaths = [sourcePath], treeState = 'dirty', over = {} } = {}) {
  const text = MANIFEST_TEXT
    .replace(`${INSTALLED}  bin/agent-launch.sh  versioned`,
      `${INSTALLED}  bin/agent-launch.sh  versioned  ${sourcePath}`)
    .replace(`source_commit: ${COMMIT}`,
      `source_commit: ${COMMIT}\nsource_tree_state: ${treeState}\nsource_dirty_paths: ${dirtyPaths.length === 0 ? 'none' : dirtyPaths.join(',')}`);
  const world = cleanWorld({ manifest: parseReleaseManifest(text), refTipCommit: TIP, ...over });
  world.refTipDigests[sourcePath] = MERGED;
  world.sourceDiffs = {
    [sourcePath]: {
      diffText: unifiedDiff(sourcePath, before, after),
      beforeText: before,
      afterText: after,
    },
  };
  return world;
}

const COMMENT_BEFORE = '// old note\nrun();\n';
const COMMENT_AFTER = '// new note\nrun();\n';

test('the dirty baseline is parsed off the manifest rather than assumed clean', () => {
  const m = dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER).manifest;
  assert.equal(m.sourceTreeState, 'dirty');
  assert.deepEqual(m.sourceDirtyPaths, ['scripts/x.mjs']);
  // `none` is zero paths, not a path called "none".
  assert.deepEqual(
    dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER, { treeState: 'clean', dirtyPaths: [] }).manifest.sourceDirtyPaths,
    []);
  // A real multi-path header, as the installer writes it.
  const multi = parseReleaseManifest(MANIFEST_TEXT.replace(`source_commit: ${COMMIT}`,
    `source_commit: ${COMMIT}\nsource_tree_state: dirty\nsource_dirty_paths: scripts/a.sh,scripts/b.mjs, scripts/c.mjs`));
  assert.deepEqual(multi.sourceDirtyPaths, ['scripts/a.sh', 'scripts/b.mjs', 'scripts/c.mjs']);
});

test('a manifest with no tree-state field reads as unknown, never as clean', () => {
  // The hand-written step-1 manifest predates both fields. Absence of evidence
  // that the tree was dirty is not evidence that it was clean.
  assert.equal(manifest().sourceTreeState, 'unknown');
  assert.deepEqual(manifest().sourceDirtyPaths, []);
  const report = buildReport(cleanWorld());
  assert.equal(report.sourceTreeState, 'unknown');
  assert.match(renderProvenance(report), /source_tree_state=unknown/);
});

// Acceptance criterion 1.
test('the report header and JSON carry the dirty baseline and its paths', () => {
  const world = dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER);
  const report = buildReport(world);
  assert.equal(report.sourceTreeState, 'dirty');
  assert.deepEqual(report.sourceDirtyPaths, ['scripts/x.mjs']);
  // The provenance line is printed on every run, clean ones included, so the
  // baseline is answerable after the fact without anyone having noticed.
  assert.match(renderProvenance(report), /source_tree_state=dirty source_dirty_paths=1/);
  const text = renderReport(report);
  assert.match(text, /Source checkout at install time: \*\*dirty\*\*/);
  assert.match(text, /--allow-dirty/);
  assert.match(text, /`scripts\/x\.mjs`/);
});

test('a clean baseline says so once and does not pad the report', () => {
  const report = buildReport(dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER,
    { treeState: 'clean', dirtyPaths: [] }));
  const text = renderReport(report);
  assert.match(text, /Source checkout at install time: \*\*clean\*\*/);
  assert.doesNotMatch(text, /--allow-dirty/);
  assert.doesNotMatch(text, /Install baseline:/);
  assert.match(renderProvenance(report), /source_tree_state=clean source_dirty_paths=0/);
});

// Acceptance criterion 2, the matching half: this is the live case today.
test('a dirty path whose install digest matches the commit is stated and keeps its severity', () => {
  // cleanWorld sets commitDigests[sourcePath] = the manifest digest, so the
  // deployed bytes ARE the committed ones — exactly the measured live state.
  const { f } = onlyFinding(dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER));
  assert.equal(f.kind, 'stale');
  assert.equal(f.sourceProvenance.dirtyAtInstall, true);
  assert.equal(f.sourceProvenance.matchesInstallCommit, true);
  // The classifier's verdict stands untouched: nothing is wrong with this file.
  assert.equal(f.classification.verdict, 'comment_only');
  assert.equal(f.severity, 'low');
  const text = renderReport(buildReport(dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER)));
  assert.match(text, /Install baseline: this path was uncommitted in the source checkout at install time, but the installed digest equals the blob/);
  assert.doesNotMatch(text, /could not be traced to the install commit/);
});

// Acceptance criterion 2, the mismatching half.
test('a dirty path whose install digest is in no commit cannot be downgraded', () => {
  // A comment-only merged delta would normally land `low`. It must not here:
  // the diff is `source_commit..tip`, and the deployed bytes are neither end.
  const world = dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER);
  world.commitDigests['scripts/x.mjs'] = EDITED; // blob at the commit != manifest digest
  const report = buildReport(world);

  const stale = report.findings.find((f) => f.kind === 'stale');
  assert.ok(stale, 'the stale finding is still produced; classification never drops a finding');
  assert.equal(stale.severity, 'high', 'a comment-only downgrade argued from the wrong baseline must not apply');
  assert.equal(stale.classification.verdict, 'unverifiable-baseline');
  assert.equal(stale.sourceProvenance.matchesInstallCommit, false);
  assert.ok(report.shouldEscalate, 'an install the commit does not describe escalates');

  // And the pre-existing unconditional check fires too: this is `critical`
  // already, without any dirty-path gate. APP-263 does not weaken that.
  assert.ok(kinds(report).includes('manifest_mismatch'));
  assert.equal(report.worstSeverity, 'critical');

  const text = renderReport(report);
  assert.match(text, /\*\*this path was uncommitted at install time AND the installed digest does not match/);
  assert.match(text, /could not be traced to the install commit/);
  assert.match(text, /no comment-only downgrade was allowed to apply/);
});

test('a dirty path not among the dirty paths is unqualified, so a clean manifest is a true regression test', () => {
  // The tree was dirty, but this file was not one of the dirty paths, so its
  // bytes trace to the commit the same as under a clean install.
  const { f } = onlyFinding(dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER,
    { dirtyPaths: ['scripts/unrelated.mjs'] }));
  assert.equal(f.severity, 'low');
  assert.equal(f.sourceProvenance, undefined, 'nothing to qualify, so nothing is printed');
});

test('a mismatched digest on a CLEAN baseline is still critical and still not downgraded past high', () => {
  // The regression guard: the dirty-path logic must not be the only thing
  // catching a manifest that disagrees with its own commit.
  const world = dirtyStaleWorld('scripts/x.mjs', COMMENT_BEFORE, COMMENT_AFTER,
    { treeState: 'clean', dirtyPaths: [] });
  world.commitDigests['scripts/x.mjs'] = EDITED;
  const report = buildReport(world);
  assert.ok(kinds(report).includes('manifest_mismatch'));
  assert.equal(report.worstSeverity, 'critical');
  assert.ok(report.shouldEscalate);
});

// APP-263 item 3 asked whether to add a `--allow-dirty` opt-in to the installer.
// It is already there and already covered end-to-end, by tests that run the real
// installer against a fixture rather than grepping its source:
//
//   scripts/tests/install-runtime-launcher.test.mjs
//     'refuses a dirty source tree unless --allow-dirty, which is then recorded'
//     'a clean tree is recorded as clean'
//     'versioned files come from the commit, never from the working tree'
//
// That last one is the reason a dirty install cannot contaminate a versioned
// file's bytes, and so the reason this module's job is to report the baseline
// rather than to re-derive it. Nothing is duplicated here.
