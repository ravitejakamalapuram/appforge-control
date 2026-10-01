// merge-worker.mjs — APP-310. Merge a PR the CEO approved in Paperclip, without
// waiting for the board's assistant, but ONLY when every mechanical fact a
// human reviewer would check is true on the exact commit the CEO approved.
//
// The CEO has no GitHub token, so it cannot read a PR's head SHA. The SHA comes
// from the author's HANDOFF (`HEAD: <sha>`) and the CEO repeats it:
//   DECISION: approve merge of https://github.com/ravitejakamalapuram/<repo>/pull/<n> at <40-char sha>
// The worker merges only if that SHA is still the head, and passes it to the
// merge API so GitHub itself refuses if someone pushes in between. Commit dates
// are never used (an agent can forge them).
//
// Every outcome other than "merged" is a named refusal, posted on the issue
// that holds the decision. Pending CI is the only reason to wait, and only for
// WAIT_LIMIT_MS after the decision.
//
// Everything here is pure or takes injected clients, so the tests need no
// network.
import { parse as parseYaml } from 'yaml';
import { evaluateCheckRuns, EXIT } from './merge-gate.mjs';

export const OWNER = 'ravitejakamalapuram';
export const MAX_FILES = 300;
export const WAIT_LIMIT_MS = 2 * 60 * 60 * 1000;
// Re-read issues a little before the last cursor: a comment written while the
// previous pass was listing must not fall between two passes.
export const CURSOR_OVERLAP_MS = 15 * 60 * 1000;
export const HANDLED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DECISION_PREFIX = /^DECISION: approve merge of\b/;
const DECISION_STRICT = new RegExp(
  `^DECISION: approve merge of (https://github\\.com/${OWNER}/([A-Za-z0-9._-]+)/pull/([1-9][0-9]*)) at ([0-9a-f]{40})\\s*$`,
);

/** Parse and validate config/merge-policy.yaml. Throws on anything unexpected. */
export function loadPolicy(text) {
  const p = parseYaml(text);
  const fail = (msg) => {
    throw new Error(`merge-policy: ${msg}`);
  };
  if (p?.version !== 1) fail('version must be 1');
  if (!/^[0-9a-f-]{36}$/.test(p.approver_agent_id ?? '')) fail('approver_agent_id must be an agent UUID');
  if (typeof p.app_author !== 'string' || !p.app_author.endsWith('[bot]')) fail('app_author must be a [bot] login');
  if (!['squash', 'merge', 'rebase'].includes(p.merge_method)) fail('merge_method must be squash, merge or rebase');
  if (!p.repos || typeof p.repos !== 'object' || Object.keys(p.repos).length === 0) fail('repos must list at least one repo');
  for (const [name, r] of Object.entries(p.repos)) {
    if (!Array.isArray(r?.required_checks) || r.required_checks.length === 0) {
      fail(`repos.${name}.required_checks must name at least one check (a repo with no required check is never auto-merged)`);
    }
    if (typeof r.base !== 'string' || !r.base) fail(`repos.${name}.base must name the base branch`);
  }
  for (const key of ['allow', 'deny']) {
    if (!Array.isArray(p[key]) || p[key].length === 0 || !p[key].every((g) => typeof g === 'string' && g)) {
      fail(`${key} must be a non-empty list of globs`);
    }
  }
  return p;
}

/** `**` crosses directories, `*` and `?` do not. Case-insensitive, so a deny cannot be dodged by case. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Own keys only: a repo named `constructor` must not resolve to Object.prototype. */
export function repoPolicyFor(policy, repo) {
  return Object.hasOwn(policy.repos, repo) ? policy.repos[repo] : null;
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Problems with a PR's file list, or [] if every path is allowed. A rename is
 * judged on BOTH paths: renaming config/x.yaml to docs/x.yaml deletes a denied
 * file.
 */
export function pathProblems(files, policy) {
  const problems = [];
  for (const f of files) {
    for (const path of [f.filename, f.previous_filename].filter(Boolean)) {
      if (matchesAny(path, policy.deny)) problems.push(`${path} is on the deny list`);
      else if (!matchesAny(path, policy.allow)) problems.push(`${path} is not on the allow list`);
    }
  }
  return problems;
}

/**
 * Approvals in one Paperclip comment. Only the CEO's own comments count:
 * authorType agent, authorAgentId = approver, written by a real run, not
 * deleted. A line from anyone else is ignored (it is not a CEO decision, so
 * nothing is waiting on the worker). A CEO line that starts like a decision
 * but is malformed (no SHA, short SHA, other owner) becomes a refusal, because
 * the CEO expects a merge from it.
 */
export function extractApprovals(comment, policy) {
  const fromCeo =
    comment?.authorType === 'agent' &&
    comment.authorAgentId === policy.approver_agent_id &&
    Boolean(comment.createdByRunId) &&
    !comment.deletedAt;
  if (!fromCeo) return [];
  const out = [];
  String(comment.body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line, index) => {
      if (!DECISION_PREFIX.test(line)) return;
      const base = { key: `${comment.id}:${index}`, commentId: comment.id, issueId: comment.issueId, createdAt: comment.createdAt };
      const m = DECISION_STRICT.exec(line);
      if (!m) {
        out.push({
          ...base,
          url: line.slice('DECISION: approve merge of '.length).split(/\s/)[0] || '(no url)',
          refusal: `the decision line is not "DECISION: approve merge of https://github.com/${OWNER}/<repo>/pull/<n> at <40-char head sha>". Copy the SHA from the author's HANDOFF \`HEAD:\` line; an approval without the exact SHA is never merged.`,
        });
        return;
      }
      out.push({ ...base, url: m[1], repo: m[2], number: Number(m[3]), sha: m[4] });
    });
  return out;
}

