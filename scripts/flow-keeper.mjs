#!/usr/bin/env node
// flow-keeper.mjs - the "tick" Paperclip lacks: make sure no assigned issue sits idle (see lib/flow-keeper.mjs).
//
//   node scripts/flow-keeper.mjs            # one pass: nudge, resume, escalate, write the assistant inbox
//   node scripts/flow-keeper.mjs --dry-run  # decide and print; wake/resume/create nothing, write no state
//
// Env: PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, NTFY_TOPIC (optional), APPFORGE_STATE_DIR (default ./state).
// Exit: 0 pass completed (even if it nudged), 2 the keeper itself could not run (loud, never "all quiet").
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSISTANT_WAIT } from './lib/flow-keeper.mjs';
import { ciGreenState, cwsReviewState, decideWait, parseWait, prMergedState, staleBlock, statusMdAgeMs } from './lib/waits.mjs';
import {
  agentsToResume, decide, escalationTitle, pruneKicks, wakeBody, ESCALATE_EVERY_MS,
} from './lib/flow-keeper.mjs';

const dry = process.argv.includes('--dry-run');
const env = process.env;
const STATE_DIR = env.APPFORGE_STATE_DIR || join(process.cwd(), 'state');
const STATE_FILE = join(STATE_DIR, 'flow-keeper.json');
const WAITS_FILE = join(STATE_DIR, 'waits.json');
const INBOX_FILE = join(STATE_DIR, 'assistant-inbox.json');
const log = (m) => console.log(`[${new Date().toISOString()}] flow-keeper: ${m}`);
const die = (m) => { console.error(`[${new Date().toISOString()}] flow-keeper: FAIL ${m}`); notify(`flow-keeper did not run: ${m}`); process.exit(2); };

for (const v of ['PAPERCLIP_API_URL', 'PAPERCLIP_COMPANY_ID']) if (!env[v]) die(`${v} is not set`);
const API = `${env.PAPERCLIP_API_URL.replace(/\/$/, '')}`;
const CO = env.PAPERCLIP_COMPANY_ID;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}
const list = (p, k) => api('GET', p).then((r) => (Array.isArray(r) ? r : r?.[k] ?? []));

function notify(msg) {
  if (!env.NTFY_TOPIC || dry) return;
  fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', headers: { Title: 'appforge flow-keeper' }, body: msg, signal: AbortSignal.timeout(10000) }).catch(() => {});
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { kicks: {}, resumes: {}, escalated: {}, waits: {}, inboxNotifiedAt: 0, inboxKey: '' }; }
}

const now = Date.now();
const state = loadState();
state.kicks = pruneKicks(state.kicks, now);

let agents, issues, busyRuns;
try {
  agents = await list(`/api/companies/${CO}/agents`, 'agents');
  issues = await list(`/api/companies/${CO}/issues?limit=500`, 'issues');
  busyRuns = [...(await list(`/api/companies/${CO}/heartbeat-runs?status=running&limit=50`, 'runs')), ...(await list(`/api/companies/${CO}/heartbeat-runs?status=queued&limit=50`, 'runs'))];
} catch (e) { die(`cannot read Paperclip: ${e.message}`); }

const byId = new Map(agents.map((a) => [a.id, a]));
const busy = new Set(busyRuns.map((r) => r.agentId));
state.waits ??= {};
const results = { woke: [], escalated: [], assistant: [], resumed: [], released: [], waiting: [] };

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
const prRef = (url) => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url ?? ''); return m ? { repo: m[1], n: m[2] } : null; };
/** Run one named check; never throws (an unreadable source is "unknown", which keeps waiting and says so). */
function runCheck(wait) {
  try {
    if (wait.check === 'cws_review_clear') {
      const md = Buffer.from(gh(['api', 'repos/ravitejakamalapuram/release-platform/contents/STATUS.md?ref=status', '--jq', '.content']), 'base64').toString('utf8');
      if (statusMdAgeMs(md, now) > wait.recheckMs) {
        if (!dry) { try { gh(['workflow', 'run', 'dashboard.yml', '-R', 'ravitejakamalapuram/release-platform']); } catch { /* next pass retries */ } }
        return { known: false, detail: 'dashboard was stale; refresh requested, will read it on the next pass' };
      }
      return cwsReviewState(md, wait.args.item);
    }
    const ref = prRef(wait.args.url);
    if (!ref) return { known: false, detail: `not a pull request url: ${wait.args.url}` };
    const pr = JSON.parse(gh(['pr', 'view', ref.n, '-R', ref.repo, '--json', 'state,statusCheckRollup']));
    return wait.check === 'pr_merged' ? prMergedState(pr) : ciGreenState(pr);
  } catch (e) { return { known: false, detail: `check could not run: ${String(e.message).slice(0, 100)}` }; }
}
const issueById = new Map(issues.map((i) => [i.id, i]));
const waitOf = (issue) => parseWait(`${issue.unblockDescriptor?.action ?? ''}\n${issue.waitLine ?? ''}`);

