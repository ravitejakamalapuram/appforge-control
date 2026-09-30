#!/usr/bin/env node
// CLI for scripts/lib/secret-scan.mjs. Prints `file:line  rule` per finding and
// NEVER the matched value. Exit 1 if anything is found, 0 if clean.
//   node scripts/secret-scan.mjs [--root DIR]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { scanTree, formatFinding } from './lib/secret-scan.mjs';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() } } });
const root = path.resolve(values.root);
const findings = scanTree(root);
for (const f of findings) console.log(formatFinding(f));
console.log(findings.length ? `\n${findings.length} secret-shaped finding(s) in ${root}` : `clean: no secret-shaped content in ${root}`);
process.exit(findings.length ? 1 : 0);
