import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, '../../infra/macos/install-plists.sh');
const REAL_TEMPLATES = path.resolve(HERE, '../../infra/macos');

// Fake secret values, assembled at runtime so no secret-shaped literal sits in this file.
const FAKE_TOKEN = ['cf', 'ut_'].join('') + 'Zx9Yw8Vu7Ts6Rq5Pn4Om3Lk2';
const FAKE_HC = 'https://hc-ping.' + 'com/' + '00000000-1111-2222-3333-444444444444';
const FAKE_TOPIC = 'appforge-' + 'founder-' + 'FAKEFAKE99';

function plist(label, keyValues) {
  const body = Object.entries(keyValues)
    .map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${label}</string>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n${body}\n\t</dict>\n</dict>\n</plist>\n`;
}

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'install-plists-'));
  const dirs = { root, tpl: path.join(root, 'tpl'), dest: path.join(root, 'dest'), envrc: path.join(root, 'envrc') };
  spawnSync('mkdir', ['-p', dirs.tpl]);
  return dirs;
}

function run(args, { env = {}, templates } = {}) {
  const r = spawnSync('bash', [INSTALLER, ...args], {
    // Clean environment: nothing inherited from the developer's shell/direnv.
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', ...(templates ? { PLIST_TEMPLATE_DIR: templates } : {}), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

test('substitutes placeholders, XML-escapes, and writes the plist mode 0600', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { DEMO_TOKEN: '__DEMO_TOKEN__' }));
  writeFileSync(s.envrc, `export DEMO_TOKEN="a&b<c>${FAKE_TOKEN}"\n`);
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.equal(r.code, 0, r.all);
  const out = path.join(s.dest, 'ing.paperclip.appforge-demo.plist');
  const text = readFileSync(out, 'utf8');
  assert.ok(text.includes(`a&amp;b&lt;c&gt;${FAKE_TOKEN}`), 'value substituted and XML-escaped');
  assert.ok(!text.includes('__DEMO_TOKEN__'), 'no placeholder left');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  rmSync(s.root, { recursive: true });
});

test('a value in the environment wins over .envrc', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { DEMO_TOKEN: '__DEMO_TOKEN__' }));
  writeFileSync(s.envrc, 'export DEMO_TOKEN="from-envrc"\n');
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl, env: { DEMO_TOKEN: 'from-env' } });
  assert.equal(r.code, 0, r.all);
  assert.ok(readFileSync(path.join(s.dest, 'ing.paperclip.appforge-demo.plist'), 'utf8').includes('from-env'));
  rmSync(s.root, { recursive: true });
});

test('a missing variable is refused, named, and its neighbours\' values are never echoed', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { HAVE: '__HAVE_IT__', LACK: '__LACKING_VAR__' }));
  writeFileSync(s.envrc, `export HAVE_IT="${FAKE_TOKEN}"\n`);
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('LACKING_VAR'), 'error names the missing variable');
  assert.ok(!r.all.includes(FAKE_TOKEN), 'no secret value in any output');
  assert.equal(existsSync(s.dest) ? readdirSync(s.dest).length : 0, 0, 'nothing written');
  rmSync(s.root, { recursive: true });
});

test('all-or-nothing: one job missing a variable leaves the other job uninstalled too', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-a.plist'), plist('ing.paperclip.appforge-a', { A: '__A_VAR__' }));
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-b.plist'), plist('ing.paperclip.appforge-b', { B: '__B_VAR__' }));
  writeFileSync(s.envrc, 'export A_VAR="present"\n');
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc], { templates: s.tpl });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('B_VAR'));
  assert.equal(existsSync(s.dest) ? readdirSync(s.dest).length : 0, 0, 'job a must not be installed');
  rmSync(s.root, { recursive: true });
});

test('refuses to install when a placeholder would remain', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { X: '__DEMO_TOKEN__' }));
  writeFileSync(s.envrc, 'export DEMO_TOKEN="__STILL_A_PLACEHOLDER__"\n');
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('STILL_A_PLACEHOLDER'));
  assert.equal(existsSync(s.dest) ? readdirSync(s.dest).length : 0, 0);
  rmSync(s.root, { recursive: true });
});

test('a value that needs shell evaluation is refused, by name', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { X: '__DYNAMIC_VAR__' }));
  writeFileSync(s.envrc, 'export DYNAMIC_VAR="$(gh auth token)"\n');
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('DYNAMIC_VAR'));
  assert.ok(!existsSync(path.join(s.dest, 'ing.paperclip.appforge-demo.plist')));
  rmSync(s.root, { recursive: true });
});

test('--dry-run resolves and validates but writes nothing and prints no value', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { DEMO_TOKEN: '__DEMO_TOKEN__' }));
  writeFileSync(s.envrc, `export DEMO_TOKEN="${FAKE_TOKEN}"\n`);
  const r = run(['--dry-run', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.equal(r.code, 0, r.all);
  assert.ok(r.out.includes('DEMO_TOKEN'), 'names what it would fill');
  assert.ok(!r.all.includes(FAKE_TOKEN), 'never prints the value');
  assert.equal(existsSync(s.dest), false, 'dry-run must not even create the destination');
  rmSync(s.root, { recursive: true });
});

test('--dry-run still fails on a missing variable', () => {
  const s = sandbox();
  writeFileSync(path.join(s.tpl, 'ing.paperclip.appforge-demo.plist'), plist('ing.paperclip.appforge-demo', { X: '__NOPE_VAR__' }));
  writeFileSync(s.envrc, '# nothing\n');
  const r = run(['--dry-run', '--dest', s.dest, '--envrc', s.envrc, 'demo'], { templates: s.tpl });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('NOPE_VAR'));
  rmSync(s.root, { recursive: true });
});

test('the REAL committed templates render cleanly with fake values and carry no fake value in git', () => {
  const s = sandbox();
  writeFileSync(
    s.envrc,
    [
      `export CLOUDFLARE_R2_API_TOKEN="${FAKE_TOKEN}"`,
      `export HEALTHCHECKS_PING_URL_BACKUP="${FAKE_HC}"`,
      `export HEALTHCHECKS_PING_URL_PAPERCLIP="${FAKE_HC}"`,
      `export NTFY_TOPIC="${FAKE_TOPIC}"`,
      '',
    ].join('\n'),
  );
  // The templates themselves must be placeholder-only.
  for (const f of readdirSync(REAL_TEMPLATES).filter((n) => n.endsWith('.plist'))) {
    const t = readFileSync(path.join(REAL_TEMPLATES, f), 'utf8');
    assert.ok(!t.includes(FAKE_TOKEN) && !t.includes(FAKE_TOPIC), `${f} must not embed values`);
  }
  const r = run(['--no-load', '--dest', s.dest, '--envrc', s.envrc], { templates: REAL_TEMPLATES });
  assert.equal(r.code, 0, r.all);
  const rendered = readFileSync(path.join(s.dest, 'ing.paperclip.appforge-backup.plist'), 'utf8');
  assert.ok(rendered.includes(FAKE_TOKEN) && rendered.includes(FAKE_TOPIC) && rendered.includes(FAKE_HC));
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(rendered));
  for (const f of readdirSync(s.dest)) assert.equal(statSync(path.join(s.dest, f)).mode & 0o777, 0o600, `${f} is 0600`);
  rmSync(s.root, { recursive: true });
});
