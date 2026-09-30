#!/usr/bin/env node
// Measure Claude provider session-budget consumption from Paperclip's
// heartbeat-run history (APP-45).
//
//   node scripts/session-burn.mjs                  # last 6h (one session window + slack)
//   node scripts/session-burn.mjs --hours 24
//   node scripts/session-burn.mjs --since 2026-09-28T03:34:38Z   # e.g. "after the APP-29 cap fix"
//   node scripts/session-burn.mjs --json
//
// Needs PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_KEY. A plain
// agent key is enough: /heartbeat-runs is readable without `agents:configure`,
// which is deliberate — measuring the problem must not require the grant that
// fixing it does.
//
// Companion to sync-agent-heartbeat.mjs (APP-39) and sync-agent-turn-limits.mjs
// (APP-29): those two WRITE the ceilings, this one READS what the ceilings
// actually cost. Run it before proposing a change to either.
//
// On the `imputed $` column: these runs are `subscription_included`, so that
// figure is list-price-equivalent, NOT cash, and it does not draw down
// DEC-0004's $100/mo cap. It is a proxy for pressure on the shared session
// window. Token counts are the honest measure; do not quote the dollar column
// as spend.
import { buildBurnReport } from './lib/session-burn.mjs';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`session-burn: ${name} is not set`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const args = { hours: 6, since: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--hours') args.hours = Number(argv[(i += 1)]);
    else if (arg === '--since') args.since = argv[(i += 1)];
    else {
      console.error(`session-burn: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!args.since && !(args.hours > 0)) {
    console.error('session-burn: --hours must be a positive number');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = requireEnv('PAPERCLIP_API_URL').replace(/\/$/, '');
  const companyId = requireEnv('PAPERCLIP_COMPANY_ID');
  const headers = { Authorization: `Bearer ${requireEnv('PAPERCLIP_API_KEY')}` };

  const [runsRes, agentsRes] = await Promise.all([
    fetch(`${base}/api/companies/${companyId}/heartbeat-runs`, { headers }),
    fetch(`${base}/api/companies/${companyId}/agents`, { headers }),
  ]);
  for (const [label, res] of [['heartbeat-runs', runsRes], ['agents', agentsRes]]) {
    if (!res.ok) {
      console.error(`session-burn: GET ${label} failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
  }
  const allRuns = await runsRes.json();
  const agentList = await agentsRes.json();
  const names = Object.fromEntries(
    (Array.isArray(agentList) ? agentList : agentList.agents || []).map((a) => [a.id, a.name]),
  );

  const now = new Date().toISOString();
  // `--since` pins the window start to a real event (a config change, a
  // reset). Otherwise walk back `--hours` from now.
  const startMs = args.since ? Date.parse(args.since) : Date.now() - args.hours * 3_600_000;
  if (Number.isNaN(startMs)) {
    console.error(`session-burn: --since is not a parseable timestamp: ${args.since}`);
    process.exit(2);
  }
  const runs = allRuns.filter((run) => Date.parse(run.createdAt) >= startMs);
  if (runs.length === 0) {
    console.error(`session-burn: no runs since ${new Date(startMs).toISOString()}`);
    process.exit(1);
  }
  // Measure against the window the caller asked about, not against the span the
  // surviving runs happen to cover — a quiet stretch inside the window is a
  // real part of the average and must not be cropped out.
  const windowHours = (Date.now() - startMs) / 3_600_000;
  const report = buildBurnReport(runs, { windowHours, now, names });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const usd = (n) => n.toFixed(2);
  const k = (n) => `${Math.round(n / 1000)}K`;

  console.log(
    `window: ${new Date(startMs).toISOString()} .. ${now}  (${windowHours.toFixed(2)}h)  ` +
      `${report.runsConsidered} runs${report.runsIgnored ? `, ${report.runsIgnored} not yet run` : ''}\n`,
  );

  console.log('per agent'.padEnd(12) + 'runs'.padStart(5) + 'in_tok'.padStart(9) + 'out_tok'.padStart(9) + 'imputed$'.padStart(10) + '$/hr'.padStart(8));
  for (const [name, b] of Object.entries(report.byAgent).sort((a, b) => b[1].imputedUsd - a[1].imputedUsd)) {
    console.log(
      name.padEnd(12) + String(b.runs).padStart(5) + k(b.inputTokens).padStart(9) +
        k(b.outputTokens).padStart(9) + usd(b.imputedUsd).padStart(10) +
        usd(b.imputedUsd / windowHours).padStart(8),
    );
  }

  console.log('\nper outcome'.padEnd(22) + 'runs'.padStart(4) + 'in_tok'.padStart(9) + 'imputed$'.padStart(10));
  for (const [outcome, b] of Object.entries(report.byOutcome).sort((a, b) => b[1].imputedUsd - a[1].imputedUsd)) {
    console.log(outcome.padEnd(22) + String(b.runs).padStart(4) + k(b.inputTokens).padStart(9) + usd(b.imputedUsd).padStart(10));
  }

  const { rate, concurrency, quota } = report;
  const productive = report.byOutcome.succeeded?.imputedUsd || 0;
  console.log(
    `\nburn rate      ${k(rate.inputTokensPerHour)} input tok/hr, $${usd(rate.imputedUsdPerHour)}/hr imputed` +
      `\nproductive     $${usd(productive)} of $${usd(rate.imputedUsd)} ` +
      `(${rate.imputedUsd ? ((100 * productive) / rate.imputedUsd).toFixed(1) : '0.0'}% went to runs that succeeded)`,
  );

  // Both numbers, always: per-agent ceilings cannot bound a shared budget, and
  // a per-agent-only reading hides that.
  const perAgentPeaks = Object.entries(concurrency.perAgent)
    .map(([id, n]) => `${names[id] || id}=${n}`)
    .sort()
    .join(' ');
  console.log(
    `\nconcurrency    company peak ${concurrency.companyPeak}` +
      `${concurrency.companyPeakAt ? ` at ${concurrency.companyPeakAt}` : ''}` +
      `\n               per agent    ${perAgentPeaks || '(none)'}`,
  );

  if (quota.runs > 0) {
    console.log(
      `\nquota failures ${quota.runs} run(s) burned ${k(quota.inputTokens)} input tok / ` +
        `$${usd(quota.imputedUsd)} imputed and returned nothing`,
    );
    if (quota.retriedWithinResetWindow > 0) {
      console.log(
        `               ${quota.retriedWithinResetWindow} re-queued under ` +
          `${quota.misclassifiedAs.join(', ')} rather than waiting for the provider reset`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`session-burn: ${err.message}`);
  process.exit(1);
});
