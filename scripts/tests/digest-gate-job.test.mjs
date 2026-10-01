import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOB = join(HERE, '..', '..', 'infra', 'macos', 'digest-gate.sh');
// Same hermetic git identity as play-vitals-job.test.mjs (APP-223).
const FIXTURE_GITCONFIG = join(HERE, 'fixtures', 'gitconfig-fixture-identity');
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, ...FIXTURE_GIT_ENV } });

/** A throwaway repo whose scripts/metrics-digest.mjs is a stub exiting `gateExit`, plus a fake curl that records URLs. */
function fixture({ gateExit }) {
  const root = mkdtempSync(join(tmpdir(), 'dg-job-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'clone', '-q', origin, repo);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'metrics-digest.mjs'), `console.log('stub digest'); process.exit(${gateExit});\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'stub'); git(repo, 'push', '-q', 'origin', 'HEAD:main');
  mkdirSync(join(repo, 'scripts', 'node_modules'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const posts = join(root, 'posts.log');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" >> "${posts}";; esac; done\nexit 0\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  const env = {
    ...FIXTURE_GIT_ENV, PATH: `${bin}:${process.env.PATH}`, HOME: root, APPFORGE_REPO: repo, APPFORGE_NODE: process.execPath,
    PAPERCLIP_API_URL: 'http://127.0.0.1:1', PAPERCLIP_COMPANY_ID: 'co-1', NTFY_TOPIC: 'test-topic',
  };
  return { root, env, posts };
}

const run = (env, ...args) => spawnSync('bash', [JOB, ...args], { env, encoding: 'utf8' });

/** A git wrapper on PATH that refuses `fetch` unless the scoped-token header is present, like a private GitHub repo. */
function privateOrigin(f, minterScript) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const gbin = join(f.root, 'gbin'); mkdirSync(gbin);
  const want = `AUTHORIZATION: basic ${Buffer.from('x-access-token:SECRET-TOKEN-VALUE').toString('base64')}`;
  writeFileSync(join(gbin, 'git'), `#!/bin/sh
for a in "$@"; do if [ "$a" = fetch ] && [ "\${GIT_CONFIG_VALUE_0:-}" != "${want}" ]; then echo "remote: Repository not found." >&2; exit 128; fi; done
exec "${realGit}" "$@"\n`);
  chmodSync(join(gbin, 'git'), 0o755);
  const argsLog = join(f.root, 'minter.args');
  const minter = join(f.root, 'minter.sh');
  writeFileSync(minter, minterScript(argsLog));
  chmodSync(minter, 0o755);
  return { env: { ...f.env, PATH: `${gbin}:${f.env.PATH}`, FETCH_ORIGIN_TOKEN_CMD: minter }, argsLog };
}

// The passing cases use --dry-run on a firing day: the full fetch -> worktree -> digest path runs and exits 0, with no POST.
test('a public origin is fetched anonymously and the gate runs', () => {
  const f = fixture({ gateExit: 0 });
  const r = run(f.env, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /FIRE stub digest/);
  assert.equal(existsSync(f.posts), false);
});

test('a private origin is fetched with a repo-scoped token and the gate runs; the token is never printed', () => {
  const f = fixture({ gateExit: 0 });
  const p = privateOrigin(f, (log) => `#!/bin/sh\necho "$@" >> "${log}"\necho '{"token":"SECRET-TOKEN-VALUE"}'\n`);
  const r = run(p.env, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /FIRE stub digest/, 'the gate ran past the fetch');
  assert.equal(readFileSync(p.argsLog, 'utf8').trim(), '--repos origin', 'the token is scoped to exactly this repo');
  assert.ok(!(r.stdout + r.stderr).includes('SECRET-TOKEN-VALUE'), 'the token must never appear in output');
});

test('a private origin with no usable token fails loudly: the gate did not run', () => {
  const f = fixture({ gateExit: 0 });
  const p = privateOrigin(f, () => '#!/bin/sh\nexit 1\n');
  const r = run(p.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL git fetch/);
  assert.doesNotMatch(r.stdout, /FIRE|quiet/, 'the digest never ran');
  const posts = readFileSync(f.posts, 'utf8');
  assert.match(posts, /ntfy\.sh/);
  assert.doesNotMatch(posts, /\/api\/routines\//, 'Analyst was not woken');
});

// APP-314: the header contract says 20 is a silent success. A non-zero exit here would make launchd record a failure
// every quiet day, so a broken gate and a quiet one would look the same in `launchctl print`.
test('a quiet day (gate exit 20) exits 0 and posts nothing', () => {
  const f = fixture({ gateExit: 20 });
  const r = run(f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /quiet stub digest/);
  assert.equal(existsSync(f.posts), false, 'no routine POST and no ntfy page');
});