/**
 * Decide one approval against the PR as GitHub reports it now.
 * Returns { action: 'merge' | 'wait' | 'refuse', reason }.
 */
export function evaluatePullRequest({ approval, pr, files, checkRunsByName, policy, nowMs }) {
  const refuse = (reason) => ({ action: 'refuse', reason });
  const repoPolicy = repoPolicyFor(policy, approval.repo);
  if (!repoPolicy) return refuse(`repo ${approval.repo} is not in config/merge-policy.yaml; the board's assistant merges it.`);
  if (pr.state !== 'open') return refuse(`PR is ${pr.merged ? 'already merged' : pr.state}.`);
  if (pr.user?.login !== policy.app_author || pr.user?.type !== 'Bot') {
    return refuse(`author is ${pr.user?.login ?? 'unknown'}, not ${policy.app_author}; only App-authored PRs are auto-merged.`);
  }
  if (pr.head?.repo?.full_name !== pr.base?.repo?.full_name) return refuse('the head branch is in another repository (fork).');
  if (pr.base?.ref !== repoPolicy.base) return refuse(`base is ${pr.base?.ref}, not ${repoPolicy.base}.`);
  if (pr.head?.sha !== approval.sha) {
    return refuse(
      `the approval is for ${approval.sha.slice(0, 7)} but the head is now ${String(pr.head?.sha).slice(0, 7)} (pushed after the decision). ` +
        'The CEO must approve the new head SHA.',
    );
  }
  if (files.length > MAX_FILES) return refuse(`${files.length} changed files; more than ${MAX_FILES} is never auto-merged.`);
  if (files.length !== pr.changed_files) {
    return refuse(`file list is incomplete (${files.length} read, PR reports ${pr.changed_files}); refusing rather than judging a partial list.`);
  }
  const problems = pathProblems(files, policy);
  if (problems.length > 0) {
    const more = problems.length > 5 ? ` (+${problems.length - 5} more)` : '';
    return refuse(`path not allowed for auto-merge: ${problems.slice(0, 5).join('; ')}${more}.`);
  }

  const waits = [];
  for (const checkName of repoPolicy.required_checks) {
    const verdict = evaluateCheckRuns({ checkRuns: checkRunsByName[checkName] ?? [], checkName, headSha: approval.sha, prNumber: approval.number });
    if (verdict.exitCode === EXIT.CHECK_FAILED) return refuse(verdict.reason.replace(/^REFUSE: /, ''));
    if (verdict.exitCode !== EXIT.GREEN) waits.push(verdict.reason.replace(/^REFUSE: /, ''));
  }
  if (pr.mergeable === false) return refuse('PR has merge conflicts with its base.');
  if (pr.mergeable == null) waits.push('GitHub has not computed mergeability yet.');

  if (waits.length > 0) {
    const ageMs = nowMs - Date.parse(approval.createdAt);
    if (!(ageMs <= WAIT_LIMIT_MS)) return refuse(`still not ready ${Math.round(ageMs / 60000)} min after the decision: ${waits.join(' ')}`);
    return { action: 'wait', reason: waits.join(' ') };
  }
  return { action: 'merge', reason: null };
}

export function emptyState() {
  return { cursor: null, handled: {}, pending: {} };
}

