/**
 * Liveness signalling for the quota-retry watchdog (APP-103 / DEBT-0003).
 *
 * WHY THIS EXISTS: the watchdog was the only one of AppForge's three
 * LaunchAgents with no liveness signal. `backup.sh` and `sync.sh` both ping
 * healthchecks.io on a successful pass and push an ntfy alert on a failed
 * one; the watchdog's only evidence of life was
 * `logs/quota-retry-watchdog.log`, which nobody reads unless already
 * suspicious. That matters more here than for the sibling jobs: a silent
 * backup job means a missed backup, but a silent watchdog can mean a
 * *paused agent*, because pausing is exactly how this workaround preempts
 * Paperclip's scheduler (see `../quota-retry-watchdog.mjs`).
 *
 * WHAT IT COVERS: the cases where the script stops running at all -- the
 * LaunchAgent gets unloaded (`launchctl bootout`, a failed reload after an
 * edit), the node binary path baked into the plist stops resolving, or the
 * pass throws every time. None of those leave a log line, so only a
 * dead-man's switch catches them. The in-script bounded-pause invariant
 * (`overduePauses` in `./quota-retry-watchdog.mjs`) covers the complementary
 * case where the script *is* running but has lost track of a pause.
 *
 * DEGRADE-SILENT CONTRACT: every function here is a no-op when its env var
 * is absent, and none of them ever throw or reject. The values reach the
 * process through the plist, a template that install-plists.sh fills from
 * `.envrc` at install time (never committed); until a value is provisioned
 * the watchdog must keep doing its real job without crashing and without
 * noise. A monitoring
 * failure must never become an availability failure for the thing being
 * monitored.
 *
 * Uses Node's global `fetch` rather than shelling out to `/usr/bin/curl`
 * the way the sibling shell scripts do. The sibling scripts pin an absolute
 * curl path because this Mac's PATH can resolve to Anaconda's bundled curl,
 * whose CA bundle does not trust the MDM root CA; Node's fetch uses Node's
 * own bundled CA set and is not affected by that PATH hazard at all.
 */

/**
 * Reads the notifier configuration out of an environment bag.
 *
 * `HEALTHCHECKS_PING_URL_WATCHDOG` is deliberately a *distinct* check from
 * `HEALTHCHECKS_PING_URL_PAPERCLIP` (sync.sh) and
 * `HEALTHCHECKS_PING_URL_BACKUP` (backup.sh): each LaunchAgent needs its own
 * dead-man's switch or one job's silence is masked by another job's pings.
 * `NTFY_TOPIC` is shared with the sibling jobs — it is the founder's single
 * push channel, not a per-job value.
 */
