#!/usr/bin/env node
// detect-workspaceless-work.mjs — APP-303.
//
// Lists open issues and routines filed in a Paperclip project that has no
// registered workspace. Every wake on one of them fails with
// `workspace_validation_failed`; see lib/workspaceless-work.mjs for why.
//
// Exit 0 = nothing found (print nothing). Exit 1 = findings, report on stdout.
// Exit 2 = the check itself could not run. A failed check is never a clean one.
//
// --open-issue: on findings, open ONE issue (title GUARD_ISSUE_TITLE) in the
// `platform` project, assigned to the CTO. If one is already open, open nothing
// and name it. This is the only write the script makes.
//
// Usage:
//   node scripts/detect-workspaceless-work.mjs
//   node scripts/detect-workspaceless-work.mjs --open-issue
//   node scripts/detect-workspaceless-work.mjs --json
//
// Auth: PAPERCLIP_API_URL + PAPERCLIP_API_KEY + PAPERCLIP_COMPANY_ID, as every
// heartbeat run already has.
import {
  GUARD_ISSUE_TITLE,
  OPEN_ISSUE_STATUSES,
  findOpenGuardIssue,
  findWorkspacelessWork,
  renderReport,
  resolveFilingTarget,
} from './lib/workspaceless-work.mjs';

const ISSUE_LIMIT = 1000;

function parseArgs(argv) {
  const args = { json: false, openIssue: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--open-issue') args.openIssue = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function apiBase() {
  const raw = process.env.PAPERCLIP_API_URL;
  if (!raw) throw new Error('PAPERCLIP_API_URL is not set');
  return raw.replace(/\/$/, '').replace(/\/api$/, '');
}

async function api(method, path, body) {
  const key = process.env.PAPERCLIP_API_KEY;
  if (!key) throw new Error('PAPERCLIP_API_KEY is not set');
  const headers = { Authorization: `Bearer ${key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (process.env.PAPERCLIP_RUN_ID) headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID;
  const res = await fetch(`${apiBase()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** List endpoints have returned both a bare array and {<key>:[…]}. Tolerate both. */
function unwrap(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  throw new Error(`unexpected ${key} payload shape`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error('PAPERCLIP_COMPANY_ID is not set');

  const projects = unwrap(await api('GET', `/api/companies/${companyId}/projects`), 'projects');
  const issues = unwrap(
    await api('GET', `/api/companies/${companyId}/issues?status=${OPEN_ISSUE_STATUSES.join(',')}&limit=${ISSUE_LIMIT}`),
    'issues',
  );
  // A full page may be a truncated one; a silent undercount is exactly the blind spot this closes.
  if (issues.length >= ISSUE_LIMIT) throw new Error(`issue list hit the ${ISSUE_LIMIT} limit; result may be truncated`);
  const routines = unwrap(await api('GET', `/api/companies/${companyId}/routines`), 'routines');

  const findings = findWorkspacelessWork({ projects, issues, routines });
  const found = findings.issues.length + findings.routines.length > 0;
  const result = { ...findings, guardIssue: null, created: false };

  if (found && args.openIssue) {
    const existing = findOpenGuardIssue(issues);
    if (existing) {
      result.guardIssue = existing.identifier;
    } else {
      const agents = unwrap(await api('GET', `/api/companies/${companyId}/agents`), 'agents');
      const cto = agents.filter((a) => a.role === 'cto');
      if (cto.length !== 1) throw new Error(`expected exactly one agent with role cto, found ${cto.length}`);
      const created = await api('POST', `/api/companies/${companyId}/issues`, {
        title: GUARD_ISSUE_TITLE,
        description: `${renderReport(findings)}\n\nOpened by \`scripts/detect-workspaceless-work.mjs --open-issue\`. It opens no second issue while this one is open; close it once the list is clear.`,
        status: 'todo',
        priority: 'medium',
        assigneeAgentId: cto[0].id,
        ...resolveFilingTarget(projects),
      });
      result.guardIssue = created.identifier ?? created.id;
      result.created = true;
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (found) {
    process.stdout.write(`${renderReport(findings)}\n`);
    if (result.guardIssue) process.stdout.write(`\nGuard issue: ${result.guardIssue} (${result.created ? 'opened now' : 'already open, nothing opened'})\n`);
  }
  process.exit(found ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`detect-workspaceless-work: ${err.message}\n`);
  process.exit(2);
});
