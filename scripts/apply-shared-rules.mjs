#!/usr/bin/env node
// Keep agents/_shared/operating-rules.md identical inside every agents/<name>/AGENTS.md.
//   node scripts/apply-shared-rules.mjs          # rewrite the blocks
//   node scripts/apply-shared-rules.mjs --check  # exit 1 if any AGENTS.md is out of date (used by the test)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_START, SHARED_END, withSharedRules } from './lib/shared-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const shared = readFileSync(join(ROOT, 'agents', '_shared', 'operating-rules.md'), 'utf8');
const check = process.argv.includes('--check');
let stale = 0;
for (const name of readdirSync(join(ROOT, 'agents')).sort()) {
  const f = join(ROOT, 'agents', name, 'AGENTS.md');
  if (name.startsWith('_') || !existsSync(f)) continue;
  const before = readFileSync(f, 'utf8');
  const after = withSharedRules(before, shared);
  if (after === before) { console.log(`ok     ${name}`); continue; }
  stale += 1;
  if (check) console.log(`STALE  ${name}`);
  else { writeFileSync(f, after); console.log(`wrote  ${name}`); }
}
process.exit(check && stale ? 1 : 0);
