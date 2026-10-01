import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOB = join(HERE, '..', '..', 'infra', 'macos', 'play-vitals.sh');
// Fixture git identity and isolation (APP-223): the identity comes from a file no repo writes to, and nothing
// ambient (the launcher's GIT_CONFIG_KEY_n pairs, system config) reaches a hermetic local repo.
const FIXTURE_GITCONFIG = join(HERE, 'fixtures', 'gitconfig-fixture-identity');
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: FIXTURE_GITCONFIG,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, ...FIXTURE_GIT_ENV } });

/** A throwaway repo whose scripts/play-vitals.mjs is a stub, plus a fake curl that records the POST body. */
function fixture({ stubExit, stubJson, importExit = 0, importMsg = 'ok' }) {
  const root = mkdtempSync(join(tmpdir(), 'pv-job-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'clone', '-q', origin, repo);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'play-vitals.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('data/metrics/raw', { recursive: true });
writeFileSync('data/metrics/raw/play-vitals-com.example.app-2026-09-28.json', '{}');
console.log(${JSON.stringify(JSON.stringify(stubJson))}); process.exit(${stubExit});\n`);
  writeFileSync(join(repo, 'scripts', 'metrics-import.mjs'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(root, 'import.args'))}, process.argv.slice(2).join(' ') + '\\n');
console.log(${JSON.stringify(importMsg)}); process.exit(${importExit});\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'stub'); git(repo, 'push', '-q', 'origin', 'HEAD:main');
  mkdirSync(join(repo, 'scripts', 'node_modules'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const posts = join(root, 'posts.log');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) url="$a";; esac; done\necho "$url" >> "${posts}"\ncat /dev/stdin >/dev/null 2>&1 || true\nfor a in "$@"; do echo "$a" >> "${posts}.args"; done\nexit 0\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  const key = join(root, 'key.json'); writeFileSync(key, '{}');
  const env = {
    ...FIXTURE_GIT_ENV, PATH: `${bin}:${process.env.PATH}`, HOME: root, APPFORGE_REPO: repo, APPFORGE_NODE: process.execPath,
    APPFORGE_STATE_DIR: join(root, 'state'), PLAY_SA_KEY_FILE: key,
    PAPERCLIP_API_URL: 'http://127.0.0.1:1', PAPERCLIP_COMPANY_ID: 'co-1', PLAY_VITALS_PACKAGES: 'com.example.app',
    NTFY_TOPIC: 'test-topic', PLAY_VITALS_ITEMS: 'com.example.app=exampleitem',
  };
  return { root, repo, env, posts, importArgs: join(root, 'import.args') };
}

const run = (env, ...args) => spawnSync('bash', [JOB, ...args], { env, encoding: 'utf8' });

test('an alert opens exactly one Paperclip issue for the window and pushes a notification', () => {
  const f = fixture({ stubExit: 1, stubJson: { window: { end: '2026-09-28' }, crash: { reasons: ['crash 2.00% over threshold'] }, anr: { reasons: [] } } });
  const r = run(f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALERT com.example.app window_end=2026-09-28/);
  const posts = readFileSync(f.posts, 'utf8');
  assert.match(posts, /ntfy\.sh\/test-topic/, 'notification sent');
  assert.match(posts, /\/api\/companies\/co-1\/issues/, 'issue opened');
  // second run for the same window must not open another issue
  const before = readFileSync(f.posts, 'utf8').split('\n').filter((l) => l.includes('/issues')).length;
  run(f.env);
  const after = readFileSync(f.posts, 'utf8').split('\n').filter((l) => l.includes('/issues')).length;
  assert.equal(after, before, 'same window is not alerted twice');
});

test('insufficient data is logged quietly: no issue, no notification, exit 0', () => {
  const f = fixture({ stubExit: 3, stubJson: { window: { end: '2026-09-28' } } });
  const r = run(f.env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /insufficient_data/);
  assert.equal(existsSync(f.posts), false, 'nothing was POSTed');
});

test('a failed check is loud: notification sent and non-zero exit, never a quiet day', () => {
  const f = fixture({ stubExit: 2, stubJson: {} });
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL com.example.app check failed/);
  assert.match(readFileSync(f.posts, 'utf8'), /ntfy\.sh/);
});

test('missing configuration fails loudly instead of running', () => {
  const f = fixture({ stubExit: 0, stubJson: {} });
  delete f.env.PLAY_SA_KEY_FILE;
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PLAY_SA_KEY_FILE is not set/);
});

test('dry-run calls nothing and opens nothing', () => {
  const f = fixture({ stubExit: 1, stubJson: { window: { end: 'x' }, crash: { reasons: ['r'] }, anr: { reasons: [] } } });
  const r = run(f.env, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(f.posts), false);
});

test('a successful run is imported into the manifest under the mapped item id', () => {
  const f = fixture({ stubExit: 0, stubJson: { window: { end: '2026-09-28' } } });
  const r = run(f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /imported com.example.app into the manifest as exampleitem/);
  const args = readFileSync(f.importArgs, 'utf8');
  assert.match(args, /--source play_vitals --item exampleitem --file .*play-vitals-com\.example\.app-2026-09-28\.json --data-root /);
});

test('insufficient data is still imported (the series is the point), quietly', () => {
  const f = fixture({ stubExit: 3, stubJson: { window: { end: '2026-09-28' } } });
  const r = run(f.env);
  assert.equal(r.status, 0);
  assert.match(readFileSync(f.importArgs, 'utf8'), /--item exampleitem/);
});

test('an empty Play window is a quiet "not yet", never a failure and never a zero', () => {
  const f = fixture({ stubExit: 3, stubJson: {}, importExit: 1, importMsg: 'play_vitals: Play returned no crash or ANR rows for com.example.app in 2026-09-15..2026-09-28; nothing imported' });
  const r = run(f.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no vitals rows yet/);
  assert.equal(existsSync(f.posts), false, 'no notification for an expected empty window');
});

test('any other import failure is loud', () => {
  const f = fixture({ stubExit: 0, stubJson: {}, importExit: 1, importMsg: 'play_vitals: file is not a play-vitals run' });
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL manifest import/);
  assert.match(readFileSync(f.posts, 'utf8'), /ntfy\.sh/);
});

test('a failed check does not attempt an import', () => {
  const f = fixture({ stubExit: 2, stubJson: {} });
  run(f.env);
  assert.equal(existsSync(f.importArgs), false);
});

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

test('a private origin is fetched with a repo-scoped token and the check runs; the token is never printed', () => {
  const f = fixture({ stubExit: 3, stubJson: { window: { end: '2026-09-28' } } });
  const p = privateOrigin(f, (log) => `#!/bin/sh\necho "$@" >> "${log}"\necho '{"token":"SECRET-TOKEN-VALUE"}'\n`);
  const r = run(p.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /insufficient_data com.example.app/, 'the check ran past the fetch');
  assert.equal(readFileSync(p.argsLog, 'utf8').trim(), '--repos origin', 'the token is scoped to exactly this repo');
  assert.ok(!(r.stdout + r.stderr).includes('SECRET-TOKEN-VALUE'), 'the token must never appear in output');
});

test('a private origin with no usable token fails loudly: the check did not run', () => {
  const f = fixture({ stubExit: 0, stubJson: {} });
  const p = privateOrigin(f, () => '#!/bin/sh\nexit 1\n');
  const r = run(p.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL git fetch/);
  assert.match(readFileSync(f.posts, 'utf8'), /ntfy\.sh/);
  assert.equal(existsSync(f.importArgs), false, 'nothing ran');
});
