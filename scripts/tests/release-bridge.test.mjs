import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-bridge.mjs');

/** Fake `gh` (prints canned JSON per subcommand, or errors) and fake `curl` (records URL + stdin). */
function fixture({ issues = [], runs = [], ghFails = false, ghHangs = false, paperclipFails = false }) {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const calls = join(root, 'calls.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> "${calls}"\n${ghHangs ? 'exec sleep 30' : ghFails ? 'echo "HTTP 401" >&2; exit 1' : `case "$1" in issue) cat <<'J'\n${JSON.stringify(issues)}\nJ\n;; run) cat <<'J'\n${JSON.stringify(runs)}\nJ\n;; esac`}\n`);
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) url="$a";; esac; done\necho "curl $url" >> "${calls}"\ncase "$url" in *api/companies*) cat >> "${root}/bodies.log"; ${paperclipFails ? 'exit 22' : 'exit 0'};; esac\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755); chmodSync(join(bin, 'curl'), 0o755);
  const apps = join(root, 'apps.yaml');
  writeFileSync(apps, 'apps:\n  - name: A\n    repo: o/a\n  - name: B\n    repo: o/b\n');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, RELEASE_BRIDGE_APPS: apps, APPFORGE_STATE_DIR: join(root, 'state'), PAPERCLIP_API_URL: 'http://127.0.0.1:1', PAPERCLIP_COMPANY_ID: 'co-1', NTFY_TOPIC: 'tt' };
  return { env, calls, bodies: join(root, 'bodies.log') };
}
const run = (env, ...a) => spawnSync(process.execPath, [SCRIPT, ...a], { env, encoding: 'utf8' });
const lines = (f, re) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => re.test(l)) : []);
const OPEN_ISSUE = [{ number: 7, title: 'Listing mismatch', url: 'https://github.com/o/a/issues/7' }];

test('MUTATION: an open listing-verify issue opens exactly one Paperclip issue; a re-run opens none', () => {
  const f = fixture({ issues: OPEN_ISSUE });
  // fake gh returns the same issue for both repos -> same URL -> still ONE
  const r1 = run(f.env);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.equal(lines(f.calls, /api\/companies\/co-1\/issues/).length, 1);
  assert.match(readFileSync(f.bodies, 'utf8'), /issues\/7/);
  assert.equal(lines(f.calls, /ntfy\.sh\/tt/).length, 1, 'ntfy sent');
  const r2 = run(f.env);
  assert.equal(r2.status, 0);
  assert.equal(lines(f.calls, /api\/companies\/co-1\/issues/).length, 1, 're-run opened nothing');
});

test('a recent failed release run is bridged; old runs and other workflows are not', () => {
  const recent = new Date().toISOString(), old = new Date(Date.now() - 30 * 86400e3).toISOString();
  const f = fixture({ runs: [
    { url: 'https://github.com/o/a/actions/runs/1', workflowName: 'release', displayTitle: 't', createdAt: recent },
    { url: 'https://github.com/o/a/actions/runs/2', workflowName: 'release', displayTitle: 't', createdAt: old },
    { url: 'https://github.com/o/a/actions/runs/3', workflowName: 'ci', displayTitle: 't', createdAt: recent },
  ] });
  assert.equal(run(f.env).status, 0);
  const body = readFileSync(f.bodies, 'utf8');
  assert.match(body, /runs\/1/); assert.doesNotMatch(body, /runs\/2|runs\/3/);
});

test('MUTATION: a gh that errors is BROKEN (ntfy + non-zero), never quiet', () => {
  const f = fixture({ ghFails: true });
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL .*issue list failed/);
  assert.equal(lines(f.calls, /ntfy\.sh\/tt/).length, 1);
  assert.equal(lines(f.calls, /api\/companies/).length, 0);
});

test('a failed Paperclip POST is broken and is retried next run (not marked seen)', () => {
  const f = fixture({ issues: OPEN_ISSUE, paperclipFails: true });
  assert.equal(run(f.env).status, 1);
  assert.equal(lines(f.calls, /ntfy\.sh/).length, 1);
  const f2 = { ...f, env: f.env };
  run(f2.env);
  assert.equal(lines(f.calls, /api\/companies\/co-1\/issues/).length, 4, 'retried (2 repos x 2 runs; the fake gh gives both the same URL)');
});

test('an unreadable app list is broken, not quiet', () => {
  const f = fixture({});
  f.env.RELEASE_BRIDGE_APPS = '/nonexistent/apps.yaml';
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.equal(lines(f.calls, /ntfy\.sh/).length, 1);
});

test('missing Paperclip config fails loudly', () => {
  const f = fixture({});
  delete f.env.PAPERCLIP_API_URL;
  const r = run(f.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PAPERCLIP_API_URL is not set/);
});

test('--dry-run calls nothing', () => {
  const f = fixture({ issues: OPEN_ISSUE });
  const r = run(f.env, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(f.calls), false, 'no gh, no curl');
  assert.match(r.stdout, /dry-run: would poll 2 repos/);
});

test('MUTATION: a hanging gh call times out and the run fails loudly instead of hanging (APP-350)', () => {
  const f = fixture({ ghHangs: true });
  const t0 = Date.now();
  const r = run({ ...f.env, RELEASE_BRIDGE_GH_TIMEOUT_MS: '500' });
  assert.ok(Date.now() - t0 < 15_000, 'run must not wait for the hung gh');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL/);
});
