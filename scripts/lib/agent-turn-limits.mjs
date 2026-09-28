import { parse } from 'yaml';

/**
 * Read the per-agent run turn ceiling out of config/agents.yaml (APP-29).
 * `defaults.max_turns_per_run` is the baseline; a per-agent value overrides it.
 * Returns [{ name, maxTurnsPerRun }] in file order.
 */
export function resolveDesiredLimits(yamlText) {
  const doc = parse(yamlText);
  if (!doc || !Array.isArray(doc.agents)) {
    throw new Error('resolveDesiredLimits: agents.yaml has no `agents` list');
  }
  const fallback = doc.defaults?.max_turns_per_run;
  return doc.agents.map((agent) => {
    const limit = agent.max_turns_per_run ?? fallback;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `resolveDesiredLimits: ${agent.name} has no usable max_turns_per_run and defaults.max_turns_per_run is missing`,
      );
    }
    return { name: agent.name, maxTurnsPerRun: limit };
  });
}

/**
 * Join the desired limits against the live Paperclip agent records by name
 * (agents.yaml uses lowercase names, the control plane uses display case).
 */
export function matchAgents(desired, liveAgents) {
  const byName = new Map(liveAgents.map((a) => [String(a.name).toLowerCase(), a]));
  return desired.map((want) => {
    const live = byName.get(want.name.toLowerCase());
    return {
      ...want,
      id: live?.id ?? null,
      // adapterConfig reads back `{}` for agents other than the caller, so an
      // absent value means "not visible to this actor", not "not set".
      current: live?.adapterConfig?.maxTurnsPerRun ?? null,
    };
  });
}

/**
 * PATCH body for one agent. `adapterConfig` MERGES server-side, so this one
 * field preserves command/cwd/env. Never send `replaceAdapterConfig: true`
 * here: `env` reads back `***REDACTED***`, so a read-modify-write would wipe
 * the agent's launch environment.
 */
export function turnLimitPatchBody(maxTurnsPerRun) {
  return { adapterConfig: { maxTurnsPerRun } };
}
