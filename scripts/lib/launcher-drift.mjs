/**
 * Detect drift between the live agent launcher and the commit it was installed
 * from (APP-162, child of APP-137).
 *
 * WHY THIS EXISTS
 *
 * APP-137's root finding was not that the launcher was editable. It was that a
 * merged control — the APP-72 worktree-prune backstop, on `main` since PR #17 —
 * was inert in production and nobody noticed for days. Step 1 moved the
 * launcher to `~/.appforge/` so a stray `git checkout` in the shared checkout
 * can no longer revert it. That closes the *reverted* failure mode and leaves
 * the *stale* one wide open: the next time someone merges a launcher change and
 * forgets to redeploy, production silently keeps running the old file. Quieter
 * is not better. This module is the alarm whose absence was the whole issue.
 *
 * TWO INDEPENDENT QUESTIONS, BOTH OF WHICH MUST BE ASKED
 *
 * 1. Does the installed byte content still match the `RELEASE` manifest?
 *    Catches a hand-edit, a partial redeploy, a deleted file. Local tampering.
 * 2. Does the commit named in the manifest still agree with the tip of the ref
 *    it was installed from? Catches the stale deploy — the APP-72 case. This is
 *    the one that needs an outside reference, because a tampered manifest and a
 *    tampered file agree with each other perfectly.
 *
 * Question 2 is why the manifest digests are also compared against the blobs at
 * `source_commit`: that is the only check a hand-rewritten `RELEASE` cannot
 * satisfy on its own, since it would have to also rewrite git history.
 *
 * ALARM, DO NOT BLOCK
 *
 * This module is read-only and is run by the hourly sweep, never by
 * `agent-launch.sh`. That separation is deliberate and load-bearing. A drift
 * check wired into launch would abort every agent run the moment it had a bad
 * day — which is precisely the APP-132 availability failure, where one
 * transient GitHub mint failure killed 25 runs. An integrity check that can
 * take the company offline is a worse bug than the drift it detects. Keep the
 * only caller the sweep.
 *
 * A DIRTY INSTALL BASELINE (APP-263)
 *
 * `RELEASE` records `source_tree_state` and `source_dirty_paths`, and until
 * APP-263 this module read neither. Two things follow, and they pull in opposite
 * directions, so both are stated:
 *
 * What is NOT at risk. Every versioned file is materialised by
 * `git show <source_commit>:<path>` into a staging directory, and the manifest
 * digest is taken from that staged file — never from the working tree
 * (`install-runtime-launcher.sh` step 4). So the installed bytes of a versioned
 * file come from the commit whether the tree was dirty or not, and if they ever
 * did not, `manifest_mismatch` already catches it at `critical` on every run,
 * for every versioned file, dirty or clean. That check needs no dirty-path
 * gate and does not get one here: gating it on `source_dirty_paths` would be a
 * strict weakening of a check that is currently unconditional.
 *
 * What IS at risk, and what this adds. A `stale` finding's severity is argued
 * from the `source_commit..ref_tip` diff, and that argument is only sound if the
 * deployed bytes are the ones at `source_commit`. When a path was dirty at
 * install AND its install digest disagrees with the blob, the diff describes a
 * transition that never happened, and the classifier must not be allowed to
 * downgrade the finding to `low` on the strength of it. So a dirty path whose
 * provenance fails pins `stale` at `high`. The reverse — a dirty path whose
 * digest matches — is stated in the report and changes nothing, because nothing
 * is wrong with it.
 *
 * The dirty state itself is reported in the header and the JSON, not raised as a
 * finding. It is a fact about a past install, not a live defect: as a finding it
 * would turn every otherwise-clean sweep on this box into a post that says the
 * same thing forever, which is how an alarm gets ignored. The reader who needs
 * it gets it on the provenance line of every run, clean ones included.
 *
 * NOT A REMEDIATOR
 *
 * Same rule as the stuck-lock detector (CEO ruling on APP-91): this detects. It
 * does not redeploy, does not rewrite `RELEASE`, does not `chmod` anything. A
 * self-healing redeploy would install whatever is at the ref tip without anyone
 * reading the diff first, which converts a loud drift into a silent unreviewed
 * deploy. If automatic redeploy is ever worth having it needs its own approval.
 */

