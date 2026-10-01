// pr-queue.mjs — APP-323. A ranked, deterministic view of every open agent PR
// across the repos in config/pr-queue.yaml, so the board's assistant can see
// what to merge next without opening each repo.
//
// Idea credit: paperclipai/pr-reviewer ranks open PRs by CI, conflicts, size,
// tests and freshness. That repo has no license, so nothing is copied from it;
// this is a reimplementation of the idea with our own signals and no score.
// The ordering is a fixed bucket order (ready, needs-rebase, red CI, waiting,
// draft), oldest first inside a bucket, so the same API state always gives
// the same table.
//
// Everything here is pure or takes an injected client, so the tests run with
// no network. The client only ever issues GETs.

// Lower rank sorts first.
export const BUCKETS = {
  ready: { rank: 1, label: 'ready to merge' },
  'needs-rebase': { rank: 2, label: 'needs rebase (conflicts)' },
  'red-ci': { rank: 3, label: 'red CI' },
  waiting: { rank: 4, label: 'waiting (CI pending/missing or mergeability unknown)' },
  draft: { rank: 5, label: 'draft' },
};

export const RISK = {
  ASSISTANT_ONLY: 'assistant-only',
  // Only meaningful once APP-310's merge worker exists; until then it is a
  // hint that the PR is cheap to review, not permission for anyone to merge.
  MERGE_WORKER_ELIGIBLE: 'merge-worker-eligible',
  STANDARD: 'standard',
};

// A path matching any of these makes the whole PR assistant-only: CI/CD,
// release config, company config, agent instructions, permissions.
const ASSISTANT_ONLY_PATHS = [
  /^\.github\/workflows\//,
  /(^|\/)release\.ya?ml$/,
  /^config\//,
  /^agents\//,
  /permission/i,
];

// docs/data only. Top-level *.md (README, CHANGELOG) counts as docs; a .md
// deeper in the tree (skills/**/SKILL.md) is instructions, not docs.
const DOCS_OR_DATA_PATHS = [/^docs\//, /^data\//, /^[^/]+\.md$/];

const TEST_PATHS = [
  /(^|\/)(tests?|__tests__|spec|integration_test)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_test\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
];

// Conclusions that mean a check ran and did not pass. `neutral` and `skipped`
// are not failures; whether they are evidence of a pass is merge-gate's call,
// not this view's.
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** green | red | pending | none, from the check runs on ONE head SHA. */
export function classifyCi(checkRuns, headSha) {
  const latest = new Map();
  for (const run of checkRuns ?? []) {
    if (run?.head_sha && headSha && run.head_sha !== headSha) continue; // a check on another commit does not count
    const prev = latest.get(run.name);
    const started = (r) => Date.parse(r.started_at ?? '') || 0;
    if (!prev || started(run) > started(prev) || (started(run) === started(prev) && (run.id ?? 0) > (prev.id ?? 0))) {
      latest.set(run.name, run);
    }
  }
  const runs = [...latest.values()];
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.status === 'completed' && RED_CONCLUSIONS.has(r.conclusion))) return 'red';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'green';
}

/** clean | conflicts | unknown. GitHub returns `mergeable: null` while it is still computing. */
export function classifyMergeable(pull) {
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') return 'conflicts';
  if (pull.mergeable === true) return 'clean';
  return 'unknown';
}

export function touchesTests(paths) {
  return paths.some((p) => TEST_PATHS.some((re) => re.test(p)));
}

/**
 * `filesComplete` is false when GitHub truncated the file list. An incomplete
 * list can still prove assistant-only, but can never prove docs/data only.
 */
export function riskClass(paths, { filesComplete = true } = {}) {
  if (paths.some((p) => ASSISTANT_ONLY_PATHS.some((re) => re.test(p)))) return RISK.ASSISTANT_ONLY;
  if (filesComplete && paths.length > 0 && paths.every((p) => DOCS_OR_DATA_PATHS.some((re) => re.test(p)))) {
    return RISK.MERGE_WORKER_ELIGIBLE;
  }
  return RISK.STANDARD;
}

export function hasVerificationSection(body) {
  return /^##\s+Verification\b/m.test(body ?? '');
}

/** The Paperclip issue: title first, then branch name, then body. */
export function linkedIssue(pull) {
  for (const text of [pull.title, pull.head?.ref, pull.body]) {
    const match = /\bAPP-(\d+)\b/i.exec(text ?? '');
    if (match) return `APP-${match[1]}`;
  }
  return null;
}

export function bucketFor({ draft, ci, mergeable }) {
  if (draft) return 'draft';
  if (mergeable === 'conflicts') return 'needs-rebase';
  if (ci === 'red') return 'red-ci';
  if (ci === 'green' && mergeable === 'clean') return 'ready';
  return 'waiting';
}

/**
 * One row per PR. `openPulls` is every open PR in the same repo, used for the
 * stack links in both directions: a PR whose base is not the default branch
 * is stacked, and a PR whose head branch is someone else's base must not have
 * that branch deleted (lesson 19: deleting a base closes the PR stacked on it).
 */
