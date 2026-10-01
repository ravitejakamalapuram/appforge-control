// APP-310: every refusal condition of the merge worker must REFUSE, and only a
// PR that passes all of them merges. Fake GitHub + fake Paperclip, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPolicy,
  globToRegExp,
  pathProblems,
  extractApprovals,
  runPass,
  emptyState,
  WAIT_LIMIT_MS,
} from '../lib/merge-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicy(readFileSync(path.resolve(HERE, '../../config/merge-policy.yaml'), 'utf8'));

const CEO = 'ac3c7fe2-7dba-40fa-95b6-aef74dbc2a2b';
const CTO = '3cba1fb3-21e1-4851-832b-95de5247bff1';
const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const NOW = Date.parse('2026-10-01T08:00:00Z');
const URL = 'https://github.com/ravitejakamalapuram/session-transfer/pull/17';

function comment({ body = `DECISION: approve merge of ${URL} at ${SHA}`, authorType = 'agent', authorAgentId = CEO, createdByRunId = 'run-1', createdAt = '2026-10-01T07:55:00Z', id = 'c1' } = {}) {
  return { id, issueId: 'issue-1', body, authorType, authorAgentId, createdByRunId, deletedAt: null, createdAt };
}

function fakePaperclip(comments) {
  const posted = [];
  return {
    posted,
    listIssuesUpdatedSince: async () => [{ id: 'issue-1' }],
    listComments: async () => comments,
    postComment: async (issueId, body) => {
      posted.push({ issueId, body });
      return { id: `p${posted.length}` };
    },
  };
}

function fakeGithub({ repo = 'session-transfer', pr = {}, files = [{ filename: 'product-facts.yaml' }], checks = 'success', mergeResult, afterMerge } = {}) {
  const writes = [];
  const basePr = {
    state: 'open',
    merged: false,
    draft: false,
    node_id: 'PR_1',
    user: { login: 'appforge-agents[bot]', type: 'Bot' },
    head: { sha: SHA, repo: { full_name: `ravitejakamalapuram/${repo}` } },
    base: { ref: 'main', repo: { full_name: `ravitejakamalapuram/${repo}` } },
    mergeable: true,
    changed_files: files.length,
    ...pr,
  };
  let merged = false;
  return {
    writes,
    getPullRequest: async () => (merged ? { ...basePr, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), ...afterMerge } : basePr),
    listFiles: async () => files,
    listCheckRuns: async (_o, _r, sha, name) =>
      checks === 'none' ? [] : [{ name, head_sha: sha, status: checks === 'pending' ? 'in_progress' : 'completed', conclusion: checks === 'pending' ? null : checks }],
    markReady: async (id) => writes.push(['markReady', id]),
    merge: async (o, r, n, opts) => {
      writes.push(['merge', r, n, opts]);
      if (mergeResult) return mergeResult;
      merged = true;
      return { ok: true, status: 200, message: 'merged' };
    },
    getCommit: async () => ({ sha: 'c'.repeat(40) }),
    compare: async () => ({ status: 'identical' }),
  };
}

async function pass({ comments = [comment()], github = fakeGithub(), state = emptyState(), dryRun = false, nowMs = NOW } = {}) {
  const paperclip = fakePaperclip(comments);
  const out = await runPass({ policy: POLICY, paperclip, github, state, nowMs, dryRun });
  return { ...out, paperclip, github };
}

function assertRefused(r, pattern) {
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].outcome, 'refused', JSON.stringify(r.results[0]));
  assert.match(r.results[0].reason, pattern);
  assert.ok(!r.github.writes.some((w) => w[0] === 'merge'), 'no merge call');
  assert.equal(r.paperclip.posted.length, 1);
  assert.match(r.paperclip.posted[0].body, /^REFUSED /);
}

// --- the one case that merges ---

test('all conditions met: merges with the approved sha, reads back, posts MERGED once', async () => {
  const r = await pass({ github: fakeGithub({ pr: { draft: true } }) });
  assert.equal(r.results[0].outcome, 'merged', JSON.stringify(r.results[0]));
  assert.deepEqual(r.github.writes[0], ['markReady', 'PR_1']);
  assert.deepEqual(r.github.writes[1], ['merge', 'session-transfer', 17, { sha: SHA, method: 'squash' }]);
  assert.match(r.paperclip.posted[0].body, new RegExp(`^MERGED ${URL} as c{40}`));
  // Second pass: the decision is handled, nothing happens again.
  const again = await pass({ state: r.state });
  assert.equal(again.results.length, 0);
  assert.equal(again.paperclip.posted.length, 0);
});

// --- the board's required refusals (APP-310 condition 4) ---

