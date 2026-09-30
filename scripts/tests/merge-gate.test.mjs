// APP-234: the merge gate must refuse every way a `node-test` check can fail
// to be a green on the PR's current head.
//
// No network. The GitHub client is exercised against an injected fetch and the
// decision logic against recorded payloads in fixtures/check-runs/ (see the
// README there for what "recorded" does and does not mean).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  EXIT,
  DEFAULT_CHECK_NAME,
  createGithubClient,
  evaluateCheckRuns,
  gate,
  isSha,
  parseRepo,
  selectLatestRun,
} from '../lib/merge-gate.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'check-runs');
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));

const PULL = fixture('pull-open');
const HEAD_SHA = PULL.head.sha;
const SUPERSEDED_SHA = fixture('green-on-superseded-sha').check_runs[0].head_sha;

/** A GitHub client backed by fixtures, keyed by the SHA the caller asks for. */
function fakeGithub({ pull = PULL, runsBySha = {}, onListCheckRuns } = {}) {
  return {
    async getPullRequest() {
      if (pull instanceof Error) throw pull;
      return pull;
    },
    async listCheckRuns(owner, repo, sha, checkName) {
      onListCheckRuns?.({ owner, repo, sha, checkName });
      return runsBySha[sha]?.check_runs ?? [];
    },
  };
}

const gateOnFixture = (name, { pull = PULL } = {}) =>
  gate({
    github: fakeGithub({ pull, runsBySha: { [HEAD_SHA]: fixture(name) } }),
    repo: 'ravitejakamalapuram/appforge-control',
    prNumber: PULL.number,
  });

// --- the five acceptance cases -------------------------------------------

test('passes on a genuine green for the PR head SHA', async () => {
  const result = await gateOnFixture('green');
  assert.equal(result.exitCode, EXIT.GREEN);
  assert.equal(result.reason, null, 'green must be quiet — no line for the caller to read past');
  assert.equal(result.headSha, HEAD_SHA);
});

