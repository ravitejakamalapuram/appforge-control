import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FALLBACK_SOURCE_PATHS,
  LAUNCH_PATH_INSTALL_PATHS,
  MAX_DIFF_LINES,
  buildReport,
  isUnversionedPath,
  parseReleaseManifest,
  renderProvenance,
  renderReport,
} from '../lib/launcher-drift.mjs';

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

// -- APP-261: the diff in the report, and behavioural classification ---------
//
// The defect these cover: every content change to a versioned launcher file
// was `stale`/`high` and went to the CEO with two blob hashes and no diff. On
// APP-226 that escalated a five-line `collateralNote` advice string under the
// headline "Production is not running that fix", and the CEO had to read the
// diff by hand to find the claim wrong. On APP-260 it escalated a
// documentation-only edit to `config/github-apps.yaml` whose comment-stripped
// content was byte-identical. An operator who watches that happen learns to
// discount the check, which is how the APP-72 blind spot comes back.

/**
 * A one-file `stale` world: `bin/agent-launch.sh` is behind the ref tip, and
 * the delta between the two revisions is whatever the caller passes.
 *
 * Only one manifest entry, so a `sourcePath` the caller picks to exercise a
 * file type cannot collide with the fixture's other entry.
 */
function staleWorld({ before, after, diffText, sourcePath = 'scripts/agent-launch.sh', installPath = 'bin/agent-launch.sh' }) {
  const m = manifest();
  m.files = [{ ...m.files[0], installPath, sourcePath, sha256: INSTALLED }];
  const world = cleanWorld({ manifest: m, refTipCommit: TIP });
  world.refTipDigests[sourcePath] = MERGED;
  world.diffs = { [sourcePath]: { before, after, diffText } };
  return world;
}

const staleFinding = (world) => {
  const report = buildReport(world);
  const f = report.findings.find((x) => x.kind === 'stale');
  assert.ok(f, 'the classifier must never make the finding disappear');
  return { report, f };
};

