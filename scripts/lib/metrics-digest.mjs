// `appforge metrics digest` — the daily digest the CEO HEARTBEAT's first step
// ("Pull Analyst's daily digest") has always assumed and that has never
// existed anywhere (APP-43).
//
// Deterministic. No model call. Every function here is a pure transform over
// data the caller fetched, so the digest can be tested without a control
// plane and cannot quietly become a narrative.
//
// Inputs 1-4 are live today. Inputs 5-7 are reported WITH THEIR GAPS rather
// than omitted: "a digest that waits for completeness is a digest that never
// ships", and a silently absent section is indistinguishable from a healthy
// one.

export const SECTION = Object.freeze({
  SPEND: 'spend',
  RUNS: 'runs',
  APPROVALS: 'approvals',
  INCIDENTS: 'incidents',
  STORE: 'store_metrics',
  ANOMALIES: 'anomalies',
  PORTFOLIO: 'portfolio',
});

const DAY_MS = 86400000;

export function ageDays(from, now) {
  if (!from) return null;
  return Math.floor((now - new Date(from)) / DAY_MS);
}

// --- 1. spend ---------------------------------------------------------------

/**
 * Spend against the $100/mo cap (DEC-0004) and per-agent `budget_cents`.
 *
 * The honest reading matters more than the number here. Runs on a Claude
 * subscription report `costCents: 0` because they are not metered per call —
 * so "0% of the cap" is NOT evidence of frugality, it is evidence that the
 * cap is not the instrument measuring this consumption. Reporting the
 * percentage without that caveat is the vanity-metric failure §22.2 names.
 * Token volume is carried alongside as the quantity that actually moves.
 */
export function buildSpend({ summary, byAgent, budgets }) {
  const monthly = budgets?.monthly_cents ?? {};
  const capCents = monthly.company ?? summary?.budgetCents ?? null;
  const spendCents = summary?.spendCents ?? 0;

  const agents = (byAgent ?? []).map((a) => {
    const key = String(a.agentName ?? '').toLowerCase();
    const budgetCents = monthly[key] ?? null;
    const subscriptionOnly = (a.apiRunCount ?? 0) === 0 && (a.subscriptionRunCount ?? 0) > 0;
    return {
      agent: a.agentName,
      budget_key: key in monthly ? key : null,
      budget_cents: budgetCents,
      cost_cents: a.costCents ?? 0,
      utilization: budgetCents ? (a.costCents ?? 0) / budgetCents : null,
      api_runs: a.apiRunCount ?? 0,
      subscription_runs: a.subscriptionRunCount ?? 0,
      subscription_only: subscriptionOnly,
      input_tokens: a.inputTokens ?? 0,
      cached_input_tokens: a.cachedInputTokens ?? 0,
      output_tokens: a.outputTokens ?? 0,
      unbudgeted: budgetCents == null,
    };
  });

  const allSubscription = agents.length > 0 && agents.every((a) => a.api_runs === 0);

  return {
    cap_cents: capCents,
    spend_cents: spendCents,
    utilization: capCents ? spendCents / capCents : null,
    metered: !allSubscription,
    metering_note: allSubscription
      ? 'every run this period was a subscription run, so costCents is 0 by construction. ' +
        'The $100/mo cap is NOT the instrument measuring this consumption — read token volume, not utilisation.'
      : null,
    agents,
    unbudgeted_agents: agents.filter((a) => a.unbudgeted).map((a) => a.agent),
    total_output_tokens: agents.reduce((s, a) => s + a.output_tokens, 0),
  };
}

// --- 2. run outcomes --------------------------------------------------------

const TERMINAL_BAD = new Set(['failed', 'error', 'timeout', 'cancelled']);
// APP-338: the claude_local adapter SIGTERMs the CLI 5s after its final result
// when a Monitor / run_in_background task keeps it alive. The CLI exits 143 and
// the server records `adapter_failed` / "Adapter failed"; this livenessReason
// is the only field that tells that apart from a real adapter failure.
const BACKGROUND_WAIT_KILLED = 'unmanaged background task stopped';

