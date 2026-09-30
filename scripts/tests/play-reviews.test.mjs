// Tests for the Play reviews ingest (APP-210).
//
// The suite is organised around the three Google-stated constraints rather
// than around the functions, because the constraints are what a future edit
// will break. Every "refuses to …" test below corresponds to a number that
// would otherwise be wrong in a way nobody could see downstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { parse as parseYaml } from 'yaml';

import {
  SOURCE,
  SCOPE,
  WINDOW_DAYS,
  EMITTABLE,
  NEVER_FROM_REVIEWS_API,
  assertReviewMetricsAreHonest,
  loadServiceAccountKey,
  buildJwtAssertion,
  fetchAccessToken,
  listReviews,
  summariseReviews,
  redactForStorage,
} from '../lib/play-reviews.mjs';
import { playTargets, ingest, EXPECTED_CLIENT_EMAIL } from '../play-reviews-ingest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const scratch = () => mkdtempSync(join(tmpdir(), 'play-reviews-'));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function writeKey(dir, overrides = {}, mode = 0o600) {
  const path = join(dir, 'key.json');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'service_account',
      client_email: EXPECTED_CLIENT_EMAIL,
      private_key: PRIVATE_PEM,
      token_uri: 'https://oauth2.googleapis.com/token',
      ...overrides,
    })
  );
  chmodSync(path, mode);
  return path;
}

/** A review as the API shapes it: comments[].userComment.{starRating,text,lastModified}. */
function review({ star, text = 'it works', author = 'Jane Q. Reviewer', secs }) {
  return {
    reviewId: 'gp:AOqpTOF-' + Math.random().toString(36).slice(2),
    authorName: author,
    comments: [{ userComment: { text, starRating: star, lastModified: { seconds: String(secs), nanos: 0 } } }],
  };
}

// ---------------------------------------------------------------------------
// Constraint 1 + 2: the guard that makes a dishonest metric name FAIL the run
// ---------------------------------------------------------------------------

test('every EMITTABLE name survives its own guard', () => {
  const metrics = Object.fromEntries(EMITTABLE.map((m) => [m, 0]));
  assert.deepEqual(Object.keys(assertReviewMetricsAreHonest(metrics)), EMITTABLE);
});

test('refuses to emit play_rating_average or play_rating_count from this source', () => {
  for (const name of NEVER_FROM_REVIEWS_API) {
    assert.throws(() => assertReviewMetricsAreHonest({ [name]: 4.6 }), /refusing to emit/);
  }
  // …and names it as the reports bucket's, so the error tells you where to go.
  assert.throws(() => assertReviewMetricsAreHonest({ play_rating_average: 4.6 }), /reports bucket/);
});

test('refuses any lifetime- or cumulative-sounding name', () => {
  for (const name of ['play_reviews_total_7d', 'play_lifetime_reviews_7d', 'play_cumulative_stars_7d']) {
    assert.throws(() => assertReviewMetricsAreHonest({ [name]: 1 }), /lifetime or cumulative/);
  }
});

test('refuses a name that does not carry its window', () => {
  assert.throws(
    () => assertReviewMetricsAreHonest({ play_commented_reviews: 3 }),
    /every metric name must carry its window/
  );
});

test('refuses a windowed name that is not declared in EMITTABLE', () => {
  // Undeclared means config/portfolio.yaml has no freshness or aliasing rule
  // for it, so it would land in the manifest ungoverned.
  assert.throws(() => assertReviewMetricsAreHonest({ play_something_new_7d: 1 }), /not in EMITTABLE/);
});

// ---------------------------------------------------------------------------
// Credential handling — addressed by path, and refused when unsafe
// ---------------------------------------------------------------------------

test('loads a well-formed mode-0600 key', () => {
  const dir = scratch();
  const key = loadServiceAccountKey(writeKey(dir), { expectClientEmail: EXPECTED_CLIENT_EMAIL });
  assert.equal(key.client_email, EXPECTED_CLIENT_EMAIL);
  assert.equal(key.token_uri, 'https://oauth2.googleapis.com/token');
});

test('refuses a group- or world-readable key', () => {
  const dir = scratch();
  const path = writeKey(dir, {}, 0o644);
  assert.throws(() => loadServiceAccountKey(path), /group- or world-readable \(mode 644\)/);
});

test('refuses a key stored inside the repository working tree', () => {
  // One `git add -A` from publishing a credential. The repo has already
  // committed a token once (PR #43); this makes the repeat impossible here.
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  const inside = join(dir, 'config');
  mkdirSync(inside, { recursive: true });
  const path = writeKey(inside);
  assert.throws(() => loadServiceAccountKey(path, { repoRoot: dir }), /inside the repository/);
});

