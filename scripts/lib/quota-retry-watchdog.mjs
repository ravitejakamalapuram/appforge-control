/**
 * Pure logic for the APP-45 / DEBT-0001 quota-retry watchdog.
 *
 * BACKGROUND (see APP-45 closing comment, comment 30411991-939a-4d5b-b637-6f4b2e19de65):
 * Paperclip's adapter correctly classifies a Claude provider session-limit
 * failure as `errorCode: "provider_quota"`, and the run's own `error` text
 * carries the exact reset time, e.g.:
 *
 *   "Claude run failed: subtype=success: You've hit your session limit \xb7 resets 9:50am (Asia/Calcutta)"
 *
 * But Paperclip's own retry scheduler (`@paperclipai/server`
 * services/recovery/service.js) ignores that and re-queues the run under
 * `scheduledRetryReason: "transient_failure"` on a short delay (observed:
 * 30s and 1.6s against a reset ~6h away) -- burning a full context re-read
 * (tens of thousands of input tokens) for a run that is rejected again on
 * arrival. 25 quota-failed runs burned 1,035K input tokens and returned
 * nothing in one 24h window.
 *
 * This is DEBT-0001: not patched in Paperclip itself (fragile, silently
 * overwritten by `paperclipai update`, duplicates control-plane logic we do
 * not own -- see the founder's direction). Instead this module supplies the
 * pure decision logic for a watchdog that reacts to Paperclip's own correct
 * `provider_quota` classification from OUR boundary: pause the agent so
 * Paperclip's scheduler cannot retry it early, then explicitly resume+wake
 * it once at the real reset time.
 *
 * Everything here is pure (no fetch, no child_process, no fs) so it can be
 * unit-tested with fake data -- the orchestration script
 * (`../quota-retry-watchdog.mjs`) is the only place that touches the network,
 * the `paperclipai` CLI, or disk.
 */

// ---------------------------------------------------------------------------
// Reset-time parsing
// ---------------------------------------------------------------------------

/**
 * Matches the exact shape Claude's CLI prints today:
 *   "You've hit your session limit \xb7 resets 9:50am (Asia/Calcutta)"
 * Hour is 1-2 digits, 12-hour clock, no leading zero required; minute is
 * always 2 digits; am/pm is lower or upper case; the IANA zone is whatever
 * Claude's CLI prints (observed: "Asia/Calcutta", a real IANA alias for
 * Asia/Kolkata that `Intl`/`Intl.DateTimeFormat` both accept).
 */
const RESET_TIME_RE = /resets\s+(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i;

/**
 * The offset (in minutes, east of UTC) that `timeZone` was at instant
 * `utcMs`, computed by asking Intl how that instant reads as a wall clock in
 * that zone. This is the standard technique for converting a *wall-clock*
 * time in an arbitrary IANA zone to a UTC instant without a timezone
 * database dependency (what libraries like date-fns-tz do internally):
 * format the instant in the zone, diff the wall-clock components against
 * the UTC ones for the same instant.
 */
function offsetMinutesAt(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - utcMs) / 60_000;
}

/**
 * Converts a wall-clock date+time in `timeZone` to a UTC instant (ms).
 * One-shot offset lookup is exact for zones with no DST (Asia/Calcutta,
 * IST, is a fixed UTC+5:30 year-round) and is off by at most the DST delta
 * (usually 0 or 1h) right at a transition for zones that do have one --
 * acceptable here since the buffer (60-90s) this watchdog adds is not meant
 * to absorb hours of drift, and the one zone actually observed in production
 * has none.
 */
function zonedWallClockToUtcMs(year, month, day, hour, minute, timeZone) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMin = offsetMinutesAt(guessMs, timeZone);
  return guessMs - offsetMin * 60_000;
}

