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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
} from './lib/quota-retry-watchdog.mjs';

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
    return { ...emptyState(), ...parsed, handledRunIds: parsed.handledRunIds || {}, agents: parsed.agents || {}, pendingActions: parsed.pendingActions || {} };
  } catch (err) {
    // A corrupt state file must never crash the watchdog — worst case we
    // re-handle a run we already handled once (idempotent CLI calls) rather
    // than stop reacting to quota failures entirely.
    return emptyState();
  }
}

function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
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

// -- main pass --------------------------------------------------------------

export async function runOnce(args, { log }) {
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
        await pauseAgent(run.agentId, cliCtx);
        log(`QUOTA paused agent=${name} (run=${run.id}) so Paperclip's scheduler cannot retry it early`);
      }

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
        await pauseAgent(run.agentId, cliCtx);
        log(`TRANSIENT paused agent=${name} (run=${run.id}) pending backoff`);
      }

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

  // Fire any scheduled resume+wake whose time has arrived.
  for (const [agentId, action] of duePendingActions(state, nowMs)) {
    const name = agentName(agentId);
    await resumeAgent(agentId, cliCtx);
    log(`RESUME agent=${name} (was pending ${action.kind} for run=${action.runId})`);
    // `action.issueId` is absent for pending actions written by a watchdog
    // build older than APP-181, and null for an interrupted run the runtime
    // never bound. Both still get woken -- unbound, as before -- but the log
    // says so, because that run will hit the 403 this binding exists to
    // prevent and the operator should not have to infer it.
    const issueId = action.issueId || null;
    await wakeAgent(agentId, action.reason, cliCtx, { issueId });
    log(
      `WAKE agent=${name} reason="${action.reason}" ` +
        (issueId
          ? `issue=${issueId} (task-bound: the resumed run can PATCH and comment)`
          : 'issue=none (UNBOUND: the resumed run will be refused issue PATCH/comment -- APP-181)'),
    );
    clearPendingAction(state, agentId);
  }

  pruneHandled(state, nowMs, HANDLED_RETENTION_MS);
  if (!args.dryRun) saveState(args.stateFile, state);
  return state;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = makeLogger(args.logFile);
  log(`--- pass start (dryRun=${args.dryRun}) ---`);
  try {
    await runOnce(args, { log });
    log('--- pass complete ---');
  } catch (err) {
    log(`FATAL ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