/**
 * One pass. Returns { state, results }, where each result is
 * { key, issueId, url, outcome: 'merged'|'refused'|'waiting'|'would_merge'|'unverified'|'error', reason, commit }.
 * In dry-run nothing is written anywhere and the returned state must not be saved.
 *
 * paperclip: { listIssuesUpdatedSince(iso), listComments(issueId), postComment(issueId, body) }
 * github:    { getPullRequest, listFiles, listCheckRuns, markReady, merge, getCommit, compare }
 */
export async function runPass({ policy, paperclip, github, state: prev, nowMs, dryRun = false, log = () => {} }) {
  const state = { cursor: prev.cursor, handled: { ...prev.handled }, pending: { ...prev.pending } };
  // First pass ever: start now. Decisions written before the worker was installed
  // are the board's assistant's to merge; the worker must not answer old threads.
  const sinceMs = state.cursor ? Date.parse(state.cursor) - CURSOR_OVERLAP_MS : nowMs;

  const approvals = new Map(Object.entries(state.pending));
  const issues = await paperclip.listIssuesUpdatedSince(new Date(sinceMs).toISOString());
  for (const issue of issues) {
    for (const comment of await paperclip.listComments(issue.id)) {
      for (const a of extractApprovals(comment, policy)) {
        if (!state.handled[a.key] && !approvals.has(a.key)) approvals.set(a.key, a);
      }
    }
  }

  const results = [];
  const ordered = [...approvals.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const approval of ordered) {
    let result;
    try {
      result = await handleApproval({ approval, policy, github, nowMs, dryRun, log });
    } catch (err) {
      // GitHub or network failure: not a decision about the PR. Keep it pending
      // and let the pass report the error loudly.
      result = { outcome: 'error', reason: err.message };
    }
    result = { key: approval.key, issueId: approval.issueId, url: approval.url, ...result };
    results.push(result);
    log(`${result.outcome.toUpperCase()} ${approval.url} (decision ${approval.key})${result.reason ? `: ${result.reason}` : ''}`);
    if (dryRun) continue;

    if (result.outcome === 'waiting' || result.outcome === 'error') {
      state.pending[approval.key] = approval;
      continue;
    }
    delete state.pending[approval.key];
    state.handled[approval.key] = { outcome: result.outcome, at: new Date(nowMs).toISOString() };
    try {
      await paperclip.postComment(approval.issueId, formatComment(approval, result));
    } catch (err) {
      result.commentError = err.message;
    }
  }

  state.cursor = new Date(nowMs).toISOString();
  for (const [key, v] of Object.entries(state.handled)) {
    if (nowMs - Date.parse(v.at) > HANDLED_TTL_MS) delete state.handled[key];
  }
  return { state, results };
}

async function handleApproval({ approval, policy, github, nowMs, dryRun, log }) {
  if (approval.refusal) return { outcome: 'refused', reason: approval.refusal };
  if (!repoPolicyFor(policy, approval.repo)) {
    return { outcome: 'refused', reason: `repo ${approval.repo} is not in config/merge-policy.yaml; the board's assistant merges it.` };
  }
  const pr = await github.getPullRequest(OWNER, approval.repo, approval.number);
  if (!pr) return { outcome: 'refused', reason: 'PR not found.' };
  // Fetch the file list and checks only for a PR worth judging; evaluate()
  // repeats the cheap checks, so the order of refusals stays in one place.
  const files = pr.state === 'open' ? await github.listFiles(OWNER, approval.repo, approval.number) : [];
  const checkRunsByName = {};
  if (pr.state === 'open' && pr.head?.sha === approval.sha) {
    for (const name of policy.repos[approval.repo].required_checks) {
      checkRunsByName[name] = await github.listCheckRuns(OWNER, approval.repo, approval.sha, name);
    }
  }
  const verdict = evaluatePullRequest({ approval, pr, files, checkRunsByName, policy, nowMs });
  if (verdict.action === 'refuse') return { outcome: 'refused', reason: verdict.reason };
  if (verdict.action === 'wait') return { outcome: 'waiting', reason: verdict.reason };
  if (dryRun) return { outcome: 'would_merge', reason: `${files.length} file(s), checks green on ${approval.sha.slice(0, 7)}` };

  if (pr.draft) {
    log(`marking ${approval.url} ready for review`);
    await github.markReady(pr.node_id);
  }
  const merged = await github.merge(OWNER, approval.repo, approval.number, { sha: approval.sha, method: policy.merge_method });
  if (!merged.ok) return { outcome: 'refused', reason: `GitHub refused the merge (HTTP ${merged.status}): ${merged.message}` };

  // Read back from GitHub, not from the merge response.
  const after = await github.getPullRequest(OWNER, approval.repo, approval.number);
  const commit = after?.merge_commit_sha;
  const commitExists = commit ? Boolean(await github.getCommit(OWNER, approval.repo, commit)) : false;
  const cmp = commitExists ? await github.compare(OWNER, approval.repo, commit, policy.repos[approval.repo].base) : null;
  const onBase = cmp?.status === 'identical' || cmp?.status === 'ahead';
  if (!after?.merged || !commitExists || !onBase) {
    return {
      outcome: 'unverified',
      commit: commit ?? null,
      reason: `merge call returned ok, but read-back failed (merged=${after?.merged}, commit=${commit ?? 'none'}, on ${policy.repos[approval.repo].base}=${onBase}). Check the PR by hand.`,
    };
  }
  return { outcome: 'merged', commit, reason: null, fileCount: files.length };
}