test('REFUSE: PR from a non-App author', async () => {
  assertRefused(await pass({ github: fakeGithub({ pr: { user: { login: 'ravitejakamalapuram', type: 'User' } } }) }), /not appforge-agents\[bot\]/);
});

test('REFUSE: approval for an older SHA than the head', async () => {
  const r = await pass({ comments: [comment({ body: `DECISION: approve merge of ${URL} at ${OLD_SHA}` })] });
  assertRefused(r, /approval is for bbbbbbb but the head is now aaaaaaa/);
});

test('REFUSE: a path on the deny list', async () => {
  assertRefused(await pass({ github: fakeGithub({ files: [{ filename: 'docs/ok.md' }, { filename: 'agents/cto/AGENTS.md' }] }) }), /agents\/cto\/AGENTS.md is on the deny list/);
});

test('REFUSE: the worker cannot merge a change to config/merge-policy.yaml', async () => {
  const github = fakeGithub({ repo: 'appforge-control', files: [{ filename: 'config/merge-policy.yaml' }] });
  const r = await pass({ comments: [comment({ body: `DECISION: approve merge of https://github.com/ravitejakamalapuram/appforge-control/pull/90 at ${SHA}` })], github });
  assertRefused(r, /config\/merge-policy.yaml is on the deny list/);
});

// --- the rest of the refusal list from the plan ---

test('REFUSE: renaming a denied file into docs/ (old path is judged too)', async () => {
  assertRefused(await pass({ github: fakeGithub({ files: [{ filename: 'docs/x.yaml', previous_filename: 'config/security.yaml', status: 'renamed' }] }) }), /config\/security.yaml is on the deny list/);
});

test('REFUSE: workflows, release.yaml, src, tests and protected docs', async () => {
  for (const f of ['.github/workflows/x.yml', 'release.yaml', 'extension/src/a.ts', 'scripts/tests/merge-worker.test.mjs', 'docs/merge-gate.md', 'docs/containment-model.md']) {
    assertRefused(await pass({ github: fakeGithub({ files: [{ filename: f }] }) }), /deny list/);
  }
});

test('REFUSE: a file outside the allow list (agent instructions are not allowed in phase 1)', async () => {
  assertRefused(await pass({ github: fakeGithub({ files: [{ filename: 'README.md' }] }) }), /README.md is not on the allow list/);
});

test('REFUSE: red CI', async () => {
  assertRefused(await pass({ github: fakeGithub({ checks: 'failure' }) }), /concluded failure/);
});

test('missing or pending CI waits, then REFUSES once the wait limit passes', async () => {
  for (const checks of ['none', 'pending']) {
    const r = await pass({ github: fakeGithub({ checks }) });
    assert.equal(r.results[0].outcome, 'waiting');
    assert.equal(r.paperclip.posted.length, 0);
    assert.ok(r.state.pending['c1:0'], 'kept pending');
    const late = await pass({ comments: [], github: fakeGithub({ checks }), state: r.state, nowMs: Date.parse('2026-10-01T07:55:00Z') + WAIT_LIMIT_MS + 60_000 });
    assertRefused(late, /still not ready/);
  }
});

test('REFUSE: repo not in the policy (InvTrack is phase 2)', async () => {
  const r = await pass({ comments: [comment({ body: `DECISION: approve merge of https://github.com/ravitejakamalapuram/InvTrack/pull/3 at ${SHA}` })] });
  assertRefused(r, /InvTrack is not in config\/merge-policy.yaml/);
});

test('REFUSE: a repo name that is an Object.prototype key', async () => {
  for (const repo of ['constructor', 'toString']) {
    const r = await pass({ comments: [comment({ body: `DECISION: approve merge of https://github.com/ravitejakamalapuram/${repo}/pull/3 at ${SHA}` })] });
    assertRefused(r, /not in config\/merge-policy.yaml/);
  }
});

test('REFUSE: closed PR, fork head, wrong base, conflicts', async () => {
  assertRefused(await pass({ github: fakeGithub({ pr: { state: 'closed' } }) }), /PR is closed/);
  assertRefused(await pass({ github: fakeGithub({ pr: { head: { sha: SHA, repo: { full_name: 'evil/session-transfer' } } } }) }), /fork/);
  assertRefused(await pass({ github: fakeGithub({ pr: { base: { ref: 'release', repo: { full_name: 'ravitejakamalapuram/session-transfer' } } } }) }), /base is release/);
  assertRefused(await pass({ github: fakeGithub({ pr: { mergeable: false } }) }), /conflicts/);
});

test('REFUSE: incomplete or oversized file list', async () => {
  assertRefused(await pass({ github: fakeGithub({ pr: { changed_files: 5 } }) }), /incomplete/);
  const many = Array.from({ length: 301 }, (_, i) => ({ filename: `docs/f${i}.md` }));
  assertRefused(await pass({ github: fakeGithub({ files: many }) }), /more than 300/);
});

