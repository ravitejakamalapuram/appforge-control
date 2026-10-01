// Schedule liveness (APP-294, docs/flow-verification.md rank 2). A launchd job that never fires is silent: the Mac
// is asleep, the plist is unloaded or the node path is broken. Each job writes a stamp (state/heartbeats/<job>.json:
// started, finished, exitCode, lastSuccess); this module decides, from the stamp and the plist's cadence, whether
// the job is ok, failed, overdue or never-ran. Pure functions only; scripts/job-liveness.mjs does the IO.

export const MIN_GRACE_SEC = 300;
export const CHECKER_JOB = 'job-liveness';
export const ISSUE_PREFIX = 'Schedule liveness:';

const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

/** Seconds between two expected runs, read from a LaunchAgent plist. null when it declares no schedule. */
export function parsePlistCadence(xml) {
  const text = stripComments(xml);
  const interval = text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  if (interval) return Number(interval[1]);
  const cal = text.match(/<key>StartCalendarInterval<\/key>\s*(<dict>[\s\S]*?<\/dict>|<array>[\s\S]*?<\/array>)/);
  if (!cal) return null;
  const keys = [...cal[1].matchAll(/<key>(\w+)<\/key>/g)].map((m) => m[1]);
  if (keys.includes('Month')) return 366 * 86400;
  if (keys.includes('Weekday')) return 7 * 86400;
  if (keys.includes('Day')) return 31 * 86400;
  if (keys.includes('Hour')) return 86400;
  return 3600; // Minute only
}

/** Grace on top of the cadence: sleep and slow starts must not page anyone, a missed cycle must. */
export function graceFor(cadenceSec, overrides = {}, job = '') {
  if (overrides[job] != null) return overrides[job];
  if (cadenceSec >= 7 * 86400) return 12 * 3600;
  if (cadenceSec >= 86400) return 3 * 3600;
  return Math.max(MIN_GRACE_SEC, Math.floor(cadenceSec / 2));
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/**
 * state: ok | failed | overdue | never-ran | unreadable | no-cadence. Anything but `ok` is a finding.
 * A missing stamp is `never-ran`, never ok. A stamp that does not parse is `unreadable`, never ok.
 */
export function classifyJob({ job, cadenceSec, graceSec, stamp, now = Date.now() }) {
  const base = { job, cadenceSec, graceSec };
  if (cadenceSec == null) return { ...base, state: 'no-cadence', detail: 'the plist declares no StartInterval or StartCalendarInterval, so lateness cannot be judged' };
  if (stamp == null) return { ...base, state: 'never-ran', detail: `no stamp state/heartbeats/${job}.json: the job has never run on this host (plist not loaded, node path broken, or the job does not write a stamp)` };
  const started = ms(stamp.started);
  if (typeof stamp !== 'object' || started == null) return { ...base, state: 'unreadable', detail: 'stamp has no valid "started" time' };
  if (stamp.finished != null && stamp.exitCode != null && stamp.exitCode !== 0) {
    return { ...base, state: 'failed', detail: `last run exited ${stamp.exitCode} at ${stamp.finished}`, lastSuccess: stamp.lastSuccess ?? null };
  }
  const lastSuccess = stamp.lastSuccess ? ms(stamp.lastSuccess) : null;
  const ref = lastSuccess ?? started; // never succeeded yet: measure from the first start
  const ageSec = Math.floor((now - ref) / 1000);
  const limit = cadenceSec + graceSec;
  if (ageSec > limit) {
    const what = lastSuccess == null ? 'never completed successfully; first started' : 'last success';
    return { ...base, state: 'overdue', ageSec, detail: `${what} ${Math.round(ageSec / 60)} min ago; expected every ${Math.round(cadenceSec / 60)} min + ${Math.round(graceSec / 60)} min grace` };
  }
  return { ...base, state: 'ok', ageSec, detail: `last success ${Math.round(ageSec / 60)} min ago` };
}

/** Evaluate every watched job. `readStamp(job)` returns a parsed stamp, null (missing) or throws (unreadable). */
export function evaluateJobs({ jobs, readStamp, now = Date.now(), graceOverrides = {} }) {
  return jobs.map(({ job, cadenceSec }) => {
    let stamp;
    try { stamp = readStamp(job); } catch (e) { return { job, cadenceSec, state: 'unreadable', detail: `stamp is unreadable: ${e.message}` }; }
    return classifyJob({ job, cadenceSec, graceSec: cadenceSec == null ? 0 : graceFor(cadenceSec, graceOverrides, job), stamp, now });
  });
}

/**
 * The checker's own gap. When the Mac slept, every job is late at once and every job is about to run again; paging
 * on that pass would be noise. If the checker's previous success is older than 2 cycles, hold the alerts one pass.
 */
export function justWoke({ prevCheckerSuccess, checkerCadenceSec, now = Date.now() }) {
  const prev = prevCheckerSuccess ? ms(prevCheckerSuccess) : null;
  return prev != null && (now - prev) / 1000 > 2 * checkerCadenceSec;
}

export const issueTitle = (key) => `${ISSUE_PREFIX} ${key}`;
export const marker = (key) => `<!-- job-liveness: ${key} -->`;

export function issueBody(finding, assigneeAgentId, projectId) {
  const { key } = finding;
  return {
    title: issueTitle(key),
    description: `${marker(key)}\nA scheduled job or drift check is not healthy, and nobody here would otherwise see it (docs/flow-verification.md, APP-294).\n\n- Key: ${key}\n- State: ${finding.state}\n- Detail: ${finding.detail}\n\nTask: find the cause (Mac asleep, plist not loaded - \`launchctl print gui/$(id -u)/ing.paperclip.appforge-${key}\`, node path, or the script's own log) and fix it, or say who must act. The checker closes this issue by itself when the job is fresh again; do not close it by hand. Max 40 turns.`,
    status: 'todo', priority: 'high', assigneeAgentId, ...(projectId ? { projectId } : {}),
  };
}

const CLOSED = new Set(['done', 'cancelled']);
/** Reconcile findings with the issues already in Paperclip: ONE issue per key, closed when the key is healthy again. */
export function planIssueSync({ findings, healthyKeys, issues }) {
  const openByTitle = new Map();
  for (const i of issues) if (typeof i.title === 'string' && i.title.startsWith(ISSUE_PREFIX) && !CLOSED.has(i.status)) openByTitle.set(i.title, i);
  const open = [];
  const keep = [];
  for (const f of findings) (openByTitle.has(issueTitle(f.key)) ? keep : open).push(f);
  const close = healthyKeys.map((k) => openByTitle.get(issueTitle(k))).filter(Boolean);
  return { open, keep, close };
}
