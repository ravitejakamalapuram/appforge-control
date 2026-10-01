import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENTS_NEEDING_RULE, checkConvention } from '../lib/flow-verification.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const real = () => ({ doc: read('docs/flow-verification.md'), agents: Object.fromEntries(AGENTS_NEEDING_RULE.map((n) => [n, read(`agents/${n}/AGENTS.md`)])) });

test('the flow-verification convention is intact in the doc and in builder/cto/qa AGENTS.md', () => {
  assert.deepEqual(checkConvention(real()), []);
});

// Mutation tests: break the convention one way at a time; the check must fail every time.
const MUTATIONS = {
  'mutation test row dropped from the definition of done': (s) => (s.doc = s.doc.replace('**Mutation test**', 'Mutation test')),
  'PR template loses the On mismatch line': (s) => (s.doc = s.doc.replace('- On mismatch:', '- On failure:')),
  'reviewer checklist emptied': (s) => (s.doc = s.doc.replace(/- \[ \]/g, '-')),
  'audit table removed': (s) => (s.doc = s.doc.replace('| Rank | Flow |', '| Flow |')),
  'Builder stops requiring the section': (s) => (s.agents.builder = s.agents.builder.replace(/`## Verification`/g, 'verification')),
  'QA no longer points at the doc': (s) => (s.agents.qa = s.agents.qa.replace(/docs\/flow-verification\.md/g, 'docs')),
};
for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`MUTATION: ${name} -> reported`, () => {
    const s = real();
    mutate(s);
    assert.ok(checkConvention(s).length > 0);
  });
}