test('refuses a key belonging to a different service account', () => {
  const dir = scratch();
  const path = writeKey(dir, { client_email: 'release-bot@rk-release-platform.iam.gserviceaccount.com' });
  assert.throws(
    () => loadServiceAccountKey(path, { expectClientEmail: EXPECTED_CLIENT_EMAIL }),
    /read paths do not carry release authority|different account/
  );
});

test('refuses a non-service-account key and a key missing a required field', () => {
  const dir = scratch();
  assert.throws(() => loadServiceAccountKey(writeKey(dir, { type: 'authorized_user' })), /expected "service_account"/);
  assert.throws(() => loadServiceAccountKey(writeKey(scratch(), { private_key: '' })), /missing `private_key`/);
});

test('a malformed key file error never echoes the file body', () => {
  const dir = scratch();
  const path = join(dir, 'key.json');
  writeFileSync(path, '{"private_key": "-----BEGIN PRIVATE KEY-----LEAKME"');
  chmodSync(path, 0o600);
  assert.throws(
    () => loadServiceAccountKey(path),
    (err) => /not valid JSON/.test(err.message) && !/LEAKME/.test(err.message)
  );
});

test('missing key file explains that the founder places it, and asks for no value', () => {
  assert.throws(
    () => loadServiceAccountKey(join(scratch(), 'absent.json')),
    (err) => /placed by the founder/.test(err.message) && /never created, requested, or transmitted/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// The JWT and the token exchange
// ---------------------------------------------------------------------------

test('the assertion is RS256-signed over the header and claims, scoped read-only', () => {
  const dir = scratch();
  const key = loadServiceAccountKey(writeKey(dir));
  const jwt = buildJwtAssertion(key, { now: 1_700_000_000_000 });
  const [h, c, sig] = jwt.split('.');

  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, EXPECTED_CLIENT_EMAIL);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, SCOPE);
  assert.equal(claims.exp - claims.iat, 3600);

  assert.ok(
    createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')),
    'signature must verify against the key pair'
  );
});

test('token exchange posts a jwt-bearer grant and returns the access token', async () => {
  const dir = scratch();
  const key = loadServiceAccountKey(writeKey(dir));
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: new URLSearchParams(init.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.TOKEN', expires_in: 3599 }) };
  };
  const out = await fetchAccessToken(key, { fetchImpl });
  assert.equal(out.access_token, 'ya29.TOKEN');
  assert.equal(seen.url, 'https://oauth2.googleapis.com/token');
  assert.equal(seen.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.ok(seen.body.get('assertion').split('.').length === 3);
});

test('a rejected token exchange surfaces Google\'s error fields and nothing else', async () => {
  const dir = scratch();
  const key = loadServiceAccountKey(writeKey(dir));
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT', secret_echo: 'ya29.LEAKED' }),
  });
  await assert.rejects(
    () => fetchAccessToken(key, { fetchImpl }),
    (err) =>
      /HTTP 400/.test(err.message) &&
      /invalid_grant: Invalid JWT/.test(err.message) &&
      !/LEAKED/.test(err.message)
  );
});

test('a non-JSON error body is not quoted into the log at all', async () => {
  const dir = scratch();
  const key = loadServiceAccountKey(writeKey(dir));
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => '<html>ya29.LEAKED</html>' });
  await assert.rejects(
    () => fetchAccessToken(key, { fetchImpl }),
    (err) => /HTTP 502/.test(err.message) && !/LEAKED/.test(err.message) && !/html/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// listReviews
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-30T08:00:00Z');
const daysAgo = (n) => Math.floor((NOW - n * 86400000) / 1000);

test('paginates until the token runs out and sends a bearer credential', async () => {
  const pages = [
    { reviews: [review({ star: 5, secs: daysAgo(1) })], tokenPagination: { nextPageToken: 'p2' } },
    { reviews: [review({ star: 3, secs: daysAgo(2) })] },
  ];
  const auths = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    auths.push(init.headers.authorization);
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[i++]) };
  };
  const out = await listReviews('com.invtracker.inv_tracker', 'ya29.T', { fetchImpl });
  assert.equal(out.reviews.length, 2);
  assert.equal(out.pages, 2);
  assert.deepEqual(auths, ['Bearer ya29.T', 'Bearer ya29.T']);
});

