#!/usr/bin/env node
// quota-retry-watchdog.mjs — DEBT-0001 (APP-45): replace Paperclip's own
// broken quota-failure retry scheduling at a boundary we own.
//
// THE BUG (see APP-45 closing comment, full text read before building this):
// Paperclip's adapter correctly classifies a Claude provider session-limit
// failure as `errorCode: "provider_quota"`, and the run's `error` text
// carries the real reset time ("...resets 9:50am (Asia/Calcutta)"). But
// Paperclip's own retry scheduler (`@paperclipai/server`
// services/recovery/service.js, 4000+ lines, not ours to patch) ignores
// that and re-queues the run under `scheduledRetryReason: "transient_failure"`
// on a short delay — observed live: 30s and 1.6s after a failure, against a
// reset ~6 hours away. 25 quota-failed runs burned 1,035K input tokens in
// one 24h window and returned nothing.
//
// WHY THIS IS A SEPARATE SCRIPT, NOT A PAPERCLIP PATCH:
// Per the founder's direction (and DEBT-0001 as recorded): patching
// Paperclip internals is fragile (silently overwritten by every
// `paperclipai update`) and duplicates control-plane logic AppForge does not
// own. `/api/llms/agent-configuration/claude_local.txt` exposes no retry,
// backoff, cooldown, or quota configuration surface at all — there is
// nothing to configure our way out of this. What Paperclip DOES expose, and
// what this script uses exclusively, is `agent pause` / `agent resume` /
// `agent wake` at board/operator level (confirmed working; an agent's own
// self-pause attempt 403s, board-level does not).
//
// WHAT THIS SCRIPT DOES, each pass:
//   1. Reads recent heartbeat-run history for every agent in the company
//      (GET /api/companies/{id}/heartbeat-runs — the same endpoint
//      session-burn.mjs uses for APP-45's measurement; there is no
//      `paperclipai` CLI subcommand that returns run history with
//      errorCode, confirmed via `paperclipai agent --help` / `activity --help`).
//   2. For each *newly seen* `provider_quota` failure (idempotent via a
//      handled-run-id state file, same pattern as sync.sh's
//      routine-sync-state.json): parses the reset time out of the run's own
//      `error` text, pauses the agent immediately (stopping Paperclip's
//      scheduler from re-queuing it early), and schedules an explicit
//      resume+wake for reset-time + a clock-skew buffer.
//   3. For each *newly seen* genuinely-retryable non-quota failure
//      (`process_lost` — see lib/quota-retry-watchdog.mjs for why that is
//      the only code in this bucket), does the same pause-then-scheduled-
//      resume dance, but computes the delay with real exponential backoff +
//      full jitter instead of trusting Paperclip's default cadence.
//   4. On any run the watchdog sees succeed for an agent, resets that
//      agent's backoff attempt counter to 0.
//   5. Executes any previously-scheduled resume+wake whose time has arrived.
//
// Run modes:
//   node scripts/quota-retry-watchdog.mjs --once            # single pass, then exit (what the launchd job runs)
//   node scripts/quota-retry-watchdog.mjs --once --dry-run  # log what it WOULD do, no pause/resume/wake calls
//
// State: state/quota-retry-watchdog-state.json (handled run ids, per-agent
// backoff attempt counts, pending scheduled resume+wake actions).
// Log: logs/quota-retry-watchdog.log (every detection, parse, pause,
// resume, wake, and backoff decision — plain appended lines, one per
// action, so `tail -f` during an incident is legible without jq).
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseResetTime,
  computeBackoffDelayMs,
  classifyForWatchdog,
  emptyState,
  isHandled,
  markHandled,
  pruneHandled,
  getBackoffAttempt,
  bumpBackoffAttempt,
  resetBackoffAttempt,
  setPendingAction,
  clearPendingAction,
  duePendingActions,
  readRunIssueId,
  recordWatchdogPause,
  clearWatchdogPause,
  getWatchdogPause,
  overduePauses,
} from './lib/quota-retry-watchdog.mjs';
import {
  partitionRecoveryCollateral,
  formatCollateralReport,
  formatBoardOnlyReport,
  pausedRunIdsFromState,
} from './lib/quota-pause-collateral.mjs';
import {
  notifierConfigFromEnv,
  pingPassSucceeded,
  alertPassFailed,
  notifyRecovered,
  planFailureAlert,
  planRecovery,
} from './lib/watchdog-notify.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_COMPANY_ID = '18b2b6ef-fbaa-48d1-acf4-168841c269ae'; // AppForge AI
const DEFAULT_API_BASE = 'http://127.0.0.1:3100'; // loopback-only, per README
const DEFAULT_STATE_FILE = join(REPO_ROOT, 'state', 'quota-retry-watchdog-state.json');
const DEFAULT_LOG_FILE = join(REPO_ROOT, 'logs', 'quota-retry-watchdog.log');
const DEFAULT_CLAUDE_CONFIG_DIR = join(REPO_ROOT, '.claude-appforge');
const PAPERCLIPAI_BIN = process.env.PAPERCLIPAI_BIN || join(process.env.HOME || '', '.local/bin/paperclipai');

