#!/usr/bin/env node
// Reconcile config/agents.yaml -> Paperclip runtimeConfig.heartbeat (APP-39).
//
// Companion to sync-agent-turn-limits.mjs (APP-29). That one owns
// adapterConfig.maxTurnsPerRun - how long a run that has already started may
// continue. This one owns runtimeConfig.heartbeat - whether an idle agent wakes
// on a clock (`enabled`) and how many of its queued runs may start at once
// (`maxConcurrentRuns`). The two are independent; raising a turn cap never made
// an idle agent wake.
//
//   node scripts/sync-agent-heartbeat.mjs            # report drift only
//   node scripts/sync-agent-heartbeat.mjs --apply    # write the drift out
//   node scripts/sync-agent-heartbeat.mjs --apply --agent builder
//
// Needs PAPERCLIP_API_URL + PAPERCLIP_COMPANY_ID, and PAPERCLIP_API_KEY with
// `agents:configure` (a board key, or an agent key holding that grant).
//
// Without that grant an agent key cannot even READ a peer's runtimeConfig - the
// value comes back as `{}`. This script treats that as "not readable" and
// REFUSES to write, because runtimeConfig is replaced wholesale and writing
// blind would destroy a config it never saw. That refusal is the control plane
// working as designed, not a bug here: rerun as an actor that holds the grant.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDesiredHeartbeats,
  matchAgents,
  isInSync,
  heartbeatPatchBody,
} from './lib/agent-heartbeat.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`sync-agent-heartbeat: ${name} is not set`);
    process.exit(2);
  }
  return value;
}

async function api(path, init = {}) {
  const base = requireEnv('PAPERCLIP_API_URL').replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnv('PAPERCLIP_API_KEY')}`,
      'Content-Type': 'application/json',
      ...(process.env.PAPERCLIP_RUN_ID ? { 'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

const apply = process.argv.includes('--apply');
const agentFlag = process.argv.indexOf('--agent');
const onlyAgent = agentFlag === -1 ? null : process.argv[agentFlag + 1]?.toLowerCase();

const desired = resolveDesiredHeartbeats(readFileSync(join(REPO_ROOT, 'config/agents.yaml'), 'utf8'));
const companyId = requireEnv('PAPERCLIP_COMPANY_ID');

const list = await api(`/api/companies/${companyId}/agents`);
if (!list.ok) {
  console.error(`sync-agent-heartbeat: cannot list agents (HTTP ${list.status})`, list.body);
  process.exit(1);
}

// The list route redacts runtimeConfig; the per-agent route returns it for
// agents this actor may read. Fetch per agent so drift detection is real.
const liveAgents = [];
for (const agent of list.body) {
  const detail = await api(`/api/agents/${agent.id}`);
  liveAgents.push(detail.ok ? { ...agent, ...detail.body } : agent);
}

let failures = 0;
let drift = 0;
let unreadable = 0;
for (const row of matchAgents(desired, liveAgents)) {
  if (onlyAgent && row.name !== onlyAgent) continue;
  const want = `timer=${row.enabled} concurrency=${row.maxConcurrentRuns}`;
  const label = `${row.name.padEnd(8)} want=${want.padEnd(28)}`;

  if (!row.id) {
    console.error(`${label} NO MATCHING PAPERCLIP AGENT`);
    failures += 1;
    continue;
  }
  if (!row.writable) {
    // Not counted as drift: we genuinely do not know whether it drifted.
    unreadable += 1;
    console.log(`${label} SKIPPED - ${row.reason}`);
    continue;
  }
  if (isInSync(row)) {
    console.log(`${label} ok`);
    continue;
  }
  drift += 1;
  const currentLabel = `timer=${row.currentEnabled} concurrency=${row.currentMaxConcurrentRuns}`;

  if (!apply) {
    console.log(`${label} DRIFT (is ${currentLabel}) - rerun with --apply`);
    continue;
  }
  const patch = await api(`/api/agents/${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify(heartbeatPatchBody(row.runtimeConfig, row)),
  });
  if (patch.ok) {
    console.log(`${label} applied (was ${currentLabel})`);
  } else {
    failures += 1;
    console.error(`${label} FAILED HTTP ${patch.status}: ${JSON.stringify(patch.body)}`);
  }
}

if (unreadable > 0) {
  console.error(
    `\nsync-agent-heartbeat: ${unreadable} agent(s) skipped as unreadable. Rerun as an actor holding agents:configure.`,
  );
}
if (failures > 0) process.exit(1);
// Usable as a CI drift check. An unreadable agent also fails the check: "we
// could not verify this" must not read as "this is in sync".
if (!apply && (drift > 0 || unreadable > 0)) process.exit(1);
