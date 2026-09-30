// merge-gate.mjs — APP-234. The mechanism behind the cooperative rule the
// board left standing on APP-225: "CTO must not merge a PR whose node-test is
// red."
//
// appforge-control is a private repo on the GitHub Free plan, where branch
// protection and rulesets are unavailable, so `node-test` is advisory by
// ruling, not by oversight. Advisory is fine against an agent that looks; the
// failure this guards is an agent that does NOT look, which is exactly how
// APP-217 happened (main red for a week because nobody read it). So the gate
// is client-side and it only ever REFUSES — it never merges, never waits, and
// never touches branch protection.
//
// Everything here is pure or takes an injected client, so the tests run with
// no network at all.

export const DEFAULT_CHECK_NAME = 'node-test';
export const DEFAULT_REPO = 'ravitejakamalapuram/appforge-control';

// Distinct exits, because the caller must react differently to each. In
// particular MISSING is NOT the same as FAILED: before the workflow lands (or
// on any commit Actions never picked up) there is no run at all, and a gate
// that passes when the check is absent is worse than no gate — it teaches the
// caller the gate works while it is inert.
export const EXIT = {
  GREEN: 0,
  CHECK_FAILED: 1, // the check ran to completion and did not succeed
  GATE_ERROR: 2, // the gate itself could not answer (usage, auth, API)
  CHECK_MISSING: 3, // no such check run on THIS head SHA
  CHECK_PENDING: 4, // queued / in_progress — refuse now, caller may retry
};

const shortSha = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));

/** `owner/name`, rejected loudly rather than half-parsed into a bad URL. */
export function parseRepo(spec) {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(String(spec ?? ''));
  if (!match) throw new Error(`repo must be "owner/name", got: ${JSON.stringify(spec)}`);
  return { owner: match[1], repo: match[2] };
}

export function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * The most recent run with this name. GitHub's default `filter=latest` already
 * collapses re-runs, but a re-run that is still in flight can arrive alongside
 * the previous completed one, and picking the older green there would be the
 * same stale-green bug in miniature. Newest wins; ties break on id.
 */
export function selectLatestRun(checkRuns, checkName) {
  const named = checkRuns.filter((run) => run?.name === checkName);
  if (named.length === 0) return null;
  const rank = (run) => {
    const started = Date.parse(run.started_at ?? '');
    return Number.isNaN(started) ? 0 : started;
  };
  return named.sort((a, b) => rank(b) - rank(a) || (b.id ?? 0) - (a.id ?? 0))[0];
}

/**
 * Decide on the check runs reported for one exact SHA.
 *
 * `headSha` is not decoration: any run carrying a different head_sha is
 * discarded before the decision. A green on an ancestor commit is the failure
 * mode most worth catching, and it must land in MISSING, never in GREEN.
 */
export function evaluateCheckRuns({ checkRuns = [], checkName, headSha, prNumber = null }) {
  const target = prNumber == null ? `${shortSha(headSha)}` : `PR #${prNumber} (head ${shortSha(headSha)})`;

  const forThisSha = checkRuns.filter((run) => !run?.head_sha || run.head_sha === headSha);
  const otherSha = checkRuns.filter((run) => run?.head_sha && run.head_sha !== headSha && run?.name === checkName);

  const run = selectLatestRun(forThisSha, checkName);

  if (!run) {
    const superseded =
      otherSha.length > 0
        ? ` (found "${checkName}" on ${shortSha(otherSha[0].head_sha)} instead — a check on a superseded commit does not count)`
        : '';
    return {
      exitCode: EXIT.CHECK_MISSING,
      run: null,
      headSha,
      reason:
        `REFUSE: no "${checkName}" check run on ${target}${superseded}. ` +
        'A missing check is not a pass — find out why Actions never ran before merging.',
    };
  }

  if (run.status !== 'completed') {
    return {
      exitCode: EXIT.CHECK_PENDING,
      run,
      headSha,
      reason: `REFUSE: "${checkName}" is ${run.status} on ${target}, not green. Re-run this gate when it completes.`,
    };
  }

  if (run.conclusion !== 'success') {
    return {
      exitCode: EXIT.CHECK_FAILED,
      run,
      headSha,
      // `skipped` and `neutral` land here on purpose: a job that did not run
      // its assertions is not evidence that the assertions pass.
      reason: `REFUSE: "${checkName}" concluded ${run.conclusion ?? 'unknown'} on ${target}.`,
    };
  }

  return { exitCode: EXIT.GREEN, run, headSha, reason: null };
}

/**
 * Resolve the target's CURRENT head SHA and judge the check against it.
 *
 * `github` is injected: { getPullRequest(owner, repo, number), listCheckRuns(owner, repo, sha, checkName) }.
 */
export async function gate({ github, repo, prNumber = null, sha = null, checkName = DEFAULT_CHECK_NAME }) {
  const { owner, repo: name } = parseRepo(repo);

  let headSha = sha;
  if (prNumber != null) {
    const pull = await github.getPullRequest(owner, name, prNumber);
    headSha = pull?.head?.sha;
    if (!isSha(headSha)) {
      return {
        exitCode: EXIT.GATE_ERROR,
        run: null,
        headSha: null,
        reason: `REFUSE: could not read a head SHA for PR #${prNumber} from the API response.`,
      };
    }
  }
  if (!isSha(headSha)) {
    return {
      exitCode: EXIT.GATE_ERROR,
      run: null,
      headSha: null,
      reason: `REFUSE: no usable head SHA to check (got ${JSON.stringify(headSha)}).`,
    };
  }

  const checkRuns = await github.listCheckRuns(owner, name, headSha, checkName);
  return evaluateCheckRuns({ checkRuns, checkName, headSha, prNumber });
}

/**
 * The read-only slice of the GitHub API this gate needs. Both endpoints are
 * already reachable with the ordinary per-run App installation token — probed
 * 2026-09-30, both 200. No new App permission, and deliberately no write call
 * of any kind lives in here.
 */
export function createGithubClient({ token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (!token) throw new Error('createGithubClient: an installation token is required');

  async function getJson(path) {
    const url = `${apiBase}${path}`;
    let res;
    try {
      res = await fetchImpl(url, {
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

  return {
    getPullRequest: (owner, repo, number) => getJson(`/repos/${owner}/${repo}/pulls/${number}`),
    // `check_name` filters server-side so a busy commit cannot push node-test
    // off page 1 and have the gate read that as "missing".
    listCheckRuns: async (owner, repo, sha, checkName) => {
      const query = `check_name=${encodeURIComponent(checkName)}&per_page=100`;
      const payload = await getJson(`/repos/${owner}/${repo}/commits/${sha}/check-runs?${query}`);
      return Array.isArray(payload?.check_runs) ? payload.check_runs : [];
    },
  };
}
