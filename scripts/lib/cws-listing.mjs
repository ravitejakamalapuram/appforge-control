// Chrome Web Store PUBLIC listing reader (APP-42 / APP-163).
//
// Why this file exists at all: A8 grouped four fields as having "no
// programmatic source" — uninstalls, weekly users, rating average, rating
// count. QA (APP-163) checked field-by-field rather than accepting the
// grouping and found it wrong for the two rating fields. Both are on the
// PUBLIC listing page: anonymous HTTPS, HTTP 200, no credential, no founder
// session, no browser automation. So they are NOT blocked on the pending
// founder dashboard-export card, and they get their own importer.
//
// A8 still holds where it matters: uninstalls and weekly users have no public
// or API source, and they are what keep the founder-session export required.
// This file narrows the blocked set from five fields to three; it does not
// remove the blocker.
//
// Two things this parser must never do, both of them real traps:
//
//  1. Never emit a rating figure it did not read. An item with no ratings
//     shows no rating block at all, and "no ratings yet" is not "rated 0".
//     A zero average would be a fabricated data point that silently drags any
//     portfolio-level mean down. Absent means absent.
//
//  2. Never attribute another extension's rating to our item. The real page is
//     noisy: QA's 2026-09-29 capture of the json-workbench listing also
//     rendered 4.5, 4.6 and 4.2 for RECOMMENDED extensions. A page-wide "first
//     rating block wins" scan would silently record a competitor's score as
//     ours, and it would look entirely plausible in the manifest. So when more
//     than one rating block is present this parser REFUSES rather than
//     guessing, and the caller must narrow the scope explicitly.
//
//  3. Never map the listing's user count to anything. The public listing also
//     shows a "N users" figure. QA flagged this explicitly: it is the
//     public-listing surface, NOT the dashboard's Weekly Users page, and the
//     two disagreed (5 vs 3) for json-workbench. Feeding it to
//     `cws_weekly_users` would silently resolve the open APP-54 question with
//     the wrong instrument. It is parsed only so it can be REPORTED as
//     deliberately-unmapped, never stored as a metric.

import { sha256, utcCalendarDate } from './metrics-manifest.mjs';

export const SOURCE = 'cws_public_listing';

/** The only two metrics this source is allowed to produce. */
export const LISTING_METRICS = Object.freeze(['cws_rating_average', 'cws_rating_count']);

/**
 * Metrics that appear on the listing surface but are deliberately NOT mapped.
 * Keyed by what it looks like → why we refuse it.
 */
export const REFUSED_FIELDS = Object.freeze({
  users: 'public-listing user count is a different instrument from the dashboard Weekly Users page (APP-54 still open); mapping it would answer an open question with the wrong number',
});

/**
 * Rating block, as rendered: "<name> <average> ( <count> rating[s] )".
 * Verified against QA's 2026-09-29 capture: "JSON Workbench 5.0 ( 1 rating )".
 * Tolerant of the spacing around the parenthesis and of thousands separators.
 */
const RATING_RE = /([0-9]+(?:\.[0-9]+)?)\s*\(\s*([0-9][0-9,]*)\s*ratings?\s*\)/i;

/** "N users" / "N,NNN users" on the listing — matched only to refuse it. */
const USERS_RE = /([0-9][0-9,]*)\s*users?\b/i;

/**
 * The listing states its own freshness bound in prose. QA captured it
 * verbatim: "Ratings are updated daily and may not reflect the most recent
 * reviews."
 *
 * This is stored VERBATIM and never converted into a number of days. APP-42 is
 * explicit that lag is measured, never assumed; turning "updated daily" into
 * `lag_days: 1` would manufacture exactly the folklore constant the issue
 * forbids. The sentence is the contract, so the sentence is what we keep.
 */
const DECLARED_FRESHNESS_RE = /Ratings are updated[^.]*\./i;

function toNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a captured public listing.
 *
 * `fetched_at` is when the HTTPS GET happened. The listing carries NO date of
 * its own, which is the important difference from the dashboard export: there
 * is no column to read `as_of` out of. `as_of` is therefore the UTC calendar
 * date of the fetch, and `as_of_source` says so in words rather than naming a
 * column that does not exist.
 *
 * That makes `lag_days` come out 0, and it must not be read as "this figure is
 * current". It means the lag is UNOBSERVABLE from this surface: the store
 * refreshes ratings on its own schedule and the page admits as much in prose
 * ("Ratings are updated daily...") without ever dating the figure. The
 * distinction is recorded in `lag_observable: false`, and the page's own
 * sentence is kept verbatim in `declared_freshness`, so nobody later mistakes a
 * structural zero for a measured one.
 */
