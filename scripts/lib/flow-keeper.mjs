// flow-keeper.mjs - decide, for every open Paperclip issue, whether the work is moving or sitting idle, and what the
// cheapest correct nudge is. Pure functions only (the IO is in scripts/flow-keeper.mjs), so every rule is tested.
//
// Why this exists (founder, 2026-10-01: "tickets stay in one status for long, I want it looped till completion"):
// Paperclip wakes an agent only on an event (assignment, comment, approval). When a run ends without a next owner, or the
// wake was cancelled by a reassignment, or the agent is waiting on a person, nothing ever wakes the issue again. This is
// the missing "tick". It never decides WHAT to do, it only makes sure the right agent is woken, with a bound so a stuck
// issue cannot burn quota in a loop.

export const STALE_MS = 10 * 60 * 1000; // an idle assigned issue older than this gets a nudge
export const BLOCKED_STALE_MS = 30 * 60 * 1000; // blocked with no live blocker: ask for a disposition
export const COOLDOWN_MS = 20 * 60 * 1000; // minimum gap between nudges for one issue
export const WINDOW_MS = 6 * 60 * 60 * 1000; // nudge budget window
export const MAX_KICKS = 4; // nudges per issue per window; past this we ESCALATE instead of looping
export const ESCALATE_EVERY_MS = 24 * 60 * 60 * 1000;
export const MAX_RESUMES_PER_HOUR = 2;

const OPEN = new Set(['todo', 'in_progress', 'in_review', 'blocked']);
// An agent in `error` is resumed only when the cause looks transient. These need a person or a config fix.
export const NON_TRANSIENT_ERROR = /installed_on|not authorized|authentication|login|credential|permission|workspace_validation|budget|paused by/i;
// The agent's last word is addressed to the board's assistant: nothing to wake, a person/assistant must act.
export const ASSISTANT_WAIT = /board'?s assistant|board assistant|@board\b|founder (must|needs|to)\b/i;

const ts = (v) => {
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? t : 0;
};

/** Newest of the timestamps that mean "something happened on this issue". */
export function lastTouchMs(issue, lastComment) {
  return Math.max(ts(issue.updatedAt), ts(issue.lastActivityAt), ts(lastComment?.createdAt));
}

/**
 * One issue -> one decision.
 *  issue        Paperclip issue JSON
 *  agent        the assignee's agent JSON (or null)
 *  busyAgents   Set of agent ids with a queued/running run
 *  lastComment  newest comment {authorType, body, createdAt} or null
 *  kicks        timestamps (ms) of earlier nudges for this issue
 * Returns { action: 'none'|'wake'|'assistant'|'escalate', reason, why }.
 */
export function decide({ issue, agent, busyAgents, lastComment, kicks = [], now }) {
  const none = (why) => ({ action: 'none', why });
  if (!OPEN.has(issue.status)) return none('closed or parked');
  if (!issue.assigneeAgentId) return none('no agent assignee (a person owns it)');
  if (!agent) return none('assignee unknown');
  if (busyAgents.has(issue.assigneeAgentId) || issue.activeRun) return none('the agent is working on it');

  const idleMs = now - lastTouchMs(issue, lastComment);
  const body = String(lastComment?.body ?? '');
  const waitingOnAssistant = lastComment?.authorType === 'agent' && ASSISTANT_WAIT.test(body);

  // Who must act next?
  let need = null;
  if (waitingOnAssistant && idleMs >= STALE_MS) {
    return { action: 'assistant', why: 'the last agent comment is addressed to the board\'s assistant', since: lastTouchMs(issue, lastComment) };
  }
  if ((issue.status === 'todo' || issue.status === 'in_progress') && idleMs >= STALE_MS) {
    need = issue.status === 'todo' ? 'todo: the assigned agent is idle and has not started' : 'in_progress: no run is working on it';
  } else if (issue.status === 'in_review' && issue.reviewAttention?.state === 'stalled' && idleMs >= STALE_MS) {
    need = 'in_review: nobody owns the next step (no reviewer, card, wake or monitor)';
  } else if (issue.status === 'blocked' && idleMs >= BLOCKED_STALE_MS && (issue.blockerAttention?.unresolvedBlockerCount ?? 0) === 0 && !issue.blockerAttention?.blockingTreeLive) {
    need = 'blocked: no live blocker is holding it';
  }
  if (!need) return none('moving, or still inside the idle threshold');
  if (agent.status === 'paused') return none('the agent is paused on purpose');

  const recent = kicks.filter((k) => now - k < WINDOW_MS);
  if (recent.length >= MAX_KICKS) {
    return { action: 'escalate', why: `${recent.length} nudges in ${Math.round(WINDOW_MS / 3600000)}h did not move it (${need})`, reason: need };
  }
  if (recent.length && now - Math.max(...recent) < COOLDOWN_MS) return none('nudged recently');
  return { action: 'wake', reason: need, why: need };
}

/** Agents to resume: errored for a transient reason, within the hourly resume budget. */
export function agentsToResume({ agents, resumes = {}, now }) {
  const out = [];
  for (const a of agents) {
    if (a.status !== 'error') continue;
    if (NON_TRANSIENT_ERROR.test(String(a.errorReason ?? a.pauseReason ?? ''))) continue;
    const recent = (resumes[a.id] ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= MAX_RESUMES_PER_HOUR) continue;
    out.push(a);
  }
  return out;
}

export const wakeKey = (issueId, now) => `flowkeeper:${issueId}:${Math.floor(now / COOLDOWN_MS)}`;

export function wakeBody(issue, reason, now) {
  return {
    source: 'automation',
    triggerDetail: 'system',
    reason: `flow-keeper: ${reason}. Continue this issue now: do the next concrete step, or hand it to a named owner, or state exactly what you are waiting for. Do not end the run with the issue in the same state.`,
    payload: { issueId: issue.id },
    idempotencyKey: wakeKey(issue.id, now),
  };
}

export function pruneKicks(kicks, now) {
  const out = {};
  for (const [k, v] of Object.entries(kicks ?? {})) {
    const keep = v.filter((t) => now - t < WINDOW_MS);
    if (keep.length) out[k] = keep;
  }
  return out;
}

export const escalationTitle = (identifier) => `Stuck: ${identifier} is not moving`;
