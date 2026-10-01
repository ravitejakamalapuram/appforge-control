// APP-323: the PR queue must put every open PR in the right bucket, rank the
// buckets in a fixed order, and flag both ends of a stack so nobody deletes a
// base branch (lesson 19).
//
// No network. Payloads come from fixtures/pr-queue-SYNTHETIC.json (see the
// README there) and the client is exercised against an injected fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RISK,
  buildRow,
  classifyCi,
  collectQueue,
  createGithubClient,
  linkedIssue,
  rankRows,
  renderTable,
  riskClass,
  touchesTests,
} from '../lib/pr-queue.mjs';

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr-queue-SYNTHETIC.json'), 'utf8'),
);
const NOW = Date.parse(FIXTURE.now);
const STATES = FIXTURE.states;
const OPEN_PULLS = Object.values(STATES).map((s) => s.pull);

const row = (name) => buildRow({ repo: FIXTURE.repo, ...STATES[name], openPulls: OPEN_PULLS, now: NOW });

/** A GitHub client backed by the fixture, for the whole collect path. */
function fakeGithub({ failRepo = null } = {}) {
  const byNumber = new Map(Object.values(STATES).map((s) => [s.pull.number, s]));
  return {
    async listOpenPulls(owner, repo) {
      if (repo === failRepo) throw new Error('GET /repos/o/x/pulls -> 404 Not Found');
      return OPEN_PULLS;
    },
    getPullRequest: async (owner, repo, n) => byNumber.get(n).pull,
    listFiles: async (owner, repo, n) => byNumber.get(n).files,
    listCheckRuns: async (owner, repo, sha) => Object.values(STATES).find((s) => s.pull.head.sha === sha).checkRuns,
  };
}

// --- one fixture per state ------------------------------------------------

for (const [name, bucket] of [
  ['ready', 'ready'],
  ['needs-rebase', 'needs-rebase'],
  ['red-ci', 'red-ci'],
  ['waiting', 'waiting'],
  ['draft', 'draft'],
]) {
  test(`fixture "${name}" lands in bucket ${bucket}`, () => {
    assert.equal(row(name).bucket, bucket);
  });
}

test('a draft is a draft even when green and mergeable', () => {
  const r = row('draft');
  assert.equal(r.ci, 'green');
  assert.equal(r.mergeable, 'clean');
  assert.equal(r.bucket, 'draft');
});

test('ranking order: ready, needs-rebase, red CI, waiting, draft; oldest first inside a bucket', () => {
  const ranked = rankRows(Object.keys(STATES).map(row));
  assert.deepEqual(
    ranked.map((r) => r.number),
    // #11 (ready, 3d) before #16 (ready, 2d): age breaks the tie.
    [11, 16, 12, 13, 14, 15],
  );
});

// --- stacks: the case that must fail if a stacked PR is not flagged --------

test('a stacked PR is flagged with the PR it sits on, and its base PR is flagged keep-branch', () => {
  const stacked = row('stacked');
  assert.equal(stacked.stacked, true, 'base branch is not the default branch: must be flagged stacked');
  assert.equal(stacked.stackedOn, 11);
  assert.equal(stacked.baseRef, 'APP-500-ready');

  const base = row('ready');
  assert.equal(base.stacked, false);
  assert.deepEqual(base.baseOf, [16], 'deleting this head branch would close #16 (lesson 19)');

  const table = renderTable({ rows: rankRows([base, stacked]), unreadable: [] });
  assert.match(table, /STACKED on #11/);
  assert.match(table, /BASE of #16: keep branch/);
});

test('a PR based on a branch no open PR owns is still flagged stacked', () => {
  const pull = { ...STATES.stacked.pull, base: { ref: 'some-old-branch', repo: { default_branch: 'main' } } };
  const r = buildRow({ repo: 'r', ...STATES.stacked, pull, openPulls: [pull], now: NOW });
  assert.equal(r.stacked, true);
  assert.equal(r.stackedOn, null);
  assert.match(renderTable({ rows: [r], unreadable: [] }), /STACKED on `some-old-branch`/);
});

// --- per-PR signals -------------------------------------------------------

test('CI is read from the head SHA only; a green on another commit is not green', () => {
  const runs = [{ id: 1, name: 'node-test', head_sha: 'old', status: 'completed', conclusion: 'success' }];
  assert.equal(classifyCi(runs, 'new'), 'none');
  assert.equal(classifyCi([], 'new'), 'none');
});

test('a re-run supersedes the older failure of the same check', () => {
  const runs = [
    { id: 1, name: 'node-test', head_sha: 's', status: 'completed', conclusion: 'failure', started_at: '2026-10-01T01:00:00Z' },
    { id: 2, name: 'node-test', head_sha: 's', status: 'completed', conclusion: 'success', started_at: '2026-10-01T02:00:00Z' },
  ];
  assert.equal(classifyCi(runs, 's'), 'green');
});

test('risk class: workflows, release.yaml, config, agents, permissions are assistant-only', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    'release.yaml',
    'apps/x/release.yml',
    'config/agents.yaml',
    'agents/cto/AGENTS.md',
    'android/app/src/main/permissions.xml',
  ]) {
    assert.equal(riskClass(['docs/a.md', path]), RISK.ASSISTANT_ONLY, path);
  }
});