/** `{year, month, day}` for `utcMs` as read on a wall clock in `timeZone`. */
function calendarDateInZone(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Adds `days` calendar days to a `{year, month, day}` triple (UTC-based arithmetic; timezone-agnostic). */
function addCalendarDays({ year, month, day }, days) {
  const ms = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Parses a Claude CLI quota-failure error string and returns the reset
 * instant as an absolute UTC timestamp (ms since epoch), or `null` if the
 * text does not match the known shape.
 *
 * DAY ROLLOVER: the printed text has no date, only a time-of-day ("resets
 * 9:50am"), so it is ambiguous between today and tomorrow. We resolve it
 * against `nowMs`: take "today" in the target zone, build the candidate
 * reset instant for today's date, and if that candidate is already in the
 * past (<= now) -- e.g. the failure text was produced at 11pm printing
 * "resets 9:50am", which obviously cannot mean the 9:50am that already
 * passed -- roll forward exactly one calendar day and recompute. This is
 * timezone-safe because the day increment happens on the zone's own
 * calendar date, not by adding a flat 24h in UTC (which would be wrong once
 * a zone with DST is involved).
 */
export function parseResetTime(errorText, nowMs) {
  if (!errorText || typeof errorText !== 'string') return null;
  const match = RESET_TIME_RE.exec(errorText);
  if (!match) return null;

  const [, hourStr, minuteStr, meridiem, tzName] = match;
  let hour = Number(hourStr) % 12;
  if (meridiem.toLowerCase() === 'pm') hour += 12;
  const minute = Number(minuteStr);
  if (minute > 59 || Number(hourStr) < 1 || Number(hourStr) > 12) return null;

  // Validate the zone name eagerly so a garbled match fails loudly here
  // rather than producing a silently-wrong instant downstream.
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tzName });
  } catch {
    return null;
  }

  const today = calendarDateInZone(nowMs, tzName);
  let candidateMs = zonedWallClockToUtcMs(today.year, today.month, today.day, hour, minute, tzName);
  let rolledOverToNextDay = false;
  if (candidateMs <= nowMs) {
    const tomorrow = addCalendarDays(today, 1);
    candidateMs = zonedWallClockToUtcMs(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, tzName);
    rolledOverToNextDay = true;
  }

  return { resetAtMs: candidateMs, timeZone: tzName, hour24: hour, minute, rolledOverToNextDay };
}

// ---------------------------------------------------------------------------
// Backoff with full jitter
// ---------------------------------------------------------------------------

/**
 * "Full Jitter" backoff: `random_between(0, min(cap, base * 2^attempt))`.
 *
 * Source/reasoning: Marc Brooker, "Exponential Backoff And Jitter", AWS
 * Architecture Blog, 2015
 * (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
 * That post benchmarks four strategies (no jitter, equal jitter, full
 * jitter, decorrelated jitter) against a simulated fleet of clients retrying
 * a throttled resource, and finds plain exponential backoff (no jitter)
 * produces synchronized retry spikes -- clients that failed together retry
 * together, which is exactly our shape: several agents can fail with
 * `process_lost` in the same few seconds (shared VM, shared provider
 * session), so a fixed-multiplier delay would line their retries back up.
 * Full jitter has the best overall client latency and the lowest total
 * request count of the strategies tested, at the cost of the single retry
 * being less predictable in wall-clock time than "equal jitter" -- an
 * acceptable trade here since nothing downstream depends on the exact
 * instant, only on "eventually, spread out."
 *
 * `attempt` is 0-based (0 = first retry after the first failure).
 */
export function computeBackoffDelayMs(attempt, { baseMs = 5_000, capMs = 20 * 60_000, randomFn = Math.random } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error('computeBackoffDelayMs: attempt must be a non-negative integer');
  }
  const bounded = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(randomFn() * bounded);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Error codes observed in real `heartbeat-runs` history (queried live
 * against the AppForge AI company, 2026-09-28; 197 runs) that represent a
 * genuinely retryable, non-quota failure -- i.e. a failure where retrying is
 * the right move but Paperclip's default immediate-ish re-queue cadence is
 * not something we want to trust blindly (same spirit as the quota case,
 * lower stakes). `process_lost` is the one that actually appeared:
 * `{max_turns_exhausted: 37, cancelled: 29, adapter_failed: 27,
 * provider_quota: 25, claude_auth_required: 13, process_lost: 6, ...}`.
 * The others are deliberately excluded:
 *  - `max_turns_exhausted` already gets a sane continuation
 *    (`scheduledRetryReason: "max_turns_continuation"`) from Paperclip
 *    itself -- that is correct behaviour, not the bug this exists for.
 *  - `adapter_failed`, `claude_auth_required`, `setup_failed`,
 *    `issue_assignee_changed`, `issue_reassigned`, `issue_terminal_status`
 *    all need operator/config intervention, not a timed retry -- retrying
 *    them on a schedule would burn budget the same way the quota bug does.
 *  - `cancelled` is not a provider failure at all.
 */
