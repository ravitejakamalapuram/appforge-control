import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_START, SHARED_END, sharedBlock, withSharedRules } from '../lib/shared-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shared = readFileSync(join(ROOT, 'agents', '_shared', 'operating-rules.md'), 'utf8');
const agents = readdirSync(join(ROOT, 'agents')).filter((n) => !n.startsWith('_') && existsSync(join(ROOT, 'agents', n, 'AGENTS.md')));

test('applying the shared rules twice equals applying once', () => {
  const once = withSharedRules('# Agent\n\nbody\n', shared);
  assert.equal(withSharedRules(once, shared), once);
});

test('an existing block is replaced in place, not duplicated, and surrounding text survives', () => {
  const stale = `# Agent\n\n${SHARED_START}\nOLD RULES\n${SHARED_END}\n\n## After\nkeep me\n`;
  const out = withSharedRules(stale, shared);
  assert.equal(out.split(SHARED_START).length - 1, 1, 'exactly one block');
  assert.ok(!out.includes('OLD RULES'));
  assert.ok(out.includes('## After\nkeep me'));
});

test('a half-present marker pair is refused rather than guessed at', () => {
  assert.throws(() => withSharedRules(`x\n${SHARED_START}\ny\n`, shared), /only one of the two markers/);
});

test('EVERY agent carries the current shared rules (a stale copy fails this test)', () => {
  assert.ok(agents.length >= 7, `expected the 7 agents, found ${agents.join(',')}`);
  for (const a of agents) {
    const text = readFileSync(join(ROOT, 'agents', a, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes(sharedBlock(shared)), `${a}/AGENTS.md is missing or has a stale shared-rules block; run: node scripts/apply-shared-rules.mjs`);
  }
});

test('the shared rules cover the standing rules the founder has set (so removing one fails loudly)', () => {
  for (const needle of [
    'Tasks belong to the system', 'CLAIM:', 'Root cause, not patches', 'verification loop',
    'NO merge authority', 'System-shaping decisions', 'No loops, no leftovers', 'LESSON:', 'Stay in scope',
  ]) assert.ok(shared.includes(needle), `shared rules lost: ${needle}`);
});

test('shared rules are numbered consecutively after the seven universal rules', () => {
  const nums = [...shared.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => 8 + i));
});