test('refuses a red node-test', async () => {
  const result = await gateOnFixture('failure');
  assert.equal(result.exitCode, EXIT.CHECK_FAILED);
  assert.match(result.reason, /concluded failure/);
  assert.match(result.reason, /PR #40/);
});

test('refuses a missing node-test with an exit distinct from a failing one', async () => {
  const result = await gateOnFixture('empty');
  assert.equal(result.exitCode, EXIT.CHECK_MISSING);
  assert.notEqual(EXIT.CHECK_MISSING, EXIT.CHECK_FAILED);
  // The loud part: a caller skimming this must not read it as "nothing to see".
  assert.match(result.reason, /A missing check is not a pass/);
});

test('refuses an in-progress node-test and says which state it saw', async () => {
  const result = await gateOnFixture('in-progress');
  assert.equal(result.exitCode, EXIT.CHECK_PENDING);
  assert.match(result.reason, /is in_progress/);
  assert.match(result.reason, /Re-run this gate/, 'the caller must be told retrying is the move');
});

test('refuses a green that belongs to a superseded head SHA', async () => {
  // The whole point of resolving the PR's CURRENT head: this payload IS green,
  // just for a commit that is no longer what would be merged.
  const result = await gate({
    github: fakeGithub({
      runsBySha: { [SUPERSEDED_SHA]: fixture('green-on-superseded-sha') },
    }),
    repo: 'ravitejakamalapuram/appforge-control',
    prNumber: PULL.number,
  });
  assert.equal(result.exitCode, EXIT.CHECK_MISSING);
  assert.equal(result.headSha, HEAD_SHA);
});

test('refuses a green run that the API returned against a different SHA', async () => {
  // Defence in depth on the same failure: even if the check-runs call were
  // asked for the head and answered with an ancestor's run, the head_sha on
  // the run itself is re-checked rather than trusted.
  const result = evaluateCheckRuns({
    checkRuns: fixture('green-on-superseded-sha').check_runs,
    checkName: DEFAULT_CHECK_NAME,
    headSha: HEAD_SHA,
    prNumber: 40,
  });
  assert.equal(result.exitCode, EXIT.CHECK_MISSING);
  assert.match(result.reason, /superseded commit does not count/);
  assert.match(result.reason, new RegExp(SUPERSEDED_SHA.slice(0, 7)));
});

// --- the rest of the refusal surface -------------------------------------

test('refuses a queued node-test', async () => {
  const result = await gateOnFixture('queued');
  assert.equal(result.exitCode, EXIT.CHECK_PENDING);
  assert.match(result.reason, /is queued/);
});

test('refuses a skipped node-test — a job that ran no assertions is not evidence', async () => {
  const result = await gateOnFixture('skipped');
  assert.equal(result.exitCode, EXIT.CHECK_FAILED);
  assert.match(result.reason, /concluded skipped/);
});

test('refuses when other checks are green but node-test is absent', async () => {
  const result = await gateOnFixture('other-checks-only');
  assert.equal(result.exitCode, EXIT.CHECK_MISSING);
});

test('an in-flight re-run beats the older green on the same SHA', async () => {
  const result = await gateOnFixture('rerun-in-flight-over-green');
  assert.equal(result.exitCode, EXIT.CHECK_PENDING);
});

test('selectLatestRun picks the newest run of that name and ignores other names', () => {
  const runs = [
    { id: 1, name: 'node-test', started_at: '2026-09-30T10:00:00Z' },
    { id: 2, name: 'lint', started_at: '2026-09-30T12:00:00Z' },
    { id: 3, name: 'node-test', started_at: '2026-09-30T11:00:00Z' },
  ];
  assert.equal(selectLatestRun(runs, 'node-test').id, 3);
  assert.equal(selectLatestRun(runs, 'nothing-named-this'), null);
});

test('selectLatestRun falls back to the higher id when started_at is unusable', () => {
  const runs = [
    { id: 7, name: 'node-test', started_at: null },
    { id: 9, name: 'node-test' },
  ];
  assert.equal(selectLatestRun(runs, 'node-test').id, 9);
});

// --- the gate refusing to guess ------------------------------------------

test('a PR payload with no head SHA is a gate error, not a pass', async () => {
  const result = await gate({
    github: fakeGithub({ pull: { number: 40, head: {} } }),
    repo: 'ravitejakamalapuram/appforge-control',
    prNumber: 40,
  });
  assert.equal(result.exitCode, EXIT.GATE_ERROR);
});

test('a bare --sha path is judged against that SHA', async () => {
  const seen = [];
  const result = await gate({
    github: fakeGithub({
      runsBySha: { [HEAD_SHA]: fixture('green') },
      onListCheckRuns: (call) => seen.push(call),
    }),
    repo: 'ravitejakamalapuram/appforge-control',
    sha: HEAD_SHA,
  });
  assert.equal(result.exitCode, EXIT.GREEN);
  assert.deepEqual(seen.map((c) => c.sha), [HEAD_SHA]);
});

test('a junk SHA with no PR is a gate error rather than a missing check', async () => {
  const result = await gate({
    github: fakeGithub(),
    repo: 'ravitejakamalapuram/appforge-control',
    sha: 'not-a-sha',
  });
  assert.equal(result.exitCode, EXIT.GATE_ERROR);
});

test('parseRepo rejects anything that is not owner/name', () => {
  assert.deepEqual(parseRepo('ravitejakamalapuram/appforge-control'), {
    owner: 'ravitejakamalapuram',
    repo: 'appforge-control',
  });
  assert.throws(() => parseRepo('appforge-control'), /owner\/name/);
  assert.throws(() => parseRepo('a/b/c'), /owner\/name/);
  assert.throws(() => parseRepo(undefined), /owner\/name/);
});

test('isSha accepts short and full hexes and nothing else', () => {
  assert.equal(isSha(HEAD_SHA), true);
  assert.equal(isSha('2b7d1f4'), true);
  assert.equal(isSha('2b7d1f'), false);
  assert.equal(isSha('zzzzzzz'), false);
  assert.equal(isSha(null), false);
});

// --- the HTTP client, with fetch injected --------------------------------

test('the client asks for check runs on the exact SHA, filtered by check name', async () => {
  const calls = [];
  const client = createGithubClient({
    token: 'ghs_fake',
    apiBase: 'https://api.example.invalid',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => fixture('green') };
    },
  });

  const runs = await client.listCheckRuns('owner', 'repo', HEAD_SHA, 'node-test');
  assert.equal(runs.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes(`/repos/owner/repo/commits/${HEAD_SHA}/check-runs`));
  assert.ok(calls[0].url.includes('check_name=node-test'));
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ghs_fake');
});

test('the client reads the PR by number', async () => {
  const calls = [];
  const client = createGithubClient({
    token: 'ghs_fake',
    apiBase: 'https://api.example.invalid',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => PULL };
    },
  });

  const pull = await client.getPullRequest('owner', 'repo', 40);
  assert.equal(pull.head.sha, HEAD_SHA);
  assert.ok(calls[0].includes('/repos/owner/repo/pulls/40'));
});

test('a non-OK response throws rather than degrading to an empty run list', async () => {
  // An empty list means "missing check"; a 403 means "the gate is blind".
  // Collapsing the second into the first would point the caller at CI when the
  // real problem is the token.
  const client = createGithubClient({
    token: 'ghs_fake',
    apiBase: 'https://api.example.invalid',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Resource not accessible' }),
  });
  await assert.rejects(() => client.listCheckRuns('owner', 'repo', HEAD_SHA, 'node-test'), /403/);
});

test('a connection failure throws with the endpoint named', async () => {
  const client = createGithubClient({
    token: 'ghs_fake',
    apiBase: 'https://api.example.invalid',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(() => client.getPullRequest('owner', 'repo', 40), /pulls\/40 failed to connect/);
});

test('createGithubClient refuses to build without a token', () => {
  assert.throws(() => createGithubClient({ token: '' }), /installation token is required/);
});

test('the exit codes stay distinct — the caller branches on them', () => {
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(EXIT.GREEN, 0);
  assert.ok(codes.filter((c) => c !== 0).every((c) => c > 0));
});