import { createHash } from 'node:crypto';
import { DEFAULT_DIFF_LINE_LIMIT, boundDiff, classifyStaleChange } from './launcher-diff-classify.mjs';

/**
 * Install-relative path -> source-repo path, for manifests that do not record
 * the mapping themselves.
 *
 * The step-1 install (APP-137) wrote `RELEASE` by hand and recorded only the
 * install-relative path, so the mapping back to the repo has to live somewhere.
 * APP-161's committed installer is expected to emit a fourth column carrying
 * `source_path` per file; `parseReleaseManifest` already reads it, and a
 * manifest that supplies it wins over this table. Treat this as a compatibility
 * shim for the hand-written manifest, not as the contract.
 *
 * An entry that is in neither place is reported as `unmapped` rather than
 * skipped — a file we cannot drift-check is exactly the silent non-coverage
 * this issue exists to end.
 */
export const FALLBACK_SOURCE_PATHS = Object.freeze({
  'bin/agent-launch.sh': 'scripts/agent-launch.sh',
  'bin/github-app-token.mjs': 'scripts/github-app-token.mjs',
  'bin/prune-agent-worktrees.sh': 'scripts/prune-agent-worktrees.sh',
  'bin/lib/github-app.mjs': 'scripts/lib/github-app.mjs',
  '.gitconfig-appforge': '.gitconfig-appforge',
  'config/github-apps.yaml': 'config/github-apps.yaml',
});

/**
 * Install-tree paths that are deliberately outside version control, and so can
 * never be drift-checked. `bin/node_modules/` holds the token minter's runtime
 * deps (gitignored) and `secrets/` holds the GitHub App private key, which is
 * in no commit by design. Anything else found in the install tree is reported.
 */
export const UNVERSIONED_PREFIXES = Object.freeze(['bin/node_modules/', 'secrets/']);

/** Files in the install tree that are the install's own bookkeeping, not payload. */
export const MANIFEST_FILENAME = 'RELEASE';

/** Finding kinds, ordered worst first. Drives both sort order and routing. */
export const FINDING_SEVERITY = Object.freeze({
  tampered: 'critical',
  missing: 'critical',
  manifest_mismatch: 'critical',
  stale: 'high',
  source_missing: 'high',
  source_removed: 'high',
  unmapped: 'high',
  unmanaged: 'medium',
});

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Install paths on the agent-launch path: read or exec'd by `agent-launch.sh`
 * on every single agent run, so a stale one is wrong for every agent from the
 * next launch onward. Everything else in the install tree is reached by the
 * hourly sweep instead.
 *
 * This is REPORTED, not scored. APP-260 argued the sweep-path files deserve a
 * lower severity than the launch-path ones, and the answer is no: APP-72 — the
 * blind spot this whole check was built for — was a stale *sweep* backstop, the
 * worktree prune, sitting inert for days. Downgrading sweep-path staleness would
 * reinstall the exact gap. The label goes in the report so the reader can judge
 * blast radius in place; it does not move the severity.
 *
 * `scripts/tests/launcher-drift.test.mjs` asserts this table against what
 * `agent-launch.sh` actually references, so it cannot quietly go stale.
 */
export const LAUNCH_PATH_INSTALL_PATHS = Object.freeze(new Set([
  // Exec'd or read directly by agent-launch.sh.
  'bin/agent-launch.sh',
  'bin/prune-agent-worktrees.sh', // line 145, the APP-72 backstop
  'bin/github-app-token.mjs',     // line 277, the token mint
  '.gitconfig-appforge',          // GIT_CONFIG_GLOBAL for every agent's git
  // Transitive dependencies of the token minter agent-launch.sh execs: a stale
  // one is just as wrong on every launch as a stale agent-launch.sh.
  'bin/lib/github-app.mjs',
  'config/github-apps.yaml',
  // The token minter's runtime deps come from `npm ci` against this lockfile at
  // install time, so a stale lockfile means launch runs against stale deps.
  'bin/package.json',
  'bin/package-lock.json',
]));