export function formatComment(approval, result) {
  const decision = `Decision comment: ${approval.commentId}.`;
  if (result.outcome === 'merged') {
    return [
      `MERGED ${approval.url} as ${result.commit}`,
      '',
      `Merge worker (APP-310): approved head ${approval.sha} matched, required checks green on it, ${result.fileCount} file(s) all on the allow list, read back as merged on the base branch. ${decision}`,
    ].join('\n');
  }
  if (result.outcome === 'unverified') {
    return `MERGE UNVERIFIED ${approval.url}: ${result.reason}\n\n${decision} The board's assistant must check this PR.`;
  }
  return `REFUSED ${approval.url}: ${result.reason}\n\nMerge worker (APP-310) did not merge. ${decision} The board's assistant can still merge it by hand.`;
}

// -- Real clients -----------------------------------------------------------

export function createPaperclipClient({ apiBase, companyId, approverAgentId, apiKey = null, fetchImpl = fetch }) {
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  async function call(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }
  const LIMIT = 1000;
  return {
    async listIssuesUpdatedSince(iso) {
      const q = `participantAgentId=${approverAgentId}&updatedSince=${encodeURIComponent(iso)}&limit=${LIMIT}`;
      const rows = await call('GET', `/api/companies/${companyId}/issues?${q}`);
      // A full page means there may be more: refuse to treat it as complete.
      if (rows.length >= LIMIT) throw new Error(`issue list hit the ${LIMIT} limit; cannot be sure every decision was seen`);
      return rows;
    },
    listComments: (issueId) => call('GET', `/api/issues/${issueId}/comments?order=asc`),
    async postComment(issueId, body) {
      const created = await call('POST', `/api/issues/${issueId}/comments`, { body });
      // Read back: a comment that was not stored was not posted.
      const stored = await call('GET', `/api/issues/${issueId}/comments/${created.id}`);
      if (stored?.body !== body) throw new Error(`comment ${created.id} did not read back`);
      return created;
    },
  };
}

export function createGithubWriteClient({ token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (!token) throw new Error('createGithubWriteClient: an installation token is required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  async function raw(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  }
  async function get(path, { allow404 = false } = {}) {
    const r = await raw('GET', path);
    if (allow404 && (r.status === 404 || r.status === 422)) return null;
    if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  }
  return {
    getPullRequest: (owner, repo, n) => get(`/repos/${owner}/${repo}/pulls/${n}`, { allow404: true }),
    async listFiles(owner, repo, n) {
      const all = [];
      for (let page = 1; page <= Math.ceil(MAX_FILES / 100) + 1; page += 1) {
        const batch = await get(`/repos/${owner}/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async listCheckRuns(owner, repo, sha, checkName) {
      const payload = await get(`/repos/${owner}/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&per_page=100`);
      return Array.isArray(payload?.check_runs) ? payload.check_runs : [];
    },
    async markReady(nodeId) {
      const r = await raw('POST', '/graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
        variables: { id: nodeId },
      });
      if (!r.ok || r.json?.errors) throw new Error(`markPullRequestReadyForReview failed: ${r.status} ${r.text.slice(0, 200)}`);
    },
    async merge(owner, repo, n, { sha, method }) {
      const r = await raw('PUT', `/repos/${owner}/${repo}/pulls/${n}/merge`, { sha, merge_method: method });
      return { ok: r.ok && r.json?.merged === true, status: r.status, message: r.json?.message ?? r.text.slice(0, 200) };
    },
    getCommit: (owner, repo, sha) => get(`/repos/${owner}/${repo}/commits/${sha}`, { allow404: true }),
    compare: (owner, repo, sha, base) => get(`/repos/${owner}/${repo}/compare/${sha}...${base}`, { allow404: true }),
  };
}
