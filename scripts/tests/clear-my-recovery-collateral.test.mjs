import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'clear-my-recovery-collateral.mjs');
const OWNER = '3cba1fb3-21e1-4851-832b-95de5247bff1';
const QUOTA_PAUSE_ERROR_CODE = 'agent_paused';

// Shaped from the real APP-217 action observed on run a520f601.
function collateralIssue(overrides = {}) {
  return {
    id: 'b126c0ef-d22b-4057-8a02-f6775c16675f',
    identifier: 'APP-217',
    title: 'main is red',
    status: 'blocked',
    assigneeAgentId: OWNER,
    checkoutRunId: null,
    executionRunId: null,
    unresolvedBlockerCount: 0,
    activeRecoveryAction: {
      id: 'ba8574f7-3101-4991-8a2a-0f4c6f23895e',
      status: 'active',
      cause: 'stranded_assigned_issue',
      ownerType: 'board',
      returnOwnerAgentId: OWNER,
      createdAt: '2026-09-29T21:11:16.812Z',
      evidence: {
        latestRunId: '18953eef-6954-4d81-8475-f802b8d48c6a',
        latestRunStatus: 'cancelled',
        latestRunErrorCode: QUOTA_PAUSE_ERROR_CODE,
      },
    },
    ...overrides,
  };
}

// Serves the one GET the script makes, and records every other request so a
// test can prove no hand-back write was attempted.
async function withStubApi(issues, run) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url.startsWith('/api/companies/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issues }));
      return;
    }
    res.writeHead(500).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    return { seen, ...(await run(apiBase)) };
  } finally {
    server.close();
  }
}

function runScript(apiBase, { taskId, args = [] }) {
  const env = {
    ...process.env,
    PAPERCLIP_API_URL: apiBase,
    PAPERCLIP_COMPANY_ID: 'fake-co',
    PAPERCLIP_API_KEY: 'k',
    PAPERCLIP_AGENT_ID: OWNER,
  };
  // The unbound case is an ABSENT var, which is what the runtime actually does.
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  else delete env.PAPERCLIP_TASK_ID;

  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

test('--resolve on a task-unbound run refuses with exit 3 and writes nothing', async () => {
  const { seen, code, stdout, stderr } = await withStubApi([collateralIssue()], (apiBase) =>
    runScript(apiBase, { taskId: null, args: ['--resolve'] }),
  );

  assert.equal(code, 3, 'a task-unbound --resolve is its own exit code, not a generic failure');
  assert.match(stdout, /pending APP-217/, 'the pending collateral is still reported');
  assert.match(stderr, /task-unbound/, 'and the reason names the actual gate');
  assert.match(stderr, /PAPERCLIP_TASK_ID/, 'pointing at the env var that is empty');
  assert.match(stderr, /do NOT release/i, 'and warns against the release that orphans the issue');
  assert.ok(
    !seen.some((s) => s.includes('recovery-actions/resolve')),
    'no hand-back may be attempted from a run that cannot attribute it',
  );
});

test('report-only on a task-unbound run still lists the collateral and exits 0', async () => {
  const { seen, code, stdout } = await withStubApi([collateralIssue()], (apiBase) =>
    runScript(apiBase, { taskId: null, args: [] }),
  );

  assert.equal(code, 0, 'reporting is always safe');
  assert.match(stdout, /would hand back APP-217/);
  assert.ok(!seen.some((s) => s.includes('recovery-actions/resolve')));
});

test('a task-bound run is allowed past the preflight and does attempt the write', async () => {
  const { seen, code } = await withStubApi([collateralIssue()], (apiBase) =>
    runScript(apiBase, { taskId: 'b126c0ef-d22b-4057-8a02-f6775c16675f', args: ['--resolve'] }),
  );

  assert.ok(
    seen.some((s) => s.includes('recovery-actions/resolve')),
    'the preflight must gate only on task-binding, not block the real path',
  );
  // The stub answers that write with 500, so the script reports a refusal.
  assert.equal(code, 1, 'a refused hand-back is exit 1, distinct from the preflight');
});

test('no collateral means nothing to do, even unbound', async () => {
  const { code, stdout } = await withStubApi([], (apiBase) =>
    runScript(apiBase, { taskId: null, args: ['--resolve'] }),
  );

  assert.equal(code, 0);
  assert.match(stdout, /nothing to hand back/);
});