// Reset-time buffer: absorbs clock skew between this Mac and the provider.
// Spec asked for 60-90s; 90s chosen (the more conservative end — a late
// resume costs nothing, an early one re-triggers the exact bug this exists
// to prevent).
const QUOTA_RESUME_BUFFER_MS = 90_000;

// If the reset time cannot be parsed out of the error text (format change
// upstream, unexpected locale, etc.), fall back to a fixed wait rather than
// either (a) never resuming the agent, or (b) resuming immediately and
// reproducing the bug. 15 minutes is short enough that the agent is not
// stuck for hours, long enough that it is not the same "retry in 30s" bug
// in a trenchcoat.
const QUOTA_FALLBACK_WAIT_MS = 15 * 60_000;

// Backoff for `process_lost` and future retryable-transient codes. Full
// jitter, see lib/quota-retry-watchdog.mjs for the AWS source and reasoning.
// Base 10s, cap 30min: process_lost is a crashed-process retry, not a
// multi-hour lockout like quota, so the ceiling is much lower.
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// How far back to look at run history each pass. Generous relative to the
// polling interval (1-2min) so a missed poll (Mac asleep, script crash)
// still catches up on the next run; bounded so the fetch+filter stays cheap.
const DEFAULT_LOOKBACK_MINUTES = 180;

// APP-103 / DEBT-0003 -- the bounded-pause invariant. How far past its own
// scheduled resume a watchdog-owned pause may drift before the next pass
// force-resumes it regardless of whether the original reason is still
// understood. 10 minutes is ~6 polling intervals (StartInterval: 90), so a
// normal due-fire always wins this race comfortably; anything still parked
// past it is parked because something broke, not because it is early.
const OVERDUE_RESUME_MARGIN_MS = 10 * 60_000;

// Absolute ceiling on how long this watchdog will leave an agent parked,
// independent of what its schedule claims. It only fires when the schedule
// itself is wrong (corrupted state, a clock jump, a mangled parse).
//
// Backoff pauses are capped at BACKOFF_CAP_MS (30min), so 12h is far outside
// anything legitimate. Quota pauses are not: a weekly limit resets days out,
// and a daily reset that rolled over can be ~24h away, so they get 8 days --
// the longest real reset (a week) plus a day of slack. A 12h ceiling there
// force-resumes the agent into the same limit every 12h (PR #14 review).
const MAX_PAUSE_MS = 12 * 3_600_000;
const MAX_QUOTA_PAUSE_MS = 8 * 86_400_000;

// How long a handled-run-id stays in the state file. Must comfortably
// exceed DEFAULT_LOOKBACK_MINUTES so a run never "ages out" of the handled
// set while still inside the window the watchdog re-scans.
const HANDLED_RETENTION_MS = 7 * 86_400_000;