export function parseCwsListing(html, { item_id, fetched_at, scope = null }) {
  if (!item_id) throw new Error('parseCwsListing requires `item_id`');
  if (!fetched_at) throw new Error('parseCwsListing requires `fetched_at`');
  if (typeof html !== 'string' || html.trim() === '') {
    throw new Error('listing capture is empty — refusing to record an empty import');
  }

  const fullText = stripTags(html);

  // `scope` narrows to the item's own block before any rating is read. On the
  // real page this is what separates our item from the recommended-extensions
  // carousel; QA scoped extraction the same way.
  let text = fullText;
  if (scope) {
    const at = fullText.indexOf(scope);
    if (at === -1) {
      throw new Error(
        `scope ${JSON.stringify(scope)} does not appear in the capture — ` +
          'refusing to fall back to a page-wide scan, which could read another extension\'s rating'
      );
    }
    text = fullText.slice(at);
  }

  const metrics = {};
  const absent = [];

  // Find EVERY rating block in range, not just the first, so ambiguity is
  // detectable instead of silently resolved.
  const all = [...text.matchAll(new RegExp(RATING_RE.source, 'gi'))];

  // Without an explicit scope, more than one rating block is UNRESOLVABLE and
  // must not be guessed at: on the real page the extras belong to the
  // recommended-extensions carousel, and picking the first would record
  // another extension's score as ours. With a scope, the caller has asserted
  // where the item's own block starts, so the nearest block after that anchor
  // is the item's — which is how QA scoped the 2026-09-29 extraction.
  if (all.length > 1 && !scope) {
    throw new Error(
      `found ${all.length} rating blocks (${all.map((m) => JSON.stringify(m[0].trim())).join(', ')}) ` +
        'and no `scope` to tell them apart. The Chrome Web Store listing also renders ratings for ' +
        'RECOMMENDED extensions, so the first match is not necessarily this item\'s. Pass `scope` to ' +
        'anchor the item block rather than recording a rating that may belong to another extension.'
    );
  }
  const ratingMatch = all[0] ?? null;
  // How many blocks the anchor did NOT exclude, recorded so a too-loose scope
  // stays visible in the manifest instead of passing as a clean read.
  const blocks_in_range = all.length;
  if (ratingMatch) {
    const average = toNumber(ratingMatch[1]);
    const count = toNumber(ratingMatch[2]);
    // A rating block with an unreadable number is a parse failure, not a zero.
    if (average === null || count === null) {
      throw new Error(`rating block matched but did not yield numbers: ${JSON.stringify(ratingMatch[0])}`);
    }
    if (average > 5) {
      throw new Error(
        `rating average ${average} exceeds the Chrome Web Store 5-point scale — ` +
          'refusing the parse rather than storing an impossible value'
      );
    }
    metrics.cws_rating_average = average;
    metrics.cws_rating_count = count;
  } else {
    // No rating block. This is the normal state for a new item and must stay
    // absent: "not yet rated" is a different fact from "rated zero".
    absent.push(...LISTING_METRICS);
  }

  // Parsed ONLY to report it as refused. Never enters `metrics`.
  const usersMatch = text.match(USERS_RE);
  const declared = fullText.match(DECLARED_FRESHNESS_RE);
  const refused = usersMatch
    ? [{ field: 'users', observed: usersMatch[0].trim(), reason: REFUSED_FIELDS.users }]
    : [];

  return {
    source: SOURCE,
    item_id,
    as_of: utcCalendarDate(fetched_at),
    as_of_source: 'fetch time — the public listing carries no as-of date of its own',
    lag_observable: false,
    // Verbatim, never parsed into a number of days. See DECLARED_FRESHNESS_RE.
    declared_freshness: declared ? declared[0].trim() : null,
    exported_at: new Date(fetched_at).toISOString(),
    metrics,
    absent_metrics: absent,
    refused_fields: refused,
    rating_block_verbatim: ratingMatch ? ratingMatch[0].trim() : null,
    scope_applied: scope,
    rating_blocks_in_range: blocks_in_range,
    checksum: sha256(html),
  };
}