// 1b. Blocked work must have a live reason. Finished blockers release it; an external wait is checked by name.
for (const issue of issues.filter((i) => i.status === 'blocked')) {
  const tag = issue.identifier;
  try { issue.blockedBy = (await api('GET', `/api/issues/${issue.id}`)).blockedBy ?? []; } catch { issue.blockedBy = []; } // the list rows carry no blocker detail
  if (staleBlock(issue, (b) => issueById.get(b.id ?? b.blockerIssueId)?.status ?? b.status)) {
    log(`${dry ? 'would release' : 'releasing'} ${tag}: every blocker is finished`);
    if (!dry) { try { await api('PATCH', `/api/issues/${issue.id}`, { status: 'todo', blockedByIssueIds: [], comment: 'flow-keeper: every blocker of this issue is finished, so it is no longer blocked. Continue now: do the next concrete step. Do not end the run with the issue in the same state.' }); } catch (e) { log(`release ${tag} failed: ${e.message.slice(0, 100)}`); continue; } }
    results.released.push(tag);
    continue;
  }
  const wait = waitOf(issue);
  if (!wait) continue;
  const rec = (state.waits[issue.id] ??= { firstSeen: now });
  const d = decideWait({ wait, lastCheckedMs: rec.lastChecked ?? 0, now });
  if (d.action === 'invalid') { log(`${tag}: ${d.why}`); rec.detail = d.why; results.waiting.push({ identifier: tag, title: issue.title, check: 'invalid', detail: d.why }); continue; }
  if (d.action === 'check') {
    const r = runCheck(wait);
    rec.lastChecked = now; rec.detail = r.detail; rec.known = !!r.known;
    log(`${tag}: ${wait.check} -> ${r.known ? (r.clear ? 'CLEAR' : 'still waiting') : 'unknown'} (${r.detail})`);
    if (r.known && r.clear) {
      const toAssistant = ASSISTANT_WAIT.test(issue.unblockDescriptor?.action ?? '');
      if (toAssistant) {
        results.assistant.push({ identifier: tag, title: issue.title, agent: byId.get(issue.assigneeAgentId)?.name, status: issue.status, since: new Date(now).toISOString(), why: `the wait is over (${r.detail}); the next step is the board's assistant's: ${String(issue.unblockDescriptor.action).slice(0, 200)}` });
      } else if (!dry) {
        try { await api('PATCH', `/api/issues/${issue.id}`, { status: 'todo', comment: `flow-keeper: the wait is over (${wait.check}: ${r.detail}). Continue now with the next step. Do not end the run with the issue in the same state.` }); } catch (e) { log(`release ${tag} failed: ${e.message.slice(0, 100)}`); }
      }
      results.released.push(tag); delete state.waits[issue.id]; continue;
    }
  }
  if (d.action === 'overdue') {
    const t = `Overdue wait: ${tag} is still waiting`;
    log(`OVERDUE ${tag}: ${d.why}`);
    if (!dry && now - (state.escalated[issue.id] ?? 0) > ESCALATE_EVERY_MS && !openTitles1.has(t)) {
      try {
        await api('POST', `/api/companies/${CO}/issues`, { title: t, status: 'todo', priority: 'high', assigneeAgentId: agents.find((a) => a.role === 'ceo')?.id, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId,
          description: `${tag} (${issue.title}) waits on \`${wait.check}\` and ${d.why}. Last check: ${rec.detail ?? 'none'}. CEO: decide whether to keep waiting (set a new deadline in the issue's WAIT line), change the plan, or cancel. Do not just wait again.` });
        state.escalated[issue.id] = now; notify(`${tag} wait is overdue`);
      } catch (e) { log(`overdue issue failed: ${e.message.slice(0, 120)}`); }
    }
    results.escalated.push(tag);
  }
  results.waiting.push({ identifier: tag, title: issue.title, check: wait.check, detail: rec.detail ?? 'not checked yet', lastChecked: rec.lastChecked ? new Date(rec.lastChecked).toISOString() : null, deadline: wait.deadlineMs ? new Date(wait.deadlineMs).toISOString().slice(0, 10) : null });
}
const openTitles1 = new Set(issues.filter((i) => !['done', 'cancelled'].includes(i.status)).map((i) => i.title));

// 1. Errored agents with a transient cause come back (bounded per hour).
for (const a of agentsToResume({ agents, resumes: state.resumes, now })) {
  log(`${dry ? 'would resume' : 'resuming'} ${a.name} (${a.errorReason ?? 'error'})`);
  if (!dry) {
    try { execFileSync('paperclipai', ['agent', 'resume', a.id], { stdio: 'ignore', timeout: 60000 }); (state.resumes[a.id] ??= []).push(now); } catch (e) { log(`resume ${a.name} failed: ${e.message.slice(0, 100)}`); }
  }
  results.resumed.push(a.name);
}