/**
 * Run outcomes since the last digest — failures, abandoned runs,
 * `error_max_turns` (the APP-29 failure mode) and escalations.
 *
 * `errorCode` and `scheduledRetryReason` describe DIFFERENT runs and must not
 * be merged. `errorCode` is how THIS run ended; `scheduledRetryReason` is why
 * the harness scheduled the NEXT one. A run can end `provider_quota` while
 * scheduling a `max_turns_continuation`, so matching /max_turns/ across both
 * fields counts one turn-ceiling event twice and attributes quota failures to
 * APP-29. The two are bucketed separately here for that reason.
 */
export function buildRuns({ runs, since, now }) {
  const window = (runs ?? []).filter((r) => new Date(r.createdAt) >= since);
  const byStatus = {};
  const byErrorCode = {};
  for (const r of window) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.errorCode) byErrorCode[r.errorCode] = (byErrorCode[r.errorCode] ?? 0) + 1;
  }

  const failures = window.filter((r) => TERMINAL_BAD.has(r.status));
  // APP-29: a run that EXHAUSTED its turn budget is not a generic failure; it
  // is a specific, recurring, fixable one and gets counted on its own.
  const maxTurns = window.filter((r) => /max_turns/.test(r.errorCode ?? ''));
  // A continuation is the harness handing a run another window. It is churn,
  // not a failure, and it is the run's SUCCESSOR that carries it — so it is
  // reported as a count, never folded into the APP-29 bucket.
  const continuations = window.filter((r) => /max_turns/.test(r.scheduledRetryReason ?? ''));
  // A run that started and never reported an end is abandoned, not running,
  // once it is older than the window itself.
  const abandoned = window.filter(
    (r) => r.startedAt && !r.finishedAt && TERMINAL_BAD.has(r.status) === false
      && new Date(r.startedAt) < new Date(now - DAY_MS)
  );
  const retries = window.filter((r) => r.retryOfRunId);
  const backgroundWaitKilled = failures.filter((r) => (r.livenessReason ?? '').startsWith(BACKGROUND_WAIT_KILLED));
  // §6.1 rule 6 escalations surface as a run the harness gave up retrying.
  const escalations = window.filter((r) => r.errorCode === 'agent_paused' || r.errorCode === 'agent_not_invokable');

  return {
    since: since.toISOString(),
    total: window.length,
    by_status: byStatus,
    by_error_code: byErrorCode,
    failures: failures.map((r) => ({
      run_id: r.id, agent_id: r.agentId, status: r.status,
      error_code: r.errorCode, error: r.error ? String(r.error).slice(0, 240) : null,
      created_at: r.createdAt,
    })),
    max_turns: maxTurns.map((r) => ({
      run_id: r.id, agent_id: r.agentId, error_code: r.errorCode,
      retry_attempt: r.scheduledRetryAttempt ?? null, created_at: r.createdAt,
    })),
    max_turns_continuations: continuations.length,
    abandoned: abandoned.map((r) => ({ run_id: r.id, agent_id: r.agentId, started_at: r.startedAt })),
    escalations: escalations.map((r) => ({ run_id: r.id, agent_id: r.agentId, error_code: r.errorCode })),
    background_wait_killed: backgroundWaitKilled.map((r) => ({ run_id: r.id, agent_id: r.agentId, error_code: r.errorCode, created_at: r.createdAt })),
    retry_count: retries.length,
    failure_rate: window.length ? failures.length / window.length : null,
  };
}

// --- 3. approvals -----------------------------------------------------------

const OPEN_APPROVAL = new Set(['pending', 'requested', 'revision_requested', 'open']);

export function buildApprovals({ approvals, now }) {
  const open = (approvals ?? []).filter((a) => OPEN_APPROVAL.has(a.status));
  const rows = open
    .map((a) => ({
      id: a.id, type: a.type, status: a.status,
      requested_by_agent_id: a.requestedByAgentId ?? null,
      age_days: ageDays(a.createdAt, now),
      created_at: a.createdAt,
    }))
    .sort((x, y) => (y.age_days ?? 0) - (x.age_days ?? 0));
  return { open: rows.length, oldest_age_days: rows[0]?.age_days ?? null, rows };
}

// --- 4. incidents -----------------------------------------------------------

