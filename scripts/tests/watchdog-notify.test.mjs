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
