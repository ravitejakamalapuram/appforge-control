// Secret-shaped-content scanner. Shared by scripts/secret-scan.mjs (CLI) and
// scripts/tests/no-secrets-in-repo.test.mjs (the guard that keeps a real
// credential from being committed again - see the 2026-09-30 incident in
// infra/macos/README.md).
//
// DESIGN RULE: a finding is { file, line, rule } and NOTHING ELSE. The matched
// text is never returned, logged or put in an error message, so a failing scan
// cannot itself leak the value into CI logs or a transcript.
//
// A line carrying the marker `secret-scan:allow` is skipped, for the rare
// fixture that must look like a secret. Prefer building fakes at runtime.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

// Per-line rules.
const LINE_RULES = [
  { rule: 'cloudflare-api-token', re: /cfut_[A-Za-z0-9]{20,}/ },
  { rule: 'healthchecks-ping-url', re: /hc-ping\.com\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  // bech32 charset, and it must have real key material after the "1".
  { rule: 'age-secret-key', re: /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{10,}/ },
  // The shape of the incident's ntfy topic. A topic is a capability: anyone who
  // knows it can push notifications to the founder.
  { rule: 'ntfy-topic-literal', re: /appforge-founder-[A-Za-z0-9]{8,}/ },
];

// Whole-file rules (they span lines). `line` is where the match starts.
const BLOCK_RULES = [
  // A PEM header only counts when key material follows it, so docs that merely
  // mention the header are not flagged.
  { rule: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/ },
  // plist form: an NTFY_TOPIC key whose string value is a literal. Placeholders start with two underscores.
  { rule: 'ntfy-topic-literal', re: /<key>NTFY_TOPIC<\/key>\s*<string>(?!__|\s*<)[^<]{4,}<\/string>/ },
  { rule: 'cloudflare-token-literal', re: /<key>CLOUDFLARE_[A-Z0-9_]*TOKEN<\/key>\s*<string>(?!__|\s*<)[^<]{8,}<\/string>/ },
];

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/** Scan one file's text. Returns [{file, line, rule}] - never the matched value. */
export function scanText(text, file) {
  const findings = [];
  const seen = new Set();
  const push = (line, rule) => {
    const k = `${line}:${rule}`;
    if (!seen.has(k)) { seen.add(k); findings.push({ file, line, rule }); }
  };
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    if (ln.includes('secret-scan:allow')) return;
    for (const { rule, re } of LINE_RULES) if (re.test(ln)) push(i + 1, rule);
  });
  for (const { rule, re } of BLOCK_RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const line = lineOf(text, m.index);
    if (lines[line - 1]?.includes('secret-scan:allow')) continue;
    push(line, rule);
  }
  return findings;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** Files to scan under `root`: tracked + untracked-not-ignored in a git repo, else a directory walk. */
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git repo - fall through */ }
  const acc = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else acc.push(path.relative(root, p));
    }
  };
  walk(root);
  return acc;
}

/** Scan every text file under root. */
export function scanTree(root) {
  const findings = [];
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; } // symlink target gone, or deleted-but-listed
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (looksBinary(buf)) continue;
    findings.push(...scanText(buf.toString('utf8'), rel));
  }
  return findings;
}

export function formatFinding(f) {
  return `${f.file}:${f.line}  ${f.rule}`;
}