function parseArgs(argv) {
  const args = {
    once: false,
    dryRun: false,
    companyId: process.env.PAPERCLIP_COMPANY_ID || DEFAULT_COMPANY_ID,
    apiBase: (process.env.PAPERCLIP_API_URL || DEFAULT_API_BASE).replace(/\/$/, ''),
    apiKey: process.env.PAPERCLIP_API_KEY || null,
    stateFile: DEFAULT_STATE_FILE,
    logFile: DEFAULT_LOG_FILE,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR,
    lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--company-id') args.companyId = argv[(i += 1)];
    else if (arg === '--api-base') args.apiBase = argv[(i += 1)].replace(/\/$/, '');
    else if (arg === '--state-file') args.stateFile = argv[(i += 1)];
    else if (arg === '--log-file') args.logFile = argv[(i += 1)];
    else if (arg === '--lookback-minutes') args.lookbackMinutes = Number(argv[(i += 1)]);
    else {
      console.error(`quota-retry-watchdog: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

// -- logging ------------------------------------------------------------

function makeLogger(logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(logFile, stamped + '\n');
    console.log(stamped);
  };
}

// -- state ----------------------------------------------------------------

function loadState(stateFile) {
  if (!existsSync(stateFile)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      ...emptyState(),
      ...parsed,
      handledRunIds: parsed.handledRunIds || {},
      agents: parsed.agents || {},
      pendingActions: parsed.pendingActions || {},
      pausedAgents: parsed.pausedAgents || {},
    };
  } catch (err) {
    // A corrupt state file must never crash the watchdog — worst case we
    // re-handle a run we already handled once (idempotent CLI calls) rather
    // than stop reacting to quota failures entirely.
    return emptyState();
  }
}

// Write-then-rename, not a plain write: a crash (or a launchd SIGKILL at
// ExitTimeOut) partway through a direct `writeFileSync` leaves a truncated
// JSON file, which `loadState` correctly refuses to parse and replaces with
// an empty state -- and an empty state is precisely how the watchdog forgets
// that it has an agent parked (APP-103). `rename` within the same directory
// is atomic, so the state file is only ever the old complete version or the
// new complete version.
function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, stateFile);
  } catch (err) {
    // Do not leave a half-written or orphaned .tmp next to the real file.
    rmSync(tmp, { force: true });
    throw err;
  }
}

// -- Paperclip HTTP API (read-only: run + agent listing) ------------------

async function fetchJson(url, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchRunsAndAgents({ apiBase, companyId, apiKey }) {
  const [runs, agentsRaw] = await Promise.all([
    fetchJson(`${apiBase}/api/companies/${companyId}/heartbeat-runs`, apiKey),
    fetchJson(`${apiBase}/api/companies/${companyId}/agents`, apiKey),
  ]);
  const agents = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw.agents || [];
  return { runs, agents };
}

// Every issue that still carries an active recovery action naming this agent
// as the return owner. Deliberately NOT filtered to `status=blocked`: the
// re-block loop can leave the action active after the status has already
// moved on, and those orphans are the ones nobody can see.
async function fetchAgentRecoveryCandidates({ apiBase, companyId, apiKey }, agentId) {
  const raw = await fetchJson(`${apiBase}/api/companies/${companyId}/issues?limit=1000`, apiKey);
  const issues = Array.isArray(raw) ? raw : raw.issues || [];
  return issues.filter((issue) => {
    const action = issue.activeRecoveryAction;
    if (!action || !['active', 'escalated'].includes(action.status)) return false;
    return action.returnOwnerAgentId === agentId || issue.assigneeAgentId === agentId;
  });
}

// WHY THIS DAEMON ONLY REPORTS THE COLLATERAL AND NEVER CLEARS IT
//
// APP-164's board input asked this watchdog to resolve these itself on resume.
// It cannot, and the reason is structural rather than a policy preference.
//
// The safe hand-back route is gated by `assertSafeRecoveryHandBackGates`,
// which requires the caller to BE the issue's assignee / the action's recorded
// return owner. Agent credentials are run-scoped JWTs whose `run_id` claim must
// resolve to a live run (docs/paperclip-run-binding.md); a long-lived daemon
// cannot hold one, and there is no per-agent key store for it to read. So the
// only credential available to this process is no credential at all -- the
// loopback path that `local_trusted` mode accepts as an instance-admin BOARD
// actor. That write would succeed and would be recorded as the founder
// personally disposing of a recovery action, every 90 seconds, unread. The
// hand-back needs no board authority in the first place
// (`stranded_assigned_issue` is not an execution-reconciliation cause), so that
// attribution would be false, not merely generous.
//
// Hence the split: this daemon DETECTS and names the collateral, in the log and
// in the wake reason it sends. The woken agent clears its own with its own
// run-scoped credential via `scripts/clear-my-recovery-collateral.mjs`. Same
// drain, correct attribution. Do not add a resolve path here.

// -- paperclipai CLI (writes: pause / resume / wake) -----------------------

async function paperclipCli(args, { claudeConfigDir, dryRun, log, describe }) {
  if (dryRun) {
    log(`DRY-RUN would run: paperclipai ${args.join(' ')}`);
    return null;
  }
  try {
    const { stdout } = await execFileAsync(PAPERCLIPAI_BIN, args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
      timeout: 30_000,
    });
    return stdout;
  } catch (err) {
    log(`ERROR ${describe} failed: ${err.message}`);
    throw err;
  }
}

function pauseAgent(agentId, ctx) {
  return paperclipCli(['agent', 'pause', agentId], { ...ctx, describe: `pause ${agentId}` });
}
function resumeAgent(agentId, ctx) {
  return paperclipCli(['agent', 'resume', agentId], { ...ctx, describe: `resume ${agentId}` });
}
// A wake with no `issueId` in its payload produces a run the server does not
// consider task-bound: `contextSnapshot` carries only the wake reason/source,
// so `readRunSourceIssueId` returns null and every `PATCH /api/issues/:id`
// and `POST /api/issues/:id/comments` from that run is refused with
// `403 cross_issue_influence_run_context_required` -- even on the issue the
// run itself checked out, because the limiter's same-issue exemption needs a
// source issue to compare against (APP-181). Forwarding the interrupted run's
// own issue restores the binding the interruption lost.
//
// This is not a widening of what the agent may do: the issue is the one that
// agent was already working, the wake route's own execution-blocker check
// still applies, and an agent with no recorded issue is still woken unbound.
function wakeAgent(agentId, reason, ctx, { issueId = null } = {}) {
  const args = ['agent', 'wake', agentId, '--source', 'automation', '--trigger', 'system', '--reason', reason];
  if (issueId) args.push('--payload', JSON.stringify({ issueId }));
  return paperclipCli(args, { ...ctx, describe: `wake ${agentId}` });
}

// The pause we just lifted cancelled this agent's in-flight runs with
// `errorCode: agent_paused`, which Paperclip's recovery sweep cannot classify
// as a quota wait -- so it board-escalated each one to `blocked` (APP-164).
// Find them BEFORE the wake, so the wake itself can tell the agent what to
// clear rather than leaving it to notice. Returns '' when there is nothing to
// say, and never throws: reporting is diagnostic, and a failure here must not
// strand a resume that already succeeded, nor block the wake.
async function collateralNoteFor(args, state, agentId, { name, issueId, log }) {
  try {
    const candidates = await fetchAgentRecoveryCandidates(args, agentId);
    const { handBack, boardOnly } = partitionRecoveryCollateral(candidates, {
      pausedRunIds: pausedRunIdsFromState(state),
    });
    for (const line of formatCollateralReport(handBack, { agentName: name })) log(line);
    for (const line of formatBoardOnlyReport(boardOnly, { agentName: name })) log(line);
    if (!handBack.length) return '';
    // `--resolve` needs a TASK-BOUND run (it exits 3 otherwise). Whether
    // this wake produces one is exactly what `issueId` decides, so the
    // advice differs: a bound wake can drain the collateral in place, an
    // unbound one cannot and must not be told to try.
    return (
      ` Note: ${handBack.length} of your issue(s) (${handBack.map((e) => e.identifier).join(', ')}) ` +
      'were set to blocked by the recovery sweep misreading that pause cancellation, not by a real ' +
      'dependency. ' +
      (issueId
        ? 'This wake is task-bound, so you can clear them here: run `node ' +
          'scripts/clear-my-recovery-collateral.mjs --resolve`.'
        : 'This wake is agent-level and UNBOUND, so `node scripts/clear-my-recovery-collateral.mjs ' +
          '--resolve` will refuse with exit 3 — it cannot attribute the write. Run it report-only ' +
          'here to see the list, and leave the clearing to a task-bound heartbeat.') +
      ' Do not release any checkout you take on them (release unassigns and orphans them to the board).'
    );
  } catch (err) {
    log(`COLLATERAL lookup failed agent=${name}: ${err.message}`);
    return '';
  }
}

