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
 * NOT A REMEDIATOR
 *
 * Same rule as the stuck-lock detector (CEO ruling on APP-91): this detects. It
 * does not redeploy, does not rewrite `RELEASE`, does not `chmod` anything. A
 * self-healing redeploy would install whatever is at the ref tip without anyone
 * reading the diff first, which converts a loud drift into a silent unreviewed
 * deploy. If automatic redeploy is ever worth having it needs its own approval.
 */

import { createHash } from 'node:crypto';
import { classifyChange } from './launcher-diff-classify.mjs';

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
 * Install paths `agent-launch.sh` execs or reads on every agent launch.
 *
 * Reported alongside each finding as blast-radius context. It deliberately
 * does NOT move severity. A sweep script that stops recovering paused agents
 * is a real failure with a real cost, and demoting it because it cannot abort
 * a launch would open a second blind spot next to the one APP-261 closes.
 * Context for the reader, nothing more.
 */
export const LAUNCH_PATH_INSTALL_PATHS = Object.freeze(new Set([
  'bin/agent-launch.sh',
  'bin/prune-agent-worktrees.sh',
  'bin/github-app-token.mjs',
  'bin/lib/github-app.mjs',
  'bin/package.json',
  'bin/package-lock.json',
  'config/github-apps.yaml',
  '.gitconfig-appforge',
]));

/**
 * Diff lines carried per `stale` finding before truncation.
 *
 * The point of the diff is that severity can be judged in place; the point of
 * the bound is that one large merge cannot turn the sweep's comment into a
 * wall nobody reads. Past the bound the report says how many lines it dropped
 * and names the `git diff` that prints the rest.
 */
export const MAX_DIFF_LINES = 80;

/** Severities that get their own escalation issue rather than a note on the sweep's issue. */
export const ESCALATING_SEVERITIES = Object.freeze(new Set(['critical', 'high']));

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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
  return {
    kind,
    severity: FINDING_SEVERITY[kind],
    installPath,
    launchPath: LAUNCH_PATH_INSTALL_PATHS.has(installPath),
    detail,
    ...extra,
  };
}

