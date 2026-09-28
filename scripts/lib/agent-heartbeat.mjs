import { parse } from 'yaml';

/**
 * Reconcile config/agents.yaml -> Paperclip `runtimeConfig.heartbeat` (APP-39).
 *
 * Two fields are in scope:
 *   `heartbeat.timer`          -> runtimeConfig.heartbeat.enabled
 *   `heartbeat.max_concurrent` -> runtimeConfig.heartbeat.maxConcurrentRuns
 *
 * WHY THIS IS NOT SHAPED LIKE agent-turn-limits.mjs
 *
 * `adapterConfig` MERGES server-side, so the turn-limit reconciler can send one
 * field and trust the rest to survive. `runtimeConfig` does NOT: the update path
 * assigns it wholesale (`patch.runtimeConfig = payload.runtimeConfig`), and
 * there is no `replaceRuntimeConfig` flag to opt out of. Whatever you send is
 * the entire new value.
 *
 * That alone would be survivable with a read-modify-write, except reads are
 * sanitized: every agent read runs `runtimeConfig` through the event-payload
 * redactor, and unlike `adapterConfig.env` there is NO restore pass to put the
 * real values back on write. So a naive read-modify-write can permanently
 * persist the literal string `***REDACTED***` over a sibling key it never
 * intended to touch.
 *
 * Hence the rule enforced by `assessWritability` below: this reconciler only
 * writes when it can actually see the whole current `runtimeConfig`. If the
 * value is not readable by the calling actor, or carries a redaction sentinel,
 * it reports and refuses rather than guessing. Unknown keys - both siblings of
 * `heartbeat` and sub-keys inside it - are passed through verbatim so that a
 * field this script does not model (`wakeOnDemand`, `maxDailyRuns`,
 * `intervalSec`) is never silently dropped.
 */

export const MAX_CONCURRENT_RUNS_MIN = 1;
export const MAX_CONCURRENT_RUNS_MAX = 50;

/** Paperclip's own default, stamped onto every agent at creation. */
export const PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS = 20;

export const REDACTION_SENTINEL = '***REDACTED***';

/**
 * Read the desired heartbeat policy out of config/agents.yaml.
 * `defaults.max_concurrent` is the baseline; a per-agent value overrides it.
 * `timer` is required per agent - there is no sane default for "should this
 * agent wake on a clock", so an omission is an error, not a silent false.
 * Returns [{ name, enabled, maxConcurrentRuns }] in file order.
 */
export function resolveDesiredHeartbeats(yamlText) {
  const doc = parse(yamlText);
  if (!doc || !Array.isArray(doc.agents)) {
    throw new Error('resolveDesiredHeartbeats: agents.yaml has no `agents` list');
  }
  const fallbackConcurrency = doc.defaults?.max_concurrent;
  return doc.agents.map((agent) => {
    const timer = agent.heartbeat?.timer;
    if (typeof timer !== 'boolean') {
      throw new Error(`resolveDesiredHeartbeats: ${agent.name} has no boolean heartbeat.timer`);
    }
    const concurrency = agent.heartbeat?.max_concurrent ?? fallbackConcurrency;
    if (!Number.isInteger(concurrency)) {
      throw new Error(
        `resolveDesiredHeartbeats: ${agent.name} has no integer heartbeat.max_concurrent and defaults.max_concurrent is missing`,
      );
    }
    if (concurrency < MAX_CONCURRENT_RUNS_MIN || concurrency > MAX_CONCURRENT_RUNS_MAX) {
      throw new Error(
        `resolveDesiredHeartbeats: ${agent.name} heartbeat.max_concurrent=${concurrency} is outside Paperclip's ${MAX_CONCURRENT_RUNS_MIN}-${MAX_CONCURRENT_RUNS_MAX} range`,
      );
    }
    return { name: agent.name, enabled: timer, maxConcurrentRuns: concurrency };
  });
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True if `***REDACTED***` appears anywhere in the structure. */
export function containsRedaction(value) {
  if (value === REDACTION_SENTINEL) return true;
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (isPlainRecord(value)) return Object.values(value).some(containsRedaction);
  return false;
}

/**
 * Decide whether this actor may safely rewrite an agent's `runtimeConfig`.
 *
 * A readable config always carries a `heartbeat` block, because Paperclip
 * stamps `{enabled, maxConcurrentRuns}` onto every agent at creation. So an
 * absent `heartbeat` means "not visible to this actor" (the peer-config read
 * grant is missing), NOT "unset" - and writing in that state would replace a
 * config we cannot see.
 */
export function assessWritability(runtimeConfig) {
  if (!isPlainRecord(runtimeConfig) || !isPlainRecord(runtimeConfig.heartbeat)) {
    return {
      writable: false,
      reason: 'runtimeConfig.heartbeat not readable by this actor (needs the agents:configure grant) - refusing to replace a config we cannot see',
    };
  }
  if (containsRedaction(runtimeConfig)) {
    return {
      writable: false,
      reason: `runtimeConfig contains ${REDACTION_SENTINEL} - a wholesale write would persist the sentinel over the real value`,
    };
  }
  return { writable: true, reason: null };
}

/**
 * Join desired policy against live Paperclip agent records by name
 * (agents.yaml uses lowercase names, the control plane uses display case).
 */
export function matchAgents(desired, liveAgents) {
  const byName = new Map(liveAgents.map((a) => [String(a.name).toLowerCase(), a]));
  return desired.map((want) => {
    const live = byName.get(want.name.toLowerCase());
    const runtimeConfig = isPlainRecord(live?.runtimeConfig) ? live.runtimeConfig : null;
    const heartbeat = isPlainRecord(runtimeConfig?.heartbeat) ? runtimeConfig.heartbeat : null;
    return {
      ...want,
      id: live?.id ?? null,
      runtimeConfig,
      // null means "not readable by this actor", never "not set" - see assessWritability.
      currentEnabled: heartbeat ? heartbeat.enabled === true : null,
      currentMaxConcurrentRuns: heartbeat
        ? (heartbeat.maxConcurrentRuns ?? PAPERCLIP_DEFAULT_MAX_CONCURRENT_RUNS)
        : null,
      ...assessWritability(runtimeConfig),
    };
  });
}

/** True when the live values already match what agents.yaml asks for. */
export function isInSync(row) {
  return row.currentEnabled === row.enabled && row.currentMaxConcurrentRuns === row.maxConcurrentRuns;
}

/**
 * PATCH body for one agent. `runtimeConfig` is REPLACED wholesale, so this
 * returns the complete value: every sibling key and every heartbeat sub-key we
 * do not model is carried through untouched, and only `enabled` and
 * `maxConcurrentRuns` are overridden. Never call this on a row that
 * `assessWritability` rejected.
 */
export function heartbeatPatchBody(runtimeConfig, { enabled, maxConcurrentRuns }) {
  const { writable, reason } = assessWritability(runtimeConfig);
  if (!writable) {
    throw new Error(`heartbeatPatchBody: refusing to build a wholesale write - ${reason}`);
  }
  return {
    runtimeConfig: {
      ...runtimeConfig,
      heartbeat: { ...runtimeConfig.heartbeat, enabled, maxConcurrentRuns },
    },
  };
}
