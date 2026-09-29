// Exit-code contract for scripts/paperclip-run-check.sh (APP-64, APP-119).
//
// The interesting case - exit 3, "the write succeeded but was recorded as the
// board" - cannot be produced against the real control plane without making the
// very unattributed write the check exists to prevent (DEC-0016 records that
// write as an accepted cost, and the standing rule is not to create more of
// them). So the control plane is stubbed here instead: the script is pointed at
// a local HTTP server that answers the three calls it makes and can be told to
// answer them any way we like.
//
// Run with `node --test` from `scripts/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(here, '..', 'paperclip-run-check.sh');

const ISSUE = 'aaaaaaaa-0000-0000-0000-000000000001';
const AGENT = 'bbbbbbbb-0000-0000-0000-000000000002';
const RUN = 'cccccccc-0000-0000-0000-000000000003';
const WATERMARK = '2026-09-29T00:00:00.000Z';
const AFTER = '2026-09-29T00:00:01.000Z';

/** An unsigned JWT. The script only base64-decodes the payload; it never verifies. */
const jwt = (payload) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
};

/** One activity row, shaped like a real `issue.updated` event. */
const event = (over = {}) => ({
  id: 'e1',
  action: 'issue.updated',
  entityType: 'issue',
  entityId: ISSUE,
  actorType: 'agent',
  actorId: AGENT,
  runId: RUN,
  // Present on a CORRECTLY attributed agent write too - the guard against
  // anyone reaching for this field as the laundering signal.
  responsibleUserId: 'local-board',
  createdAt: AFTER,
  ...over,
});

const priorEvent = () => event({ id: 'e0', createdAt: WATERMARK });

/**
 * Starts a stub control plane.
 * @param {{patchStatus?: number, activity: Array<Array<object>|{status: number, body?: unknown}>}} opts
 *   `activity` is answered in order: [0] is the pre-probe watermark read,
 *   [1] the post-probe read-back. An entry may be a plain row array (answered
 *   200) or `{status, body}` to make that specific call fail - which is what
 *   separates "the log is empty" from "the fetch failed" (APP-169).
 */