test('403 is reported as a Play Console permission question, not a code bug', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{}' });
  await assert.rejects(
    () => listReviews('com.carfry369.teleport', 'ya29.T', { fetchImpl }),
    /permission question, not a code question/
  );
});

test('refuses to paginate forever', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ reviews: [], tokenPagination: { nextPageToken: 'always' } }),
  });
  await assert.rejects(() => listReviews('com.x.y', 'ya29.T', { fetchImpl, maxPages: 3 }), /paginated past 3 pages/);
});

test('an absent `reviews` key is handled like an empty list, not a crash', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{}' });
  const out = await listReviews('com.x.y', 'ya29.T', { fetchImpl });
  assert.deepEqual(out.reviews, []);
});

// ---------------------------------------------------------------------------
// Constraint 3: missing is not zero. This is the heart of the suite.
// ---------------------------------------------------------------------------

const base = { packageName: 'com.invtracker.inv_tracker', itemId: 'invtrack', fetchedAt: '2026-09-30T08:00:00Z' };

test('a published app with an empty week reports a REAL zero', () => {
  const out = summariseReviews({ ...base, reviews: [], storeItemStatus: 'published' });
  assert.equal(out.metrics.play_commented_reviews_7d, 0);
  for (let s = 1; s <= 5; s++) assert.equal(out.metrics[`play_commented_reviews_7d_star_${s}`], 0);
  // …but the MEAN of an empty set is absent, not 0 and not 5.
  assert.equal(out.metrics.play_commented_review_star_mean_7d, undefined);
  assert.equal(out.missing.play_commented_review_star_mean_7d, 'metric_missing');
});

test('an internal-track app reports MISSING for every metric, never zero', () => {
  const out = summariseReviews({
    packageName: 'com.carfry369.teleport',
    itemId: 'teleport',
    fetchedAt: base.fetchedAt,
    reviews: [],
    storeItemStatus: 'internal_track',
  });
  assert.deepEqual(out.metrics, {});
  assert.deepEqual(Object.keys(out.missing).sort(), [...EMITTABLE].sort());
  for (const code of Object.values(out.missing)) assert.equal(code, 'play_reviews_production_only');
  // The distinction is recorded, not merely observed.
  assert.equal(out.provenance.store_item_status, 'internal_track');
});

test('refuses to summarise without a store_item_status rather than defaulting to zero', () => {
  assert.throws(
    () => summariseReviews({ ...base, reviews: [] }),
    /indistinguishable from a quiet week|requires `storeItemStatus`/
  );
});