// 2. Idle issues.
const openTitles = new Set(issues.filter((i) => !['done', 'cancelled'].includes(i.status)).map((i) => i.title));
for (const issue of issues) {
  if (issue.status === 'blocked' && waitOf(issue) && !waitOf(issue).invalid) continue; // handled by its named check above
  const first = decide({ issue, agent: byId.get(issue.assigneeAgentId), busyAgents: busy, lastComment: null, kicks: state.kicks[issue.id], now });
  let d = first;
  if (first.action !== 'none' || ['todo', 'in_progress', 'in_review', 'blocked'].includes(issue.status)) {
    // The newest comment can show the agent is waiting on the assistant, or that the issue is fresher than its row says.
    const stale = first.action !== 'none' || (issue.assigneeAgentId && !busy.has(issue.assigneeAgentId) && issue.status !== 'blocked');
    if (!stale && issue.status !== 'blocked') continue;
    let last = null;
    try {
      const cs = await list(`/api/issues/${issue.id}/comments`, 'comments');
      last = cs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).filter((c) => !/^## Workspace Ready/.test(c.body ?? '')).at(-1) ?? null;
    } catch { /* decide without it */ }
    d = decide({ issue, agent: byId.get(issue.assigneeAgentId), busyAgents: busy, lastComment: last, kicks: state.kicks[issue.id], now });
  }
  if (d.action === 'none') continue;
  const tag = `${issue.identifier} (${byId.get(issue.assigneeAgentId)?.name})`;
  if (d.action === 'wake') {
    log(`${dry ? 'would wake' : 'waking'} ${tag}: ${d.reason}`);
    if (!dry) {
      try { await api('POST', `/api/agents/${issue.assigneeAgentId}/wakeup`, wakeBody(issue, d.reason, now)); (state.kicks[issue.id] ??= []).push(now); } catch (e) { log(`wake ${tag} failed: ${e.message.slice(0, 120)}`); continue; }
    }
    results.woke.push(issue.identifier);
  } else if (d.action === 'assistant') {
    results.assistant.push({ identifier: issue.identifier, title: issue.title, agent: byId.get(issue.assigneeAgentId)?.name, status: issue.status, since: new Date(d.since).toISOString(), why: d.why });
  } else if (d.action === 'escalate') {
    const t = escalationTitle(issue.identifier);
    log(`ESCALATE ${tag}: ${d.why}`);
    if (!dry && now - (state.escalated[issue.id] ?? 0) > ESCALATE_EVERY_MS && !openTitles.has(t)) {
      try {
        await api('POST', `/api/companies/${CO}/issues`, { title: t, status: 'todo', priority: 'high', assigneeAgentId: agents.find((a) => a.role === 'ceo')?.id, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId,
          description: `The flow keeper nudged ${issue.identifier} (${issue.title}) ${d.why}. CEO: read the thread, decide the real blocker, and either re-scope, reassign, split, or cancel it. If it needs the board's assistant, comment ESCALATE with your recommendation. Do not just nudge again.` });
        state.escalated[issue.id] = now; notify(`${issue.identifier} is stuck: ${d.why}`);
      } catch (e) { log(`escalation issue failed: ${e.message.slice(0, 120)}`); }
    }
    results.escalated.push(issue.identifier);
  }
}

// 3. The assistant's inbox: work only a person/assistant can do. Written for the board assistant, digested to ntfy.
const inboxKey = results.assistant.map((i) => i.identifier).sort().join(',');
if (!dry) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(INBOX_FILE, JSON.stringify({ updated: new Date(now).toISOString(), items: results.assistant }, null, 2) + '\n');
  if (results.assistant.length && (inboxKey !== state.inboxKey || now - state.inboxNotifiedAt > 2 * 3600 * 1000)) {
    notify(`${results.assistant.length} item(s) wait for the board's assistant: ${inboxKey}`);
    state.inboxNotifiedAt = now;
  }
  state.inboxKey = inboxKey;
  writeFileSync(WAITS_FILE, JSON.stringify({ updated: new Date(now).toISOString(), items: results.waiting }, null, 2) + '\n');
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
log(`pass done: woke ${results.woke.length} [${results.woke.join(' ')}], escalated ${results.escalated.length} [${results.escalated.join(' ')}], resumed ${results.resumed.length}, released ${results.released.length} [${results.released.join(' ')}], waiting on outside events ${results.waiting.length}, waiting on the assistant ${results.assistant.length} [${inboxKey}]${dry ? ' (dry run: nothing changed)' : ''}`);