test('a comment-only change is reported, with the diff, as low', () => {
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'config/github-apps.yaml',
    before: 'apps:\n  appforge-agents:\n    installed_on:\n      - StellarTab\n',
    after: 'apps:\n  appforge-agents:\n    # CAUTION (APP-251): not symmetric with deliberately_excluded.\n    installed_on:\n      - StellarTab\n',
    diffText: [
      '--- a/config/github-apps.yaml',
      '+++ b/config/github-apps.yaml',
      '@@ -1,4 +1,5 @@',
      ' apps:',
      '   appforge-agents:',
      '+    # CAUTION (APP-251): not symmetric with deliberately_excluded.',
      '     installed_on:',
      '       - StellarTab',
    ].join('\n'),
  }));

  assert.equal(f.classification, 'comment_only');
  assert.equal(f.behavioural, false);
  assert.equal(f.severity, 'low', 'a documentation edit must not be rated the same as an inert safety control');
  assert.equal(report.shouldEscalate, false, 'a note, not a CEO escalation');

  const md = renderReport(report);
  assert.match(md, /Routing: note only/);
  assert.match(md, /```diff/, 'the diff belongs in the report so severity is judged in place');
  assert.match(md, /# CAUTION \(APP-251\)/);
  assert.match(md, /The finding stands; only its severity moved/);
});

test('a logic change stays high and still escalates', () => {
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'scripts/lib/quota-retry-watchdog.mjs',
    before: 'export function readRunIssueId(run) {\n  return run?.nativeIssueId ?? null;\n}\n',
    after: 'export function readRunIssueId(run) {\n  return run?.contextSnapshot?.issueId ?? run?.nativeIssueId ?? null;\n}\n',
    diffText: [
      '--- a/scripts/lib/quota-retry-watchdog.mjs',
      '+++ b/scripts/lib/quota-retry-watchdog.mjs',
      '@@ -1,3 +1,3 @@',
      ' export function readRunIssueId(run) {',
      '-  return run?.nativeIssueId ?? null;',
      '+  return run?.contextSnapshot?.issueId ?? run?.nativeIssueId ?? null;',
      ' }',
    ].join('\n'),
  }));

  assert.equal(f.classification, 'behavioural');
  assert.equal(f.severity, 'high');
  assert.equal(report.shouldEscalate, true);
  assert.match(renderReport(report), /Routing: escalate/);
});

test('an unparseable diff fails toward high', () => {
  // An unterminated literal means the scanner cannot say what is code and what
  // is not. A false `low` reintroduces the blind spot; a false `high` costs a
  // read, so uncertainty resolves upward.
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'scripts/agent-launch.sh',
    before: "echo 'fine'\n",
    after: "echo 'unterminated\n",
    diffText: "--- a/scripts/agent-launch.sh\n+++ b/scripts/agent-launch.sh\n@@ -1 +1 @@\n-echo 'fine'\n+echo 'unterminated\n",
  }));
  assert.equal(f.classification, 'unparseable');
  assert.equal(f.severity, 'high');
  assert.equal(report.shouldEscalate, true);
});

test('a missing diff fails toward high rather than assuming it was harmless', () => {
  const world = cleanWorld({ refTipCommit: TIP });
  world.refTipDigests['scripts/agent-launch.sh'] = MERGED;
  // No `diffs` at all — the git read failed, or the caller did not supply one.
  const { report, f } = staleFinding(world);
  assert.equal(f.classification, 'unavailable');
  assert.equal(f.severity, 'high');
  assert.equal(report.shouldEscalate, true);
  assert.match(renderReport(report), /No diff available/);
});

test('a tampered file stays critical even when the delta is comment-only', () => {
  // The classifier adjusts `stale` and nothing else. An unexplained hand-edit
  // to the credential-bearing launcher tree is critical because it is
  // unexplained, not because of what it touched.
  const world = staleWorld({
    sourcePath: 'config/github-apps.yaml',
    before: 'apps:\n  appforge-agents: {}\n',
    after: 'apps:\n  # a comment\n  appforge-agents: {}\n',
    diffText: '--- a/config/github-apps.yaml\n+++ b/config/github-apps.yaml\n@@ -1,2 +1,3 @@\n apps:\n+  # a comment\n   appforge-agents: {}\n',
  });
  world.installDigests['bin/agent-launch.sh'] = EDITED;

  const report = buildReport(world);
  const tampered = report.findings.find((f) => f.kind === 'tampered');
  assert.ok(tampered, 'the hand-edit is still reported');
  assert.equal(tampered.severity, 'critical');
  assert.equal(tampered.classification, undefined, 'the classifier must not touch a critical finding');
  assert.equal(report.worstSeverity, 'critical');
  assert.equal(report.shouldEscalate, true, 'a comment-only delta cannot talk a tampered file down');
});

test('the APP-226 case — an advice string assigned to a variable — stays high, labelled, with its diff', () => {
  // PR #53 review (2026-10-01): a literal outside a message sink may be a
  // match key read elsewhere, and this classifier cannot see where. So the
  // literal APP-226 shape — `const collateralNote = '...'` — no longer earns
  // `low`. What APP-226 actually cost was a hand-read of the diff; the report
  // now carries that diff and names the change `string_only`.
  const before = "  const collateralNote = ' Clear them yourself with the script.';\n";
  const after = "  const collateralNote = ' This wake is task-bound, so you can clear them here.';\n";
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'scripts/quota-retry-watchdog.mjs',
    before,
    after,
    diffText: `--- a/scripts/quota-retry-watchdog.mjs\n+++ b/scripts/quota-retry-watchdog.mjs\n@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n`,
  }));
  assert.equal(f.classification, 'string_only');
  assert.equal(f.severity, 'high');
  assert.equal(report.shouldEscalate, true);
});

test('the same advice edit passed straight to a message sink does not escalate', () => {
  const before = "  console.error('Clear them yourself with the script.');\n";
  const after = "  console.error('This wake is task-bound, so you can clear them here.');\n";
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'scripts/quota-retry-watchdog.mjs',
    before,
    after,
    diffText: `--- a/scripts/quota-retry-watchdog.mjs\n+++ b/scripts/quota-retry-watchdog.mjs\n@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n`,
  }));
  assert.equal(f.classification, 'prose_string_only');
  assert.equal(f.severity, 'low');
  assert.equal(report.shouldEscalate, false);
});

test('a flag swap inside a string literal is NOT talked down to low', () => {
  // The blind spot a blanket "string literals are harmless" rule would open:
  // `--dry-run` to `--force` changes no code skeleton at all.
  const { f } = staleFinding(staleWorld({
    sourcePath: 'scripts/quota-retry-watchdog.mjs',
    before: "  run('git', ['push', '--dry-run']);\n",
    after: "  run('git', ['push', '--force']);\n",
    diffText: "--- a/scripts/quota-retry-watchdog.mjs\n+++ b/scripts/quota-retry-watchdog.mjs\n@@ -1 +1 @@\n-  run('git', ['push', '--dry-run']);\n+  run('git', ['push', '--force']);\n",
  }));
  assert.equal(f.classification, 'string_only');
  assert.equal(f.behavioural, true);
  assert.equal(f.severity, 'high');
});

test('a file type with no comment model is behavioural by default', () => {
  const { f } = staleFinding(staleWorld({
    sourcePath: 'scripts/package.json',
    before: '{ "dependencies": { "yaml": "^2.5.0" } }\n',
    after: '{ "dependencies": { "yaml": "^2.6.0" } }\n',
    diffText: '--- a/scripts/package.json\n+++ b/scripts/package.json\n@@ -1 +1 @@\n-{ "dependencies": { "yaml": "^2.5.0" } }\n+{ "dependencies": { "yaml": "^2.6.0" } }\n',
  }));
  assert.equal(f.classification, 'unmodelled_filetype');
  assert.equal(f.severity, 'high');
});

test('the diff carried in the report is bounded', () => {
  const body = Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n');
  const { report, f } = staleFinding(staleWorld({
    sourcePath: 'scripts/lib/github-app.mjs',
    before: 'const a = 1;\n',
    after: `${body}\nconst a = 2;\n`,
    diffText: `--- a/x\n+++ b/x\n@@ -1 +1,201 @@\n-const a = 1;\n${body.split('\n').map((l) => `+${l}`).join('\n')}\n+const a = 2;\n`,
  }));
  assert.equal(f.diffTruncated, true);
  assert.equal(f.diffHunks.split('\n').length, MAX_DIFF_LINES);
  assert.ok(f.diffLineCount > MAX_DIFF_LINES);
  assert.match(renderReport(report), new RegExp(`Truncated at ${MAX_DIFF_LINES} of ${f.diffLineCount} lines`));
});

test('findings record whether the file is on the launch path, without that moving severity', () => {
  // Blast-radius context for the reader. It must not demote: a sweep script
  // that stops recovering paused agents is a real failure, and demoting it
  // because it cannot abort a launch would open a second blind spot beside
  // the one this work closes.
  assert.ok(LAUNCH_PATH_INSTALL_PATHS.has('bin/agent-launch.sh'));
  assert.ok(!LAUNCH_PATH_INSTALL_PATHS.has('bin/quota-retry-watchdog.mjs'));

  const world = cleanWorld();
  world.installDigests['bin/agent-launch.sh'] = EDITED;
  const [f] = buildReport(world).findings;
  assert.equal(f.launchPath, true);
  assert.equal(f.severity, 'critical', 'launch-path context is reported, not scored');
});

test('low sorts below medium so the escalating findings stay at the top', () => {
  const world = staleWorld({
    sourcePath: 'config/github-apps.yaml',
    before: 'a: 1\n',
    after: '# note\na: 1\n',
    diffText: '--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n+# note\n a: 1\n',
  });
  world.installExtras = ['bin/extra.sh'];
  const report = buildReport(world);
  assert.deepEqual(report.findings.map((f) => f.severity), ['medium', 'low']);
  assert.equal(report.worstSeverity, 'medium');
  assert.equal(report.shouldEscalate, false);
});
