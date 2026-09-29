// APP-194: every capability granted in config/agents.yaml must be defined in
// docs/capabilities.md.
//
// Nothing in this repo reads the `capabilities:` lists — they are declarations
// consumed by humans and by agents deciding how to route work. That makes an
// undefined grant worse than a missing one: it looks authoritative at filing
// time and fails days later at execution. `browser:e2e` was granted with no
// definition anywhere, was read as "QA can drive a browser", and APP-54 was
// routed to QA on that reading for a task it could never do.
//
// This test is the only enforcement there is. It does not check that a
// capability is *implemented* — no static check can — only that someone wrote
// down what it means, which is the step that was skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const grantedCapabilities = () => {
  const config = parse(readFileSync(join(repoRoot, 'config', 'agents.yaml'), 'utf8'));
  return [...new Set(config.agents.flatMap((agent) => agent.capabilities ?? []))];
};

const capabilityDocs = () => readFileSync(join(repoRoot, 'docs', 'capabilities.md'), 'utf8');

test('every granted capability is defined in docs/capabilities.md', () => {
  const docs = capabilityDocs();
  const undefined_ = grantedCapabilities().filter((cap) => !docs.includes(`\`${cap}\``));
  assert.deepEqual(
    undefined_,
    [],
    `granted in config/agents.yaml but defined nowhere: ${undefined_.join(', ')}. ` +
      'Add a definition to docs/capabilities.md in this same PR, stating what the ' +
      'capability covers, what it does NOT cover, and the evidence it works.',
  );
});

test('every capability defined in the docs is still granted to someone', () => {
  // The reverse direction catches a retired grant whose definition was left
  // behind — a stale definition reads as a live capability to anyone routing
  // work, which is the same failure mode in the other direction.
  const docs = capabilityDocs();
  const granted = new Set(grantedCapabilities());
  const documented = [...docs.matchAll(/^## `([a-z][a-z0-9:_*-]*)`/gm)].map((m) => m[1]);

  assert.ok(documented.length > 0, 'no `## `capability`` headings found — has the doc format changed?');

  const orphaned = documented.filter((cap) => !cap.includes('*') && !granted.has(cap));
  assert.deepEqual(orphaned, [], `documented but granted to no agent: ${orphaned.join(', ')}`);
});

test('browser:e2e is documented with its authenticated-session boundary intact', () => {
  // The specific regression APP-194 exists to prevent. The grant is real and
  // the harness works; what is NOT true is that it can reach a logged-in
  // browser. If that caveat ever disappears from the doc, the next router will
  // re-make the APP-54 mistake.
  const docs = capabilityDocs();
  assert.match(docs, /##\s+`browser:e2e`/);
  assert.match(
    docs,
    /Does not cover[\s\S]{0,600}authenticated/i,
    "browser:e2e's definition must keep stating that it cannot reach an authenticated session",
  );
});
