// waits.mjs - an issue that waits on something outside Paperclip (a store review, a PR merge, a CI run) must say HOW to
// tell the wait is over, so the flow keeper can check it and release the work. Pure functions; IO is injected.
//
// Format (one line, in the issue's unblock action text or its newest comment):
//   WAIT: check=cws_review_clear item=<store item id> recheck=60m deadline=2026-10-09
//   WAIT: check=pr_merged url=https://github.com/o/r/pull/12 recheck=15m deadline=2026-10-03
//   WAIT: check=ci_green url=https://github.com/o/r/pull/12 recheck=15m
// `recheck` is minutes (m) or hours (h); `deadline` is a date after which the CEO is asked to decide.

export const CHECKS = {
  cws_review_clear: ['item'],
  pr_merged: ['url'],
  ci_green: ['url'],
};
export const DEFAULT_RECHECK_MS = 60 * 60 * 1000;
export const MIN_RECHECK_MS = 5 * 60 * 1000;

export function parseWait(text) {
  const line = String(text ?? '').split('\n').filter((l) => /\bWAIT:\s*check=/.test(l)).at(-1);
  if (!line) return null;
  const kv = {};
  for (const m of line.slice(line.indexOf('WAIT:') + 5).matchAll(/(\w+)=(\S+)/g)) kv[m[1]] = m[2];
  const required = CHECKS[kv.check];
  if (!required || required.some((k) => !kv[k])) return { invalid: `unknown check or missing argument in: ${line.trim().slice(0, 120)}` };
  let recheckMs = DEFAULT_RECHECK_MS;
  const r = /^(\d+)([mh])$/.exec(kv.recheck ?? '');
  if (r) recheckMs = Math.max(MIN_RECHECK_MS, Number(r[1]) * (r[2] === 'h' ? 3600000 : 60000));
  const deadlineMs = kv.deadline ? Date.parse(`${kv.deadline}T23:59:59Z`) : null;
  return { check: kv.check, args: kv, recheckMs, deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : null };
}

/** A row of the release-platform STATUS.md for one store item -> is a review still pending? */
export function cwsReviewState(statusMd, item) {
  const row = String(statusMd ?? '').split('\n').find((l) => l.includes(`\`${item}\``));
  if (!row) return { known: false, detail: `item ${item} not found on the dashboard` };
  const pending = /PENDING_REVIEW/.test(row);
  return { known: true, clear: !pending, detail: pending ? 'store still shows PENDING_REVIEW' : 'no pending review on the store' };
}
export const statusMdAgeMs = (statusMd, now) => {
  const m = /_Updated (\S+?)Z? by/.exec(String(statusMd ?? ''));
  const t = m ? Date.parse(m[1].endsWith('Z') ? m[1] : `${m[1]}Z`) : NaN;
  return Number.isFinite(t) ? now - t : Infinity;
};

export function prMergedState(pr) {
  if (!pr) return { known: false, detail: 'pull request not readable' };
  if (pr.state === 'MERGED') return { known: true, clear: true, detail: 'pull request is merged' };
  if (pr.state === 'CLOSED') return { known: true, clear: true, detail: 'pull request was closed without merging' };
  return { known: true, clear: false, detail: 'pull request is still open' };
}
export function ciGreenState(pr) {
  const runs = pr?.statusCheckRollup ?? [];
  if (!pr || !runs.length) return { known: false, detail: 'no checks reported yet' };
  if (runs.some((c) => c.status && c.status !== 'COMPLETED')) return { known: true, clear: false, detail: 'checks still running' };
  const bad = runs.filter((c) => c.conclusion && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion));
  return bad.length ? { known: true, clear: true, detail: `checks finished with failures: ${bad.map((c) => c.name).join(', ')}` } : { known: true, clear: true, detail: 'all checks passed' };
}

/** What to do with one waiting issue now. lastCheckedMs = when the keeper last evaluated it. */
export function decideWait({ wait, lastCheckedMs = 0, now }) {
  if (wait?.invalid) return { action: 'invalid', why: wait.invalid };
  if (wait.deadlineMs && now > wait.deadlineMs) return { action: 'overdue', why: `deadline ${new Date(wait.deadlineMs).toISOString().slice(0, 10)} passed` };
  if (now - lastCheckedMs >= wait.recheckMs) return { action: 'check' };
  return { action: 'none' };
}

/** Blockers that are all finished: the block is stale and the work must go back to its owner.
 *  statusOf(blocker) -> status string; defaults to the blocker's own `status` field. */
export function staleBlock(issue, statusOf = (b) => b.status) {
  const b = issue.blockedBy ?? [];
  return issue.status === 'blocked' && b.length > 0 && b.every((x) => ['done', 'cancelled'].includes(statusOf(x)));
}