const SEV_RE = /^sev([0-4])$/i;
const TERMINAL_ISSUE = new Set(['done', 'cancelled']);

// Labels arrive as objects from the control plane; tolerate bare strings too.
function labelNames(issue) {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

/**
 * Open incidents by SEV with age.
 *
 * A zero here is a MEASURED zero, not an assumed one — the query is live and
 * runs against every issue in the company. That distinction is load-bearing:
 * `unresolvable_policy_or_security_risk` reads this input, and the config is
 * explicit that "zero matching incidents is a MEASURED zero, not an assumed one".
 */
export function buildIncidents({ issues, now }) {
  const all = issues ?? [];
  // A measured zero is only as strong as the convention it measures. If NO
  // issue in the company has ever carried `type:incident` — open or closed —
  // then "0 open incidents" is indistinguishable from "nobody labels
  // incidents", and saying the former would be the vanity reading. Report
  // which of the two this is.
  const conventionEverUsed = all.some((i) => labelNames(i).includes('type:incident'));
  const incidents = all.filter(
    (i) => !TERMINAL_ISSUE.has(i.status) && labelNames(i).includes('type:incident')
  );
  const rows = incidents.map((i) => {
    const sevLabel = labelNames(i).find((n) => SEV_RE.test(n));
    return {
      identifier: i.identifier, title: i.title, status: i.status,
      sev: sevLabel ? sevLabel.toUpperCase() : 'UNLABELLED',
      age_days: ageDays(i.createdAt, now),
      assignee_agent_id: i.assigneeAgentId ?? null,
    };
  });
  const bySev = {};
  for (const r of rows) bySev[r.sev] = (bySev[r.sev] ?? 0) + 1;
  return {
    open: rows.length,
    by_sev: bySev,
    measured: true,
    issues_scanned: all.length,
    convention_in_use: conventionEverUsed,
    convention_note: conventionEverUsed ? null
      : `scanned ${all.length} issue(s); NOT ONE carries the \`type:incident\` label, ` +
        'so this zero means "no issue is labelled as an incident", not "no incident happened". '
        + 'config/security.yaml defines SEV0-SEV4 but no label convention, and nothing writes one.',
    rows: rows.sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)),
  };
}

// --- 5. store-metric deltas -------------------------------------------------

/**
 * Store-metric deltas — "ONLY on days a fresh export landed. The other six
 * days must read 'no new store data (last import as_of …)'. Never restate
 * last week's figures as today's."
 *
 * So this returns a delta only when an import's `as_of` falls inside the
 * window. Otherwise it returns the last import's `as_of` and nothing else.
 * There is no code path that emits a figure from an import it did not
 * receive today.
 */
export function buildStoreMetrics({ manifest, since, now }) {
  const entries = [...(manifest ?? [])].sort((a, b) => a.as_of.localeCompare(b.as_of));
  if (entries.length === 0) {
    return {
      fresh_import_today: false,
      last_import_as_of: null,
      message: 'no store export has ever landed — no store data exists to delta against',
      deltas: [],
    };
  }
  const last = entries[entries.length - 1];
  const landed = entries.filter((e) => new Date(e.recorded_at ?? e.exported_at) >= since);

  if (landed.length === 0) {
    return {
      fresh_import_today: false,
      last_import_as_of: last.as_of,
      message: `no new store data (last import as_of ${last.as_of})`,
      deltas: [],
    };
  }

  const deltas = [];
  for (const entry of landed) {
    for (const [metric, value] of Object.entries(entry.metrics ?? {})) {
      const prior = entries
        .filter((e) => e.item_id === entry.item_id && e.as_of < entry.as_of && metric in (e.metrics ?? {}))
        .pop();
      deltas.push({
        item_id: entry.item_id, metric, value, as_of: entry.as_of,
        prior_value: prior ? prior.metrics[metric] : null,
        prior_as_of: prior ? prior.as_of : null,
        delta: prior && typeof value === 'number' && typeof prior.metrics[metric] === 'number'
          ? value - prior.metrics[metric] : null,
      });
    }
  }
  return {
    fresh_import_today: true,
    last_import_as_of: last.as_of,
    message: `${landed.length} import(s) landed since ${since.toISOString().slice(0, 10)}`,
    deltas,
  };
}

