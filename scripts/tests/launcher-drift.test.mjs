import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FALLBACK_SOURCE_PATHS,
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