test('flags the contradiction when a non-production app returns reviews anyway', () => {
  const out = summariseReviews({
    packageName: 'com.carfry369.teleport',
    itemId: 'teleport',
    fetchedAt: base.fetchedAt,
    reviews: [review({ star: 5, secs: daysAgo(1) })],
    storeItemStatus: 'internal_track',
  });
  assert.match(out.provenance.status_contradiction, /promoted to production and the config is stale/);
  assert.deepEqual(out.metrics, {}, 'still recorded as missing — the contradiction is reported, not resolved');
  assert.equal(out.observed_review_count, 1);
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

test('counts, histogram and mean come from the returned window only', () => {
  const reviews = [
    review({ star: 5, secs: daysAgo(1) }),
    review({ star: 5, secs: daysAgo(2) }),
    review({ star: 2, secs: daysAgo(3) }),
    review({ star: 4, secs: daysAgo(4) }),
  ];
  const out = summariseReviews({ ...base, reviews, storeItemStatus: 'published' });
  assert.equal(out.metrics.play_commented_reviews_7d, 4);
  assert.equal(out.metrics.play_commented_reviews_7d_star_5, 2);
  assert.equal(out.metrics.play_commented_reviews_7d_star_2, 1);
  assert.equal(out.metrics.play_commented_reviews_7d_star_4, 1);
  assert.equal(out.metrics.play_commented_reviews_7d_star_1, 0);
  assert.equal(out.metrics.play_commented_review_star_mean_7d, 4);
  // The histogram must account for every counted review, or one of the two is wrong.
  const summed = [1, 2, 3, 4, 5].reduce((a, s) => a + out.metrics[`play_commented_reviews_7d_star_${s}`], 0);
    assert.equal(summed, out.metrics.play_commented_reviews_7d);
});

test('the mean is not rounded to an integer', () => {
  const reviews = [review({ star: 5, secs: daysAgo(1) }), review({ star: 4, secs: daysAgo(1) }), review({ star: 4, secs: daysAgo(1) })];
  const out = summariseReviews({ ...base, reviews, storeItemStatus: 'published' });
  assert.equal(out.metrics.play_commented_review_star_mean_7d, 4.333);
});

test('as_of is the fetch date and the declared window is seven days back from it', () => {
  const out = summariseReviews({ ...base, reviews: [], storeItemStatus: 'published' });
  assert.equal(out.as_of, '2026-09-30');
  assert.equal(out.provenance.window_start_utc, '2026-09-23');
  assert.equal(out.provenance.window_days, WINDOW_DAYS);
  assert.equal(out.source, SOURCE);
});

test('no metric is ever synthesized, and the record says so', () => {
  const out = summariseReviews({ ...base, reviews: [review({ star: 5, secs: daysAgo(1) })], storeItemStatus: 'published' });
  assert.deepEqual(out.provenance.synthesized_metrics, []);
  assert.deepEqual(out.provenance.not_derivable_here, ['play_rating_average', 'play_rating_count']);
  assert.match(out.provenance.aggregation, /no accumulation across pulls/);
});

test('the three API constraints travel with every entry as verbatim quotes', () => {
  const out = summariseReviews({ ...base, reviews: [], storeItemStatus: 'published' });
  const c = out.provenance.api_constraints;
  assert.match(c.window, /created or modified within the last week/);
  assert.match(c.commented_only, /does not provide a comment, their feedback is not accessible/);
  assert.match(c.production_only, /only for production versions of your app/);
  assert.match(c.source_url, /^https:\/\/developers\.google\.com\//);
});

test('a review returned from outside the documented window is reported, not silently counted', () => {
  const reviews = [review({ star: 5, secs: daysAgo(1) }), review({ star: 1, secs: daysAgo(40) })];
  const out = summariseReviews({ ...base, reviews, storeItemStatus: 'published' });
  assert.equal(out.provenance.returned_but_older_than_window, 1);
  assert.match(out.provenance.window_anomaly, /may be wrong|Report on APP-42/);
});

test('a review carrying no star rating is counted as unrated, not as a zero-star', () => {
  const noStar = { reviewId: 'gp:x', authorName: 'A', comments: [{ developerComment: { text: 'thanks' } }] };
  const out = summariseReviews({ ...base, reviews: [noStar], storeItemStatus: 'published' });
  assert.equal(out.metrics.play_commented_reviews_7d, 0);
  assert.equal(out.provenance.reviews_without_a_star_rating, 1);
});

// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------

test('the persisted artefact contains no review text, author name or review id', () => {
  const reviews = [
    review({ star: 1, secs: daysAgo(1), text: 'CRASHES CONSTANTLY call me at 555-0100', author: 'Priya Raman' }),
    review({ star: 5, secs: daysAgo(2), text: 'love it', author: 'Sam Okafor' }),
  ];
  const { bytes, artefact, checksum } = redactForStorage({ ...base, reviews });
  for (const leak of ['CRASHES CONSTANTLY', '555-0100', 'Priya Raman', 'Sam Okafor', 'love it', reviews[0].reviewId]) {
    assert.ok(!bytes.includes(leak), `artefact must not contain ${JSON.stringify(leak)}`);
  }
  // What survives is exactly what the metrics need and nothing more.
  assert.deepEqual(Object.keys(artefact.reviews[0]).sort(), ['last_modified_utc', 'star_rating']);
  assert.equal(artefact.review_count, 2);
  assert.match(artefact.note, /PII-REMOVED/);
  assert.match(checksum, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Config coherence — the code and config/portfolio.yaml must agree
// ---------------------------------------------------------------------------

const portfolio = parseYaml(readFileSync(join(REPO_ROOT, 'config', 'portfolio.yaml'), 'utf8'));

test('every EMITTABLE metric is declared in config/portfolio.yaml under this source', () => {
  for (const name of EMITTABLE) {
    const spec = portfolio.metrics?.[name];
    assert.ok(spec, `config/portfolio.yaml declares no metric \`${name}\``);
    assert.equal(spec.source, 'play_reviews_api', `\`${name}\` must declare source play_reviews_api`);
    assert.equal(spec.origin, 'store');
  }
});

test('the reviews-API metrics are alias-forbidden against their reports-bucket namesakes', () => {
  const pairs = (portfolio.forbidden_aliases ?? []).map((a) => [...a.pair].sort().join('|'));
  assert.ok(pairs.includes(['play_commented_review_star_mean_7d', 'play_rating_average'].sort().join('|')));
  assert.ok(pairs.includes(['play_commented_reviews_7d', 'play_rating_count'].sort().join('|')));
});

test('play_reviews_production_only is a registered reason code', () => {
  // An unregistered code is a validator failure, not a free-text note.
  assert.ok(portfolio.reason_codes?.play_reviews_production_only);
  assert.match(portfolio.reason_codes.play_reviews_production_only, /production/i);
});

test('playTargets reads both Android packages and their publication status from config', () => {
  const targets = playTargets(join(REPO_ROOT, 'config', 'portfolio.yaml'));
  const byId = Object.fromEntries(targets.map((t) => [t.item_id, t]));
  assert.equal(byId.invtrack.package_name, 'com.invtracker.inv_tracker');
  assert.equal(byId.invtrack.store_item_status, 'published');
  assert.equal(byId.teleport.package_name, 'com.carfry369.teleport');
  assert.equal(byId.teleport.store_item_status, 'internal_track');
});

test('playTargets refuses an Android product with no play_package rather than guessing one', () => {
  const dir = scratch();
  const path = join(dir, 'portfolio.yaml');
  writeFileSync(path, 'products:\n  mystery: { platform: android, store_item_status: published }\n');
  assert.throws(() => playTargets(path), /declares no `play_package`/);
});

// ---------------------------------------------------------------------------
// End to end: a stubbed API run lands real manifest entries
// ---------------------------------------------------------------------------

test('a full ingest run lands one manifest entry per target, with a derived lag_days', async () => {
  const dir = scratch();
  const keyFile = writeKey(dir);
  const dataRoot = join(dir, 'data');

  const byPackage = {
    'com.invtracker.inv_tracker': {
      reviews: [review({ star: 5, secs: daysAgo(1) }), review({ star: 3, secs: daysAgo(2), author: 'Ana Ruiz', text: 'needs dark mode' })],
    },
    'com.carfry369.teleport': { reviews: [] },
  };

  const fetchImpl = async (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.T', expires_in: 3599 }) };
    }
    const pkg = decodeURIComponent(url.split('/applications/')[1].split('/')[0]);
    return { ok: true, status: 200, text: async () => JSON.stringify(byPackage[pkg]) };
  };

  const lines = [];
  await ingest({
    targets: playTargets(join(REPO_ROOT, 'config', 'portfolio.yaml')),
    keyFile,
    dataRoot,
    fetchImpl,
    now: () => '2026-09-30T08:00:00Z',
    log: (m) => lines.push(m),
  });

  const entries = readFileSync(join(dataRoot, 'metrics', 'manifest.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(entries.length, 2);

  const byItem = Object.fromEntries(entries.map((e) => [e.item_id, e]));

  // InvTrack: published, two commented reviews in the window.
  assert.equal(byItem.invtrack.source, SOURCE);
  assert.equal(byItem.invtrack.as_of, '2026-09-30');
  assert.equal(byItem.invtrack.lag_days, 0, 'lag_days is derived from as_of and exported_at, never configured');
  assert.equal(byItem.invtrack.metrics.play_commented_reviews_7d, 2);
  assert.equal(byItem.invtrack.metrics.play_commented_review_star_mean_7d, 4);
  assert.deepEqual(byItem.invtrack.notes.missing, {});

  // TelePort: internal track. Empty list, and the entry says MISSING, not 0.
  assert.deepEqual(byItem.teleport.metrics, {});
  assert.equal(byItem.teleport.notes.missing.play_commented_reviews_7d, 'play_reviews_production_only');

  // The persisted artefact is the PII-free one, and the checksum is over it.
  const artefact = readFileSync(byItem.invtrack.raw_path, 'utf8');
  assert.ok(!artefact.includes('Ana Ruiz') && !artefact.includes('needs dark mode'));
  assert.match(byItem.invtrack.notes.upstream_response_sha256, /^[0-9a-f]{64}$/);

  // Nothing printed by the job may contain the credential or the token.
  const printed = lines.join('\n');
  assert.ok(!printed.includes('ya29.T'), 'the access token must never reach a log line');
  assert.ok(!printed.includes('BEGIN PRIVATE KEY'));
});

test('the job refuses to start when pointed at a key for the publisher account', async () => {
  const dir = scratch();
  const keyFile = writeKey(dir, { client_email: 'release-bot@rk-release-platform.iam.gserviceaccount.com' });
  await assert.rejects(
    () => ingest({ targets: [], keyFile, dataRoot: join(dir, 'data'), fetchImpl: async () => { throw new Error('must not be called'); }, log: () => {} }),
    /different account|release authority/
  );
});