function wakeLogLine(name, reason, collateralNote, issueId) {
  return (
    `WAKE agent=${name} reason="${reason}"${collateralNote ? ' (+collateral note)' : ''} ` +
    (issueId
      ? `issue=${issueId} (task-bound: the resumed run can PATCH and comment)`
      : 'issue=none (UNBOUND: the resumed run will be refused issue PATCH/comment -- APP-181)')
  );
}

// -- bounded-pause bookkeeping (APP-103) ------------------------------------

/**
 * Records, or refreshes, this watchdog's claim that `agentId` is parked.
 *
 * The `alreadyPaused` distinction matters and is the reason this is a
 * function rather than a bare `recordWatchdogPause` call. An agent can be
 * paused for two very different reasons:
 *
 *  - this watchdog parked it on an earlier pass (there is already a registry
 *    entry) -- refresh the schedule, keep the original `pausedAtMs`, and keep
 *    owning it;
 *  - a human operator parked it deliberately (no registry entry) -- do NOT
 *    take ownership. The bounded-pause sweep force-resumes what it owns, and
 *    silently undoing a founder's deliberate pause would be a far worse bug
 *    than the one this is fixing.
 */
function notePause(state, agentId, { alreadyPaused, nowMs, scheduledResumeAtMs, kind, runId, issueId = null, log, name }) {
  if (alreadyPaused && !getWatchdogPause(state, agentId)) {
    log(
      `PAUSE-OWNERSHIP agent=${name} was already paused by someone other than this watchdog — ` +
        `scheduling its resume but not claiming the pause (it will not be force-resumed by the sweep)`,
    );
    return;
  }
  recordWatchdogPause(state, agentId, { pausedAtMs: nowMs, scheduledResumeAtMs, kind, runId, issueId, stillPaused: alreadyPaused });
}