// --- 6. anomaly flags -------------------------------------------------------

/**
 * Deterministic anomaly flags (§6.2). These gate Analyst's 06:30 wake, which
 * "correctly stays silent when nothing crosses a threshold" — so every check
 * here must be computable without a model, and the absence of a flag must
 * mean "checked and nothing crossed", never "could not check".
 *
 * Checks that CANNOT be computed today are returned under `unavailable`, so
 * the routine's gate is never quietly satisfied or quietly starved by a
 * missing input.
 */
export function buildAnomalies({ spend, runs, approvals, incidents, store, portfolio, budgets, now }) {
  const flags = [];
  const unavailable = [];

  // budget — §24.3 alert thresholds. config/budgets.yaml spells these
  // `soft_pct`/`hard_pct`; reading a key the file does not define would have
  // silently pinned every threshold to the hardcoded default, which is the
  // same class of bug as defaulting a missing metric to 0.
  const warnAt = budgets?.alerts?.soft_pct;
  const hardAt = budgets?.alerts?.hard_pct;
  if (warnAt == null) {
    unavailable.push({ check: 'agent_budget', reason: 'config/budgets.yaml declares no alerts.soft_pct; a budget threshold cannot be evaluated' });
  }
  if (warnAt != null) {
    for (const a of spend.agents) {
      if (a.utilization == null) continue;
      const pct = a.utilization * 100;
      if (hardAt != null && pct >= hardAt) {
        flags.push({ check: 'agent_budget', severity: 'breach', detail: `${a.agent} at ${pct.toFixed(0)}% of ${a.budget_cents} cents — past hard_pct ${hardAt}` });
      } else if (pct >= warnAt) {
        flags.push({ check: 'agent_budget', severity: 'warn', detail: `${a.agent} at ${pct.toFixed(0)}% of ${a.budget_cents} cents` });
      }
    }
    if (spend.utilization != null && spend.utilization * 100 >= warnAt && spend.metered) {
      flags.push({ check: 'company_budget', severity: 'warn', detail: `company spend at ${(spend.utilization * 100).toFixed(0)}% of the ${spend.cap_cents}-cent cap` });
    }
  }
  if (!spend.metered) {
    unavailable.push({ check: 'company_budget', reason: 'all runs are subscription runs; cost is not metered, so a spend threshold cannot be crossed' });
  }
  if (spend.unbudgeted_agents.length) {
    flags.push({ check: 'unbudgeted_agent', severity: 'warn', detail: `no budgets.yaml entry for: ${spend.unbudgeted_agents.join(', ')}` });
  }

  // runs
  if (runs.max_turns.length > 0) {
    flags.push({ check: 'error_max_turns', severity: 'warn', detail: `${runs.max_turns.length} run(s) EXHAUSTED the turn ceiling (APP-29 failure mode); ${runs.max_turns_continuations} further run(s) were continued at the ceiling` });
  }
  if (runs.escalations.length > 0) {
    flags.push({ check: 'run_escalation', severity: 'warn', detail: `${runs.escalations.length} run(s) ended paused or not-invokable — §6.1 rule 6 escalation territory` });
  }
  if (runs.background_wait_killed.length > 0) {
    flags.push({ check: 'background_wait_killed', severity: 'warn', detail: `${runs.background_wait_killed.length} run(s) ended while a Monitor / background task was live and were killed (shared rule 13, APP-338)` });
  }
  if (runs.failures.length > 0) {
    flags.push({ check: 'run_failures', severity: 'warn', detail: `${runs.failures.length} failed run(s) of ${runs.total}` });
  }

  // approvals
  if (approvals.oldest_age_days != null && approvals.oldest_age_days >= 3) {
    flags.push({ check: 'approval_aging', severity: 'warn', detail: `oldest open approval is ${approvals.oldest_age_days}d old` });
  }

  // incidents — any open SEV0-2 is a flag by config/security.yaml's fail_on: SEV2
  for (const r of incidents.rows) {
    if (['SEV0', 'SEV1', 'SEV2'].includes(r.sev)) {
      flags.push({ check: 'open_incident', severity: r.sev.toLowerCase(), detail: `${r.identifier} ${r.sev}, ${r.age_days}d old` });
    }
  }

  // store metrics — a skipped export is itself the anomaly
  if (!store.fresh_import_today && store.last_import_as_of) {
    const age = Math.floor((now - new Date(store.last_import_as_of)) / DAY_MS);
    if (age > 14) {
      flags.push({ check: 'store_export_stale', severity: 'warn', detail: `newest store import is as_of ${store.last_import_as_of}, ${age}d old` });
    }
  }
  // The §6.2 gate names "the ingest job's deterministic anomaly check" — a
  // week-over-week delta threshold. That needs two readings on one surface,
  // and no product has two.
  unavailable.push({
    check: 'store_metric_delta',
    reason: 'a delta threshold needs >=2 readings of one metric on one surface; no product has two. Blocked on APP-54 (CWS export) and APP-210 (Play service account).',
  });

  // portfolio — a SCALE/PAUSE/SUNSET/ITERATE is the §22.1 signal itself, and a
  // refusal means the portfolio is unreadable today. Both need the CEO.
  if (portfolio?.refused) {
    flags.push({ check: 'portfolio_refused', severity: 'warn', detail: 'the §22.1 evaluator refused to emit any verdict — product inputs are unusable' });
  }
  for (const a of portfolio?.actionable ?? []) {
    flags.push({ check: 'portfolio_outcome', severity: 'warn', detail: `${a.product} → ${a.outcome} (${a.reason_codes.join(', ') || 'no reason code'})` });
  }
  if (portfolio && portfolio.available === false && !portfolio.refused) {
    unavailable.push({ check: 'portfolio_outcome', reason: portfolio.reason });
  }

  return { any: flags.length > 0, flags, unavailable };
}