async function withStub(opts, body) {
  const activity = [...opts.activity];
  let activityCalls = 0;
  const server = http.createServer((req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url.includes('/activity')) {
      const entry = activity[Math.min(activityCalls, activity.length - 1)];
      activityCalls += 1;
      if (Array.isArray(entry)) return json(200, entry);
      return json(entry.status, entry.body ?? { code: 'activity_unavailable' });
    }
    if (req.method === 'PATCH') {
      const status = opts.patchStatus ?? 200;
      return json(status, status === 200 ? { id: ISSUE, priority: 'high' } : { code: 'nope' });
    }
    return json(200, { id: ISSUE, priority: 'high' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** Runs the check against `url`; resolves with {code, out}. */
function run(url, { token } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PAPERCLIP_API_URL: url,
    PAPERCLIP_API_KEY: token ?? jwt({ sub: AGENT, run_id: RUN }),
    PAPERCLIP_RUN_ID: RUN,
  };
  return new Promise((resolve) => {
    execFile('bash', [CHECK, ISSUE], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` });
    });
  });
}

test('exit 0 when the write is recorded as this agent and this run', async () => {
  const { code, out } = await withStub(
    { activity: [[priorEvent()], [event(), priorEvent()]] },
    (url) => run(url),
  );
  assert.equal(code, 0, out);
  assert.match(out, /recorded as THIS AGENT/);
});

test('exit 3 when the write succeeded but was recorded as the board', async () => {
  const laundered = event({ actorType: 'user', actorId: 'local-board', runId: null, agentId: null });
  const { code, out } = await withStub(
    { activity: [[priorEvent()], [laundered, priorEvent()]] },
    (url) => run(url),
  );
  assert.equal(code, 3, out);
  assert.match(out, /LAUNDERED/);
  assert.match(out, /actorId=local-board/);
  // Must not be reported as the 403 family or as a clean bill of health.
  assert.doesNotMatch(out, /CAN write to any issue|recorded as THIS AGENT/);
});

test('responsibleUserId: local-board alone is not laundering', async () => {
  // The regression this guards: `responsibleUserId` is the human whose
  // authority the agent rides and reads `local-board` on every correct agent
  // write, so testing it would fail every healthy run.
  //
  // The empty first activity response here is a genuinely EMPTY LOG answered
  // 200, which is still a legitimate exit 0. The paired cases below cover the
  // other way an empty watermark used to arise - a failed fetch - which must
  // NOT reach exit 0.
  const { code, out } = await withStub(
    { activity: [[], [event({ responsibleUserId: 'local-board' })]] },
    (url) => run(url),
  );
  assert.equal(code, 0, out);
});

test('exit 2 when the probe succeeds but no event is recorded after it', async () => {
  const { code, out } = await withStub(
    { activity: [[priorEvent()], [priorEvent()]] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /UNVERIFIED/);
  assert.match(out, /no issue\.updated event recorded after the probe/);
});

test('exit 2 when the only fresh event belongs to a different agent', async () => {
  const other = event({ actorId: 'dddddddd-0000-0000-0000-000000000004', runId: 'other-run' });
  const { code, out } = await withStub(
    { activity: [[priorEvent()], [other, priorEvent()]] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /none match this agent\/run/);
});

test('exit 2 when the token carries no sub claim to compare against', async () => {
  const { code, out } = await withStub(
    { activity: [[priorEvent()], [event(), priorEvent()]] },
    (url) => run(url, { token: jwt({ run_id: RUN }) }),
  );
  assert.equal(code, 2, out);
  assert.match(out, /no .?sub.? claim/);
});

test('exit 1 on a 403 probe still wins over any attribution check', async () => {
  const { code, out } = await withStub(
    { patchStatus: 403, activity: [[priorEvent()], [priorEvent()]] },
    (url) => run(url),
  );
  assert.equal(code, 1, out);
  assert.match(out, /CANNOT write to any issue/);
});

// --- APP-169: a failed watermark fetch must not be read as "no constraint" ---
//
// Before the fix, both activity reads were piped straight into a reader with
// their HTTP status discarded, so a failed watermark GET produced an empty
// watermark, and an empty watermark disabled the freshness filter entirely.
// The check then asserted over the issue's whole history in both directions.

test('APP-169 case A: a failed watermark fetch must not mask a laundered write', async () => {
  // Read-back holds a STALE correctly-attributed row (e.g. from earlier in the
  // same heartbeat) alongside the fresh laundered one. Unconstrained, the stale
  // row satisfies the "this agent, this run" match and the check exits 0 - a
  // false all-clear on the exact condition it exists to detect.
  const staleMine = event({ id: 'e0', createdAt: WATERMARK });
  const launderedFresh = event({
    id: 'e2', actorType: 'user', actorId: 'local-board', runId: null, createdAt: AFTER,
  });
  const { code, out } = await withStub(
    { activity: [{ status: 500 }, [launderedFresh, staleMine]] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /UNVERIFIED/);
  assert.match(out, /could not read the activity log/);
  assert.doesNotMatch(out, /recorded as THIS AGENT/);
});

test('APP-169 case B: a failed watermark fetch must not invent a laundering report', async () => {
  // Read-back holds no fresh row at all, just a months-old board-authored one.
  // 43% of sampled company issues carry such a row, so unconstrained this turns
  // a single transient GET failure into a phantom containment incident.
  const oldBoard = event({
    id: 'e9', actorType: 'user', actorId: 'local-board', runId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  const { code, out } = await withStub(
    { activity: [{ status: 500 }, [oldBoard]] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /UNVERIFIED/);
  assert.doesNotMatch(out, /LAUNDERED/);
});

test('APP-169: a 200 activity response that is not an array is UNVERIFIED', async () => {
  const { code, out } = await withStub(
    { activity: [{ status: 200, body: { code: 'not_an_array' } }, [event()]] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /not a\n?.*JSON array|not a[\s\S]{0,40}JSON array/);
});

test('APP-169: a failed read-back fetch is UNVERIFIED, not an all-clear', async () => {
  // The watermark establishes fine; it is the post-probe read that fails. The
  // write landed, so this cannot be reported as a clean run either way.
  const { code, out } = await withStub(
    { activity: [[priorEvent()], { status: 503 }] },
    (url) => run(url),
  );
  assert.equal(code, 2, out);
  assert.match(out, /could not re-read the activity log/);
  assert.doesNotMatch(out, /recorded as THIS AGENT|LAUNDERED/);
});
