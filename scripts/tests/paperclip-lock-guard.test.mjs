import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, utimesSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'paperclip-lock-guard.sh');

const LOCK = 'postmaster.pid';
const HOUR_AGO = () => new Date(Date.now() - 3600 * 1000);

// The runner inherits NTFY_TOPIC from direnv on the founder's machine; a test
// that forgot to scrub it would push a real notification. Always start clean.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['NTFY_TOPIC', 'NTFY_URL_BASE', 'PAPERCLIP_DB_DIR', 'PAPERCLIP_HEALTH_URL', 'MIN_LOCK_AGE_SEC', 'PAPERCLIP_GUARD_LOG']) delete env[k];
  return env;
}

/** A scratch workspace: db dir, log path, and a bag of things to clean up. */
function makeWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'appforge-lockguard-'));
  const db = path.join(root, 'db');
  mkdirSync(db);
  const cleanups = [];
  return {
    root,
    db,
    log: path.join(root, 'logs', 'guard.log'),
    lock: path.join(db, LOCK),
    onCleanup: (fn) => cleanups.push(fn),
    async done() {
      for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });

async function downUrl() { return `http://127.0.0.1:${await freePort()}/api/health`; }

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function writeLock(world, pid, { ageSec = 3600 } = {}) {
  writeFileSync(world.lock, `${pid}\n${world.db}\n1790000000\n54329\n/tmp\n\n`);
  if (ageSec > 0) {
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(world.lock, t, t);
  }
}

/** A pid that has definitely exited. */
function deadPid() {
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(out);
}

/** Starts a long-lived process whose argv[0] is `argv0`; resolves once ps shows it. */
async function spawnAs(world, argv0) {
  const child = spawn('/bin/bash', ['-c', `exec -a "$1" sleep 30`, 'bash', argv0], { stdio: 'ignore' });
  world.onCleanup(() => child.kill('SIGKILL'));
  for (let i = 0; i < 50; i += 1) {
    try {
      const cmd = execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' });
      if (cmd.startsWith(argv0.split(' ')[0])) return child.pid;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`process never appeared as "${argv0}"`);
}

async function runGuard(world, env = {}) {
  const { stdout, stderr } = await execFileP('/bin/bash', [GUARD], {
    env: { ...cleanEnv(), PAPERCLIP_DB_DIR: world.db, PAPERCLIP_GUARD_LOG: world.log, MIN_LOCK_AGE_SEC: '60', ...env },
  });
  return { stdout, stderr, log: existsSync(world.log) ? readFileSync(world.log, 'utf8') : '' };
}

const staleFiles = (world) => readdirSync(world.db).filter((f) => f.startsWith(`${LOCK}.stale-`)).sort();

test('no lock file: does nothing and creates nothing in the db dir', async () => {
  const w = makeWorld();
  try {
    writeFileSync(path.join(w.db, 'PG_VERSION'), '18\n');
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.deepEqual(readdirSync(w.db), ['PG_VERSION']);
    assert.match(log, /no lock file/);
  } finally { await w.done(); }
});

test('healthy API: leaves even an old, dead-pid lock alone', async () => {
  const w = makeWorld();
  const { server, port } = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    writeLock(w, deadPid());
    const before = statSync(w.lock).mtimeMs;
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: `http://127.0.0.1:${port}/api/health` });
    assert.ok(existsSync(w.lock), 'lock must remain while the server is healthy');
    assert.equal(statSync(w.lock).mtimeMs, before);
    assert.deepEqual(staleFiles(w), []);
    assert.match(log, /healthy, nothing to do/);
  } finally { server.close(); await w.done(); }
});

test('a non-200 health answer is not "healthy"', async () => {
  const w = makeWorld();
  const { server, port } = await startServer((req, res) => { res.writeHead(503); res.end('starting'); });
  try {
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: `http://127.0.0.1:${port}/api/health` });
    assert.ok(!existsSync(w.lock), 'a 503 with a dead-pid lock is a stale lock');
    assert.equal(staleFiles(w).length, 1);
  } finally { server.close(); await w.done(); }
});

test('fresh lock (younger than MIN_LOCK_AGE_SEC): a start may be in progress, do nothing', async () => {
  const w = makeWorld();
  try {
    writeLock(w, deadPid(), { ageSec: 0 });
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(existsSync(w.lock));
    assert.deepEqual(staleFiles(w), []);
    assert.match(log, /fresh/);
  } finally { await w.done(); }
});

test('dead pid + API down + old lock: moves the lock aside (never deletes) and logs why', async () => {
  const w = makeWorld();
  try {
    const pid = deadPid();
    writeLock(w, pid);
    const original = readFileSync(w.lock, 'utf8');
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(!existsSync(w.lock), 'lock should be gone from its original name');
    const stale = staleFiles(w);
    assert.equal(stale.length, 1);
    assert.match(stale[0], /^postmaster\.pid\.stale-\d{8}T\d{6}Z$/);
    assert.equal(readFileSync(path.join(w.db, stale[0]), 'utf8'), original, 'content must be preserved byte for byte');
    assert.match(log, new RegExp(`stale lock.*pid ${pid}`));
    assert.match(log, /moved aside/);
  } finally { await w.done(); }
});

test('lock pid alive but NOT postgres (pid reuse, e.g. cfprefsd): lock is stale and is cleared', async () => {
  const w = makeWorld();
  try {
    writeLock(w, process.pid); // this node process: alive, not postgres
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(!existsSync(w.lock));
    assert.equal(staleFiles(w).length, 1);
    assert.match(log, new RegExp(`pid ${process.pid} is now`));
  } finally { await w.done(); }
});

