// Tests for the watchdog's liveness signalling (APP-103 / DEBT-0003).
//
// The contract under test is deliberately lopsided: getting a ping WRONG is
// cheap (a missed notification), but letting the notifier throw would be
// expensive, because it would turn a monitoring failure into an availability
// failure for the very thing being monitored — the watchdog pass that gets
// agents un-paused. So most of what is asserted here is "does not throw" and
// "does nothing at all when unconfigured", not just "sends the right URL".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notifierConfigFromEnv,
  pingPassSucceeded,
  alertPassFailed,
  notifyRecovered,
  planFailureAlert,
  planRecovery,
  ALERT_REPEAT_MS,
} from '../lib/watchdog-notify.mjs';

function recordingFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ...opts });
    return impl ? impl(url, opts) : { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

test('notifierConfigFromEnv reads the watchdog\'s own healthcheck, not a sibling job\'s', () => {
  const cfg = notifierConfigFromEnv({
    HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/watchdog-uuid',
    HEALTHCHECKS_PING_URL_PAPERCLIP: 'https://hc-ping.com/sync-uuid',
    NTFY_TOPIC: 'test-topic-not-a-real-value',
  });
  assert.equal(cfg.healthcheckUrl, 'https://hc-ping.com/watchdog-uuid');
  assert.equal(cfg.ntfyTopic, 'test-topic-not-a-real-value');
  assert.equal(cfg.enabled, true);
});

test('notifierConfigFromEnv treats missing, empty, and whitespace-only values as unset', () => {
  assert.deepEqual(notifierConfigFromEnv({}), { healthcheckUrl: null, ntfyTopic: null, enabled: false });
  assert.deepEqual(notifierConfigFromEnv({ HEALTHCHECKS_PING_URL_WATCHDOG: '', NTFY_TOPIC: '   ' }), {
    healthcheckUrl: null,
    ntfyTopic: null,
    enabled: false,
  });
});

test('one half configured is still enabled — an operator may inject the healthcheck before the ntfy topic', () => {
  const cfg = notifierConfigFromEnv({ HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/x' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.ntfyTopic, null);
});

// --- degrade-silent: the acceptance criterion for an un-provisioned plist ---

test('an unconfigured notifier makes no network calls at all (no crash, no noise)', async () => {
  const cfg = notifierConfigFromEnv({});
  const fetchFn = recordingFetch();
  const logs = [];

  assert.equal(await pingPassSucceeded(cfg, { fetchFn, log: (l) => logs.push(l) }), false);
  assert.equal(await alertPassFailed(cfg, 'something broke', { fetchFn, log: (l) => logs.push(l) }), false);

  assert.equal(fetchFn.calls.length, 0, 'must not call out when unconfigured');
  assert.equal(logs.length, 0, 'must not log about monitoring it was never asked to do');
});

// --- the configured happy path ---

test('a successful pass pings the healthcheck URL', async () => {
  const cfg = notifierConfigFromEnv({ HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/abc' });
  const fetchFn = recordingFetch();
  assert.equal(await pingPassSucceeded(cfg, { fetchFn }), true);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://hc-ping.com/abc');
  assert.equal(fetchFn.calls[0].method, 'GET');
});

test('a failed pass pings /fail and pushes ntfy, both carrying the reason', async () => {
  const cfg = notifierConfigFromEnv({
    HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/abc/',
    NTFY_TOPIC: 'test-topic-not-a-real-value',
  });
  const fetchFn = recordingFetch();
  assert.equal(await alertPassFailed(cfg, 'resume CTO failed: ENOENT', { fetchFn }), true);

  assert.equal(fetchFn.calls.length, 2);
  const [hc, ntfy] = fetchFn.calls;
  // The trailing slash on the configured URL must not produce a double slash.
  assert.equal(hc.url, 'https://hc-ping.com/abc/fail');
  assert.equal(hc.method, 'POST');
  assert.ok(hc.body.includes('resume CTO failed: ENOENT'));
  assert.equal(ntfy.url, 'https://ntfy.sh/test-topic-not-a-real-value');
  assert.ok(ntfy.body.includes('quota watchdog'), 'the push must say which job failed');
  assert.ok(ntfy.body.includes('resume CTO failed: ENOENT'));
});

test('a long reason is truncated rather than pushed whole to a phone', async () => {
  const cfg = notifierConfigFromEnv({ NTFY_TOPIC: 'test-topic-not-a-real-value' });
  const fetchFn = recordingFetch();
  await alertPassFailed(cfg, 'x'.repeat(5000), { fetchFn });
  assert.ok(fetchFn.calls[0].body.length < 1200, 'the full detail belongs in the log, not the alert');
});

// --- never-throws, under every failure shape a real network gives us ---

test('a rejecting fetch is logged and swallowed, never thrown', async () => {
  const cfg = notifierConfigFromEnv({
    HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/abc',
    NTFY_TOPIC: 'test-topic-not-a-real-value',
  });
  const fetchFn = recordingFetch(() => {
    throw new Error('getaddrinfo ENOTFOUND hc-ping.com');
  });
  const logs = [];

  assert.equal(await pingPassSucceeded(cfg, { fetchFn, log: (l) => logs.push(l) }), false);
  assert.equal(await alertPassFailed(cfg, 'boom', { fetchFn, log: (l) => logs.push(l) }), false);

  assert.equal(logs.length, 3, 'one log line per attempted call (1 success ping + 2 alert calls)');
  assert.ok(logs.every((l) => l.startsWith('NOTIFY ') && l.includes('ignored')));
});

test('a non-2xx response is logged and swallowed, never thrown', async () => {
  const cfg = notifierConfigFromEnv({ HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/abc' });
  const fetchFn = recordingFetch(() => ({ ok: false, status: 503 }));
  const logs = [];
  assert.equal(await pingPassSucceeded(cfg, { fetchFn, log: (l) => logs.push(l) }), false);
  assert.ok(logs[0].includes('HTTP 503'));
});

test('alertPassFailed reports success if EITHER channel landed — one broken channel must not hide the alert', async () => {
  const cfg = notifierConfigFromEnv({
    HEALTHCHECKS_PING_URL_WATCHDOG: 'https://hc-ping.com/abc',
    NTFY_TOPIC: 'test-topic-not-a-real-value',
  });
  const fetchFn = recordingFetch((url) => {
    if (url.includes('hc-ping.com')) throw new Error('down');
    return { ok: true, status: 200 };
  });
  assert.equal(await alertPassFailed(cfg, 'boom', { fetchFn }), true);
});

test('a null/undefined reason does not produce a "undefined" alert or a crash', async () => {
  const cfg = notifierConfigFromEnv({ NTFY_TOPIC: 'test-topic-not-a-real-value' });
  const fetchFn = recordingFetch();
  await alertPassFailed(cfg, null, { fetchFn });
  assert.ok(fetchFn.calls[0].body.includes('unknown failure'));
});

// ---------------------------------------------------------------------------
// Throttling (PR #14 review). The watchdog runs every 90s, so an unthrottled
// alert on a persistent failure is ~960 phone pushes a day -- which trains
// the reader to mute the channel, i.e. the alert stops working exactly when
// the failure is persistent enough to matter.
// ---------------------------------------------------------------------------

const HC_NTFY = { healthcheckUrl: 'https://hc-ping.com/test-uuid', ntfyTopic: 'test-topic-not-a-real-value', enabled: true };

test('planFailureAlert: the first failure pushes', () => {
  const { push, next } = planFailureAlert(null, { nowMs: 1_000, reason: 'resume CTO failed' });
  assert.equal(push, true);
  assert.equal(next.failing, true);
  assert.equal(next.lastPushAtMs, 1_000);
});

test('planFailureAlert: the same failure on the next pass does NOT push again, and counts what it suppressed', () => {
  let state = planFailureAlert(null, { nowMs: 0, reason: 'resume CTO failed: resume was due 40min ago' }).next;
  for (let pass = 1; pass <= 10; pass += 1) {
    const r = planFailureAlert(state, { nowMs: pass * 90_000, reason: `resume CTO failed: resume was due ${40 + pass}min ago` });
    assert.equal(r.push, false, `pass ${pass}: a changing duration is not a new failure`);
    state = r.next;
  }
  assert.equal(state.suppressed, 10);
});

test('planFailureAlert: a persistent failure re-pushes at most once per repeat interval', () => {
  let state = planFailureAlert(null, { nowMs: 0, reason: 'x' }).next;
  let pushes = 1;
  for (let t = 90_000; t <= 24 * 3_600_000; t += 90_000) {
    const r = planFailureAlert(state, { nowMs: t, reason: 'x' });
    if (r.push) pushes += 1;
    state = r.next;
  }
  assert.equal(ALERT_REPEAT_MS, 3_600_000);
  assert.ok(pushes <= 25, `expected <= 25 pushes in 24h, got ${pushes}`);
  assert.ok(pushes >= 24, 'but it must keep reminding while the failure persists');
});

test('planFailureAlert: a DIFFERENT failure pushes immediately, even inside the repeat interval', () => {
  const state = planFailureAlert(null, { nowMs: 0, reason: 'resume CTO failed' }).next;
  assert.equal(planFailureAlert(state, { nowMs: 90_000, reason: 'pass threw: ECONNREFUSED' }).push, true);
});

test('planRecovery: pushes once only when a failure streak ends, and resets so the next failure alerts at once', () => {
  assert.equal(planRecovery(null).push, false, 'healthy -> healthy is silent');
  const failing = planFailureAlert(null, { nowMs: 0, reason: 'x' }).next;
  const rec = planRecovery(failing);
  assert.equal(rec.push, true);
  assert.equal(planRecovery(rec.next).push, false);
  assert.equal(planFailureAlert(rec.next, { nowMs: 1, reason: 'x' }).push, true);
});

test('alertPassFailed with push:false still pings /fail but sends no ntfy', async () => {
  const fetchFn = recordingFetch();
  await alertPassFailed(HC_NTFY, 'x', { fetchFn, push: false });
  assert.deepEqual(fetchFn.calls.map((c) => c.url), ['https://hc-ping.com/test-uuid/fail']);
});

test('notifyRecovered pushes one ntfy message and never throws; no-op without a topic', async () => {
  const fetchFn = recordingFetch();
  await notifyRecovered(HC_NTFY, { fetchFn, suppressed: 3 });
  assert.equal(fetchFn.calls.length, 1);
  assert.match(fetchFn.calls[0].url, /ntfy\.sh/);
  assert.match(fetchFn.calls[0].body, /recovered/);
  const none = recordingFetch();
  await notifyRecovered({ healthcheckUrl: null, ntfyTopic: null, enabled: false }, { fetchFn: none });
  assert.equal(none.calls.length, 0);
  await assert.doesNotReject(notifyRecovered(HC_NTFY, { fetchFn: async () => { throw new Error('offline'); } }));
});
