#!/usr/bin/env node
// Reconcile agents/<name>/{AGENTS,HEARTBEAT,SOUL,TOOLS}.md -> Paperclip managed instruction bundles.
//
//   node scripts/sync-agent-instructions.mjs            # report drift only (exit 1 if any)
//   node scripts/sync-agent-instructions.mjs --apply    # write the drift out
//   node scripts/sync-agent-instructions.mjs --apply --agent cto
//
// Needs PAPERCLIP_COMPANY_ID. PAPERCLIP_API_URL defaults to http://127.0.0.1:3100 and
// PAPERCLIP_API_KEY is optional (the local_trusted board needs none). Files are only ever
// created or updated, never deleted. Writing an instructions file changes that agent's
// session fingerprint once, so a saved session will not resume after an --apply: apply
// while the agent is idle, not mid-task.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUCTION_FILES, indexAgentsByName, planInstructionSync } from './lib/agent-instructions.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.PAPERCLIP_API_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const companyId = process.env.PAPERCLIP_COMPANY_ID;
if (!companyId) {
  console.error('sync-agent-instructions: PAPERCLIP_COMPANY_ID is not set');
  process.exit(2);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.PAPERCLIP_API_KEY ? { Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

const apply = process.argv.includes('--apply');
const agentFlag = process.argv.indexOf('--agent');
const onlyAgent = agentFlag === -1 ? null : process.argv[agentFlag + 1]?.toLowerCase();

const list = await api(`/api/companies/${companyId}/agents`);
if (!list.ok) {
  console.error(`sync-agent-instructions: cannot list agents (HTTP ${list.status})`);
  process.exit(2);
}
const liveByName = indexAgentsByName(list.body);

const repoFiles = [];
for (const agent of liveByName.keys()) {
  if (onlyAgent && agent !== onlyAgent) continue;
  for (const file of INSTRUCTION_FILES) {
    const p = join(REPO_ROOT, 'agents', agent, file);
    repoFiles.push({ agent, file, repo: existsSync(p) ? readFileSync(p, 'utf8') : null });
  }
}

// Read every deployed file up front so planInstructionSync stays synchronous and pure.
const deployed = new Map();
for (const { agent, file } of repoFiles) {
  const live = liveByName.get(agent);
  const r = await api(`/api/agents/${live.id}/instructions-bundle/file?path=${encodeURIComponent(file)}`);
  deployed.set(`${live.id}/${file}`, r.ok ? (r.body?.content ?? null) : null);
}

const plan = planInstructionSync(repoFiles, liveByName, (id, file) => deployed.get(`${id}/${file}`) ?? null);
for (const s of plan.skipped) console.log(`skip   ${s.agent}/${s.file}: ${s.reason}`);
for (const w of plan.writes) {
  console.log(`${apply ? 'write ' : 'drift '} ${w.agent}/${w.file} (${w.kind}: deployed ${w.deployedLines} lines -> git ${w.repoLines} lines)`);
}
console.log(`${plan.unchanged} file(s) already match git, ${plan.writes.length} differ.`);

if (!apply) process.exit(plan.writes.length ? 1 : 0);

let failed = 0;
for (const w of plan.writes) {
  const r = await api(`/api/agents/${w.agentId}/instructions-bundle/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: w.file, content: w.content }),
  });
  if (!r.ok) {
    failed += 1;
    console.error(`FAILED ${w.agent}/${w.file}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
}
process.exit(failed ? 1 : 0);
