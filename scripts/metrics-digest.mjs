#!/usr/bin/env node
// `appforge metrics digest` — the daily digest the CEO HEARTBEAT's first step
// ("Pull Analyst's daily digest") has always assumed and that never existed
// anywhere until APP-43.
//
//   node scripts/metrics-digest.mjs [--since 2026-09-29] [--hours 24] [--json]
//                                   [--no-portfolio] [--products-root ~/git-personal]
//                                   [--gate]
//
// DETERMINISTIC. No model call on this path, by construction: every number is
// a pure transform (scripts/lib/metrics-digest.mjs) over data fetched here.
// That is the §22.1 anti-sunk-cost control — the recommendation is computed
// from metrics BEFORE the CEO sees narrative, so no LLM sits between the
// metric and the verdict.
//
// Needs PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_KEY.
//
// --gate turns section 6 into a trigger condition a SHELL can branch on, with
// no model in the loop. §6.2 gates Analyst's 06:30 wake on "the ingest job's
// deterministic anomaly check"; APP-50 removed that routine precisely because
// a routine that "fires unconditionally and spends a model call to conclude
// nothing" is the shape the APP-39 ruling rejected on cost grounds, against
// the smallest budget in the company (Analyst, 400 cents).
//
// So the gate is evaluated OUTSIDE the agent: infra/macos/digest-gate.sh runs
// this with --gate and only fires the routine's api trigger on exit 0. On a
// quiet day the wake never happens and no model call is spent — which is what
// "correctly stays silent when nothing crosses a threshold" has to mean if it
// is to mean anything.
//
// Exit codes:
//   0  a digest was produced (including one whose sections report their gaps).
//      Under --gate: at least one anomaly flag fired — WAKE.
//   1  a REQUIRED live input (1-4) could not be fetched. A digest missing a
//      live section silently is worse than no digest, so it is not printed.
//      Under --gate this is NOT "no anomalies" — it is "the check did not run",
//      and the caller must not read it as all-clear.
//   2  bad usage.
//  20  --gate only: the digest computed cleanly and NO flag fired. Stay silent.
//      Distinct from 1 so a failed check can never be mistaken for a quiet day.

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { readManifest } from './lib/metrics-manifest.mjs';
import { buildDigest } from './lib/metrics-digest.mjs';
import { runPortfolio } from './metrics-portfolio.mjs';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`metrics-digest: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv) {
  const args = { hours: 24, json: false, portfolio: true, gate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--gate') args.gate = true;
    else if (a === '--no-portfolio') args.portfolio = false;
    else if (a === '--since') args.since = argv[(i += 1)];
    else if (a === '--hours') args.hours = Number(argv[(i += 1)]);
    else if (a === '--products-root') args.productsRoot = argv[(i += 1)];
    else if (a === '--data-root') args.dataRoot = argv[(i += 1)];
    else if (a === '--budgets') args.budgets = argv[(i += 1)];
    else if (a === '--portfolio-config') args.portfolioConfig = argv[(i += 1)];
    else {
      console.error(`metrics-digest: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function getJson(base, path, headers, label) {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GET ${label} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const asList = (j) => (Array.isArray(j) ? j : j?.items ?? j?.issues ?? j?.agents ?? j?.approvals ?? []);

// --- rendering --------------------------------------------------------------
// Plain text, because the consumer is a CEO heartbeat reading a comment, and
// the shape has to survive being pasted into one.

const pct = (u) => (u == null ? 'n/a' : `${(u * 100).toFixed(1)}%`);
const usd = (c) => `$${(c / 100).toFixed(2)}`;

function render(d) {
  const L = [];
  L.push(`# appforge daily digest — ${d.generated_at.slice(0, 16)}Z`);
  L.push(`window: since ${d.since.slice(0, 16)}Z`);
  L.push('');
  L.push('Deterministic: every figure below is computed by script from control-plane data.');
  L.push('No model call produced any number here.');

  // 1
  L.push('');
  L.push('## 1. Spend');
  L.push(`cap ${usd(d.spend.cap_cents ?? 0)}/mo (DEC-0004) · spend ${usd(d.spend.spend_cents)} · ${pct(d.spend.utilization)} of cap`);
  if (d.spend.metering_note) L.push(`! ${d.spend.metering_note}`);
  L.push(`output tokens this period: ${d.spend.total_output_tokens.toLocaleString()}`);
  for (const a of d.spend.agents) {
    const b = a.budget_cents == null ? 'NO BUDGET ENTRY' : `${usd(a.cost_cents)} / ${usd(a.budget_cents)} (${pct(a.utilization)})`;
    L.push(`  ${a.agent.padEnd(9)} ${b}${a.subscription_only ? '  [subscription runs only — cost not metered]' : ''}`);
    L.push(`  ${''.padEnd(9)}   in ${a.input_tokens.toLocaleString()} · cached ${a.cached_input_tokens.toLocaleString()} · out ${a.output_tokens.toLocaleString()}`);
  }
  if (d.spend.unbudgeted_agents.length) L.push(`! no budgets.yaml entry for: ${d.spend.unbudgeted_agents.join(', ')}`);

  // 2
  L.push('');
  L.push('## 2. Run outcomes');
  L.push(`${d.runs.total} run(s) · ${Object.entries(d.runs.by_status).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'}`);
  L.push(`failure rate ${pct(d.runs.failure_rate)} · retries ${d.runs.retry_count}`);
  // The error-code distribution is the actionable part: it names WHICH failure
  // mode dominates, which a single failure rate hides.
  const codes = Object.entries(d.runs.by_error_code).sort((a, b) => b[1] - a[1]);
  if (codes.length) L.push(`by error code: ${codes.map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  if (d.runs.max_turns.length) {
    L.push(`! ${d.runs.max_turns.length} run(s) EXHAUSTED the turn ceiling (APP-29 failure mode).`);
    L.push(`  ${d.runs.max_turns_continuations} further run(s) were CONTINUED at the ceiling — churn, counted separately, not folded in.`);
    for (const r of d.runs.max_turns.slice(0, 5)) L.push(`    ${r.run_id.slice(0, 8)} ${r.error_code} attempt=${r.retry_attempt ?? '-'} ${r.created_at?.slice(0, 16)}`);
    if (d.runs.max_turns.length > 5) L.push(`    … ${d.runs.max_turns.length - 5} more (--json for the full list)`);
  }
  if (d.runs.failures.length) {
    L.push(`! ${d.runs.failures.length} failed run(s); newest 5:`);
    for (const r of d.runs.failures.slice(0, 5)) L.push(`    ${r.run_id.slice(0, 8)} ${r.status} ${r.error_code ?? ''} ${(r.error ?? '').slice(0, 90)}`.trimEnd());
    if (d.runs.failures.length > 5) L.push(`    … ${d.runs.failures.length - 5} more (--json for the full list)`);
  }
  if (d.runs.escalations.length) L.push(`! ${d.runs.escalations.length} run(s) ended paused or not-invokable — §6.1 rule 6 escalation territory`);
  if (d.runs.abandoned.length) L.push(`! ${d.runs.abandoned.length} abandoned run(s) (started, never reported an end)`);

  // 3
  L.push('');
  L.push('## 3. Open approvals');
  L.push(d.approvals.open === 0 ? 'none open' : `${d.approvals.open} open · oldest ${d.approvals.oldest_age_days}d`);
  for (const a of d.approvals.rows) L.push(`  ${String(a.age_days).padStart(3)}d  ${a.type}  ${a.status}  ${a.id.slice(0, 8)}`);

  // 4
  L.push('');
  L.push('## 4. Open incidents by SEV');
  L.push(d.incidents.open === 0 ? 'none open' : `${d.incidents.open} open · ${Object.entries(d.incidents.by_sev).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  for (const r of d.incidents.rows) L.push(`  ${r.sev}  ${String(r.age_days).padStart(3)}d  ${r.identifier}  ${r.title.slice(0, 70)}`);
  if (d.incidents.convention_note) L.push(`! ${d.incidents.convention_note}`);

  // 5
  L.push('');
  L.push('## 5. Store-metric deltas');
  L.push(d.store.message);
  for (const x of d.store.deltas) {
    const delta = x.delta == null ? '(no prior reading)' : `${x.delta >= 0 ? '+' : ''}${x.delta} vs ${x.prior_as_of}`;
    L.push(`  ${x.item_id} ${x.metric} = ${x.value} as_of ${x.as_of}  ${delta}`);
  }

  // 6
  L.push('');
  L.push('## 6. Anomaly flags (§6.2)');
  L.push(d.anomalies.any ? `${d.anomalies.flags.length} flag(s) — Analyst's 06:30 wake FIRES` : 'no flag crossed a threshold — Analyst\'s 06:30 wake stays SILENT');
  for (const f of d.anomalies.flags) L.push(`  [${f.severity}] ${f.check}: ${f.detail}`);
  if (d.anomalies.unavailable.length) {
    L.push('  checks that cannot be computed today (absence of a flag here does NOT mean "nothing crossed"):');
    for (const u of d.anomalies.unavailable) L.push(`    - ${u.check}: ${u.reason}`);
  }

  // 7
  L.push('');
  L.push('## 7. Portfolio outcome per product (§22.1)');
  if (d.portfolio.refused) {
    L.push('REFUSED — no verdict for any product:');
    for (const line of String(d.portfolio.reason).split('\n')) L.push(`  ${line}`);
    L.push(`  ${d.portfolio.note}`);
  } else if (!d.portfolio.available) {
    L.push(`unavailable: ${d.portfolio.reason}`);
  } else {
    L.push(Object.entries(d.portfolio.by_outcome).map(([k, v]) => `${v} ${k}`).join(' · '));
    for (const r of d.portfolio.rows) {
      L.push(`  ${r.outcome.padEnd(17)} ${r.product}${r.reason_codes.length ? `  (${r.reason_codes.join(', ')})` : ''}`);
    }
    L.push(d.portfolio.actionable.length
      ? `! ${d.portfolio.actionable.length} product(s) carry an actionable §22.1 outcome`
      : 'no product carries an actionable §22.1 outcome (SCALE/PAUSE/SUNSET/ITERATE)');
  }

  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = requireEnv('PAPERCLIP_API_URL').replace(/\/$/, '');
  const companyId = requireEnv('PAPERCLIP_COMPANY_ID');
  // PAPERCLIP_API_KEY is OPTIONAL, deliberately. A heartbeat run has a
  // run-scoped JWT injected and passes it; the LaunchAgent that drives the
  // §6.2 gate has none, and minting a long-lived key to give it one would be
  // a new standing credential on disk for GETs the local control plane
  // already serves unauthenticated on 127.0.0.1. Same shape as
  // quota-retry-watchdog.mjs, which ships this way on `main`.
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const now = new Date();
  const sinceMs = args.since ? Date.parse(args.since) : now.getTime() - args.hours * 3_600_000;
  if (Number.isNaN(sinceMs)) {
    console.error(`metrics-digest: --since is not a parseable timestamp: ${args.since}`);
    process.exit(2);
  }
  const since = new Date(sinceMs);

  // Inputs 1-4 are REQUIRED. A fetch failure here exits 1 rather than printing
  // a digest with a quietly missing section.
  const [summary, byAgent, approvals, issues] = await Promise.all([
    getJson(base, `/api/companies/${companyId}/costs/summary`, headers, 'costs/summary'),
    getJson(base, `/api/companies/${companyId}/costs/by-agent`, headers, 'costs/by-agent'),
    getJson(base, `/api/companies/${companyId}/approvals`, headers, 'approvals'),
    getJson(base, `/api/companies/${companyId}/issues`, headers, 'issues'),
  ]);
  // Run outcomes need the full heartbeat-run list; the window filter is applied
  // in the library so the same data can be replayed in a test.
  const runs = asList(await getJson(base, `/api/companies/${companyId}/heartbeat-runs`, headers, 'heartbeat-runs'));

  const budgets = parseYaml(readFileSync(args.budgets ?? 'config/budgets.yaml', 'utf8'));
  const dataRoot = args.dataRoot ?? 'data';
  const manifest = readManifest(dataRoot);

  // Input 7. The evaluator's refusal is a REPORTED result, not a crash: the
  // digest must ship even on a day the portfolio cannot be read.
  let portfolio = {};
  if (args.portfolio) {
    try {
      const { results } = runPortfolio({
        portfolioPath: args.portfolioConfig ?? 'config/portfolio.yaml',
        productsRoot: resolve((args.productsRoot ?? `${homedir()}/git-personal`).replace(/^~/, homedir())),
        dataRoot,
        now,
      });
      portfolio = { results };
    } catch (err) {
      portfolio = { error: err.message };
    }
  }

  const digest = buildDigest({
    now, since, budgets, summary, byAgent: asList(byAgent), approvals: asList(approvals),
    issues: asList(issues), runs, manifest, portfolio,
  });

  if (args.gate) {
    // One line, machine-readable, on stdout; the digest itself is NOT printed
    // here. The waking agent re-runs without --gate to get the full text, so
    // the gate stays cheap and the digest stays single-sourced.
    const { any, flags } = digest.anomalies;
    console.log(JSON.stringify({ wake: any, flag_count: flags.length, checks: flags.map((f) => f.check), generated_at: digest.generated_at }));
    process.exit(any ? 0 : 20);
  }

  console.log(args.json ? JSON.stringify(digest, null, 2) : render(digest));
}

main().catch((err) => {
  console.error(`metrics-digest: ${err.message}`);
  process.exit(1);
});
