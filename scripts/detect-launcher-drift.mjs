#!/usr/bin/env node
// detect-launcher-drift.mjs — APP-162 (child of APP-137).
//
// Compares the live agent launcher in ~/.appforge against the RELEASE manifest
// it was installed with, and against the commit that manifest names. Answers
// the two questions APP-137 left open after step 1 moved the launcher out of
// the shared checkout:
//
//   Was the live file edited after deploy?          (manifest vs disk)
//   Has the ref moved on without a redeploy?        (install commit vs ref tip)
//
// The second is the APP-72 case: the worktree-prune backstop sat merged on
// `main` and inert in production for days, and the only reason anyone found out
// was a human noticing. This is the instrument for that.
//
// A `stale` finding carries the diff that produced it and a behavioural /
// non-behavioural classification (APP-261). A comment-only change is reported
// as `low` and routed as a note; everything the classifier cannot rule out
// stays `high`. It never suppresses a finding, and `tampered` / `missing` /
// `manifest_mismatch` stay `critical` whatever the delta looks like.
//
// Exit 0 = no drift; the provenance line is still printed (that is APP-137
//          criterion 2 — the source commit belongs in every run log, clean or
//          not). The sweep posts nothing on 0; the do-nothing rule applies.
// Exit 1 = drift found; stdout is the report, to be carried verbatim.
// Exit 2 = the check itself could not run. NOT a clean bill of health.
//
// ALARM, DO NOT BLOCK. This script must never be called from agent-launch.sh.
// A launch-time integrity gate that fails takes every agent run down with it —
// the exact APP-132 availability failure, where one transient GitHub mint
// failure killed 25 runs. The sweep is the only sanctioned caller.
//
// Read-only. It hashes files, runs `git cat-file`/`rev-parse`/`fetch`, and
// writes nothing. `git fetch` only moves remote-tracking refs, so it is safe
// against the shared checkout; there is no checkout, no branch switch, no
// working-tree read. Pass --no-fetch to skip it, but be aware that a stale
// local `origin/main` silently defeats the stale-deploy check, which is the
// whole point of the script.
//
// Usage:
//   node scripts/detect-launcher-drift.mjs
//   node scripts/detect-launcher-drift.mjs --json
//   node scripts/detect-launcher-drift.mjs --install-dir /tmp/fixture --no-fetch
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  MANIFEST_FILENAME,
  buildReport,
  isUnversionedPath,
  parseReleaseManifest,
  renderProvenance,
  renderReport,
  sha256,
} from './lib/launcher-drift.mjs';

const run = promisify(execFile);

function parseArgs(argv) {
  const args = { json: false, fetch: true, installDir: path.join(homedir(), '.appforge'), sourceRepo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--no-fetch') args.fetch = false;
    else if (arg === '--install-dir') args.installDir = argv[++i];
    else if (arg === '--source-repo') args.sourceRepo = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.installDir) throw new Error('--install-dir requires a path');
  return args;
}

