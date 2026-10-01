// Release-platform bridge (APP-293, docs/flow-verification.md rank 1). The release-platform verifiers fail a
// GitHub run and open a `listing-verify` issue in the APP repo; nobody here watches that. This polls GitHub
// (read-only) and turns each NEW signal into ONE Paperclip issue for the CTO plus an ntfy push, de-duplicated by
// the GitHub issue / run URL. A gh call that errors is reported as BROKEN, never as a quiet day.
import { parse } from 'yaml';

export const RUN_WORKFLOWS = ['listing', 'release', 'promote'];
export const VERIFY_LABEL = 'listing-verify';

/** Repos (owner/name) listed in release-platform/apps.yaml. Throws on an unreadable or empty registry. */
export function reposFromApps(text) {
  const doc = parse(text);
  const repos = [...new Set((doc?.apps ?? []).map((a) => a?.repo).filter(Boolean))];
  if (repos.length === 0) throw new Error('apps.yaml lists no repos');
  return repos;
}

/**
 * One poll. `gh(args)` returns stdout or throws; `onNew(signal)` creates the Paperclip issue (throws on failure);
 * `seen` is a Set of URLs already handled. Returns { fresh, broken } and never throws for a per-repo problem.
 */
export async function poll({ repos, gh, seen, onNew, now = Date.now(), lookbackHours = 48 }) {
  const signals = [];
  const broken = [];
  for (const repo of repos) {
    try {
      const issues = JSON.parse(gh(['issue', 'list', '-R', repo, '--label', VERIFY_LABEL, '--state', 'open', '--limit', '50', '--json', 'number,title,url']));
      if (!Array.isArray(issues)) throw new Error('issue list was not an array');
      for (const i of issues) signals.push({ kind: 'listing-verify issue', repo, url: i.url, title: i.title });
    } catch (e) { broken.push(`${repo}: issue list failed: ${e.message}`); }
    try {
      const runs = JSON.parse(gh(['run', 'list', '-R', repo, '--status', 'failure', '--limit', '30', '--json', 'url,workflowName,displayTitle,createdAt']));
      if (!Array.isArray(runs)) throw new Error('run list was not an array');
      for (const r of runs) {
        if (!RUN_WORKFLOWS.includes(r.workflowName)) continue;
        if (now - Date.parse(r.createdAt) > lookbackHours * 3600e3) continue;
        signals.push({ kind: `failed ${r.workflowName} run`, repo, url: r.url, title: r.displayTitle });
      }
    } catch (e) { broken.push(`${repo}: run list failed: ${e.message}`); }
  }
  const fresh = [];
  for (const s of signals) {
    if (!s.url || seen.has(s.url)) continue;
    try { await onNew(s); seen.add(s.url); fresh.push(s); }
    catch (e) { broken.push(`${s.repo}: could not open the Paperclip issue for ${s.url}: ${e.message}`); }
  }
  return { fresh, broken };
}

export function issueBody(s, assigneeAgentId, projectId) {
  return {
    title: `Release-platform: ${s.kind} in ${s.repo}`,
    description: `A release-platform verifier reported a problem that nobody here would otherwise see.\n\n- Kind: ${s.kind}\n- Repo: ${s.repo}\n- Title: ${s.title}\n- GitHub: ${s.url}\n\nTask: read the GitHub issue/run, say which flow and package it concerns and whether the store state really differs from the intended state (docs/flow-verification.md). Do NOT push to release-platform or run a production dispatch yourself; if the fix needs a release-platform change or a founder action, say so and set status blocked naming the owner. Max 40 turns.\n\nDe-dup key: ${s.url}`,
    status: 'todo', priority: 'high', assigneeAgentId, ...(projectId ? { projectId } : {}),
  };
}