// --- 7. per-product portfolio outcome ---------------------------------------

/**
 * Per-product portfolio outcome from script 1 (`appforge metrics portfolio`).
 *
 * The caller passes either the evaluator's results or the error it refused
 * with. A refusal is NOT an absent section: the evaluator declining to emit a
 * verdict is itself the day's most important portfolio fact, and burying it
 * would reintroduce exactly the confident-wrong-answer failure the APP-86
 * input guard exists to prevent.
 */
export function buildPortfolio({ results, error }) {
  if (error) {
    return {
      available: false,
      refused: true,
      reason: error,
      note: 'the evaluator refused to emit a verdict for ANY product. This is the designed '
        + 'behaviour for unjustifiable inputs, not a digest failure — fix the named product.yaml.',
      rows: [],
    };
  }
  if (!results) {
    return { available: false, refused: false, reason: 'portfolio evaluation was not run', rows: [] };
  }
  const tally = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
  return {
    available: true,
    refused: false,
    by_outcome: tally,
    // §22.1 exists to stop work or escalate spend. Those are the outcomes that
    // warrant CEO attention today; the rest are stated but not surfaced.
    actionable: results
      .filter((r) => ['SCALE', 'PAUSE', 'SUNSET', 'ITERATE'].includes(r.outcome))
      .map((r) => ({ product: r.product, outcome: r.outcome, reason_codes: r.reason_codes ?? [] })),
    rows: results.map((r) => ({
      product: r.product,
      outcome: r.outcome,
      reason_codes: r.reason_codes ?? [],
      blocking_rules: (r.blocking ?? []).map((b) => b.rule_id),
    })),
  };
}

// --- assembly ---------------------------------------------------------------

export function buildDigest(input) {
  const { now, since, budgets } = input;
  const spend = buildSpend(input);
  const runs = buildRuns({ runs: input.runs, since, now });
  const approvals = buildApprovals({ approvals: input.approvals, now });
  const incidents = buildIncidents({ issues: input.issues, now });
  const store = buildStoreMetrics({ manifest: input.manifest, since, now });
  const portfolio = buildPortfolio(input.portfolio ?? {});
  const anomalies = buildAnomalies({ spend, runs, approvals, incidents, store, portfolio, budgets, now });

  return {
    generated_at: now.toISOString(),
    since: since.toISOString(),
    spend, runs, approvals, incidents, store, anomalies, portfolio,
  };
}