/** sha256 of a file, or null when it is not there. Any other error propagates. */
async function digestFile(absPath) {
  try {
    return sha256(await readFile(absPath));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Every file under `dir`, as install-relative posix paths. */
async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (isUnversionedPath(`${rel}/`)) continue;
      out.push(...await walk(abs, base));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (isUnversionedPath(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

/**
 * sha256 of a blob at a commit, or null when the path is not in that tree.
 *
 * `git cat-file blob <commit>:<path>` reads history only — it never consults
 * the working tree, so this is safe to point at the shared checkout no matter
 * which branch another agent has left it on.
 */
async function digestAtCommit(repo, commit, relPath) {
  try {
    const { stdout } = await run('git', ['-C', repo, 'cat-file', 'blob', `${commit}:${relPath}`], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    return sha256(stdout);
  } catch {
    return null;
  }
}

/** Text of a blob at a commit, or null when it cannot be read as text. */
async function readBlobAtCommit(repo, commit, relPath) {
  try {
    const { stdout } = await run('git', ['-C', repo, 'cat-file', 'blob', `${commit}:${relPath}`], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    // A blob with a NUL byte is binary; there is nothing to classify and
    // nothing readable to put in the report, so the caller gets `unavailable`
    // and the finding keeps its `high`.
    if (stdout.includes(0)) return null;
    return stdout.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Unified diff of one path between two commits (APP-261).
 *
 * `git diff <a>..<b> -- <path>` reads history only, never the working tree,
 * so this keeps the same shared-checkout safety the digest reads have. A
 * failure returns null rather than throwing: a diff we cannot take is a
 * classification we cannot make, which the classifier already answers with
 * `unavailable` and therefore `high`.
 */
async function diffBetweenCommits(repo, from, to, relPath) {
  try {
    const { stdout } = await run(
      'git',
      ['-C', repo, 'diff', '--no-color', '--no-ext-diff', `${from}..${to}`, '--', relPath],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

async function resolveCommit(repo, ref) {
  try {
    const { stdout } = await run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifestPath = path.join(args.installDir, MANIFEST_FILENAME);
  let manifest;
  try {
    manifest = parseReleaseManifest(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the install manifest at ${manifestPath}: ${err.message}`);
  }

  const sourceRepo = args.sourceRepo ?? manifest.sourceRepo;
  const repoStat = await stat(path.join(sourceRepo, '.git')).catch(() => null);
  if (!repoStat) throw new Error(`source repo ${sourceRepo} is not a git repository`);

  // A stale remote-tracking ref makes a stale deploy look current, so fetch
  // before resolving the tip. Fetch touches refs only, never the working tree.
  if (args.fetch) {
    try {
      await run('git', ['-C', sourceRepo, 'fetch', '--quiet', 'origin'], { timeout: 60_000 });
    } catch (err) {
      throw new Error(`git fetch failed, so the ref tip cannot be trusted: ${err.message}`);
    }
  }

  const installDigests = {};
  for (const entry of manifest.files) {
    installDigests[entry.installPath] = await digestFile(path.join(args.installDir, entry.installPath));
  }

  const known = new Set([...manifest.files.map((f) => f.installPath), MANIFEST_FILENAME]);
  const installExtras = (await walk(args.installDir)).filter((rel) => !known.has(rel));

  const refTipCommit = await resolveCommit(sourceRepo, manifest.sourceRef);
  if (!refTipCommit) throw new Error(`cannot resolve \`${manifest.sourceRef}\` in ${sourceRepo}`);

  const commitDigests = {};
  const refTipDigests = {};
  for (const entry of manifest.files) {
    if (!entry.sourcePath) continue;
    commitDigests[entry.sourcePath] = await digestAtCommit(sourceRepo, manifest.sourceCommit, entry.sourcePath);
    refTipDigests[entry.sourcePath] = await digestAtCommit(sourceRepo, refTipCommit, entry.sourcePath);
  }

  // Only the paths that actually moved need a diff; taking one per versioned
  // file on every sweep would spend eleven `git diff` calls to learn nothing.
  const diffs = {};
  if (refTipCommit !== manifest.sourceCommit) {
    for (const entry of manifest.files) {
      if (!entry.versioned || !entry.sourcePath) continue;
      const atCommit = commitDigests[entry.sourcePath];
      const atTip = refTipDigests[entry.sourcePath];
      if (!atCommit || !atTip || atCommit === atTip) continue;
      diffs[entry.sourcePath] = {
        diffText: await diffBetweenCommits(sourceRepo, manifest.sourceCommit, refTipCommit, entry.sourcePath),
        before: await readBlobAtCommit(sourceRepo, manifest.sourceCommit, entry.sourcePath),
        after: await readBlobAtCommit(sourceRepo, refTipCommit, entry.sourcePath),
      };
    }
  }

  const report = buildReport({
    manifest,
    installDigests,
    installExtras,
    commitDigests,
    refTipCommit,
    refTipDigests,
    diffs,
    installDir: args.installDir,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? 0 : 1;
  }

  // Provenance goes to stderr so that stdout stays exactly the report the sweep
  // carries verbatim, and stays empty on a clean run. Both streams land in the
  // run log, which is what criterion 2 asks for.
  process.stderr.write(`${renderProvenance(report)}\n`);
  if (report.findings.length === 0) return 0;
  process.stdout.write(`${renderReport(report)}\n`);
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`launcher drift check failed: ${err.message}\n`);
    process.stderr.write('This is NOT a clean result — the check could not run.\n');
    process.exitCode = 2;
  },
);
