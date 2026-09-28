/**
 * Measure Claude provider *session budget* consumption from Paperclip's
 * heartbeat-run history (APP-45).
 *
 * WHY THIS EXISTS AS TOOLING AND NOT A ONE-OFF QUERY
 *
 * APP-29 raised `maxTurnsPerRun` 10 -> 40/60 and the binding constraint
 * immediately moved one layer down, to the provider session limit. That is the
 * second ceiling in a row that was only discovered by watching runs die. The
 * company has no instrument that answers "how much of the shared session budget
 * are we burning per hour, and who is burning it" — so every answer has been
 * reconstructed by hand from the run table after the fact. This module is that
 * instrument.
 *
 * WHAT "COST" MEANS HERE — READ THIS BEFORE QUOTING A NUMBER
 *
 * `usageJson.costUsd` on a `billingType: "subscription_included"` run is an
 * IMPUTED figure: what those tokens would have cost at API list price. It is
 * NOT cash and it does NOT draw down DEC-0004's $100/mo cap. Quoting it as
 * spend would be wrong and would look like a budget breach that has not
 * happened. It is used here as a single scalar proxy for pressure on the shared
 * subscription session window, because the provider exposes no direct
 * "fraction of session budget consumed" reading. Token counts are the honest
 * underlying measure; `imputedUsd` is a convenience roll-up over them.
 *
 * THE STRUCTURAL FINDING THIS MODULE IS BUILT TO KEEP VISIBLE
 *
 * `peakConcurrency` reports a company-wide peak alongside the per-agent peaks
 * precisely because Paperclip only offers a PER-AGENT ceiling
 * (`runtimeConfig.heartbeat.maxConcurrentRuns`). Seven agents at the APP-39
 * baseline of 2 permit 14 simultaneous runs against ONE shared session budget —
 * more than the 12 actually observed when the budget blew. Per-agent caps
 * therefore cannot bound the shared resource by construction, and a report that
 * only showed per-agent numbers would hide that. Keep both.
 */

/** Runs in these states never reached the provider, so they are not evidence. */
const NOT_YET_RUN = new Set(['queued', 'scheduled_retry']);

/**
 * Outcome class for a run, collapsing `status` and `errorCode` into the one
 * label that explains where its tokens went.
 *
 * `provider_quota` and `max_turns_exhausted` are deliberately kept apart even
 * though both are "killed by a ceiling": they need opposite responses. A
 * turn-cap death is retryable immediately (the next run makes progress); a
 * quota death is retryable only after the provider's reset, and retrying it
 * sooner re-reads the whole context and is rejected again — spending budget to
 * buy nothing. Collapsing them would erase exactly the distinction APP-45 is
 * about.
 */
export function classifyRun(run) {
  if (run.errorCode) return run.errorCode;
  if (run.status === 'succeeded') return 'succeeded';
  return run.status;
}

/** Tokens/cost actually charged to the session window by one run, or zeroes. */
export function runUsage(run) {
  const u = run.usageJson || {};
  return {
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    imputedUsd: u.costUsd || 0,
  };
}

function emptyBucket() {
  return { runs: 0, inputTokens: 0, outputTokens: 0, imputedUsd: 0 };
}

function addTo(bucket, run) {
  const u = runUsage(run);
  bucket.runs += 1;
  bucket.inputTokens += u.inputTokens;
  bucket.outputTokens += u.outputTokens;
  bucket.imputedUsd += u.imputedUsd;
  return bucket;
}

/**
 * Group consumption by a caller-supplied key (agent name, outcome class, hour).
 * Returns a plain object so callers can sort it however they need; this module
 * does not decide presentation order.
 */
export function groupBy(runs, keyFn) {
  const out = {};
  for (const run of runs) {
    const key = keyFn(run);
    out[key] = addTo(out[key] || emptyBucket(), run);
  }
  return out;
}

/**
 * Per-agent consumption, keyed by display name. `names` maps agentId -> name;
 * an id with no mapping keeps its id rather than being dropped, because a run
 * we cannot attribute still consumed the shared budget and must stay in the
 * total.
 */
export function summarizeByAgent(runs, names = {}) {
  return groupBy(runs, (run) => names[run.agentId] || run.agentId);
}

