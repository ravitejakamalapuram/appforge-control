#!/usr/bin/env node
// Reconcile config/agents.yaml -> Paperclip adapterConfig.maxTurnsPerRun (APP-29).
//
// config/agents.yaml is the reviewable source of truth for the run turn
// ceiling, but nothing applied it: the value only ever lived in each agent's
// Paperclip adapterConfig, so git and the control plane could drift silently.
// This is the reconciler.
//
//   node scripts/sync-agent-turn-limits.mjs            # report drift only
//   node scripts/sync-agent-turn-limits.mjs --apply    # write the drift out
//   node scripts/sync-agent-turn-limits.mjs --apply --agent analyst
//
// Needs PAPERCLIP_API_URL + PAPERCLIP_COMPANY_ID, and PAPERCLIP_API_KEY with
// `agents:configure` (a board key, or an agent key holding that grant). An
// agent key without the grant gets 403 `deny_no_grant` per agent and can only
// ever patch itself - that is the control plane working as designed, not a bug
// in this script.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesiredLimits, matchAgents, turnLimitPatchBody } from './lib/agent-turn-limits.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`sync-agent-turn-limits: ${name} is not set`);
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

const desired = resolveDesiredLimits(readFileSync(join(REPO_ROOT, 'config/agents.yaml'), 'utf8'));
const companyId = requireEnv('PAPERCLIP_COMPANY_ID');

const list = await api(`/api/companies/${companyId}/agents`);
if (!list.ok) {
  console.error(`sync-agent-turn-limits: cannot list agents (HTTP ${list.status})`, list.body);
  process.exit(1);
}

// The list route redacts adapterConfig; the per-agent route returns it for
// agents this actor may read. Fetch per agent so drift detection is real.
const liveAgents = [];
for (const agent of list.body) {
  const detail = await api(`/api/agents/${agent.id}`);
  liveAgents.push(detail.ok ? { ...agent, ...detail.body } : agent);
}

let failures = 0;
let drift = 0;
for (const row of matchAgents(desired, liveAgents)) {
  if (onlyAgent && row.name !== onlyAgent) continue;
  const label = `${row.name.padEnd(8)} want=${String(row.maxTurnsPerRun).padEnd(3)}`;

  if (!row.id) {
    console.error(`${label} NO MATCHING PAPERCLIP AGENT`);
    failures += 1;
    continue;
  }
  if (row.current === row.maxTurnsPerRun) {
    console.log(`${label} ok`);
    continue;
  }
  drift += 1;
  const currentLabel = row.current === null ? 'not readable by this actor' : `is=${row.current}`;

  if (!apply) {
    console.log(`${label} DRIFT (${currentLabel}) - rerun with --apply`);
    continue;
  }
  const patch = await api(`/api/agents/${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify(turnLimitPatchBody(row.maxTurnsPerRun)),
  });
  if (patch.ok) {
    console.log(`${label} applied (was ${currentLabel})`);
  } else {
    failures += 1;
    console.error(`${label} FAILED HTTP ${patch.status}: ${JSON.stringify(patch.body)}`);
  }
}

if (failures > 0) process.exit(1);
if (!apply && drift > 0) process.exit(1); // usable as a CI drift check
