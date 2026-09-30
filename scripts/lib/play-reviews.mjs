// Google Play Developer API — reviews read path (APP-210).
//
// This module is the ONLY place in the repo that touches a store credential,
// and it is deliberately not reachable from an agent run: `scripts/agent-*`
// never imports it, and the key is addressed by PATH, never by value (see
// `loadServiceAccountKey`). §6.1 rule 4 holds because there is nothing here
// for an agent to hold.
//
// ---------------------------------------------------------------------------
// THE THREE CONSTRAINTS, quoted from Google, that shape every name below
// ---------------------------------------------------------------------------
// https://developers.google.com/android-publisher/reply-to-reviews
//
//   1. "You can retrieve only the reviews that users have created or modified
//      within the last week."
//   2. "The API shows only the reviews that include comments. If a user rates
//      your app but does not provide a comment, their feedback is not
//      accessible from the API."
//   3. "The Reply to Reviews API allows you to access feedback only for
//      production versions of your app."
//
// Each one destroys a metric somebody will otherwise try to derive here:
//
//   (1) kills any lifetime count. A tally off this endpoint is a SEVEN-DAY
//       ROLLING count, and next week's number is not this week's plus new
//       arrivals — reviews leave the window. Summing weekly pulls would
//       double-count every edited review and miss every ratings-only one.
//   (2) kills the rating average. The mean star rating over reviews that have
//       comments is a mean over a SELF-SELECTED SUBSAMPLE; users who write
//       are not users who merely rate. `play_rating_average` is a different
//       quantity with a different source (the reports bucket) and the two
//       must never meet. config/portfolio.yaml's `forbidden_aliases` carries
//       the pair.
//   (3) kills the zero. A non-production app returns HTTP 200 and an EMPTY
//       LIST — the same bytes a production app with a quiet week returns.
//       TelePort is `internal_track`, so its empty response means "no
//       observable surface", i.e. `missing`, NOT `0`. §7 of the master plan
//       forbids reporting an absent reading as a zero, and this is precisely
//       the case where the API hands you one for free.
//
// Every metric name this module can emit therefore carries its window in the
// name, and `assertReviewMetricsAreHonest` refuses on the way out if one does
// not. Adding an unwindowed or lifetime-sounding metric makes the ingest
// FAIL, not drift.

import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { sha256, utcCalendarDate } from './metrics-manifest.mjs';

export const SOURCE = 'play_reviews_api';

/** The read-only scope. `androidpublisher` is the only scope Play exposes. */
export const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** The window Google enforces server-side. Not configurable: it is not ours. */
export const WINDOW_DAYS = 7;

/**
 * Metric names this source may emit, and nothing else.
 *
 * Read the suffixes as load-bearing. `_7d` is not decoration — it is the
 * difference between a number that means something and a number that means
 * whatever the reader assumed. `commented_` likewise states constraint (2)
 * in the name, so the bias travels with the value into every downstream
 * table instead of living in a doc nobody opens.
 */
export const EMITTABLE = Object.freeze([
  'play_commented_reviews_7d',
  'play_commented_review_star_mean_7d',
  'play_commented_reviews_7d_star_1',
  'play_commented_reviews_7d_star_2',
  'play_commented_reviews_7d_star_3',
  'play_commented_reviews_7d_star_4',
  'play_commented_reviews_7d_star_5',
]);

/**
 * Names that must never be emitted from this source, by name.
 *
 * Both have a real definition and a real source elsewhere
 * (`play_reports_bucket`). The failure mode being blocked is not someone
 * inventing a number — it is someone filling a legitimately empty cell with
 * the nearest available one.
 */
export const NEVER_FROM_REVIEWS_API = Object.freeze([
  'play_rating_average',
  'play_rating_count',
]);

const LIFETIME_SOUNDING = /rating_(average|count)|reviews_total|total_reviews|lifetime|all_time|cumulative/i;

/**
 * Last gate before anything leaves this module.
 *
 * Mirrors `assertNoWeeklySynthesis` in play-report.mjs: the guard runs on the
 * VALUES actually produced, not on the code that produced them, so it cannot
 * be defeated by adding a mapping somewhere else.
 */