test('risk class: docs/data only is merge-worker-eligible, anything else is standard', () => {
  assert.equal(riskClass(['docs/a.md', 'data/b.json', 'README.md']), RISK.MERGE_WORKER_ELIGIBLE);
  assert.equal(riskClass(['docs/a.md', 'scripts/x.mjs']), RISK.STANDARD);
  assert.equal(riskClass(['skills/foo/SKILL.md']), RISK.STANDARD, 'instructions are not docs');
  assert.equal(riskClass([]), RISK.STANDARD, 'no files is no evidence');
  assert.equal(riskClass(['docs/a.md'], { filesComplete: false }), RISK.STANDARD, 'a truncated list cannot prove docs-only');
});

test('fixture rows carry tests, verification, lines, age and issue', () => {
  const r = row('ready');
  assert.equal(r.touchesTests, true);
  assert.equal(r.hasVerification, true);
  assert.equal(r.linesChanged, 42);
  assert.equal(r.ageDays, 3);
  assert.equal(r.issue, 'APP-500');
  assert.equal(r.risk, RISK.STANDARD);
  assert.equal(row('needs-rebase').risk, RISK.MERGE_WORKER_ELIGIBLE);
  assert.equal(row('needs-rebase').issue, 'APP-501', 'issue from the body when title and branch have none');
  assert.equal(row('red-ci').hasVerification, false);
  assert.equal(row('red-ci').issue, null);
  assert.equal(touchesTests(['lib/foo_test.dart']), true);
  assert.equal(linkedIssue({ title: 'x', head: { ref: 'app-77-thing' } }), 'APP-77');
});

// --- collect / render / client --------------------------------------------

test('an unreadable repo is reported, not dropped', async () => {
  const q = await collectQueue({ github: fakeGithub({ failRepo: 'x' }), owner: 'o', repos: ['r', 'x'], now: NOW });
  assert.equal(q.rows.length, 6);
  assert.deepEqual(q.unreadable.map((u) => u.repo), ['x']);
  assert.match(renderTable(q), /UNREADABLE: x: GET \/repos\/o\/x\/pulls -> 404/);
});

test('mergeability still computing is re-read once', async () => {
  const github = fakeGithub();
  let reads = 0;
  github.listOpenPulls = async () => [STATES.ready.pull];
  github.getPullRequest = async () => {
    reads += 1;
    return reads === 1 ? { ...STATES.ready.pull, mergeable: null } : STATES.ready.pull;
  };
  const q = await collectQueue({ github, owner: 'o', repos: ['r'], now: NOW, sleep: async () => {} });
  assert.equal(reads, 2);
  assert.equal(q.rows[0].bucket, 'ready');
});

test('client only issues GETs and pages until a short page', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const page = Number(new URL(url).searchParams.get('page'));
    const items = Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ number: i }));
    return { ok: true, json: async () => items };
  };
  const gh = createGithubClient({ token: 't', fetchImpl, apiBase: 'https://api.test' });
  const pulls = await gh.listOpenPulls('o', 'r');
  assert.equal(pulls.length, 103);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.match(calls[0].url, /\/repos\/o\/r\/pulls\?state=open&per_page=100&page=1$/);
});