test('REFUSE: merge API says the head moved (409)', async () => {
  const r = await pass({ github: fakeGithub({ mergeResult: { ok: false, status: 409, message: 'Head branch was modified' } }) });
  assert.equal(r.results[0].outcome, 'refused');
  assert.match(r.results[0].reason, /HTTP 409/);
});

test('read-back that does not show a merge is loud (unverified), never "merged"', async () => {
  const r = await pass({ github: fakeGithub({ afterMerge: { merged: false } }) });
  assert.equal(r.results[0].outcome, 'unverified');
  assert.match(r.paperclip.posted[0].body, /^MERGE UNVERIFIED /);
});

// --- who may approve ---

test('no approval: nothing happens', async () => {
  const r = await pass({ comments: [comment({ body: 'Looks good, approve.' })] });
  assert.equal(r.results.length, 0);
  assert.equal(r.github.writes.length, 0);
});

test('approval by a non-CEO agent, by a user, or with no run is never acted on', async () => {
  for (const c of [comment({ authorAgentId: CTO }), comment({ authorType: 'user', authorAgentId: null }), comment({ createdByRunId: null })]) {
    const r = await pass({ comments: [c] });
    assert.equal(r.results.length, 0);
    assert.equal(r.github.writes.length, 0);
  }
});

test('REFUSE: CEO approval without a full SHA', async () => {
  for (const body of [`DECISION: approve merge of ${URL}`, `DECISION: approve merge of ${URL} at abc1234`]) {
    assertRefused(await pass({ comments: [comment({ body })] }), /40-char head sha/);
  }
});

// --- dry-run ---

test('dry-run makes no write call, posts nothing, and leaves state untouched', async () => {
  const state = emptyState();
  const r = await pass({ dryRun: true, state, github: fakeGithub({ pr: { draft: true } }) });
  assert.equal(r.results[0].outcome, 'would_merge');
  assert.equal(r.github.writes.length, 0);
  assert.equal(r.paperclip.posted.length, 0);
  assert.deepEqual(state, emptyState());
});

test('first pass starts at install time; later passes overlap the last cursor', async () => {
  const seen = [];
  const paperclip = { ...fakePaperclip([]), listIssuesUpdatedSince: async (iso) => (seen.push(iso), []) };
  const { state } = await runPass({ policy: POLICY, paperclip, github: fakeGithub(), state: emptyState(), nowMs: NOW });
  await runPass({ policy: POLICY, paperclip, github: fakeGithub(), state, nowMs: NOW + 300_000 });
  assert.deepEqual(seen, [new Date(NOW).toISOString(), new Date(NOW - 15 * 60_000).toISOString()]);
});

// --- pieces ---

test('globs: ** crosses directories, * does not, matching ignores case', () => {
  assert.ok(globToRegExp('**/product-facts.yaml').test('product-facts.yaml'));
  assert.ok(globToRegExp('**/product-facts.yaml').test('apps/x/product-facts.yaml'));
  assert.ok(globToRegExp('data/**/*.yaml').test('data/a.yaml'));
  assert.ok(globToRegExp('data/**/*.yaml').test('data/a/b/c.yaml'));
  assert.ok(!globToRegExp('data/**/*.yaml').test('data/a.yml'));
  assert.ok(globToRegExp('config/**').test('Config/merge-policy.yaml'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
});

test('policy: deny covers every path the board named; allow is exactly phase 1', () => {
  assert.deepEqual(POLICY.allow, ['**/product-facts.yaml', 'data/**/*.yaml', 'docs/**']);
  for (const p of ['agents/x.md', 'scripts/tests/a.mjs', 'docs/containment-model.md', 'docs/capabilities.md', 'docs/agent-repo-scope.md', 'docs/merge-gate.md', 'config/merge-policy.yaml']) {
    assert.match(pathProblems([{ filename: p }], POLICY)[0], /deny list/, p);
  }
  assert.deepEqual(Object.keys(POLICY.repos).sort(), ['appforge-control', 'session-transfer']);
  assert.deepEqual(POLICY.repos['session-transfer'].required_checks, ['ci / Validate and test']);
  assert.deepEqual(POLICY.repos['appforge-control'].required_checks, ['node-test']);
});

test('policy loader refuses a repo with no required check', () => {
  const bad = readFileSync(path.resolve(HERE, '../../config/merge-policy.yaml'), 'utf8').replace('required_checks: [node-test]', 'required_checks: []');
  assert.throws(() => loadPolicy(bad), /at least one check/);
});

test('extractApprovals ignores a deleted CEO comment', () => {
  assert.deepEqual(extractApprovals({ ...comment(), deletedAt: '2026-10-01T07:56:00Z' }, POLICY), []);
});