// -- main pass --------------------------------------------------------------

/**
 * One watchdog pass.
 *
 * `recordError` (APP-103) collects non-fatal, per-agent failures so a single
 * broken `resume` no longer aborts the whole pass. Before this, one failing
 * CLI call threw out of `runOnce`, which meant (a) nothing after it ran and
 * (b) `saveState` was never reached, so the pass's bookkeeping was discarded
 * too. It is optional so existing callers/tests that only pass `{ log }`
 * keep working; `main` supplies one and uses it to decide whether the pass
 * counts as healthy for liveness-signalling purposes.
 */
export async function runOnce(args, { log, recordError = () => {} }) {
  const nowMs = Date.now();
  const state = loadState(args.stateFile);
  const cliCtx = { claudeConfigDir: args.claudeConfigDir, dryRun: args.dryRun, log };

  const { runs, agents } = await fetchRunsAndAgents(args);
  const agentById = Object.fromEntries(agents.map((a) => [a.id, a]));
  const agentName = (id) => agentById[id]?.name || id;

  const sinceMs = nowMs - args.lookbackMinutes * 60_000;
  const recentRuns = runs
    .filter((r) => Date.parse(r.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const run of recentRuns) {
    const outcome = classifyForWatchdog(run);
    if (!outcome) continue;

    if (outcome === 'succeeded') {
      if (isHandled(state, `success:${run.id}`)) continue;
      resetBackoffAttempt(state, run.agentId, { seenAt: run.finishedAt || run.createdAt });
      markHandled(state, `success:${run.id}`, { action: 'reset_backoff', at: new Date(nowMs).toISOString() });
      continue;
    }

    if (isHandled(state, run.id)) continue;

    const name = agentName(run.agentId);
    const alreadyPaused = agentById[run.agentId]?.status === 'paused';

    if (outcome === 'quota') {
      const parsed = parseResetTime(run.error, nowMs);
      let resetAtMs;
      if (parsed) {
        log(
          `QUOTA detected agent=${name} run=${run.id} error="${run.error}" ` +
            `parsedReset=${new Date(parsed.resetAtMs).toISOString()} tz=${parsed.timeZone} rolledOver=${parsed.rolledOverToNextDay}`,
        );
        resetAtMs = parsed.resetAtMs;
      } else {
        log(
          `QUOTA detected agent=${name} run=${run.id} error="${run.error}" ` +
            `-- could not parse a reset time, falling back to a fixed ${QUOTA_FALLBACK_WAIT_MS / 60_000}min wait`,
        );
        resetAtMs = nowMs + QUOTA_FALLBACK_WAIT_MS;
      }
      const scheduledAtMs = resetAtMs + QUOTA_RESUME_BUFFER_MS;

      if (alreadyPaused) {
        log(`QUOTA agent=${name} already paused, skipping duplicate pause call`);
      } else {
        try {
          await pauseAgent(run.agentId, cliCtx);
        } catch (err) {
          recordError(`pause ${name} (quota run=${run.id}) failed: ${err.message}`);
          continue; // not marked handled -- the next pass retries this run
        }
        log(`QUOTA paused agent=${name} (run=${run.id}) so Paperclip's scheduler cannot retry it early`);
      }

      notePause(state, run.agentId, {
        alreadyPaused,
        nowMs,
        scheduledResumeAtMs: scheduledAtMs,
        kind: 'quota',
        runId: run.id,
        issueId: readRunIssueId(run),
        log,
        name,
      });

      setPendingAction(state, run.agentId, {
        kind: 'quota',
        runId: run.id,
        issueId: readRunIssueId(run),
        scheduledAtMs,
        reason: 'resuming after provider_quota reset (watchdog)',
      });
      markHandled(state, run.id, { action: 'quota_paused_scheduled', at: new Date(nowMs).toISOString() });
      log(`QUOTA scheduled resume+wake for agent=${name} at ${new Date(scheduledAtMs).toISOString()} (reset + ${QUOTA_RESUME_BUFFER_MS / 1000}s buffer)`);
      continue;
    }

    if (outcome === 'transient') {
      const attempt = getBackoffAttempt(state, run.agentId);
      const delayMs = computeBackoffDelayMs(attempt, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
      const scheduledAtMs = nowMs + delayMs;
      log(
        `TRANSIENT detected agent=${name} run=${run.id} errorCode=${run.errorCode} attempt=${attempt} ` +
          `-- full-jitter backoff chose ${Math.round(delayMs / 1000)}s (base=${BACKOFF_BASE_MS}ms cap=${BACKOFF_CAP_MS}ms)`,
      );

      if (alreadyPaused) {
        log(`TRANSIENT agent=${name} already paused, skipping duplicate pause call`);
      } else {
        try {
          await pauseAgent(run.agentId, cliCtx);
        } catch (err) {
          recordError(`pause ${name} (transient run=${run.id}) failed: ${err.message}`);
          continue; // not marked handled -- the next pass retries this run
        }
        log(`TRANSIENT paused agent=${name} (run=${run.id}) pending backoff`);
      }

      notePause(state, run.agentId, {
        alreadyPaused,
        nowMs,
        scheduledResumeAtMs: scheduledAtMs,
        kind: 'backoff',
        runId: run.id,
        issueId: readRunIssueId(run),
        log,
        name,
      });

      setPendingAction(state, run.agentId, {
        kind: 'backoff',
        runId: run.id,
        issueId: readRunIssueId(run),
        scheduledAtMs,
        reason: `resuming after ${run.errorCode} backoff attempt ${attempt} (watchdog)`,
      });
      bumpBackoffAttempt(state, run.agentId);
      markHandled(state, run.id, { action: 'transient_backoff_scheduled', at: new Date(nowMs).toISOString() });
      log(`TRANSIENT scheduled resume+wake for agent=${name} at ${new Date(scheduledAtMs).toISOString()}`);
    }
  }

  // Fire any scheduled resume+wake whose time has arrived. A failure here is
  // logged and recorded but does NOT abort the pass: the pending action is
  // left in place so the next pass retries it, and the bounded-pause sweep
  // below is what guarantees the agent gets out eventually even if this keeps
  // failing.
  for (const [agentId, action] of duePendingActions(state, nowMs)) {
    const name = agentName(agentId);
    try {
      await resumeAgent(agentId, cliCtx);
    } catch (err) {
      recordError(`resume ${name} (pending ${action.kind} for run=${action.runId}) failed: ${err.message}`);
      continue;
    }
    log(`RESUME agent=${name} (was pending ${action.kind} for run=${action.runId})`);
    // `action.issueId` is absent for pending actions written by a watchdog
    // build older than APP-181, and null for an interrupted run the runtime
    // never bound. Both still get woken -- unbound, as before -- but the log
    // says so, because that run will hit the 403 this binding exists to
    // prevent and the operator should not have to infer it.
    const issueId = action.issueId || null;
    const collateralNote = await collateralNoteFor(args, state, agentId, { name, issueId, log });

    // Only now, after the collateral lookup has read `handledRunIds`, and
    // before the wake: the resume already landed, so a wake that fails below
    // must not leave either record claiming the agent is still parked.
    clearPendingAction(state, agentId);
    clearWatchdogPause(state, agentId);
    try {
      await wakeAgent(agentId, `${action.reason}${collateralNote}`, cliCtx, { issueId });
      log(wakeLogLine(name, action.reason, collateralNote, issueId));
    } catch (err) {
      // The resume already landed, so the agent is no longer parked -- it
      // will pick work up on its own next heartbeat. A failed wake is a
      // latency problem, not the stuck-agent problem this watchdog exists
      // to prevent, so it must not undo the resume bookkeeping above.
      recordError(`wake ${name} failed after a successful resume: ${err.message}`);
    }
  }

  // --- APP-103 / DEBT-0003: the bounded-pause invariant ------------------
  //
  // Everything above depends on bookkeeping that can go wrong: a pending
  // action can be lost with the state file, a `resume` can fail every time,
  // a reset time can be parsed into nonsense. This sweep is the backstop
  // that does not depend on any of that being right -- it asks only "is an
  // agent still parked because of us, long past when it should have been?"
  // and, if so, resumes it. FAIL OPEN: a premature resume costs one failed
  // run; a missed resume costs an agent indefinitely.
  for (const [agentId, entry, why] of overduePauses(state, nowMs, {
    overdueMarginMs: OVERDUE_RESUME_MARGIN_MS,
    maxPauseMs: MAX_PAUSE_MS,
    maxQuotaPauseMs: MAX_QUOTA_PAUSE_MS,
  })) {
    const name = agentName(agentId);
    const known = agentById[agentId];

    if (!known) {
      // The agent no longer exists in the company (deleted, moved). Nothing
      // to resume; drop the registry entry so it stops being swept forever.
      log(`PAUSE-SWEEP agent=${agentId} is no longer in the company, dropping stale pause record`);
      clearWatchdogPause(state, agentId);
      clearPendingAction(state, agentId);
      continue;
    }

    if (known.status !== 'paused') {
      // Someone (an operator, or a resume we already issued) got it out
      // already. Reconcile silently-ish rather than issuing a redundant
      // resume.
      log(`PAUSE-SWEEP agent=${name} is already ${known.status}, clearing stale pause record (${why})`);
      clearWatchdogPause(state, agentId);
      clearPendingAction(state, agentId);
      continue;
    }

    log(`PAUSE-SWEEP force-resuming agent=${name} — ${why} (pause kind=${entry.kind} run=${entry.runId})`);
    try {
      await resumeAgent(agentId, cliCtx);
    } catch (err) {
      // Keep the registry entry: this is exactly the persistently-failing
      // resume case, and the entry is the only thing that will make the
      // next pass try again. Alert on it — a force-resume that cannot land
      // is an agent nobody is getting back without a human.
      recordError(`FORCE-RESUME of paused agent ${name} failed (${why}): ${err.message}`);
      continue;
    }
    log(`PAUSE-SWEEP resumed agent=${name}`);
    // Same APP-181 binding as the due-fire path. Prefer the registry entry's
    // own issueId: the sweep's whole job is to cope with a pending action that
    // was lost, and the registry is what survives that.
    const issueId = entry.issueId || state.pendingActions?.[agentId]?.issueId || null;
    const reason = `force-resuming a pause the watchdog could not account for: ${why}`;
    const collateralNote = await collateralNoteFor(args, state, agentId, { name, issueId, log });
    clearWatchdogPause(state, agentId);
    clearPendingAction(state, agentId);
    try {
      await wakeAgent(agentId, `${reason}${collateralNote}`, cliCtx, { issueId });
      log(`PAUSE-SWEEP ${wakeLogLine(name, reason, collateralNote, issueId)}`);
    } catch (err) {
      recordError(`wake ${name} failed after a successful force-resume: ${err.message}`);
    }
  }

  pruneHandled(state, nowMs, HANDLED_RETENTION_MS);
  if (!args.dryRun) saveState(args.stateFile, state);
  return state;
}

// -- pass reporting (APP-103; throttled per the PR #14 review) --------------

// Where the alert throttle's record lives: beside the state file, but separate
// from it, because the state file is only written by a pass that got far
// enough to save -- and a pass that threw is exactly the one that must alert.
function alertStateFileFor(stateFile) {
  return `${stateFile.replace(/\.json$/, '')}-alerts.json`;
}

function readAlertState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Missing or unreadable reads as "not currently failing", so the next
    // failure pushes. Losing the record can cost a duplicate alert, never a
    // missed one.
    return null;
  }
}

