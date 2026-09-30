import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTION_FILES, indexAgentsByName, planInstructionSync } from '../lib/agent-instructions.mjs';

const live = indexAgentsByName([{ id: 'id-cto', name: 'CTO' }, { id: 'id-qa', name: 'QA' }]);

test('matches live agents by lowercase display name', () => {
  assert.equal(live.get('cto').id, 'id-cto');
  assert.equal(live.get('qa').id, 'id-qa');
});

test('identical content is unchanged, differing content becomes an update write', () => {
  const plan = planInstructionSync(
    [
      { agent: 'cto', file: 'AGENTS.md', repo: 'same\n' },
      { agent: 'cto', file: 'TOOLS.md', repo: 'new tools\nmore\n' },
    ],
    live,
    (id, file) => (file === 'AGENTS.md' ? 'same\n' : 'old stub\n'),
  );
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].kind, 'update');
  assert.equal(plan.writes[0].agentId, 'id-cto');
  assert.equal(plan.writes[0].content, 'new tools\nmore\n');
});

test('a file missing on the deployed side is a create', () => {
  const plan = planInstructionSync([{ agent: 'qa', file: 'SOUL.md', repo: 'x\n' }], live, () => null);
  assert.equal(plan.writes[0].kind, 'create');
  assert.equal(plan.writes[0].deployedLines, 0);
});

test('never deletes: a file absent in git is skipped, not written', () => {
  const plan = planInstructionSync([{ agent: 'qa', file: 'TOOLS.md', repo: null }], live, () => 'deployed\n');
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /never delete/);
});

test('an agent with no live counterpart is skipped with a reason, not a crash', () => {
  const plan = planInstructionSync([{ agent: 'ghost', file: 'AGENTS.md', repo: 'x' }], live, () => null);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped[0].reason, /no live agent/);
});

test('an empty repo file is a real value, not absence', () => {
  const plan = planInstructionSync([{ agent: 'cto', file: 'AGENTS.md', repo: '' }], live, () => 'something\n');
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].content, '');
});

test('the synced set is exactly the four bundle files each agent directory carries', () => {
  assert.deepEqual(INSTRUCTION_FILES, ['AGENTS.md', 'HEARTBEAT.md', 'SOUL.md', 'TOOLS.md']);
});
