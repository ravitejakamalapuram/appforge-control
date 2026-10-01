#!/usr/bin/env node
// merge-worker.mjs — APP-310. One pass of the deterministic merge worker: find
// CEO `DECISION: approve merge of <url> at <sha>` comments in Paperclip and
// merge each PR that passes every check in config/merge-policy.yaml. No LLM.
// The rules live in lib/merge-worker.mjs; this file only wires I/O.
//
//   node scripts/merge-worker.mjs            # one pass (what launchd runs, via infra/macos/merge-worker.sh)
//   node scripts/merge-worker.mjs --dry-run  # print each decision; no GitHub write, no comment, no state write
//
// Env: GH_TOKEN (an appforge-agents App installation token, minted by the
// wrapper), PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, optional PAPERCLIP_API_KEY,
// NTFY_TOPIC, HEALTHCHECKS_PING_URL_MERGE_WORKER.
//
// Exit 0: pass completed (merges and refusals are both a completed pass).
// Exit 1: the pass, or one approval, failed for a reason that is not a
// decision about the PR (API down, bad policy). The approval stays pending.
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPolicy, runPass, emptyState, createPaperclipClient, createGithubWriteClient } from './lib/merge-worker.mjs';
import { planFailureAlert } from './lib/watchdog-notify.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    policy: { type: 'string', default: join(REPO_ROOT, 'config', 'merge-policy.yaml') },
    'state-file': { type: 'string', default: join(REPO_ROOT, 'state', 'merge-worker-state.json') },
    'log-file': { type: 'string', default: join(REPO_ROOT, 'logs', 'merge-worker.log') },
  },
});
const dryRun = args['dry-run'];

function log(line) {
  const text = `[${new Date().toISOString()}] merge-worker: ${dryRun ? 'DRY-RUN ' : ''}${line}`;
  process.stdout.write(`${text}\n`);
  if (dryRun) return;
  try {
    mkdirSync(dirname(args['log-file']), { recursive: true });
    appendFileSync(args['log-file'], `${text}\n`);
  } catch {
    // stdout is also captured by launchd; a log-file failure must not stop the pass
  }
}

async function ntfy(message) {
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic || dryRun) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: `AppForge merge worker: ${message}`.slice(0, 900), signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    log(`ntfy failed: ${err.message}`);
  }
}

function readState(file) {
  if (!existsSync(file)) return emptyState();
  return { ...emptyState(), ...JSON.parse(readFileSync(file, 'utf8')) };
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

async function main() {
  const nowMs = Date.now();
  const stateFile = args['state-file'];
  const state = readState(stateFile);
  let failure = null;
  try {
    const policy = loadPolicy(readFileSync(args.policy, 'utf8'));
    for (const v of ['GH_TOKEN', 'PAPERCLIP_API_URL', 'PAPERCLIP_COMPANY_ID']) {
      if (!process.env[v]) throw new Error(`${v} is not set`);
    }
    const { state: next, results } = await runPass({
      policy,
      paperclip: createPaperclipClient({
        apiBase: process.env.PAPERCLIP_API_URL.replace(/\/$/, ''),
        companyId: process.env.PAPERCLIP_COMPANY_ID,
        approverAgentId: policy.approver_agent_id,
        apiKey: process.env.PAPERCLIP_API_KEY || null,
      }),
      github: createGithubWriteClient({ token: process.env.GH_TOKEN }),
      state,
      nowMs,
      dryRun,
      log,
    });
    for (const r of results) {
      if (r.outcome === 'refused' || r.outcome === 'unverified') await ntfy(`${r.outcome.toUpperCase()} ${r.url}: ${r.reason}`);
      if (r.commentError) await ntfy(`${r.outcome} ${r.url} but the Paperclip comment failed: ${r.commentError}`);
    }
    const errors = results.filter((r) => r.outcome === 'error');
    if (errors.length > 0) failure = errors.map((r) => `${r.url}: ${r.reason}`).join('; ');
    Object.assign(state, next);
    log(`pass done: ${results.length} decision(s) looked at${results.length ? ` (${results.map((r) => r.outcome).join(', ')})` : ''}`);
  } catch (err) {
    failure = err.message;
  }

  if (failure) {
    log(`FAIL ${failure}`);
    const plan = planFailureAlert(state.alert, { nowMs, reason: failure });
    state.alert = plan.next;
    if (plan.push) await ntfy(`pass failed: ${failure}`);
  } else {
    state.alert = { failing: false };
    const hc = (process.env.HEALTHCHECKS_PING_URL_MERGE_WORKER || '').trim();
    if (hc && !dryRun) await fetch(hc, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
  if (!dryRun) writeState(stateFile, state);
  process.exit(failure ? 1 : 0);
}

main();
