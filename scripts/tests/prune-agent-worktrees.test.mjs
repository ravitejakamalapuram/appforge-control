import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRUNE = path.join(here, '..', 'prune-agent-worktrees.sh');
const LAUNCH = path.join(here, '..', 'agent-launch.sh');

// Fixture identity lives in a file this suite owns, never in each fixture's own
// .git/config: a host agent rewrites that file underneath a fresh repo and can
// drop a value we just wrote (APP-223). GIT_CONFIG_SYSTEM and GIT_CONFIG_COUNT
// are neutralised so nothing ambient reaches a fixture either - the launcher
// exports GIT_CONFIG_KEY/VALUE pairs (credential helper, GitHub auth header)
// that have no business in a hermetic local repo.
const FIXTURE_GITCONFIG = path.join(here, 'fixtures', 'gitconfig-fixture-identity');
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
};

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...FIXTURE_GIT_ENV } });

/**
 * `rm -rf` that tolerates a third party writing into the tree as we remove it.
 * The host agent described in fixtures/gitconfig-fixture-identity injects its
 * `[include]` stanza into a new repo's .git/config asynchronously, so it can
 * re-create an entry under .git/ after rmSync has already walked past it -
 * which surfaces as ENOTEMPTY out of cleanup rather than out of anything the
 * test asserts. maxRetries is Node's documented remedy for exactly that class
 * (EBUSY/ENOTEMPTY/EPERM), and it guards teardown only: no assertion depends on
 * it, so it cannot mask a real failure. (APP-223)
 */
const rmTree = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** A repo root holding one real git repo with one commit. */
function makeRoot(repoName = 'demo') {
  const root = mkdtempSync(path.join(tmpdir(), 'appforge-prune-test-'));
  const repo = path.join(root, repoName);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'seed');
  return { root, repo };
}

/** Runs the prune script; returns its exit code (it must always be 0). */
function prune(root, repos) {
  const res = execFileSync('bash', [PRUNE, repos], {
    encoding: 'utf8',
    env: { ...process.env, APPFORGE_REPO_ROOT: root },
  });
  return res;
}

const worktreeDirs = (repo) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));

test('prunes the metadata of a worktree whose directory is gone', () => {
  const { root, repo } = makeRoot();
  try {
    const gone = path.join(root, 'scratch-gone');
    git(repo, 'worktree', 'add', '--detach', gone, 'HEAD');
    assert.equal(worktreeDirs(repo).length, 2);

    // Simulate Paperclip deleting $PAPERCLIP_RUN_SCRATCH_DIR when a run ends
    // without the run having called `worktree remove`.
    rmTree(gone);
    assert.equal(worktreeDirs(repo).length, 2, 'stale entry should still be listed before pruning');

    prune(root, 'demo');
    assert.equal(worktreeDirs(repo).length, 1, 'stale entry should be pruned');
  } finally {
    rmTree(root);
  }
});

test('leaves a live concurrent worktree alone', () => {
  const { root, repo } = makeRoot();
  try {
    const live = path.join(root, 'scratch-live');
    git(repo, 'worktree', 'add', '--detach', live, 'HEAD');

    prune(root, 'demo');

    assert.ok(existsSync(live), 'live worktree directory must survive');
    assert.ok(
      worktreeDirs(repo).some((d) => d.endsWith('scratch-live')),
      'live worktree metadata must survive - another agent may be mid-run in it'
    );
  } finally {
    rmTree(root);
  }
});

test('prunes every repo in a comma-separated list', () => {
  const a = makeRoot('alpha');
  const root = a.root;
  try {
    const b = path.join(root, 'beta');
    mkdirSync(b);
    git(b, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(b, 'f.txt'), 'x\n');
    git(b, 'add', 'f.txt');
    git(b, 'commit', '-q', '-m', 'seed');

    for (const [repo, name] of [[a.repo, 'wt-a'], [b, 'wt-b']]) {
      const d = path.join(root, name);
      git(repo, 'worktree', 'add', '--detach', d, 'HEAD');
      rmTree(d);
    }

    prune(root, 'alpha,beta');

    assert.equal(worktreeDirs(a.repo).length, 1);
    assert.equal(worktreeDirs(b).length, 1);
  } finally {
    rmTree(root);
  }
});

test('the literal repo scope `none` prunes nothing and exits 0', () => {
  const { root, repo } = makeRoot();
  try {
    const gone = path.join(root, 'scratch-gone');
    git(repo, 'worktree', 'add', '--detach', gone, 'HEAD');
    rmTree(gone);

    prune(root, 'none');

    assert.equal(worktreeDirs(repo).length, 2, '`none` means no repo scope - touch nothing');
  } finally {
    rmTree(root);
  }
});

test('an empty repo scope exits 0 without touching anything', () => {
  const { root } = makeRoot();
  try {
    assert.doesNotThrow(() => prune(root, ''));
  } finally {
    rmTree(root);
  }
});

test('a missing repo, a non-git directory and a bare name never fail the launch', () => {
  const { root } = makeRoot();
  try {
    mkdirSync(path.join(root, 'notarepo'));
    // `absent` does not exist at all; `notarepo` has no .git. Both must be
    // skipped silently - this script runs on the launch path of every agent.
    assert.doesNotThrow(() => prune(root, 'absent,notarepo,demo'));
  } finally {
    rmTree(root);
  }
});

// The launch-path wiring. agent-launch.sh cannot be run end-to-end here because
// its next step reads the founder's real gh token, so this asserts the
// call site's presence and position in the source instead - the position is the
// part that matters, since a prune placed after the token lookup would not run for
// an agent whose scope is `none`.
test('agent-launch.sh invokes the prune backstop before reading the gh token', () => {
  const src = execFileSync('cat', [LAUNCH], { encoding: 'utf8' });
  const call = src.indexOf('"$SCRIPT_DIR/prune-agent-worktrees.sh" "$APPFORGE_AGENT_REPOS"');
  const scopeCheck = src.indexOf('APPFORGE_AGENT_REPOS is not set');
  const mint = src.indexOf('gh auth token');

  assert.ok(call > 0, 'agent-launch.sh must call prune-agent-worktrees.sh');
  assert.ok(call > scopeCheck, 'prune must run after the repo-scope validation');
  assert.ok(call < mint, 'prune must run before the token lookup, so it also covers a `none` scope');
  assert.match(src.slice(call, call + 200), /\|\| true/, 'prune must never be able to block a launch');
});