export function notifierConfigFromEnv(env = process.env) {
  const healthcheckUrl = (env.HEALTHCHECKS_PING_URL_WATCHDOG || '').trim();
  const ntfyTopic = (env.NTFY_TOPIC || '').trim();
  return {
    healthcheckUrl: healthcheckUrl || null,
    ntfyTopic: ntfyTopic || null,
    enabled: Boolean(healthcheckUrl || ntfyTopic),
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One best-effort HTTP call. Never throws, never rejects: returns `true` on
 * a 2xx, `false` on anything else (non-2xx, DNS failure, timeout, offline
 * Mac). The watchdog's own work has already happened by the time these are
 * called, so a failed ping is worth a log line and nothing more.
 */
async function bestEffort(url, { body, fetchFn, timeoutMs, log, label }) {
  try {
    const res = await fetchFn(url, {
      method: body === undefined ? 'GET' : 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log?.(`NOTIFY ${label} returned HTTP ${res.status} (ignored — monitoring must not break the pass)`);
      return false;
    }
    return true;
  } catch (err) {
    log?.(`NOTIFY ${label} failed: ${err.message} (ignored — monitoring must not break the pass)`);
    return false;
  }
}

/**
 * Reports a healthy pass to healthchecks.io. Silent no-op when
 * `HEALTHCHECKS_PING_URL_WATCHDOG` is unset.
 *
 * Grace period on the healthchecks.io side wants to be a small multiple of
 * the plist's `StartInterval: 90` — see `infra/macos/README.md`; 10 minutes
 * (~6 passes) is the documented value, loose enough to survive a single
 * slow pass or a brief sleep, tight enough that a truly dead LaunchAgent is
 * noticed the same hour.
 */
export async function pingPassSucceeded(config, { fetchFn = fetch, log, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!config.healthcheckUrl) return false;
  return bestEffort(config.healthcheckUrl, { fetchFn, timeoutMs, log, label: 'healthcheck success ping' });
}

/**
 * Reports a failed pass: a `/fail` ping to healthchecks.io (so the check
 * goes red immediately rather than after the grace period) and an ntfy push
 * to the founder. Either half is skipped silently if its env var is unset,
 * and both are best-effort.
 *
 * `reason` is truncated because healthchecks.io keeps only the first 10KB of
 * a ping body and ntfy messages are pushed to a phone — a full stack trace
 * is in `logs/quota-retry-watchdog.log`, the alert only has to say enough to
 * send the reader there.
 *
 * `push: false` skips the ntfy half only -- see `planFailureAlert` for why
 * the phone push is throttled but the healthchecks.io `/fail` ping is not.
 */
export async function alertPassFailed(config, reason, { fetchFn = fetch, log, timeoutMs = DEFAULT_TIMEOUT_MS, push = true } = {}) {
  const text = String(reason ?? 'unknown failure').slice(0, 900);
  const results = [];
  if (config.healthcheckUrl) {
    results.push(
      await bestEffort(`${config.healthcheckUrl.replace(/\/$/, '')}/fail`, {
        body: text,
        fetchFn,
        timeoutMs,
        log,
        label: 'healthcheck fail ping',
      }),
    );
  }
  if (config.ntfyTopic && push) {
    results.push(
      await bestEffort(`https://ntfy.sh/${config.ntfyTopic}`, {
        body: `AppForge quota watchdog pass failed: ${text}`,
        fetchFn,
        timeoutMs,
        log,
        label: 'ntfy alert',
      }),
    );
  }
  return results.some(Boolean);
}

// -- alert throttling (PR #14 review) ----------------------------------------
//
// The watchdog runs every 90s. Pushing on every failed pass turns one stuck
// resume into ~960 phone notifications a day, and a channel that noisy gets
// muted -- so the alert stops working exactly when the failure has lasted long
// enough to matter. The rule: push on the first failure, on a change in what
// is failing, and otherwise at most once per ALERT_REPEAT_MS while it persists;
// push once more when it recovers.
//
// Only the ntfy push is throttled. The healthchecks.io `/fail` ping still goes
// out every failed pass: it is not a phone push, healthchecks.io itself only
// notifies on up/down transitions, and it keeps the check red.
//
// These are pure functions over a small persisted record, because each pass is
// a fresh process; `main` in ../quota-retry-watchdog.mjs owns the file.

export const ALERT_REPEAT_MS = 3_600_000;

/**
 * What identifies "the same failure" across passes. Digits are normalised
 * away because the messages carry durations and counts ("resume was due
 * 41min ago") that change every pass without the fault changing; agent and
 * run ids are stable per fault, so they stay.
 */
function failureSignature(reason) {
  return String(reason ?? '').replace(/\d+/g, '#');
}

/**
 * Decides whether this failed pass pushes, and returns the record to persist.
 * `prev` is the previous record, or null/undefined when there is none.
 */
export function planFailureAlert(prev, { nowMs, reason, repeatMs = ALERT_REPEAT_MS }) {
  const signature = failureSignature(reason);
  const continuing = Boolean(prev?.failing);
  const push =
    !continuing ||
    prev.signature !== signature ||
    !(Number.isFinite(prev.lastPushAtMs) && nowMs - prev.lastPushAtMs < repeatMs);
  return {
    push,
    next: {
      failing: true,
      signature,
      sinceMs: continuing && Number.isFinite(prev.sinceMs) ? prev.sinceMs : nowMs,
      lastPushAtMs: push ? nowMs : prev.lastPushAtMs,
      suppressed: push ? 0 : (prev.suppressed || 0) + 1,
    },
  };
}

/** A healthy pass: push a recovery notice only if a failure streak just ended. */
export function planRecovery(prev) {
  return { push: Boolean(prev?.failing), next: { failing: false } };
}

/** One ntfy push saying the watchdog is healthy again. Never throws. */
export async function notifyRecovered(config, { fetchFn = fetch, log, timeoutMs = DEFAULT_TIMEOUT_MS, suppressed = 0 } = {}) {
  if (!config.ntfyTopic) return false;
  const tail = suppressed > 0 ? ` (${suppressed} repeat alert(s) were suppressed while it was failing)` : '';
  return bestEffort(`https://ntfy.sh/${config.ntfyTopic}`, {
    body: `AppForge quota watchdog recovered: passes are healthy again${tail}`,
    fetchFn,
    timeoutMs,
    log,
    label: 'ntfy recovery notice',
  });
}