/** Consumption by outcome class — the "what did we buy with this" view. */
export function summarizeByOutcome(runs) {
  return groupBy(runs, classifyRun);
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Burn rate over an explicit window.
 *
 * The window is a required argument rather than being inferred from the runs,
 * because inferring it from first-to-last run timestamp silently reports a
 * *burst* rate as a sustained one: an idle company that fires ten runs in five
 * minutes would be scored at that five-minute pace. Callers must say what
 * period they believe these runs represent.
 */
export function burnRate(runs, windowHours) {
  if (!(windowHours > 0)) {
    throw new Error('burnRate: windowHours must be a positive number');
  }
  const total = runs.reduce((acc, run) => addTo(acc, run), emptyBucket());
  return {
    ...total,
    windowHours,
    inputTokensPerHour: total.inputTokens / windowHours,
    outputTokensPerHour: total.outputTokens / windowHours,
    imputedUsdPerHour: total.imputedUsd / windowHours,
  };
}

/**
 * Peak simultaneous runs, company-wide and per agent, by sweeping start/finish
 * events.
 *
 * `now` supplies the end time for runs that are still going. It is an argument,
 * not `Date.now()`, so the function stays pure and testable — and so that
 * analysing a historical export does not stretch every unfinished run in it all
 * the way to the present and invent concurrency that never happened.
 *
 * Ties matter: when one run finishes at the same instant another starts, the
 * finish is processed first, so a clean handoff is not miscounted as an
 * overlap.
 */
export function peakConcurrency(runs, now) {
  const endFallback = parseTime(now);
  if (endFallback === null) {
    throw new Error('peakConcurrency: `now` must be a parseable timestamp');
  }
  const events = [];
  for (const run of runs) {
    const start = parseTime(run.startedAt);
    if (start === null) continue; // never started => never held a session slot
    const finish = parseTime(run.finishedAt) ?? endFallback;
    events.push({ at: start, delta: 1, agentId: run.agentId });
    events.push({ at: Math.max(finish, start), delta: -1, agentId: run.agentId });
  }
  // -1 before +1 at equal timestamps: a handoff is not an overlap.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let live = 0;
  let companyPeak = 0;
  let companyPeakAt = null;
  const livePerAgent = new Map();
  const peakPerAgent = new Map();

  for (const event of events) {
    live += event.delta;
    const perAgent = (livePerAgent.get(event.agentId) || 0) + event.delta;
    livePerAgent.set(event.agentId, perAgent);
    if (live > companyPeak) {
      companyPeak = live;
      companyPeakAt = new Date(event.at).toISOString();
    }
    if (perAgent > (peakPerAgent.get(event.agentId) || 0)) {
      peakPerAgent.set(event.agentId, perAgent);
    }
  }
  return { companyPeak, companyPeakAt, perAgent: Object.fromEntries(peakPerAgent) };
}

/**
 * What the company paid for runs that died on the provider session limit.
 *
 * This is the number that justifies reset-aware backoff. A quota-failed run is
 * not free: it re-reads its whole context — tens of thousands of input tokens —
 * before the provider rejects it. Retrying such a run while the window is still
 * closed converts budget directly into nothing, and (because the tokens are
 * still counted) pushes the reset no closer.
 *
 * `retriedWithinResetWindow` counts the quota failures that a scheduler
 * re-queued on a short transient-style delay rather than waiting for the
 * provider's stated reset. Those are the unambiguously wasted ones.
 */
export function quotaWaste(runs) {
  const quotaRuns = runs.filter((run) => run.errorCode === 'provider_quota');
  const total = quotaRuns.reduce((acc, run) => addTo(acc, run), emptyBucket());
  const misscheduled = quotaRuns.filter(
    (run) => run.scheduledRetryAt && run.scheduledRetryReason !== 'provider_quota',
  );
  return {
    ...total,
    retriedWithinResetWindow: misscheduled.length,
    // The reasons a quota failure was filed under. Anything other than a
    // quota-aware reason here is the scheduler mistaking a timed lockout for a
    // blip and retrying into a closed window.
    misclassifiedAs: [...new Set(misscheduled.map((run) => run.scheduledRetryReason))].sort(),
  };
}

/**
 * Full report for a set of runs. `windowHours` and `now` are passed through to
 * the two functions that genuinely need a caller-supplied frame of reference.
 */
export function buildBurnReport(runs, { windowHours, now, names = {} }) {
  const consuming = runs.filter((run) => !NOT_YET_RUN.has(run.status));
  return {
    runsConsidered: consuming.length,
    runsIgnored: runs.length - consuming.length,
    byAgent: summarizeByAgent(consuming, names),
    byOutcome: summarizeByOutcome(consuming),
    rate: burnRate(consuming, windowHours),
    concurrency: peakConcurrency(consuming, now),
    quota: quotaWaste(consuming),
  };
}
