// launcher-git-read.mjs — history reads for the launcher-drift diff (APP-261).
//
// Split out of detect-launcher-drift.mjs so they can be exercised against a
// real git repository: that script runs main() on import. Both read history
// only, never the working tree, and both return null rather than throw — a
// read that fails leaves the classifier with `unavailable`, which is `high`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Text of a blob at a commit, or null when it cannot be read as text. */
export async function readBlobAtCommit(repo, commit, relPath) {
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
export async function diffBetweenCommits(repo, from, to, relPath) {
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
