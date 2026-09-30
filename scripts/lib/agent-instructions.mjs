/**
 * Reconcile agents/<name>/*.md (git, reviewable) -> each Paperclip agent's managed
 * instructions bundle. Until this existed nothing deployed those files, so the
 * live agents ran stale copies: the CTO's AGENTS.md/SOUL.md still said "never
 * touch InvTrack without the founder" after the founder removed that rule, and
 * every TOOLS.md was a ~30 line stub of the ~170 line file in git.
 *
 * Pure functions only; the script does the HTTP.
 */

export const INSTRUCTION_FILES = ['AGENTS.md', 'HEARTBEAT.md', 'SOUL.md', 'TOOLS.md'];

/** Live agents keyed by lowercase display name ("CTO" -> "cto", matching agents/<dir>). */
export function indexAgentsByName(liveAgents) {
  return new Map(liveAgents.map((a) => [String(a.name).toLowerCase(), a]));
}

/**
 * Decide what to write.
 * @param {Array<{agent:string,file:string,repo:string|null}>} repoFiles  file content from git (null = absent in git)
 * @param {Map<string,{id:string}>} liveByName
 * @param {(agentId:string,file:string)=>string|null} readDeployed  deployed content or null if absent
 * @returns {{writes:Array, unchanged:number, skipped:Array}}
 */
export function planInstructionSync(repoFiles, liveByName, readDeployed) {
  const writes = [];
  const skipped = [];
  let unchanged = 0;
  for (const { agent, file, repo } of repoFiles) {
    const live = liveByName.get(agent);
    if (!live) {
      skipped.push({ agent, file, reason: 'no live agent with this name' });
      continue;
    }
    if (repo === null || repo === undefined) {
      skipped.push({ agent, file, reason: 'absent in git - never delete a deployed file from here' });
      continue;
    }
    const deployed = readDeployed(live.id, file);
    if (deployed === repo) {
      unchanged += 1;
      continue;
    }
    writes.push({
      agent,
      agentId: live.id,
      file,
      content: repo,
      kind: deployed === null ? 'create' : 'update',
      deployedLines: deployed === null ? 0 : deployed.split('\n').length,
      repoLines: repo.split('\n').length,
    });
  }
  return { writes, unchanged, skipped };
}
