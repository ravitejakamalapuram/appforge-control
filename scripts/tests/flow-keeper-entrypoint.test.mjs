import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../flow-keeper.mjs', import.meta.url));

async function runScenario({ deadline, passes = 1 }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'flow-keeper-regression-'));
  const stateDir = join(tempDir, 'state');
  const fakeBin = join(tempDir, 'bin');
  await mkdir(fakeBin);
  const ghStub = join(fakeBin, 'gh');
  await writeFile(ghStub, '#!/bin/sh\n# Keep this integration test offline and side-effect free.\nexit 1\n');
  await chmod(ghStub, 0o755);

  const createdIssues = [];
  const issue = {
    id: 'issue-324',
    identifier: 'APP-324',
    title: 'Wait for the PR',
    status: 'blocked',
    assigneeAgentId: 'worker-1',
    projectId: 'project-1',
    projectWorkspaceId: 'workspace-1',
    waitLine: `WAIT: check=pr_merged url=https://github.com/example/repo/pull/1 recheck=15m deadline=${deadline}`,
    updatedAt: new Date().toISOString(),
  };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/companies/company-1/agents') {
      return json(200, { agents: [
        { id: 'ceo-1', name: 'CEO', role: 'ceo', status: 'idle' },
        { id: 'worker-1', name: 'Worker', role: 'engineer', status: 'idle' },
      ] });
    }
    if (req.method === 'GET' && url.pathname === '/api/companies/company-1/issues') {
      return json(200, { issues: [issue] });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/companies/company-1/heartbeat-runs')) {
      return json(200, { runs: [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/issues/issue-324') {
      return json(200, { blockedBy: [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/companies/company-1/issues') {
      createdIssues.push(JSON.parse(body));
      return json(201, { id: `created-${createdIssues.length}` });
    }
    return json(404, { error: `unexpected request: ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;

  async function runPass() {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          PAPERCLIP_API_URL: apiUrl,
          PAPERCLIP_COMPANY_ID: 'company-1',
          APPFORGE_STATE_DIR: stateDir,
          NTFY_TOPIC: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  try {
    const runs = [];
    for (let i = 0; i < passes; i++) runs.push(await runPass());
    return { runs, createdIssues };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('non-dry overdue WAIT entrypoint succeeds and creates one idempotent escalation', async () => {
  const { runs, createdIssues } = await runScenario({ deadline: '2026-10-01', passes: 2 });

  for (const run of runs) {
    assert.equal(run.code, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /pass done:/);
    assert.doesNotMatch(run.stderr, /openTitles1|before initialization|ReferenceError/);
  }
  assert.equal(
    createdIssues.filter((issue) => issue.title === 'Overdue wait: APP-324 is still waiting').length,
    1,
    'the overdue item should create exactly one escalation across repeated passes',
  );
});

test('a future WAIT deadline does not create an overdue escalation', async () => {
  const { runs, createdIssues } = await runScenario({ deadline: '2099-01-01' });

  assert.equal(runs[0].code, 0, `stdout:\n${runs[0].stdout}\nstderr:\n${runs[0].stderr}`);
  assert.doesNotMatch(runs[0].stdout, /OVERDUE APP-324/);
  assert.equal(createdIssues.length, 0, 'control case must not create an escalation');
});