/** `launch-path` when a stale file is wrong for every agent launch, else `sweep-path`. */
export function blastRadiusFor(installPath) {
  return LAUNCH_PATH_INSTALL_PATHS.has(installPath) ? 'launch-path' : 'sweep-path';
}

/** Severities that get their own escalation issue rather than a note on the sweep's issue. */
export const ESCALATING_SEVERITIES = Object.freeze(new Set(['critical', 'high']));

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * `source_tree_state`, normalised. `unknown` covers two cases that must not be
 * read as `clean`: the hand-written step-1 manifest, which predates the field,
 * and a manifest carrying a value the installer never writes.
 *
 * Absence is not cleanliness. The report says `unknown` and means it.
 */
function parseTreeState(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'clean' || v === 'dirty' ? v : 'unknown';
}

/**
 * `source_dirty_paths` as an array of repo-relative paths. The installer writes
 * the literal `none` for a clean tree, which is zero paths, not a path named
 * "none".
 */
function parseDirtyPaths(raw) {
  const v = (raw ?? '').trim();
  if (v === '' || v.toLowerCase() === 'none') return [];
  return v.split(',').map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Parse `~/.appforge/RELEASE`.
 *
 * The format is a small `key: value` header followed by a `files:` block whose
 * entries are `<sha256>  <install-path>  <versioning>[  <source-path>]`. It is
 * intentionally not YAML: the installer writes it with shell, and a parser that
 * needs a dependency is a parser the sweep cannot run from a bare worktree.
 *
 * Unparseable input throws — a manifest we cannot read is a failure of the
 * check itself (exit 2), never a clean bill of health.
 */
export function parseReleaseManifest(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('RELEASE manifest is empty');

  const header = {};
  const files = [];
  let inFiles = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || line.trimStart().startsWith('#')) continue;

    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }

    if (inFiles && /^\s+/.test(line)) {
      const fields = line.trim().split(/\s+/);
      // The trailing "(bin/node_modules, secrets/) UNVERSIONED" prose line is
      // part of the hand-written manifest and is documentation, not an entry.
      if (!/^[0-9a-f]{64}$/.test(fields[0])) continue;
      const [digest, installPath, versioning, sourcePath] = fields;
      if (!installPath) throw new Error(`RELEASE file entry has no path: ${line.trim()}`);
      files.push({
        sha256: digest,
        installPath,
        versioned: (versioning ?? 'versioned').toLowerCase() === 'versioned',
        sourcePath: sourcePath ?? FALLBACK_SOURCE_PATHS[installPath] ?? null,
        sourcePathFrom: sourcePath ? 'manifest' : (FALLBACK_SOURCE_PATHS[installPath] ? 'fallback-table' : null),
      });
      continue;
    }

    inFiles = false;
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (match) header[match[1]] = match[2].trim();
  }

  for (const required of ['source_repo', 'source_ref', 'source_commit']) {
    if (!header[required]) throw new Error(`RELEASE manifest is missing \`${required}\``);
  }
  if (files.length === 0) throw new Error('RELEASE manifest lists no files');

  return {
    sourceRepo: header.source_repo,
    sourceRef: header.source_ref,
    sourceCommit: header.source_commit,
    sourceTreeState: parseTreeState(header.source_tree_state),
    sourceDirtyPaths: parseDirtyPaths(header.source_dirty_paths),
    installedAt: header.installed_at ?? null,
    installedByRun: header.installed_by_run ?? null,
    files,
  };
}

/** True for install-tree paths that are outside version control by design. */
export function isUnversionedPath(installPath) {
  return UNVERSIONED_PREFIXES.some((prefix) => installPath.startsWith(prefix));
}

function finding(kind, installPath, detail, extra = {}) {
  return { kind, severity: FINDING_SEVERITY[kind], installPath, detail, ...extra };
}

/**
 * Build the one finding whose severity is not fixed by its kind.
 *
 * `stale` starts at the `FINDING_SEVERITY` default of `high` and is lowered to
 * `low` only when the classifier can prove the delta is comments and whitespace.
 * Every other outcome — no diff supplied, an unknown file type, an unparseable
 * diff, a mixed change, changed string text — leaves it `high`. The finding is
 * always produced; classification adjusts severity and routing and can never
 * drop it (APP-261).
 */
