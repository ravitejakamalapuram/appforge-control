#!/usr/bin/env node
// release-bridge.mjs - host-side job (infra/macos/release-bridge.sh): GitHub -> Paperclip + ntfy (APP-293).
//   release-bridge.mjs [--dry-run]
// Exit 0: polled cleanly (new signals, if any, were opened). Exit 1: something is BROKEN (ntfy sent).
// Env: PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, NTFY_TOPIC (optional), RELEASE_BRIDGE_APPS, RELEASE_BRIDGE_ASSIGNEE,
//      RELEASE_BRIDGE_PROJECT (optional), APPFORGE_STATE_DIR. GitHub auth comes from the host's `gh`; read-only calls only.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { poll, reposFromApps, issueBody } from './lib/release-bridge.mjs';

const dry = process.argv.includes('--dry-run');
if (process.argv.slice(2).some((a) => a !== '--dry-run')) { console.error('usage: release-bridge.mjs [--dry-run]'); process.exit(2); }

const env = process.env;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = env.RELEASE_BRIDGE_APPS ?? join(homedir(), 'git-personal/release-platform/apps.yaml');
const CTO_ID = env.RELEASE_BRIDGE_ASSIGNEE ?? '3cba1fb3-21e1-4851-832b-95de5247bff1';
const PROJECT = env.RELEASE_BRIDGE_PROJECT ?? '';
const STATE = join(env.APPFORGE_STATE_DIR ?? join(REPO_ROOT, 'state'), 'release-bridge-seen.json');
const log = (m) => console.log(`[${new Date().toISOString()}] release-bridge: ${m}`);

function curl(args, input) {
  return execFileSync('curl', ['-fsS', '-m', '15', ...args], { input, stdio: ['pipe', 'pipe', 'pipe'] });
}
function notify(msg) {
  if (!env.NTFY_TOPIC || dry) return;
  try { curl(['-H', 'Title: appforge release-bridge', '-d', msg, `https://ntfy.sh/${env.NTFY_TOPIC}`]); } catch { /* best effort */ }
}
const fail = (msg) => { log(`FAIL ${msg}`); notify(`BROKEN: ${msg}`); process.exit(1); };

let repos;
try { repos = reposFromApps(readFileSync(APPS, 'utf8')); } catch (e) { fail(`cannot read the app list ${APPS}: ${e.message}`); }

if (dry) {
  log(`dry-run: would poll ${repos.length} repos (${repos.join(', ')}) for open listing-verify issues and failed listing/release/promote runs; nothing called, nothing opened`);
  process.exit(0);
}
for (const v of ['PAPERCLIP_API_URL', 'PAPERCLIP_COMPANY_ID']) if (!env[v]) fail(`${v} is not set - check did not run. This is NOT a quiet day.`);

let seen;
try { seen = new Set(JSON.parse(readFileSync(STATE, 'utf8'))); }
catch (e) { if (e.code === 'ENOENT') seen = new Set(); else fail(`state file ${STATE} is unreadable: ${e.message}`); }

// APP-373: a gh stuck on a dead connection hung the job for 12h (launchd skips intervals while it runs).
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: Number(env.RELEASE_BRIDGE_GH_TIMEOUT_MS) || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const onNew = (s) => {
  curl(['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '@-', `${env.PAPERCLIP_API_URL}/api/companies/${env.PAPERCLIP_COMPANY_ID}/issues`], JSON.stringify(issueBody(s, CTO_ID, PROJECT)));
  notify(`${s.kind} in ${s.repo}: ${s.url}`);
  log(`opened Paperclip issue for ${s.kind} ${s.url}`);
};
const { fresh, broken } = await poll({ repos, gh, seen, onNew });
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify([...seen], null, 1));
log(`polled ${repos.length} repos: ${fresh.length} new, ${broken.length} broken`);
if (broken.length) fail(broken.join(' | '));
