import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, scanTree, formatFinding } from '../lib/secret-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SECRET_SCAN_ROOT lets us point the guard at an arbitrary tree (e.g. a pristine
// export of an older commit) to prove it fails there.
const ROOT = process.env.SECRET_SCAN_ROOT ?? path.resolve(HERE, '../..');

// ---- Fabricated fakes. Every one is assembled at runtime from pieces so the
// ---- literal never appears in this file and cannot trip the scan of this file.
const fake = {
  cloudflare: ['cf', 'ut_'].join('') + 'A1b2C3d4E5f6G7h8I9j0K1',
  hcPing: 'https://hc-ping.' + 'com/' + '12345678-1234-1234-1234-123456789abc',
  ghToken: 'gh' + 'p_' + 'A'.repeat(30),
  ageKey: 'AGE-SECRET-' + 'KEY-1' + 'QPZRY9X8GF'.repeat(2),
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIE'.repeat(20) + '\n',
  ntfyShape: 'appforge-' + 'founder-' + 'abcdEFGH12',
  ntfyPlist: '<key>NTFY_TOPIC' + '</key>\n\t<string>' + 'some-real-topic' + '</string>',
  cfPlist: '<key>CLOUDFLARE_R2_API_TOKEN' + '</key><string>' + 'not-a-placeholder-value' + '</string>',
};

const rules = (text) => scanText(text, 'x').map((f) => f.rule);

test('the repository contains no secret-shaped content', () => {
  const findings = scanTree(ROOT);
  // Only file:line and the rule name are ever printed - never the matched text.
  assert.deepEqual(findings.map(formatFinding), [], 'secret-shaped content found (values deliberately not shown)');
});

test('detects a Cloudflare API token', () => assert.ok(rules(`X=${fake.cloudflare}`).includes('cloudflare-api-token')));
test('detects a healthchecks ping URL', () => assert.ok(rules(`u=${fake.hcPing}`).includes('healthchecks-ping-url')));
test('detects a GitHub token', () => assert.ok(rules(`t=${fake.ghToken}`).includes('github-token')));
test('detects an age secret key', () => assert.ok(rules(fake.ageKey).includes('age-secret-key')));
test('detects a PEM private key block that has key material', () => assert.ok(rules(fake.pem).includes('pem-private-key')));
test('detects the incident-shaped ntfy topic', () => assert.ok(rules(`topic ${fake.ntfyShape}`).includes('ntfy-topic-literal')));
test('detects a literal NTFY_TOPIC in a plist', () => assert.ok(rules(fake.ntfyPlist).includes('ntfy-topic-literal')));
test('detects a literal Cloudflare token in a plist', () => assert.ok(rules(fake.cfPlist).includes('cloudflare-token-literal')));

test('reports the right line number', () => {
  const f = scanText(`a\nb\nX=${fake.cloudflare}\nd`, 'f.txt');
  assert.deepEqual(f.map((x) => [x.file, x.line, x.rule]), [['f.txt', 3, 'cloudflare-api-token']]);
});

test('a finding never carries the matched value', () => {
  const [f] = scanText(`X=${fake.cloudflare}`, 'f.txt');
  assert.deepEqual(Object.keys(f).sort(), ['file', 'line', 'rule']);
  assert.ok(!formatFinding(f).includes(fake.cloudflare));
});

test('placeholders are not secrets', () => {
  const ok = [
    '<key>NTFY_TOPIC' + '</key>\n\t<string>__NTFY_TOPIC__</string>',
    '<key>CLOUDFLARE_R2_API_TOKEN' + '</key>\n\t<string>__CLOUDFLARE_R2_API_TOKEN__</string>',
    'https://hc-ping.' + 'com/__HEALTHCHECKS_PING_URL_BACKUP__',
  ].join('\n');
  assert.deepEqual(scanText(ok, 'x'), []);
});

test('docs that merely mention a PEM header are not flagged', () => {
  assert.deepEqual(scanText('the file starts with -----BEGIN ' + 'RSA PRIVATE KEY----- and must never be committed', 'x'), []);
});

test('the secret-scan:allow marker suppresses a single line', () => {
  assert.deepEqual(scanText(`X=${fake.cloudflare} # secret-scan:allow`, 'x'), []);
});
