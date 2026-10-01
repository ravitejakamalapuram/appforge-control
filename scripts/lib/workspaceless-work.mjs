/**
 * Find open work filed in a Paperclip project that has no registered workspace (APP-303).
 *
 * WHY THIS EXISTS
 *
 * An issue asks for an `isolated_workspace` / `git_worktree` execution. When its
 * project has no workspace, Paperclip falls back to
 * `projects/<company>/<projectId>/_default`, which is not a git checkout, and the
 * wake fails with `workspace_validation_failed`
 * (`git_worktree_base_not_git_checkout`). The run never starts, and the seat
 * that woke goes to `error`. On 2026-10-01 that was 14 failed runs, 31 platform
 * issues misfiled in the parked json-workbench project, and Growth and QA in
 * `error`. Nothing reported it until a daily digest counted the failures.
 *
 * Routines count too: a routine creates its execution issues in its own
 * project, which is how the hourly integrity sweep's issues ended up in
 * json-workbench.
 *
 * Only work that can wake an agent is reported (APP-305, board answer): an
 * issue with an agent assignee, and a routine that is not paused. Parked
 * product work is unassigned and paused on purpose, and wakes nothing.
 *
 * Pure functions only. The CLI (`scripts/detect-workspaceless-work.mjs`) does
 * the GETs and the one optional POST.
 */

export const OPEN_ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];

/** Title of the ONE issue the guard opens. Also the dedupe key: never open a second while one is open. */
export const GUARD_ISSUE_TITLE = 'Guard: open work filed in projects with no workspace';

export function hasWorkspace(project) {
  return (project?.workspaces?.length ?? 0) > 0 || Boolean(project?.primaryWorkspace?.id);
}

function isOpenIssue(issue) {
  return OPEN_ISSUE_STATUSES.includes(issue?.status);
}

/**
 * Open agent-assigned issues and active routines whose project has no workspace.
 * An issue or routine with no project is not reported: it does not fall back
 * to a project `_default` path.
 */
export function findWorkspacelessWork({ projects, issues, routines = [] }) {
  const bare = new Map((projects ?? []).filter((p) => !hasWorkspace(p)).map((p) => [p.id, p.name]));
  const byIdentifier = (a, b) => String(a.identifier).localeCompare(String(b.identifier), undefined, { numeric: true });
  return {
    issues: (issues ?? [])
      .filter((i) => isOpenIssue(i) && i.assigneeAgentId && bare.has(i.projectId))
      .map((i) => ({ id: i.id, identifier: i.identifier, status: i.status, project: bare.get(i.projectId), title: i.title }))
      .sort(byIdentifier),
    routines: (routines ?? [])
      .filter((r) => !['paused', 'archived'].includes(r?.status) && bare.has(r?.projectId))
      .map((r) => ({ id: r.id, status: r.status, project: bare.get(r.projectId), title: r.title })),
  };
}

export function findOpenGuardIssue(issues) {
  return (issues ?? []).find((i) => isOpenIssue(i) && i.title === GUARD_ISSUE_TITLE) ?? null;
}

/** Where the guard files its issue: the named project, which must itself have a workspace. */
export function resolveFilingTarget(projects, name = 'platform') {
  const project = (projects ?? []).find((p) => p.name === name);
  if (!project) throw new Error(`no project named "${name}"`);
  const workspaceId = project.primaryWorkspace?.id ?? project.workspaces?.[0]?.id;
  if (!workspaceId) throw new Error(`project "${name}" has no workspace, so an issue filed there would fail the same way`);
  return { projectId: project.id, projectWorkspaceId: workspaceId };
}

export function renderReport({ issues, routines }) {
  if (issues.length === 0 && routines.length === 0) return '';
  const lines = [
    `${issues.length} open agent-assigned issue(s) and ${routines.length} active routine(s) are in a project with no workspace.`,
    'A wake on any of them fails with workspace_validation_failed (APP-303).',
    'Fix: move platform/brain work to the `platform` project; park product work by removing its agent assignee / pausing the routine, or give its project a workspace (board call).',
  ];
  if (issues.length) {
    lines.push('', '| Issue | Status | Project | Title |', '|---|---|---|---|');
    for (const i of issues) lines.push(`| ${i.identifier} | ${i.status} | ${i.project} | ${String(i.title).replace(/\|/g, '/')} |`);
  }
  if (routines.length) {
    lines.push('', '| Routine | Status | Project | Title |', '|---|---|---|---|');
    for (const r of routines) lines.push(`| ${r.id.slice(0, 8)} | ${r.status} | ${r.project} | ${String(r.title).replace(/\|/g, '/')} |`);
  }
  return lines.join('\n');
}