export function buildRow({ repo, pull, files, checkRuns, openPulls, now }) {
  const paths = files.map((f) => f.filename);
  const filesComplete = pull.changed_files == null || files.length >= pull.changed_files;
  const defaultBranch = pull.base?.repo?.default_branch;
  const stacked = Boolean(defaultBranch) && pull.base.ref !== defaultBranch;
  const stackedOn = stacked ? (openPulls.find((p) => p.head?.ref === pull.base.ref)?.number ?? null) : null;
  const baseOf = openPulls
    .filter((p) => p.number !== pull.number && p.base?.ref === pull.head?.ref)
    .map((p) => p.number)
    .sort((a, b) => a - b);
  const ci = classifyCi(checkRuns, pull.head?.sha);
  const mergeable = classifyMergeable(pull);
  const draft = Boolean(pull.draft);
  return {
    repo,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    issue: linkedIssue(pull),
    bucket: bucketFor({ draft, ci, mergeable }),
    draft,
    ci,
    mergeable,
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    linesChanged: (pull.additions ?? 0) + (pull.deletions ?? 0),
    touchesTests: touchesTests(paths),
    hasVerification: hasVerificationSection(pull.body),
    risk: riskClass(paths, { filesComplete }),
    filesComplete,
    stacked,
    baseRef: pull.base?.ref ?? null,
    stackedOn,
    baseOf,
    headSha: pull.head?.sha ?? null,
    ageDays: Math.max(0, Math.floor((now - Date.parse(pull.created_at)) / DAY_MS)),
  };
}

export function rankRows(rows) {
  return [...rows].sort(
    (a, b) =>
      BUCKETS[a.bucket].rank - BUCKETS[b.bucket].rank ||
      b.ageDays - a.ageDays ||
      a.repo.localeCompare(b.repo) ||
      a.number - b.number,
  );
}

/**
 * Read every repo. A repo that cannot be read lands in `unreadable` with the
 * error; it is never dropped silently, because an empty queue and an unread
 * queue must not look the same.
 */
export async function collectQueue({ github, owner, repos, now = Date.now(), sleep = defaultSleep }) {
  const rows = [];
  const unreadable = [];
  for (const repo of repos) {
    try {
      const listed = await github.listOpenPulls(owner, repo);
      for (const summary of listed) {
        let pull = await github.getPullRequest(owner, repo, summary.number);
        // GitHub computes mergeability lazily on the first read; ask once more.
        if (pull.mergeable == null && !pull.draft) {
          await sleep(2000);
          pull = await github.getPullRequest(owner, repo, summary.number);
        }
        const [files, checkRuns] = await Promise.all([
          github.listFiles(owner, repo, pull.number),
          github.listCheckRuns(owner, repo, pull.head.sha),
        ]);
        rows.push(buildRow({ repo, pull, files, checkRuns, openPulls: listed, now }));
      }
    } catch (err) {
      unreadable.push({ repo, error: err.message });
    }
  }
  return { rows: rankRows(rows), unreadable };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stackCell(row) {
  const parts = [];
  if (row.stacked) parts.push(`STACKED on ${row.stackedOn ? `#${row.stackedOn}` : `\`${row.baseRef}\``}`);
  if (row.baseOf.length) parts.push(`BASE of ${row.baseOf.map((n) => `#${n}`).join(', ')}: keep branch`);
  return parts.join('; ') || '-';
}

const escapeCell = (text) => String(text ?? '').replace(/\|/g, '\\|');

/** Markdown: one table, ranked, plus counts and any unreadable repo. */
export function renderTable({ rows, unreadable }, { date } = {}) {
  const counts = Object.keys(BUCKETS)
    .map((b) => `${rows.filter((r) => r.bucket === b).length} ${b}`)
    .join(', ');
  const lines = [`## PR queue${date ? ` (${date})` : ''}`, '', `${rows.length} open PRs: ${counts}.`];
  const stackedCount = rows.filter((r) => r.stacked || r.baseOf.length).length;
  if (stackedCount) lines.push(`${stackedCount} PR(s) in a stack: do not delete a branch marked BASE until the PR on it is retargeted.`);
  for (const u of unreadable) lines.push(`UNREADABLE: ${u.repo}: ${u.error}`);
  if (rows.length) {
    lines.push(
      '',
      '| # | Bucket | PR | Issue | CI | Merge | Lines | Tests | Verification | Risk | Stack | Age (d) | Title |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    rows.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${r.bucket} | [${r.repo}#${r.number}](${r.url}) | ${r.issue ?? '-'} | ${r.ci} | ${r.mergeable} | ` +
          `+${r.additions}/-${r.deletions} | ${r.touchesTests ? 'yes' : 'no'} | ${r.hasVerification ? 'yes' : 'NO'} | ` +
          `${r.risk}${r.filesComplete ? '' : ' (file list truncated)'} | ${stackCell(r)} | ${r.ageDays} | ${escapeCell(r.title)} |`,
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The read-only slice of the GitHub API the queue needs: pulls, pull files and
 * check runs, all GETs under the agents' App grants (pull_requests, checks,
 * contents). No write call of any kind lives in here.
 */
export function createGithubClient({ token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (!token) throw new Error('createGithubClient: a token is required');

  async function getJson(path) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      throw new Error(`GET ${path} failed to connect: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 200)}`.trim());
    }
    return res.json();
  }

  // Pages until a short page. `pick` pulls the array out of wrapped payloads.
  async function getAll(path, { maxPages, pick = (x) => x }) {
    const out = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const items = pick(await getJson(`${path}${sep}per_page=100&page=${page}`)) ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  return {
    listOpenPulls: (owner, repo) => getAll(`/repos/${owner}/${repo}/pulls?state=open`, { maxPages: 10 }),
    getPullRequest: (owner, repo, number) => getJson(`/repos/${owner}/${repo}/pulls/${number}`),
    // GitHub caps this list at 3000 files; buildRow compares against changed_files.
    listFiles: (owner, repo, number) => getAll(`/repos/${owner}/${repo}/pulls/${number}/files`, { maxPages: 30 }),
    listCheckRuns: (owner, repo, sha) =>
      getAll(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, { maxPages: 5, pick: (p) => p?.check_runs }),
  };
}