/** Drop tags and collapse whitespace so the rating block reads as one line. */
function stripTags(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What this import did and did not establish, for the import log. */
export function listingProvenance(parsed) {
  return {
    rating_block: parsed.rating_block_verbatim,
    mapped: Object.keys(parsed.metrics),
    absent: parsed.absent_metrics,
    refused: parsed.refused_fields,
    lag_observable: parsed.lag_observable,
    declared_freshness: parsed.declared_freshness,
    scope_applied: parsed.scope_applied,
    rating_blocks_in_range: parsed.rating_blocks_in_range,
  };
}

// ---------------------------------------------------------------------------
// Attested extracts
// ---------------------------------------------------------------------------
//
// There is no automation channel to a browser in this runtime (QA established
// this on APP-54: Playwright absent, npm egress 403, no browser tool, Brave
// running without --remote-debugging-port). So the agent that can parse a
// listing is not the agent that can fetch one, and the 648KB page QA captured
// on 2026-09-29 does not live in this repo.
//
// The dishonest shortcut would be to reconstruct a page locally, hash it, and
// record that hash as the capture's checksum. That would put a checksum in the
// manifest that attests to a file nobody ever fetched. Instead an attested
// extract carries the UPSTREAM checksum — the hash of the bytes the capturing
// agent actually received — plus who captured it and where the raw artifact
// lives, and marks `raw_artifact_present: false` so the manifest never implies
// this repo can reproduce the bytes.
//
// This is the cycle-one fallback APP-42 sanctions, made auditable rather than
// implicit.

const REQUIRED_ATTESTATION = ['captured_by', 'captured_at', 'upstream_sha256', 'artifact_ref'];

/**
 * Build a listing import from an attested extract rather than from page bytes.
 *
 * Every figure must be present VERBATIM as the capturing agent recorded it.
 * Nothing is inferred: if the extract does not carry a rating block, the
 * rating metrics come out absent, exactly as they would from a real page.
 */
export function parseAttestedListing(extract, { item_id }) {
  if (!item_id) throw new Error('parseAttestedListing requires `item_id`');
  if (!extract || typeof extract !== 'object') {
    throw new Error('attested extract must be an object');
  }

  const missing = REQUIRED_ATTESTATION.filter((k) => !extract[k]);
  if (missing.length) {
    throw new Error(
      `attested extract is missing provenance field(s): ${missing.join(', ')}. ` +
        'An extract without provenance is an unsourced number and must not enter the manifest.'
    );
  }
  if (!/^[0-9a-f]{64}$/.test(extract.upstream_sha256)) {
    throw new Error(
      `upstream_sha256 ${JSON.stringify(extract.upstream_sha256)} is not a sha256 hex digest`
    );
  }

  const block = extract.rating_block_verbatim ?? null;
  const metrics = {};
  const absent = [];
  if (block) {
    // Parsed from the verbatim block, not from pre-computed numbers, so the
    // recorded string and the stored values cannot drift apart.
    const m = String(block).match(RATING_RE);
    if (!m) {
      throw new Error(
        `rating_block_verbatim ${JSON.stringify(block)} does not match the listing rating format`
      );
    }
    const average = toNumber(m[1]);
    const count = toNumber(m[2]);
    if (average === null || count === null) {
      throw new Error(`attested rating block yielded no numbers: ${JSON.stringify(block)}`);
    }
    if (average > 5) {
      throw new Error(`attested rating average ${average} exceeds the 5-point scale`);
    }
    metrics.cws_rating_average = average;
    metrics.cws_rating_count = count;
  } else {
    absent.push(...LISTING_METRICS);
  }

  return {
    source: SOURCE,
    item_id,
    as_of: utcCalendarDate(extract.captured_at),
    as_of_source:
      'capture time — the public listing carries no as-of date of its own (attested extract)',
    lag_observable: false,
    declared_freshness: extract.declared_freshness ?? null,
    exported_at: new Date(extract.captured_at).toISOString(),
    metrics,
    absent_metrics: absent,
    // The listing's user figure is refused here for the same reason as in the
    // HTML path: it is a different instrument from the dashboard Weekly Users
    // page and must not touch the open APP-54 question.
    refused_fields: extract.refused_observations
      ? Object.entries(extract.refused_observations).map(([field, observed]) => ({
          field,
          observed,
          reason: REFUSED_FIELDS[field] ?? 'not a mapped metric for this source',
        }))
      : [],
    rating_block_verbatim: block,
    scope_applied: extract.scope_note ?? null,
    rating_blocks_in_range: null, // not observable from an extract
    // The manifest checksum is the hash of the bytes the CAPTURING agent
    // received, never a hash of anything reconstructed locally.
    checksum: extract.upstream_sha256,
    attestation: {
      captured_by: extract.captured_by,
      captured_at: extract.captured_at,
      artifact_ref: extract.artifact_ref,
      raw_artifact_present: false,
      http_status: extract.http_status ?? null,
      byte_length: extract.byte_length ?? null,
    },
  };
}