test('lock pid alive and looks like postgres: a real owner exists, do nothing', async () => {
  const w = makeWorld();
  try {
    const pid = await spawnAs(w, 'postgres');
    writeLock(w, pid);
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(existsSync(w.lock));
    assert.deepEqual(staleFiles(w), []);
    assert.match(log, /owner/);
  } finally { await w.done(); }
});

test('lock pid alive and looks like postmaster: also a real owner', async () => {
  const w = makeWorld();
  try {
    const pid = await spawnAs(w, 'postmaster');
    writeLock(w, pid);
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(existsSync(w.lock));
  } finally { await w.done(); }
});

test('a postgres process holding THIS data dir protects the lock even if the pid file is wrong', async () => {
  const w = makeWorld();
  try {
    await spawnAs(w, `postgres -D ${w.db} -p 54329`);
    writeLock(w, deadPid());
    const { log } = await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(existsSync(w.lock));
    assert.deepEqual(staleFiles(w), []);
    assert.match(log, /data dir/);
  } finally { await w.done(); }
});

test('a postgres process on a DIFFERENT data dir does not protect this lock', async () => {
  const w = makeWorld();
  try {
    await spawnAs(w, `postgres -D ${path.join(w.root, 'some-other-db')} -p 5432`);
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(!existsSync(w.lock));
    assert.equal(staleFiles(w).length, 1);
  } finally { await w.done(); }
});

test('a non-postgres process merely mentioning the data dir (an agent prompt, a tail) does not protect it', async () => {
  const w = makeWorld();
  try {
    await spawnAs(w, `claude -p investigate postgres in ${w.db}`);
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.ok(!existsSync(w.lock), 'only a process that IS postgres counts as an owner');
    assert.equal(staleFiles(w).length, 1);
  } finally { await w.done(); }
});

test('prunes to the newest 5 .stale-* files, touches nothing else in the db dir', async () => {
  const w = makeWorld();
  try {
    mkdirSync(path.join(w.db, 'base'));
    writeFileSync(path.join(w.db, 'PG_VERSION'), '18\n');
    writeFileSync(path.join(w.db, 'postmaster.opts'), 'opts\n');
    writeFileSync(path.join(w.db, 'base', '1234'), 'data');
    for (let d = 1; d <= 7; d += 1) writeFileSync(path.join(w.db, `${LOCK}.stale-2026010${d}T000000Z`), `old${d}`);
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl() });

    const stale = staleFiles(w);
    assert.equal(stale.length, 5);
    assert.ok(stale.includes('postmaster.pid.stale-20260107T000000Z'));
    assert.ok(!stale.includes('postmaster.pid.stale-20260101T000000Z'));
    assert.ok(!stale.includes('postmaster.pid.stale-20260102T000000Z'));
    assert.ok(!stale.includes('postmaster.pid.stale-20260103T000000Z'));
    assert.equal(readFileSync(path.join(w.db, 'PG_VERSION'), 'utf8'), '18\n');
    assert.equal(readFileSync(path.join(w.db, 'postmaster.opts'), 'utf8'), 'opts\n');
    assert.equal(readFileSync(path.join(w.db, 'base', '1234'), 'utf8'), 'data');
  } finally { await w.done(); }
});

test('ntfy: pushes a low-priority notice when it clears a lock and NTFY_TOPIC is set', async () => {
  const w = makeWorld();
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ url: req.url, priority: req.headers.priority, body }); res.writeHead(200); res.end('ok'); });
  });
  try {
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl(), NTFY_TOPIC: 'test-topic', NTFY_URL_BASE: `http://127.0.0.1:${port}` });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/test-topic');
    assert.equal(seen[0].priority, 'low');
    assert.match(seen[0].body, /Paperclip stale Postgres lock auto-cleared/);
  } finally { server.close(); await w.done(); }
});

test('ntfy: silent when NTFY_TOPIC is unset, and silent when there is nothing to clear', async () => {
  const w = makeWorld();
  const seen = [];
  const { server, port } = await startServer((req, res) => { seen.push(req.url); res.writeHead(200); res.end(); });
  try {
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl(), NTFY_URL_BASE: `http://127.0.0.1:${port}` });
    assert.equal(staleFiles(w).length, 1, 'still clears the lock without a topic');

    const w2 = makeWorld();
    try {
      await runGuard(w2, { PAPERCLIP_HEALTH_URL: await downUrl(), NTFY_TOPIC: 'test-topic', NTFY_URL_BASE: `http://127.0.0.1:${port}` });
    } finally { await w2.done(); }
    assert.deepEqual(seen, []);
  } finally { server.close(); await w.done(); }
});

test('an unreachable ntfy server never makes the guard fail or undo the fix', async () => {
  const w = makeWorld();
  try {
    writeLock(w, deadPid());
    await runGuard(w, { PAPERCLIP_HEALTH_URL: await downUrl(), NTFY_TOPIC: 't', NTFY_URL_BASE: `http://127.0.0.1:${await freePort()}` });
    assert.equal(staleFiles(w).length, 1);
  } finally { await w.done(); }
});

test('a missing db dir is not an error', async () => {
  const w = makeWorld();
  try {
    const { log } = await runGuard(w, { PAPERCLIP_DB_DIR: path.join(w.root, 'does-not-exist'), PAPERCLIP_HEALTH_URL: await downUrl() });
    assert.match(log, /no lock file/);
  } finally { await w.done(); }
});