export function assertReviewMetricsAreHonest(metrics) {
  for (const name of Object.keys(metrics ?? {})) {
    if (NEVER_FROM_REVIEWS_API.includes(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from ${SOURCE}: the reviews endpoint returns only ` +
          'commented reviews from the last 7 days, so it cannot see a lifetime rating. ' +
          `\`${name}\` comes from the Play reports bucket. See config/portfolio.yaml forbidden_aliases.`
      );
    }
    if (LIFETIME_SOUNDING.test(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from ${SOURCE}: the name claims a lifetime or cumulative ` +
          'quantity, and this endpoint has a 7-day rolling window (Google: "You can retrieve only ' +
          'the reviews that users have created or modified within the last week").'
      );
    }
    if (!/_7d(_|$)/.test(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from ${SOURCE}: every quantity from this endpoint is ` +
          'window-bounded, so every metric name must carry its window (`_7d`). An unwindowed ' +
          'name is read as a running total by everyone downstream.'
      );
    }
    if (!EMITTABLE.includes(name)) {
      throw new Error(
        `refusing to emit \`${name}\` from ${SOURCE}: not in EMITTABLE. Adding a metric here is a ` +
          'deliberate act — define it in config/portfolio.yaml first so freshness and aliasing ' +
          'rules apply to it.'
      );
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Credential: addressed by path, never by value
// ---------------------------------------------------------------------------

/**
 * Read the service-account JSON key from a path on the operator's machine.
 *
 * The key is NEVER passed as a value — not as an env var, not as an argument,
 * not through a Paperclip run env. `PLAY_READONLY_INGEST_KEY_FILE` holds a
 * PATH, which is not a secret, which is why it is safe to keep in `.envrc`
 * and safe to render into a launchd plist. A plist holding the JSON itself
 * would be a second copy of the credential in a second place with a second
 * lifetime; a path is a copy of nothing.
 *
 * The checks below are cheap and each one corresponds to a way this has gone
 * wrong somewhere: a key committed to a repo, a key left world-readable, a
 * key that turned out to be the *publisher* account's.
 */
export function loadServiceAccountKey(path, { expectClientEmail = null, repoRoot = null } = {}) {
  const abs = resolve(path);

  if (repoRoot) {
    const root = resolve(repoRoot);
    if (abs === root || abs.startsWith(root + '/')) {
      throw new Error(
        `refusing to read a service-account key from inside the repository (${abs}). ` +
          'A credential under a git working tree is one `git add -A` from being published. ' +
          'Keep it outside, mode 0600.'
      );
    }
  }

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new Error(
      `no service-account key at ${abs}. This file is placed by the founder and is never ` +
        'created, requested, or transmitted by any agent. See docs/metrics-ingest.md §4.5.'
    );
  }
  // 0o077 = any permission bit for group or other.
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `service-account key ${abs} is group- or world-readable (mode ${(stat.mode & 0o777).toString(8)}). ` +
        'Run `chmod 600` on it and re-run.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    // Deliberately does not echo the file body: a parse error on a credential
    // file loves to quote the bytes it failed on.
    throw new Error(`service-account key ${abs} is not valid JSON (${err.name})`);
  }

  for (const field of ['client_email', 'private_key', 'token_uri']) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      throw new Error(`service-account key ${abs} is missing \`${field}\``);
    }
  }
  if (parsed.type !== 'service_account') {
    throw new Error(`service-account key ${abs} has type ${JSON.stringify(parsed.type)}, expected "service_account"`);
  }
  if (expectClientEmail && parsed.client_email !== expectClientEmail) {
    // The ingest identity and the publishing identity are different accounts
    // on purpose. `release-bot` stays the only publisher; a read path that
    // silently accepted its key would quietly put release authority in a cron
    // job. Errors name the EXPECTED address, which is not a secret.
    throw new Error(
      `service-account key ${abs} is for a different account than this job expects ` +
        `(expected ${expectClientEmail}). The ingest identity is read-only and separate from ` +
        'the publisher identity by design; do not point this job at a publishing key.'
    );
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri,
    key_path: abs,
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Build and RS256-sign the JWT bearer assertion. */
export function buildJwtAssertion(key, { now = Date.now(), scope = SCOPE, lifetimeSeconds = 3600 } = {}) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: key.token_uri,
      iat,
      exp: iat + lifetimeSeconds,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Exchange the assertion for an access token.
 *
 * Every throw path here is scrubbed: the request body contains the signed
 * assertion and the response body contains the token, and an unscrubbed
 * error from either lands in a launchd log that lives forever.
 */
export async function fetchAccessToken(key, { fetchImpl = fetch, now = Date.now(), scope = SCOPE } = {}) {
  const assertion = buildJwtAssertion(key, { now, scope });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  let res;
  try {
    res = await fetchImpl(key.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`token exchange failed to reach ${key.token_uri} (${err.name})`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Google's error body carries `error` and `error_description` and no
    // token; surface those two fields only, never the whole body.
    let detail = '';
    try {
      const j = JSON.parse(text);
      detail = [j.error, j.error_description].filter(Boolean).join(': ');
    } catch { /* non-JSON body: say nothing about its contents */ }
    throw new Error(`token exchange rejected with HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('token exchange returned a non-JSON body');
  }
  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw new Error('token exchange returned no access_token');
  }
  return { access_token: json.access_token, expires_in: json.expires_in ?? null };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export const REVIEWS_ENDPOINT = (packageName) =>
  `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/reviews`;

/**
 * List every review the API will return for `packageName`.
 *
 * `maxPages` is a stop, not a tuning knob: an endpoint that paginates forever
 * because of a server-side bug should fail the job, not fill a disk.
 */
export async function listReviews(packageName, accessToken, { fetchImpl = fetch, maxResults = 100, maxPages = 50 } = {}) {
  const reviews = [];
  let token = null;
  let pages = 0;

  for (;;) {
    const url = new URL(REVIEWS_ENDPOINT(packageName));
    url.searchParams.set('maxResults', String(maxResults));
    if (token) url.searchParams.set('token', token);

    let res;
    try {
      res = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      throw new Error(`reviews.list failed to reach the API for ${packageName} (${err.name})`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `reviews.list returned HTTP ${res.status} for ${packageName}: the service account is not ` +
          'granted on this app, or the grant does not include "View app information". ' +
          'This is a Play Console permission question, not a code question.'
      );
    }
    if (!res.ok) throw new Error(`reviews.list returned HTTP ${res.status} for ${packageName}`);

    let page;
    try {
      page = JSON.parse(text);
    } catch {
      throw new Error(`reviews.list returned a non-JSON body for ${packageName}`);
    }
    // An absent `reviews` key and an empty array mean the same thing here and
    // both are legitimate; what they do NOT mean is "zero" — see
    // `summariseReviews`, which decides that with the track status in hand.
    for (const r of page.reviews ?? []) reviews.push(r);

    token = page.tokenPagination?.nextPageToken ?? null;
    pages += 1;
    if (!token) break;
    if (pages >= maxPages) {
      throw new Error(
        `reviews.list paginated past ${maxPages} pages for ${packageName}; refusing to continue. ` +
          'The endpoint returns at most one week of commented reviews, so this is a bug, not volume.'
      );
    }
  }

  return { reviews, pages };
}

// ---------------------------------------------------------------------------
// Derivation — where missing and zero are told apart
// ---------------------------------------------------------------------------

/** Every star rating the API documents: "from 1 to 5". */
const STARS = [1, 2, 3, 4, 5];

function starOf(review) {
  const comments = review?.comments ?? [];
  for (const c of comments) {
    const s = c?.userComment?.starRating;
    if (Number.isInteger(s) && s >= 1 && s <= 5) return s;
  }
  return null;
}

function lastModifiedSeconds(review) {
  let newest = null;
  for (const c of review?.comments ?? []) {
    const secs = Number(c?.userComment?.lastModified?.seconds ?? c?.developerComment?.lastModified?.seconds);
    if (Number.isFinite(secs) && (newest === null || secs > newest)) newest = secs;
  }
  return newest;
}

/**
 * Turn a review list into metrics, or into an explicit absence.
 *
 * `storeItemStatus` comes from config/portfolio.yaml and is REQUIRED. It is
 * the only thing that distinguishes "we looked at a production app for seven
 * days and nobody wrote anything" (a real 0) from "this app has no production
 * version, so the endpoint has nothing to look at" (missing). The API itself
 * returns identical bytes in both cases, so a caller that does not supply it
 * cannot be given a correct answer and is refused rather than defaulted.
 */
export function summariseReviews({
  packageName,
  itemId,
  reviews,
  storeItemStatus,
  fetchedAt,
  upstreamSha256 = null,
}) {
  if (!packageName) throw new Error('summariseReviews requires `packageName`');
  if (!itemId) throw new Error('summariseReviews requires `itemId`');
  if (!fetchedAt) throw new Error('summariseReviews requires `fetchedAt`');
  if (!storeItemStatus) {
    throw new Error(
      'summariseReviews requires `storeItemStatus`: an empty review list from a non-production ' +
        'app is indistinguishable from a quiet week on a published one, and calling both `0` is ' +
        'the exact error §7 forbids.'
    );
  }

  const as_of = utcCalendarDate(fetchedAt);
  const windowStart = utcCalendarDate(new Date(new Date(fetchedAt).getTime() - WINDOW_DAYS * 86400000));

  const provenance = {
    api_constraints: {
      window: 'Google: "You can retrieve only the reviews that users have created or modified within the last week."',
      commented_only:
        'Google: "The API shows only the reviews that include comments. If a user rates your app but does not provide a comment, their feedback is not accessible from the API."',
      production_only:
        'Google: "The Reply to Reviews API allows you to access feedback only for production versions of your app."',
      source_url: 'https://developers.google.com/android-publisher/reply-to-reviews',
    },
    window_days: WINDOW_DAYS,
    window_start_utc: windowStart,
    window_end_utc: as_of,
    aggregation: 'count and mean over the returned window only — no accumulation across pulls',
    synthesized_metrics: [],
    not_derivable_here: NEVER_FROM_REVIEWS_API.slice(),
    store_item_status: storeItemStatus,
    upstream_response_sha256: upstreamSha256,
  };

  // Constraint (3): no production version ⇒ no surface ⇒ missing, not zero.
  if (storeItemStatus !== 'published') {
    // …but if the endpoint DID return reviews for an app we believe has no
    // production version, one of the two is wrong, and silently discarding
    // real data is the worse failure. Say so loudly; the config is the thing
    // most likely to be stale.
    if (Array.isArray(reviews) && reviews.length > 0) {
      provenance.status_contradiction =
        `config/portfolio.yaml says store_item_status=${storeItemStatus} for ${itemId}, but the ` +
        `production-only reviews endpoint returned ${reviews.length} review(s). Either the app was ` +
        'promoted to production and the config is stale, or the documented production-only ' +
        'constraint does not hold. Resolve before trusting either reading; this pull is recorded ' +
        'as missing, not as data.';
    }
    return {
      source: SOURCE,
      item_id: itemId,
      package_name: packageName,
      as_of,
      exported_at: new Date(fetchedAt).toISOString(),
      metrics: {},
      missing: Object.fromEntries(EMITTABLE.map((m) => [m, 'play_reviews_production_only'])),
      observed_review_count: Array.isArray(reviews) ? reviews.length : 0,
      provenance,
    };
  }

  const stars = [];
  const perStar = Object.fromEntries(STARS.map((s) => [s, 0]));
  let unrated = 0;
  let outOfWindow = 0;
  const windowStartSecs = Math.floor(new Date(fetchedAt).getTime() / 1000) - WINDOW_DAYS * 86400;

  for (const r of reviews ?? []) {
    const s = starOf(r);
    if (s === null) { unrated += 1; continue; }
    stars.push(s);
    perStar[s] += 1;
    const lm = lastModifiedSeconds(r);
    if (lm !== null && lm < windowStartSecs) outOfWindow += 1;
  }

  const metrics = {
    play_commented_reviews_7d: stars.length,
  };
  const missing = {};

  if (stars.length > 0) {
    const mean = stars.reduce((a, b) => a + b, 0) / stars.length;
    // Rounded at the point of derivation so the manifest carries one number,
    // not a float whose last digits differ per platform.
    metrics.play_commented_review_star_mean_7d = Math.round(mean * 1000) / 1000;
  } else {
    // A mean over an empty set is not 0 and is not 5. It does not exist.
    missing.play_commented_review_star_mean_7d = 'metric_missing';
  }

  for (const s of STARS) metrics[`play_commented_reviews_7d_star_${s}`] = perStar[s];

  provenance.reviews_without_a_star_rating = unrated;
  // Google's window is "created or modified", so a review whose last
  // modification predates the window should not appear. If one does, the
  // window is not what the doc says and the count's meaning has changed —
  // report it rather than quietly including it.
  provenance.returned_but_older_than_window = outOfWindow;
  if (outOfWindow > 0) {
    provenance.window_anomaly =
      `${outOfWindow} returned review(s) were last modified before the documented ${WINDOW_DAYS}-day window. ` +
      'The documented window may be wrong or may apply to creation only. Report on APP-42 before ' +
      'trusting this count as a 7-day figure.';
  }

  assertReviewMetricsAreHonest(metrics);

  return {
    source: SOURCE,
    item_id: itemId,
    package_name: packageName,
    as_of,
    exported_at: new Date(fetchedAt).toISOString(),
    metrics,
    missing,
    observed_review_count: Array.isArray(reviews) ? reviews.length : 0,
    provenance,
  };
}

/**
 * The PII-free artefact that gets persisted.
 *
 * Review bodies and author names are user personal data. Nothing in this
 * pipeline needs them — every metric above is a count or a mean of stars —
 * so they are dropped at the boundary rather than written to disk and
 * regretted later. The checksum in the manifest is taken over THIS, the thing
 * that actually exists on disk; the hash of the untruncated response travels
 * alongside as `upstream_response_sha256` so the drop is auditable.
 */
export function redactForStorage({ packageName, itemId, reviews, fetchedAt }) {
  const rows = (reviews ?? []).map((r) => ({
    star_rating: starOf(r),
    last_modified_utc: (() => {
      const s = lastModifiedSeconds(r);
      return s === null ? null : new Date(s * 1000).toISOString();
    })(),
  }));
  const artefact = {
    note:
      'PII-REMOVED. Review text, author names, reviewer language, device and review ids are ' +
      'dropped at ingest: no metric derived from this source needs them.',
    source: SOURCE,
    package_name: packageName,
    item_id: itemId,
    fetched_at: new Date(fetchedAt).toISOString(),
    review_count: rows.length,
    reviews: rows,
  };
  const bytes = JSON.stringify(artefact, null, 2) + '\n';
  return { artefact, bytes, checksum: sha256(bytes) };
}