function staleFinding(entry, manifest, { atCommit, atTip, refTipCommit, sourceDiffs, diffLineLimit, provenance }) {
  const supplied = sourceDiffs[entry.sourcePath] ?? null;
  const classification = supplied
    ? classifyStaleChange({
      sourcePath: entry.sourcePath,
      beforeText: supplied.beforeText,
      afterText: supplied.afterText,
      diffText: supplied.diffText,
    })
    : {
      verdict: 'unparseable',
      severity: FINDING_SEVERITY.stale,
      label: 'no diff was supplied, so it is treated as behavioural',
      reason: 'the caller produced no diff for this path; severity stays at the default',
      family: null,
    };

  const f = finding('stale', entry.installPath,
    `merged but not deployed — \`${entry.sourcePath}\` changed on \`${manifest.sourceRef}\` after the install commit, and the live file is still the old one.`,
    {
      sourcePath: entry.sourcePath,
      deployedDigest: atCommit,
      mergedDigest: atTip,
      sourceCommit: manifest.sourceCommit,
      refTipCommit,
      blastRadius: blastRadiusFor(entry.installPath),
      classification: {
        verdict: classification.verdict,
        label: classification.label,
        reason: classification.reason,
        family: classification.family,
      },
      diff: supplied ? boundDiff(supplied.diffText, diffLineLimit) : null,
    });

  f.severity = classification.severity;

  // A dirty path whose deployed bytes are in no commit makes the diff above a
  // description of a transition that did not happen, so it cannot be the
  // evidence for a downgrade. Pin to the `stale` default and say why in place.
  // Matching provenance, and a clean baseline, leave severity exactly as the
  // classifier set it — including `low`.
  if (provenance) {
    f.sourceProvenance = provenance;
    if (provenance.dirtyAtInstall && provenance.matchesInstallCommit === false) {
      f.severity = FINDING_SEVERITY.stale;
      f.classification = {
        ...f.classification,
        verdict: 'unverifiable-baseline',
        label: 'the deployed bytes are in no commit, so the diff below is not the real delta',
        reason: `\`${entry.sourcePath}\` was uncommitted at install time and the installed digest does not match the blob at \`${manifest.sourceCommit}\`, so \`${classification.verdict}\` was argued from the wrong baseline and cannot lower the severity`,
        family: classification.family,
      };
    }
  }
  return f;
}

/**
 * What the manifest's own dirty record implies for one versioned file.
 *
 * Returns null for a file that was not dirty at install under a manifest that
 * says so — there is nothing to qualify and nothing to print. Everything else
 * gets a verdict the report can state, including the `unknown` tree state, where
 * the honest answer is that the manifest does not say.
 */
function sourceProvenanceFor(entry, manifest, atCommit) {
  const state = manifest.sourceTreeState ?? 'unknown';
  const dirtyPaths = manifest.sourceDirtyPaths ?? [];
  const dirtyAtInstall = state === 'dirty' && dirtyPaths.includes(entry.sourcePath);
  if (!dirtyAtInstall && state !== 'unknown') return null;

  const matchesInstallCommit = atCommit === null ? null : atCommit === entry.sha256;
  return {
    treeState: state,
    dirtyAtInstall,
    matchesInstallCommit,
    installCommit: manifest.sourceCommit,
    note: describeProvenance(state, dirtyAtInstall, matchesInstallCommit),
  };
}

function describeProvenance(state, dirtyAtInstall, matchesInstallCommit) {
  if (dirtyAtInstall && matchesInstallCommit === true) {
    return 'this path was uncommitted in the source checkout at install time, but the installed digest equals the blob at the install commit, so the deployed bytes are the committed ones and the diff below is the real delta.';
  }
  if (dirtyAtInstall && matchesInstallCommit === false) {
    return 'this path was uncommitted at install time AND the installed digest does not match the blob at the install commit — the deployed bytes are in no commit, so the install commit does not describe what is installed.';
  }
  if (dirtyAtInstall) {
    return 'this path was uncommitted at install time and the blob at the install commit could not be read, so the deployed bytes cannot be traced to any commit.';
  }
  return 'the manifest does not record `source_tree_state`, so whether the source checkout was clean at install time is unknown — absence of the field is not evidence of a clean tree.';
}

