// Tests for the workspace-less work guard (APP-303).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARD_ISSUE_TITLE,
  findOpenGuardIssue,
  findWorkspacelessWork,
  renderReport,
  resolveFilingTarget,
} from '../lib/workspaceless-work.mjs';

const projects = [
  { id: 'p-platform', name: 'platform', workspaces: [{ id: 'ws-1' }], primaryWorkspace: { id: 'ws-1' } },
  { id: 'p-jwb', name: 'json-workbench', workspaces: [], primaryWorkspace: null },
];

test('flags an open, agent-assigned issue in a project with no workspace (the APP-303 failure)', () => {
  const issues = [{ id: 'i1', identifier: 'APP-265', status: 'blocked', projectId: 'p-jwb', assigneeAgentId: 'ag', title: 't' }];
  const out = findWorkspacelessWork({ projects, issues });
  assert.deepEqual(out.issues.map((i) => i.identifier), ['APP-265']);
  assert.equal(out.issues[0].project, 'json-workbench');
});

test('ignores closed issues, issues in a project with a workspace, and issues with no project', () => {
  const issues = [
    { id: 'a', identifier: 'APP-1', status: 'done', projectId: 'p-jwb', assigneeAgentId: 'ag', title: 't' },
    { id: 'b', identifier: 'APP-2', status: 'cancelled', projectId: 'p-jwb', assigneeAgentId: 'ag', title: 't' },
    { id: 'c', identifier: 'APP-3', status: 'todo', projectId: 'p-platform', assigneeAgentId: 'ag', title: 't' },
    { id: 'd', identifier: 'APP-4', status: 'todo', projectId: null, assigneeAgentId: 'ag', title: 't' },
  ];
  assert.deepEqual(findWorkspacelessWork({ projects, issues }).issues, []);
});

test('backlog counts as open: a backlog issue fails as soon as it is moved to todo and woken', () => {
  const issues = [{ id: 'a', identifier: 'APP-66', status: 'backlog', projectId: 'p-jwb', assigneeAgentId: 'ag', title: 't' }];
  assert.equal(findWorkspacelessWork({ projects, issues }).issues.length, 1);
});

test('parked work is not flagged: an unassigned or user-assigned issue wakes no agent (APP-305)', () => {
  const issues = [
    { id: 'a', identifier: 'APP-7', status: 'todo', projectId: 'p-jwb', assigneeAgentId: null, title: 't' },
    { id: 'b', identifier: 'APP-17', status: 'todo', projectId: 'p-jwb', assigneeUserId: 'founder', title: 't' },
  ];
  assert.deepEqual(findWorkspacelessWork({ projects, issues }).issues, []);
});

test('flags active routines in a workspace-less project, not paused or archived ones (APP-305)', () => {
  const routines = [
    { id: 'r1', status: 'active', projectId: 'p-jwb', title: 'Hourly sweep' },
    { id: 'r2', status: 'paused', projectId: 'p-jwb', title: 'parked' },
    { id: 'r3', status: 'archived', projectId: 'p-jwb', title: 'old' },
    { id: 'r4', status: 'active', projectId: 'p-platform', title: 'fine' },
  ];
  assert.deepEqual(findWorkspacelessWork({ projects, issues: [], routines }).routines.map((r) => r.id), ['r1']);
});

test('only one guard issue: an open one is found, a closed one is not', () => {
  assert.equal(findOpenGuardIssue([{ identifier: 'APP-9', status: 'todo', title: GUARD_ISSUE_TITLE }])?.identifier, 'APP-9');
  assert.equal(findOpenGuardIssue([{ identifier: 'APP-9', status: 'done', title: GUARD_ISSUE_TITLE }]), null);
});

test('files into platform with its workspace, and refuses a target with no workspace', () => {
  assert.deepEqual(resolveFilingTarget(projects), { projectId: 'p-platform', projectWorkspaceId: 'ws-1' });
  assert.throws(() => resolveFilingTarget(projects, 'json-workbench'), /no workspace/);
  assert.throws(() => resolveFilingTarget(projects, 'nope'), /no project/);
});

test('report is empty on a clean pass and names every finding otherwise', () => {
  assert.equal(renderReport({ issues: [], routines: [] }), '');
  const text = renderReport({
    issues: [{ identifier: 'APP-7', status: 'todo', project: 'json-workbench', title: 'a | b' }],
    routines: [{ id: '42a12b56-xxxx', status: 'paused', project: 'json-workbench', title: 'Hourly sweep' }],
  });
  assert.match(text, /\| APP-7 \| todo \| json-workbench \| a \/ b \|/);
  assert.match(text, /\| 42a12b56 \| paused \|/);
});