/**
 * Reports one finished pass: `failure` is null for a healthy pass, otherwise
 * a one-line reason. The healthchecks.io ping (success or `/fail`) goes out
 * every pass; the ntfy push is throttled by `planFailureAlert`, so a
 * persistent failure is one push and then at most hourly, not one per 90s.
 * Never throws: monitoring must not become an availability failure.
 */
export async function reportPassOutcome(notifier, { failure }, { alertStateFile, nowMs = Date.now(), fetchFn = fetch, log }) {
  const prev = readAlertState(alertStateFile);
  let next;
  if (failure) {
    const plan = planFailureAlert(prev, { nowMs, reason: failure });
    next = plan.next;
    if (!plan.push) {
      log?.(`NOTIFY ntfy push suppressed (same failure as ${Math.round((nowMs - next.lastPushAtMs) / 60_000)}min ago; repeats at most hourly)`);
    }
    await alertPassFailed(notifier, failure, { fetchFn, log, push: plan.push });
  } else {
    const plan = planRecovery(prev);
    next = plan.next;
    await pingPassSucceeded(notifier, { fetchFn, log });
    if (plan.push) await notifyRecovered(notifier, { fetchFn, log, suppressed: prev?.suppressed || 0 });
  }
  if (!notifier.enabled) return;
  try {
    saveState(alertStateFile, next);
  } catch (err) {
    log?.(`NOTIFY could not persist alert state (${err.message}); the next failure will push again`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = makeLogger(args.logFile);

  // APP-103 / DEBT-0003: liveness signalling, same pattern backup.sh and
  // sync.sh already use. Degrades to a silent no-op when the env vars are
  // absent (they reach the process through the plist template, filled from
  // `.envrc` by install-plists.sh at install time -- see infra/macos/README.md),
  // so an un-provisioned watchdog still does its real job without crashing.
  const notifier = notifierConfigFromEnv(process.env);
  const alertStateFile = alertStateFileFor(args.stateFile);
  const errors = [];
  const recordError = (message) => {
    errors.push(message);
    log(`ERROR ${message}`);
  };

  log(`--- pass start (dryRun=${args.dryRun}, liveness=${notifier.enabled ? 'on' : 'off (env not set)'}) ---`);
  try {
    await runOnce(args, { log, recordError });
  } catch (err) {
    log(`FATAL ${err.stack || err.message}`);
    process.exitCode = 1;
    await reportPassOutcome(notifier, { failure: `pass threw: ${err.message}` }, { alertStateFile, log });
    log('--- pass failed ---');
    return;
  }

  if (errors.length > 0) {
    // The pass finished -- every agent that could be handled was handled --
    // but at least one CLI call failed. That is not a healthy pass: the most
    // likely thing behind it is a `resume` that cannot land, which is the
    // stuck-agent case this whole issue is about. Alert, and deliberately do
    // NOT send the success ping, so the healthchecks.io check goes red.
    process.exitCode = 1;
    await reportPassOutcome(notifier, { failure: `${errors.length} error(s): ${errors.join('; ')}` }, { alertStateFile, log });
    log(`--- pass complete with ${errors.length} error(s) ---`);
    return;
  }

  await reportPassOutcome(notifier, { failure: null }, { alertStateFile, log });
  log('--- pass complete ---');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