/** Bound a unified diff for display, keeping the head and saying what was cut. */
export function boundDiff(diffText, max = MAX_DIFF_LINES) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return { diffHunks: null, diffLineCount: 0, diffTruncated: false };
  }
  // The two `diff --git` / `index` preamble lines carry no content and eat
  // budget; the `---`/`+++` pair is kept because it names both revisions.
  const lines = diffText.replace(/\n$/, '').split('\n')
    .filter((line) => !line.startsWith('diff --git ') && !line.startsWith('index '));
  if (lines.length <= max) {
    return { diffHunks: lines.join('\n'), diffLineCount: lines.length, diffTruncated: false };
  }
  return {
    diffHunks: lines.slice(0, max).join('\n'),
    diffLineCount: lines.length,
    diffTruncated: true,
  };
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
 *   - `diffs`           source path -> `{ diffText, before, after }` between the
 *                       two commits, used to carry the hunks in the report and
 *                       to classify a `stale` change (APP-261). An absent or
 *                       incomplete entry classifies as `unavailable`, which is
 *                       behavioural, which stays `high`.
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
  diffs = {},
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
      // APP-261. Any content change used to be `high` and go to the CEO, with
      // blob hashes and no diff, so a comment edit and a silently-inert safety
      // control arrived looking the same. The classifier decides severity and
      // routing only — it can never make the finding go away — and everything
      // it cannot rule out stays `high`.
      const delta = diffs[entry.sourcePath] ?? {};
      const classified = classifyChange({
        sourcePath: entry.sourcePath,
        before: delta.before,
        after: delta.after,
        diffText: delta.diffText,
      });
      const bounded = boundDiff(delta.diffText);
      const stale = finding('stale', entry.installPath,
        `merged but not deployed — \`${entry.sourcePath}\` changed on \`${manifest.sourceRef}\` after the install commit, and the live file is still the old one.`,
        {
          sourcePath: entry.sourcePath,
          deployedDigest: atCommit,
          mergedDigest: atTip,
          sourceCommit: manifest.sourceCommit,
          refTipCommit,
          classification: classified.classification,
          behavioural: classified.behavioural,
          classificationLabel: classified.label,
          classificationNote: classified.note,
          ...bounded,
        });
      if (!classified.behavioural) stale.severity = 'low';
      findings.push(stale);
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
    `ref_tip=${report.refTipCommit ?? 'unresolved'}`,
    `deploy=${report.behind ? 'BEHIND-REF-TIP' : 'at-ref-tip'}`,
    `installed_at=${report.installedAt ?? 'unknown'}`,
    `installed_by_run=${report.installedByRun ?? 'unknown'}`,
    `versioned_files=${report.versionedCount}`,
    `findings=${report.findings.length}`,
  ];
  if (report.installDir) parts.push(`install_dir=${report.installDir}`);
  return parts.join(' ');
}

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
    '',
  ];

  for (const f of report.findings) {
    lines.push(`### \`${f.installPath}\` — ${f.kind} (${f.severity})`);
    lines.push('');
    lines.push(`- ${f.detail}`);
    if (f.sourcePath) lines.push(`- Source path: \`${f.sourcePath}\``);
    lines.push(f.launchPath
      ? '- Launch path: this file is exec\'d or read by `agent-launch.sh` on every agent launch.'
      : '- Launch path: no — this file is not read at agent launch.');
    if (f.expected) lines.push(`- Expected \`${f.expected}\`, found \`${f.actual ?? 'nothing'}\`.`);
    if (f.deployedDigest) lines.push(`- Deployed blob \`${f.deployedDigest}\`, merged blob \`${f.mergedDigest}\`.`);
    if (f.manifestDigest) lines.push(`- RELEASE says \`${f.manifestDigest}\`, commit has \`${f.commitDigest}\`.`);

    // APP-261: for a `stale` finding the diff is the evidence. Without it the
    // reader has two hashes and has to go and run the diff by hand, which is
    // what turned a five-line advice string into a CEO escalation on APP-226.
    if (f.kind === 'stale') {
      lines.push(`- Change: **${f.classificationLabel}** (\`${f.classification}\`) — ${f.classificationNote}`);
      lines.push(f.behavioural
        ? '- Severity: `high` — a behavioural change to a versioned launcher file that production is not running.'
        : '- Severity: lowered `high` -> `low` by the diff classifier. Routed as a note, not an escalation. The finding stands; only its severity moved.');
      lines.push('');
      if (f.diffHunks) {
        lines.push('```diff');
        lines.push(f.diffHunks);
        lines.push('```');
        if (f.diffTruncated) {
          lines.push(`_Truncated at ${MAX_DIFF_LINES} of ${f.diffLineCount} lines. Full diff:_ \`git -C ${report.sourceRepo} diff ${f.sourceCommit}..${f.refTipCommit} -- ${f.sourcePath}\``);
        }
      } else {
        lines.push(`_No diff available._ Run \`git -C ${report.sourceRepo} diff ${f.sourceCommit}..${f.refTipCommit} -- ${f.sourcePath}\` by hand; the classifier had nothing to read, which is why this stayed \`high\`.`);
      }
    }
    lines.push('');
  }

  lines.push(report.shouldEscalate
    ? 'Routing: escalate — at least one finding is `critical` or `high`.'
    : `Routing: note only — no finding rose above \`${report.worstSeverity}\`.`);
  if (report.findings.some((f) => f.kind === 'stale' && !f.behavioural)) {
    lines.push('');
    lines.push('A `stale` finding shown as `low` was classified non-behavioural from the diff above (APP-261). It is still real drift and production is still running the old file; it does not warrant a CEO escalation on its own. If the classifier looks wrong, the hunks are right there — say so, and the rule gets fixed rather than trusted.');
  }
  lines.push('');
  lines.push('Detection only. Nothing was redeployed, rewritten, or reverted; remediation is a reviewed install from a named ref (APP-161), not an automatic action by this check.');
  return lines.join('\n');
}