export const RETRYABLE_TRANSIENT_ERROR_CODES = new Set(['process_lost']);

export const QUOTA_ERROR_CODE = 'provider_quota';

/**
 * Classifies one heartbeat run into the action the watchdog should take:
 *  - `'quota'`        -- provider_quota failure, needs reset-time handling
 *  - `'transient'`     -- a retryable transient failure, needs backoff
 *  - `'succeeded'`     -- resets the agent's backoff counter
 *  - `null`            -- nothing for this watchdog to do
 */
export function classifyForWatchdog(run) {
  if (run.status === 'succeeded') return 'succeeded';
  if (run.status !== 'failed') return null;
  if (run.errorCode === QUOTA_ERROR_CODE) return 'quota';
  if (RETRYABLE_TRANSIENT_ERROR_CODES.has(run.errorCode)) return 'transient';
  return null;
}

// ---------------------------------------------------------------------------
// State shape + idempotency helpers
// ---------------------------------------------------------------------------

/** A fresh, empty state object -- same shape `loadState` falls back to when the file does not exist yet. */
export function emptyState() {
  return { handledRunIds: {}, agents: {}, pendingActions: {} };
}

function ensureAgent(state, agentId) {
  if (!state.agents[agentId]) {
    state.agents[agentId] = { backoffAttempt: 0, lastSuccessSeenAt: null };
  }
  return state.agents[agentId];
}

/** Idempotency check, same pattern as `sync.sh`'s `lastHandledOccurrence`: a run id, once handled, is never handled twice. */
export function isHandled(state, runId) {
  return Boolean(state.handledRunIds[runId]);
}

/** Marks a run handled with a small audit trail (what action, when) -- enough to answer "did the watchdog already see this" without growing unbounded per-run detail. */
export function markHandled(state, runId, { action, at }) {
  state.handledRunIds[runId] = { action, at };
}

/** Drops handled-run entries older than `retentionMs` so the state file does not grow forever. Safe because a run id older than the retention window will never be re-fetched by the watchdog's own lookback window anyway. */
export function pruneHandled(state, nowMs, retentionMs) {
  for (const [runId, entry] of Object.entries(state.handledRunIds)) {
    if (nowMs - Date.parse(entry.at) > retentionMs) delete state.handledRunIds[runId];
  }
}

export function getBackoffAttempt(state, agentId) {
  return ensureAgent(state, agentId).backoffAttempt;
}

export function bumpBackoffAttempt(state, agentId) {
  const agent = ensureAgent(state, agentId);
  agent.backoffAttempt += 1;
  return agent.backoffAttempt;
}

/** Resets the per-agent backoff counter to 0 -- called on any run the watchdog observes succeeding for that agent. */
export function resetBackoffAttempt(state, agentId, { seenAt } = {}) {
  const agent = ensureAgent(state, agentId);
  agent.backoffAttempt = 0;
  if (seenAt) agent.lastSuccessSeenAt = seenAt;
}

/** Records a pending pause->resume+wake action for an agent (one at a time; a new one overwrites a stale pending action for the same agent, e.g. a second quota failure before the first reset arrived). */
/**
 * The issue a heartbeat run was bound to, or `null` for a run the runtime
 * never bound to one.
 *
 * The read order deliberately mirrors the server's own
 * `readRunSourceIssueId` (`services/cross-issue-influence-limit.js`):
 * `contextSnapshot.issueId`, then `contextSnapshot.taskId`. That function is
 * what decides whether a run may `PATCH` an issue or comment on it, so
 * anything it would not accept must not be reported here as a binding.
 * `nativeIssueId` is checked last as a column-level fallback for runs whose
 * snapshot was written before the snapshot keys existed; it is the same issue
 * by definition, and returning it can only ever turn an unbound wake into a
 * bound one.
 */
export function readRunIssueId(run) {
  const snapshot = run?.contextSnapshot;
  const candidates = [
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot.issueId : null,
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot.taskId : null,
    run?.nativeIssueId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function setPendingAction(state, agentId, action) {
  state.pendingActions[agentId] = action;
}

export function clearPendingAction(state, agentId) {
  delete state.pendingActions[agentId];
}

/** Pending actions whose `scheduledAtMs` has arrived, as `[agentId, action]` pairs. */
export function duePendingActions(state, nowMs) {
  return Object.entries(state.pendingActions).filter(([, action]) => action.scheduledAtMs <= nowMs);
}