/**
 * Compare the three views of every versioned file and return the findings.
 *
 * Inputs are all plain data so this stays testable without a git repo or an
 * install tree:
 *   - `manifest`        parsed `RELEASE`
 *   - `installDigests`  install path -> sha256 of the file on disk, or null if absent
 *   - `installExtras`   install-tree paths present on disk but not in the manifest
 *   - `commitDigests`   source path -> sha256 of the blob at `manifest.sourceCommit`
 *   - `refTipCommit`    the commit `manifest.sourceRef` resolves to now, or null
 *   - `refTipDigests`   source path -> sha256 of the blob at `refTipCommit`
 *   - `sourceDiffs`     source path -> `{ diffText, beforeText, afterText }` for
 *                       the install-commit..ref-tip delta, when the caller could
 *                       produce it. Absent or partial input is fine: a `stale`
 *                       finding with no diff stays `high`, which is the default
 *                       this classification only ever narrows downward from with
 *                       positive evidence.
 *
 * A null digest means "not present at that commit", which is a finding in its
 * own right and not the same as "unchanged".
 */
export function buildReport({
  manifest,
  installDigests = {},
  installExtras = [],
  commitDigests = {},
  refTipCommit = null,
  refTipDigests = {},
  sourceDiffs = {},
  diffLineLimit = DEFAULT_DIFF_LINE_LIMIT,
  installDir = null,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!manifest) throw new Error('buildReport requires a parsed manifest');

  const findings = [];
  const versioned = manifest.files.filter((f) => f.versioned);
  const behind = Boolean(refTipCommit) && refTipCommit !== manifest.sourceCommit;

  for (const entry of versioned) {
    const onDisk = installDigests[entry.installPath] ?? null;

    if (onDisk === null) {
      findings.push(finding('missing', entry.installPath,
        'listed in RELEASE but absent from the install tree — the launcher is running against an incomplete install.',
        { expected: entry.sha256 }));
    } else if (onDisk !== entry.sha256) {
      findings.push(finding('tampered', entry.installPath,
        'on-disk content does not match the digest RELEASE recorded at install time — the live file was edited after deploy.',
        { expected: entry.sha256, actual: onDisk }));
    }

    if (!entry.sourcePath) {
      findings.push(finding('unmapped', entry.installPath,
        'no source path in RELEASE and none in the fallback table, so this file cannot be compared against any commit. It is unmonitored.',
        {}));
      continue;
    }

    const atCommit = commitDigests[entry.sourcePath] ?? null;
    if (atCommit === null) {
      findings.push(finding('source_missing', entry.installPath,
        `\`${entry.sourcePath}\` does not exist at the recorded source commit, so the install cannot have come from it.`,
        { sourcePath: entry.sourcePath, sourceCommit: manifest.sourceCommit }));
      continue;
    }

    if (atCommit !== entry.sha256) {
      findings.push(finding('manifest_mismatch', entry.installPath,
        'the digest RELEASE records does not match the blob at the commit RELEASE names — the manifest describes an install that never happened, or was written by hand.',
        { sourcePath: entry.sourcePath, manifestDigest: entry.sha256, commitDigest: atCommit, sourceCommit: manifest.sourceCommit }));
    }

    if (!behind) continue;

    const atTip = refTipDigests[entry.sourcePath] ?? null;
    if (atTip === null) {
      findings.push(finding('source_removed', entry.installPath,
        `\`${entry.sourcePath}\` has been removed from \`${manifest.sourceRef}\` since the install, but the file is still live.`,
        { sourcePath: entry.sourcePath, refTipCommit }));
    } else if (atTip !== atCommit) {
      findings.push(staleFinding(entry, manifest, {
        atCommit, atTip, refTipCommit, sourceDiffs, diffLineLimit,
        provenance: sourceProvenanceFor(entry, manifest, atCommit),
      }));
    }
  }

  for (const extra of installExtras) {
    findings.push(finding('unmanaged', extra,
      'present in the install tree but in no RELEASE entry — it was added after deploy and is under no integrity check.'));
  }

  findings.sort((a, b) =>
    (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
    a.installPath.localeCompare(b.installPath));

  const worstSeverity = findings.length === 0 ? null : findings[0].severity;

  return {
    checkedAt,
    installDir,
    sourceRepo: manifest.sourceRepo,
    sourceRef: manifest.sourceRef,
    sourceCommit: manifest.sourceCommit,
    sourceTreeState: manifest.sourceTreeState ?? 'unknown',
    sourceDirtyPaths: manifest.sourceDirtyPaths ?? [],
    installedAt: manifest.installedAt,
    installedByRun: manifest.installedByRun,
    refTipCommit,
    behind,
    versionedCount: versioned.length,
    findings,
    worstSeverity,
    shouldEscalate: findings.some((f) => ESCALATING_SEVERITIES.has(f.severity)),
  };
}

/**
 * One machine-greppable line naming the commit the live launcher came from.
 *
 * This is APP-137 acceptance criterion 2 and it is printed on every run,
 * including clean ones. The do-nothing rule governs what the sweep *posts*, not
 * what it *logs*: a clean sweep still leaves the source commit in its run log,
 * so "which commit was production running at 14:00?" is answerable after the
 * fact without anybody having had to notice anything at the time. That question
 * being unanswerable is how APP-72 stayed invisible.
 */
export function renderProvenance(report) {
  const parts = [
    'launcher-release:',
    `source_commit=${report.sourceCommit}`,
    `source_ref=${report.sourceRef}`,
    `source_tree_state=${report.sourceTreeState ?? 'unknown'}`,
    `source_dirty_paths=${(report.sourceDirtyPaths ?? []).length}`,
    `ref_tip=${report.refTipCommit ?? 'unresolved'}`,
    `deploy=${report.behind ? 'BEHIND-REF-TIP' : 'at-ref-tip'}`,
    `installed_at=${report.installedAt ?? 'unknown'}`,
    `installed_by_run=${report.installedByRun ?? 'unknown'}`,
    `versioned_files=${report.versionedCount}`,
    `findings=${report.findings.length}`,
    `worst=${report.worstSeverity ?? 'none'}`,
    `escalate=${report.shouldEscalate ? 'yes' : 'no'}`,
  ];
  if (report.installDir) parts.push(`install_dir=${report.installDir}`);
  return parts.join(' ');
}

/**
 * The clause after the tree state in the report header.
 *
 * A dirty baseline is named with its paths because a reader judging a `stale`
 * finding has to know whether the install commit describes what is installed —
 * that is the whole of APP-263. A clean baseline gets nothing: the state word
 * already said it, and padding a clean report is how the loud parts get skipped.
 */
function renderDirtyBaseline(report) {
  const state = report.sourceTreeState ?? 'unknown';
  const paths = report.sourceDirtyPaths ?? [];
  if (state === 'clean') return ' — every versioned file traces to a commit.';
  if (state === 'unknown') {
    return ' — the manifest records no `source_tree_state`, so this is not a statement that the tree was clean.';
  }
  const listed = paths.length === 0
    ? 'no paths were recorded'
    : paths.map((p) => `\`${p}\``).join(', ');
  return ` — installed under \`--allow-dirty\` with uncommitted changes to ${listed}. Versioned files are still materialised from \`${report.sourceCommit}\` by \`git show\`, and any divergence would be reported above as \`manifest_mismatch\`; the dirty record is here so a \`stale\` verdict can be read against the baseline it was argued from.`;
}

const short = (sha) => (typeof sha === 'string' && sha.length > 12 ? sha.slice(0, 12) : (sha ?? 'unknown'));

/** Markdown report for the sweep to carry verbatim. Empty string when clean. */
export function renderReport(report) {
  if (report.findings.length === 0) return '';

  const lines = [
    `## Launcher drift detected — ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} across ${report.versionedCount} versioned file${report.versionedCount === 1 ? '' : 's'}`,
    '',
    `Checked at ${report.checkedAt}. Install \`${report.installDir ?? 'unknown'}\`, installed ${report.installedAt ?? 'at an unrecorded time'} by run \`${report.installedByRun ?? 'unknown'}\`.`,
    '',
    `- Live launcher was installed from \`${report.sourceCommit}\` (\`${report.sourceRef}\` in \`${report.sourceRepo}\`).`,
    `- \`${report.sourceRef}\` now points at \`${report.refTipCommit ?? 'unresolved'}\`${report.behind ? ' — **the deploy is behind the ref tip**.' : '.'}`,
    `- Source checkout at install time: **${report.sourceTreeState ?? 'unknown'}**${renderDirtyBaseline(report)}`,
    '',
  ];

  for (const f of report.findings) {
    lines.push(`### \`${f.installPath}\` — ${f.kind} (${f.severity})`);
    lines.push('');
    lines.push(`- ${f.detail}`);
    if (f.sourcePath) lines.push(`- Source path: \`${f.sourcePath}\``);
    if (f.blastRadius) {
      lines.push(f.blastRadius === 'launch-path'
        ? '- Blast radius: **launch path** — `agent-launch.sh` reads or execs this on every agent run, so a stale copy is wrong for every agent from the next launch.'
        : '- Blast radius: sweep path — reached by the hourly sweep, not by agent launch. Still a real inert control: APP-72 was a stale sweep backstop.');
    }
    if (f.classification) lines.push(`- Change: **${f.classification.verdict}** — ${f.classification.label}. ${f.classification.reason}.`.replace(/\.\.$/, '.'));
    if (f.sourceProvenance) {
      const bad = f.sourceProvenance.matchesInstallCommit !== true;
      lines.push(`- Install baseline: ${bad ? '**' : ''}${f.sourceProvenance.note}${bad ? '**' : ''}`);
    }
    if (f.expected) lines.push(`- Expected \`${f.expected}\`, found \`${f.actual ?? 'nothing'}\`.`);
    if (f.deployedDigest) lines.push(`- Deployed blob \`${f.deployedDigest}\`, merged blob \`${f.mergedDigest}\`.`);
    if (f.manifestDigest) lines.push(`- RELEASE says \`${f.manifestDigest}\`, commit has \`${f.commitDigest}\`.`);
    // The diff goes in the report so severity can be judged where it is read.
    // On APP-226 its absence cost a CEO ruling and a board approval to arrive at
    // "routine" (APP-261).
    if (f.diff && f.diff.text) {
      lines.push('');
      lines.push(`<details><summary>\`git diff ${short(f.sourceCommit)}..${short(f.refTipCommit)} -- ${f.sourcePath}\`${f.diff.truncated ? ` (first ${f.diff.shownLines} of ${f.diff.totalLines} lines)` : ''}</summary>`);
      lines.push('');
      lines.push('```diff');
      lines.push(f.diff.text);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }

  lines.push(report.shouldEscalate
    ? 'Routing: escalate — at least one finding is `critical` or `high`.'
    : 'Routing: note only — no finding rose above `medium`. Nothing here needs a CEO ruling.');
  const noted = report.findings.filter((f) => f.severity === 'low');
  if (noted.length > 0) {
    lines.push('');
    lines.push(`${noted.length} finding${noted.length === 1 ? '' : 's'} carried at \`low\` because the merged delta is comments and whitespace only, proven by comparing both revisions with comments stripped. Classification adjusts severity and routing only — it never drops a finding, and \`critical\` kinds (\`tampered\`, \`missing\`, \`manifest_mismatch\`) are not classified at all, because an unexplained hand-edit to the credential-bearing launcher tree is critical for being unexplained.`);
  }
  const unverifiable = report.findings.filter((f) => f.sourceProvenance?.matchesInstallCommit !== true && f.sourceProvenance);
  if (unverifiable.length > 0) {
    lines.push('');
    lines.push(`${unverifiable.length} finding${unverifiable.length === 1 ? '' : 's'} could not be traced to the install commit, so ${unverifiable.length === 1 ? 'its' : 'their'} merged diff is not the real delta and no comment-only downgrade was allowed to apply. Re-install from a clean checkout to make the install commit describe the install again.`);
  }
  lines.push('');
  lines.push('Detection only. Nothing was redeployed, rewritten, or reverted; remediation is a reviewed install from a named ref (APP-161), not an automatic action by this check.');
  return lines.join('\n');
}
