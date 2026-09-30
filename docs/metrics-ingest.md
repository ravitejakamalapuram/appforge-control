# Store-metrics ingest

Gets Chrome Web Store, Google Play and Gumroad figures into a place
`appforge metrics` can read, with **zero product code change and no agent ever
holding a store credential** (§6.1 rule 4).

Issue: APP-42. Contract: `config/portfolio.yaml` → `metrics.*.max_age_days`.

---

## 1. A8 — answered

Master-plan assumption **A8: "CWS has no public API for install/user counts."**
It had been propagating through the plan unchecked. Verified by Analyst on
primary sources 2026-09-29 (full record: the `a8-verification` document on
APP-42), partially corrected by QA the same day (APP-163).

**Verdict: confirmed as written for user counts; partially false for installs.**

| Door | Result |
|---|---|
| Chrome Web Store API v1.1 | **Closed.** One resource (`items`), methods `get`/`insert`/`update`/`publish`. Schemas carry `uploadState`, `crxVersion`, `itemError`, `status` — zero statistics fields. It is a publishing API. No v2 with a stats surface exists. |
| Chrome Management API `customers.reports.countInstalledApps` | **Closed, and a different question.** `customer` means the caller's own Workspace org; it reports apps on a managed fleet. A developer cannot see store-wide installs of their own item. |
| GA4 opt-in (Store listing tab) | **Open — but not to a service account.** Emits `page_view` and a custom `install` event into a GA4 property the store creates, on which the developer holds **Marketer**, a role that "can't be changed" and cannot manage users. No service account can therefore be granted read access. The Data API *is* reachable, with **OAuth user credentials**. Answered in §3. **APP-157.** |
| Public listing page | **Open for two fields.** Rating average and rating count are on the anonymous public listing — no credential, no session, no automation. **APP-163.** |

### What A8 got right, and what it cost

A8 was load-bearing in the direction the plan assumed: **uninstalls and weekly
users have no public and no API source at all.** The founder-session CSV export
is genuinely necessary, not busywork, and the plan does not collapse.

But A8's grouping was wrong in two places, and both were caught only because
somebody checked rather than inheriting the claim:

- It said four fields had no programmatic source. **Two of those four — the
  rating fields — are on a public web page.** The dashboard export needs to
  carry **five** fields, not seven.
- It implied nothing programmatic existed for installs. **GA4 is a partial
  path** for installs and listing page views — the two inputs to
  `store_listing_conversion`, EXP-0001's primary metric.

And the correction had a correction. The GA4 row above was first written as
"readable through the service-account-capable Data API." The Data API is
service-account-capable; **this property is not service-account-grantable**, and
those are different claims. §3 records how that collapsed and what replaced it.

---

## 2. What the CWS dashboard export must carry

Five fields per item, for the eight items with a `cws` id in their
`product.yaml`:

`cws_weekly_users`, `cws_installs`, `cws_uninstalls`,
`cws_listing_page_views`, `cws_impressions`.

**Not** `cws_rating_average` / `cws_rating_count` — those come from the public
listing (`source: cws_public_listing`, `available_today: true`). Attributing
them to the export is what made them look blocked on the founder card; APP-163
corrected it.

### Nothing here is confirmed yet

**No real Chrome Web Store export has ever reached this repository.** Every
header→metric mapping in `scripts/lib/cws-export.mjs` carries
`confirmed: false`, and `cws_weekly_users.field_confirmed` is `false` in
`config/portfolio.yaml`. The fixture at
`scripts/tests/fixtures/cws-export-SYNTHETIC.csv` is hand-written and is
labelled so; its headers are **not** evidence about the real schema.

When the first real export lands, the importer prints the verbatim headers.
That closes APP-54 deliverable 1 — and only that does.

---

## 3. Chrome Web Store GA4 — installs and listing page views

APP-157. The question was deliberately narrow: **is the CWS-managed GA4
property reachable by an external read-only service account?** Answered from
primary sources 2026-09-30.

**No — and the reason is structural, not a configuration gap we can close. A
different credential shape does work, and it is still fully delegable.**

### 3.1 Why the service account is closed

Two sentences of Google's own documentation compose into the answer. Neither is
ambiguous and neither is about us.

Chrome Web Store, on the property it creates on the developer's behalf:

> "You will be granted access to the property with the Marketer role. This
> can't be changed."

Google Analytics, on who may add a user to a property:

> **Administrator** — "Full control of Analytics. Can manage users (add/delete
> users, assign any role or data restriction)."
>
> **Marketer** — "Can create, edit, and delete audiences, events, and key
> events." Includes the Analyst role's permissions (which include Viewer's).

User management is an **Administrator** capability. The developer is
permanently **Marketer**. So there is **nobody on our side of that property who
can grant a service account anything**. The grant is not restricted, it is
unavailable. No amount of Cloud-project or IAM work changes it, because the
missing permission sits on the Analytics property, not on the service account.

This is the one unknown APP-157 was opened to settle, and it resolves against
the optimistic reading. Recorded here rather than left as folklore — which is
the whole complaint against A8.

### 3.2 The two sharing routes CWS does offer, and why both are refused

> "Additional users can only be added by invitation to your publisher."

That routes GA4 access through **Chrome Web Store publisher membership**. A
publisher member can act on store listings. Buying a metrics *read* path by
handing an identity *publish* authority is exactly the trade §6.1 rule 4 exists
to refuse, and exactly the kind of permission grant the CTO role is forbidden to
make. Refused on the security posture — before reaching the separate question of
whether a service account could accept a developer invitation and its terms at
all (it cannot; there is no one to click).

> "Alternatively, you can use Data Studio to create a report based on your
> Google Analytics data. This can be shared with any Google Account."

Looker Studio sharing is a **viewing** grant. The Looker Studio API manages
assets, not report data — there is no supported way to read a report's numbers
back out programmatically. It produces a human-readable page, which is the thing
this issue exists to get away from. Refused, and recorded so it is not
re-proposed as a clever workaround.

### 3.3 What does work: the Data API with OAuth user credentials

The Data API never required a service account. Google's quickstart states you
can authenticate "with a user account or service account", against scope:

```
https://www.googleapis.com/auth/analytics.readonly
```

The authenticated principal needs read access on the property. Marketer
includes Analyst, which includes Viewer — the role renamed from "Read &
Analyze". **The founder's own Google account already satisfies the Data API's
requirement the moment the opt-in completes.** Nothing further has to be granted
inside Analytics.

So the read path is: a one-time OAuth consent by the founder, exchanged for a
refresh token, held as a Paperclip secret, used by the ingest job to call
`runReport` for `eventCount` broken out by `eventName`.

### 3.4 The detail that decides whether the founder actually exits the loop

A refresh token is only a delegation if it outlives the consent. One Google rule
governs this and it is easy to trip:

> "A Google Cloud Platform project with an OAuth consent screen configured for
> an external user type and a publishing status of 'Testing' is issued a refresh
> token expiring in 7 days"

A Testing-status OAuth client would put the founder back in the loop **every
week** — strictly worse than the dashboard export it was meant to replace. So
the OAuth client's consent screen must be **"In production"** (or **Internal**,
if the founder's account is on Workspace; the 7-day rule is scoped to *external*
+ Testing).

`analytics.readonly` is a sensitive scope, so an unverified production app shows
the "unverified app" warning once and is capped at **100 new users over the
project's lifetime**. We need **one**. The cap and the warning are therefore
immaterial here, and full Google verification is not on the critical path.

None of the other documented revocation triggers bite either:

- *unused for six months* — a daily ingest keeps it warm.
- *password change* — applies only to refresh tokens carrying **Gmail** scopes.
  Ours carries `analytics.readonly` and nothing else.
- *user revocation* — a deliberate act, and the correct kill switch to keep.

With the consent screen in production, one founder consent yields an
**indefinitely durable** token. A8's *conclusion* for installs survives: this is
delegable and the founder leaves permanently. A8's implied *mechanism* does not.

### 3.5 Three constraints that must survive into the design

1. **Retention is two months, and we cannot raise it.** CWS states "Data
   retention is set to two months." Changing retention is a property-settings
   action; Marketer is not a settings-administration role and the role "can't be
   changed". This is harder than a default we could bump: GA4 is permanently a
   **current-period** source. It can never satisfy `min_history_weeks: 12` on
   `wau_growth_monthly` / `wau_flat_60d`. Any history is history **our** ingest
   accumulated in durable rows. Do not design as though GA4 backfills.
2. **GA4 `install` is a different instrument from the dashboard's "Installs".**
   One counts store-listing-funnel install events; the other is the store's own
   install accounting. They will not agree. Same for `page_view` versus the
   dashboard's listing-page-views figure. **Two pairs, four columns, never two**
   — `cws_installs`/`ga4_install_events` and
   `cws_listing_page_views`/`ga4_listing_page_views`, all four banned from
   substitution in `forbidden_aliases` and enforced by `assertNotAliased`.
   `store_listing_conversion` stays defined on the **dashboard** family; mixing
   a GA4 numerator with a dashboard denominator is the precise error the alias
   ban exists to stop.
3. **A withheld row is not a zero.** De-identification is on and CWS warns data
   "may be withheld if it doesn't meet system-defined thresholds". At
   single-digit install volumes that will happen. The importer must distinguish
   "GA4 returned no rows" (→ `missing`) from "GA4 returned 0" (→ a real zero).
   Writing 0 for a thresholded day would be a fabricated reading, and the
   freshness contract's "never imported is `missing`, not `0`" rule only
   protects us if the importer does not invent the row.

### 3.6 Credential handling

- The opt-in needs Developer Dashboard access. **No agent has it and none
  should.** Analyst's TOOLS deny list stands (APP-157 names this).
- The OAuth client secret and the resulting refresh token are held as
  **Paperclip secrets**, bound `access.*` to the **ingest job only** — bound to
  **no agent**. Not Analyst, not CTO, not QA. §6.1 rule 4 is absolute.
- No agent reads, echoes, copies or stores either value.
- Rotation: revoke in the founder's Google account, re-consent, replace the
  secret. The CWS opt-in is untouched by rotation.

### 3.7 The importer — built, and the two halves it is split into

APP-215. `--source ga4` is implemented and **no longer refuses**. It splits into
a request half and a response half, and the split is the security property:

```
# 1. the request. No credential involved, so this is deterministic and testable.
node scripts/metrics-import.mjs --source ga4 --emit-request \
     --property <numeric property id> --start <YYYY-MM-DD> --end <YYYY-MM-DD>

# 2. the ingest job POSTs that body with the bearer token it holds, saves the
#    response, and hands the FILE over.

# 3. the response.
node scripts/metrics-import.mjs --source ga4 --item <item> \
     --file <runReport-response.json> [--property <numeric property id>]
```

`scripts/lib/ga4-report.mjs` opens no socket, reads no credential and has no
code path to one — the same structural guarantee `play-report.mjs` has, and the
reason both were written to consume bytes rather than fetch them. §6.1 rule 4
holds here by construction, not by discipline.

Four decisions in it are worth reading before the first real response lands,
because each is a place a careless import would produce a plausible wrong
number.

**A withheld day is `missing`, and this is the rule the file exists for.**
§3.5 constraint 3, made mechanical. GA4 signals a de-identified combination by
**omitting the row** — there is no flag, no null, no marker of any kind. So
absence and zero are distinguishable *only* by row presence, and the parser
records a value only when a row exists. Three cases, held apart by three
fixtures and tests:

| What GA4 returned | What lands | Why |
|---|---|---|
| no row for `install` on the `as_of` day | metric **absent** from `metrics`, and **named** in `notes.withheld_metrics` | freshness reads it `missing` — true |
| `"0"` for `install` | `0` | a returned zero **is** a measurement |
| no `rows` key at all | **nothing** — the import throws and writes no entry | no entry means `missing`, which is also true |

The third is the one that looks like a bug and is not. Refusing to write is
correct: there is no date to attribute the reading to, and an entry full of
zeroes on an assumed date would be a fabrication on two counts.

**`as_of` comes from the response's own `date` dimension**, never from the
requested range — a range end is what we *asked for*, the dimension value is
what GA4 *had*. GA4 returns it as `YYYYMMDD` and it is normalised. Rows GA4
could not date (`(other)`, emitted past a cardinality limit) are reported in
`notes.undated_rows` and contribute no value.

**No aggregation of one quantity.** Values come from the `as_of` day only. One
row per event name is not aggregation — each event is a different quantity —
but two rows for the same `(date, eventName)` pair are **refused rather than
summed**, because if that ever happens the query shape is not what we think it
is and summing would hide it. The fixture's daily installs are 4, 6, 3 so a
test can assert the emitted value is `3` and not the sum `13`.

**GA4 is never the dashboard family.** `assertNotDashboardFamily` throws if
this parser is ever made to emit `cws_installs`, `cws_listing_page_views` or
`cws_weekly_users`. That is the `forbidden_aliases` ban (§3.5 constraint 2)
enforced at the point of *emission* as well as downstream, so remapping
`install` onto `cws_installs` to make `store_listing_conversion` "work" fails
the import instead of silently corrupting EXP-0001's primary metric. There is a
test that performs that edit and asserts the throw.

Two smaller guards worth naming. The request builder **refuses a window older
than 60 days**, because GA4 answers an out-of-retention request with an empty
row set that is indistinguishable from total thresholding — better to fail on
the request than to debug that from the response. And it **refuses a
non-numeric property id**, because the CWS-created property is *named* with the
extension id while the Data API takes the numeric id; that is the most likely
first-attempt mistake and it would otherwise surface as a confusing 404.

`notes.property_time_zone` is carried through verbatim. GA4 dates are in the
property's reporting timezone, which the store set and Marketer cannot change,
while `lag_days` is UTC calendar arithmetic — so a property ahead of UTC can
legitimately produce an `as_of` that looks like tomorrow. Recorded so that is
diagnosable rather than mysterious.

Every mapping carries `confirmed: false`, and `notes.backfillable` is `false`
on every entry. The fixtures are `*-SYNTHETIC.json` and were run against a
scratch data root: **nothing synthetic entered `data/metrics/manifest.jsonl`.**

### 3.7a Status — what is done and what is not

**Code: done.** `--source ga4` imports; 24 tests in
`scripts/tests/ga4-report.test.mjs` plus 5 end-to-end in
`metrics-import.test.mjs`.

**Provisioning: not done, and no agent can do it.**

- the Store-listing **"Opt in to Google Analytics"** has not been clicked, so
  the GA4 property does not exist yet and has no numeric property id;
- no OAuth client exists, no consent has been given, no secret is bound.

Both need founder Developer Dashboard / Google account access.

`ga4_install_events` and `ga4_listing_page_views` therefore **stay
`available_today: false`** in `config/portfolio.yaml`. This is deliberate and
it is the one acceptance criterion on APP-215 that is not met: the flag means
"readable today with nothing further provisioned", and until the opt-in is
clicked and the token bound, setting it `true` would assert something false to
every rule that reads it. It flips when — and only when — a real `runReport`
against the real property returns rows. Flipping it is a one-line change gated
on that evidence, not on this importer existing.

Marking `install` as a key event is a Marketer capability and is presumably why
CWS grants that role — but it is **not required** for this read path. Querying
`eventCount` by `eventName` needs no conversion configuration, so the founder's
only dashboard action is the opt-in itself.

### 3.7b What the first real response has to settle

Written down before the bytes arrive, so it cannot be graded on a curve
afterwards. Any difference gets reported on APP-215 and APP-42, because each one
falsifies something inferred without access:

| Question | Second-hand expectation | How the response answers it |
|---|---|---|
| Install event name | `install` | appears in `notes.unmapped_events` if wrong |
| Page-view event name | `page_view` | same |
| Property timezone | unknown | `notes.property_time_zone`, from `metadata.timeZone` |
| Does thresholding omit rows or return 0? | **omits** — the whole design rests on this | a day of single-digit installs returning `0` rather than no row would falsify §3.5 constraint 3 |
| Retention really two months? | 60 days | a request at day 59 succeeding and day 61 returning nothing |
| Does `install` fire without being a key event? | yes | rows present at all |

Row four is the one to read twice. If CWS thresholding turns out to return a
zero rather than omit the row, then **zeros from this source are untrustworthy**
and the importer needs a different rule — that finding is more valuable than
the convenience, and it is the reason the `withheld` and `zero` cases are
separate fixtures rather than one.

### 3.8 Confidence, stated honestly

- **Service account closed: HIGH.** Two verbatim documentation statements that
  compose deterministically. No live test could make Marketer able to manage
  users.
- **OAuth user-credential path succeeds end to end: still MEDIUM-HIGH,
  unchanged.** APP-215 built the importer but **could not run the live call**:
  the property still does not exist, so `runReport` has never been executed
  against a CWS-managed one. Nothing was learned that could move this number,
  and it is left where APP-157 put it rather than nudged up because more code
  now exists. Code is not evidence about someone else's API.
- **Parser behaviour against the documented response shape: HIGH.** That is a
  different and smaller claim than the one above, and it is the only thing the
  24 tests establish. They prove the importer does the right thing with the
  shape Google documents; they cannot prove the shape.
- **First live attempt still settles the remainder**, and it is still one call —
  now a copy-paste, via `--source ga4 --emit-request` (§3.7). Whoever runs it
  records the answer on APP-215 either way, **including a failure**. That is the
  lesson A8 cost us, and it is still outstanding.

---

## 4. Google Play — read-only service account

Play is **fully delegable**: the founder does this once and then permanently
exits the loop. Two Google surfaces are involved.

### 4.1 The reports bucket (installs, uninstalls, 30-day active devices)

Play publishes CSV statistics reports into a Cloud Storage bucket named
`pubsite_prod_rev_<developer_id>`, readable by a service account.

**Setup — founder, once:**

1. In a Google Cloud project, create a service account
   (e.g. `appforge-metrics-ro@<project>.iam.gserviceaccount.com`). Create a
   JSON key. **Do not download it to a shared or synced location.**
2. In **Play Console → Users and permissions**, invite that service-account
   email and grant **exactly one** account-level permission:
   **"View app information and download bulk reports (read-only)."**
3. Grant **nothing else.** Specifically **not** "Release apps to testing
   tracks", **not** "Manage production releases", **not** "Manage store
   presence", **not** "Manage orders and subscriptions". A read-only metrics
   path has no business holding release authority, and `release-platform`'s
   security invariant is not this issue's to touch.
4. Grant the same service account `roles/storage.objectViewer` on the reports
   bucket.

**Secret handling — this is the part that matters:**

- The JSON key is held as a **Paperclip secret**, bound `access.*` to the
  **ingest job only**.
- It is bound to **no agent**. Not to Analyst — Analyst's TOOLS deny list
  stands, and APP-42 names this constraint explicitly. Not to CTO. Not to QA.
- No agent reads, echoes, copies or stores it. §6.1 rule 4 is absolute here.
- Rotation: re-key in Cloud Console, replace the Paperclip secret. The Play
  Console grant does not need re-issuing.

Covers `invtrack` and `teleport`.

### 4.2 Play Developer Reporting API (crash rate, ANR rate)

Same service account, plus the `playdeveloperreporting.googleapis.com` API
enabled on the project. Feeds `play_crash_rate` and `play_anr_rate`.

### 4.3 The asymmetry that must not be smoothed over

**Play has no weekly-distinct active figure at all.** Daily active devices
cannot be summed into a weekly distinct count, and
`play_active_devices_30d` is a **third quantity** — distinct from both
`cws_weekly_users` and `true_wau`. Three quantities, three names, no aliasing
between any pair. DEC-0009 D5 rejected the substitution by name, and
`forbidden_aliases` in `config/portfolio.yaml` enforces it mechanically
(`assertNotAliased`).

Analyst's read of Play's report schema is second-hand — Analyst has no store
access, by design. **Confirm against the first real export and report back if
the schema differs.**

### 4.4 The importer — built, and what it deliberately does not do

APP-210. `scripts/lib/play-report.mjs` parses a Play statistics report;
`--source play` is implemented and no longer refuses. It consumes a **file**
the ingest job downloaded from the bucket: the script opens no socket, reads no
credential, and has no code path to one. §6.1 rule 4 holds structurally here
rather than by discipline.

Three decisions in it are worth reading before the first real report lands,
because each one is a place a careless import would produce a plausible wrong
number.

**Encoding is observed, not assumed.** Play's reports are widely *said* to be
UTF-16 with a byte-order mark, and a mangled header row is the usual first
symptom of getting that wrong. `decodeReport` branches on the actual BOM bytes
and records which branch it took in `notes.encoding_detected`. A big-endian BOM
is **refused** rather than read little-endian, because that failure mode is
silent — every character transposed, no error.

**The device/user split is resolved once, on purpose.** Play reports most
quantities twice: once counting devices, once counting Google accounts. They
are different numbers. We take the **device** family throughout, for one
non-aesthetic reason: `play_active_devices_30d` exists *only* in the device
family, so a user-family numerator over a device-family denominator would be
exactly the category error `forbidden_aliases` exists to stop. The user-family
columns are reported as `unmapped_headers`, never silently dropped, and
`FAMILY_CHOICE` states the reason in the module.

**Every mapping is `confirmed: false`.** Same posture as CWS, same reason:
Analyst's read of Play's schema is second-hand, Analyst has **no store access
by design**, and no real Play report has ever reached this repository. The
fixtures are named `*-SYNTHETIC.csv` and their package id is suffixed
`.SYNTHETIC` so it cannot be mistaken for InvTrack's real application id —
which, note, this repo does not know: `config/portfolio.yaml` holds no package
names. The parser records `package_names_verbatim`, so the first real report
answers that too.

### 4.5 No weekly figure was synthesized — the written confirmation

APP-210 asks for this in writing. Stating it plainly:

> **No weekly-distinct figure has been derived from Play daily active devices,
> and none can be.** Play's reports carry daily and cumulative columns only.
> Summing seven daily active-device values counts a device once per day it was
> active, so the total has no referent — it is not an approximation of a weekly
> distinct count, it is a different and meaningless quantity. Nothing in the
> ingest computes one, and DEC-0009 D5 rejected the substitution by name.

It is not left to good intentions. Four mechanisms, in increasing order of how
hard they are to defeat:

1. **No cross-row aggregation anywhere.** Values are read from the single row
   whose date equals `as_of`. No sum, mean, rolling window, or fill-forward
   exists in the module. The fixture's daily installs are 4, 6, 3 precisely so
   a test can assert the emitted value is `3` and **not** `13`.
2. **`assertNoWeeklySynthesis`** runs on the way out of every parse and throws
   on any metric name matching `/weekly|wau/i`, plus `cws_weekly_users` and
   `true_wau` by name. Adding a weekly row to `HEADER_MAP` therefore makes the
   import **fail**; it cannot quietly start emitting one. There is a test that
   does exactly that edit and asserts the throw.
3. **The manifest says so.** Each Play entry carries
   `notes.synthesized_metrics: []`, `notes.aggregation: "none — single row,
   as_of"`, and `notes.weekly_distinct` with reason code
   `play_wau_unavailable`. A reader asking "was anything here computed rather
   than read?" answers it from the record, not from this document.
4. **`forbidden_aliases`** still refuses the substitution downstream even if
   something bypassed all of the above, via `assertNotAliased`.

`play_active_devices_30d` also carries a **semantic caveat** into the manifest,
and it is the first thing to check against real bytes: Play's figure counts
**devices that were active with the app installed** — device activity, not app
usage. A device that has never opened the app still counts. So it is not
`true_wau` (use) and not `cws_weekly_users` (a weekly install reading on a
different store). Three quantities, three names. **The 30-day window in the
metric's own name is second-hand and unconfirmed** — the real report has to
prove it, and if it turns out to be a different window the metric is misnamed
and must be renamed, not reinterpreted.

### 4.6 What the first real report has to settle

The schema check APP-210 asks for, written down before the bytes arrive so it
cannot be graded on a curve afterwards. Run:

```
node scripts/metrics-import.mjs --source play --item invtrack \
    --file <installs_overview.csv> --package <application id>
```

and compare the printed provenance block against this list. **Any difference
gets reported back on APP-42**, because each one falsifies something Analyst
inferred without access:

| Question | Second-hand expectation | How the report answers it |
|---|---|---|
| Encoding | UTF-16LE with BOM | `encoding_detected` |
| Install column | `Daily Device Installs` | appears in `unmapped_headers` if wrong |
| Uninstall column | `Daily Device Uninstalls` | same |
| 30-day active column | `Active Device Installs` | same |
| Its actual window | 30 days | **not in the CSV** — needs Play's own column documentation; if it is not 30, `play_active_devices_30d` is misnamed |
| Rating column | `Total Average Rating` (lifetime) | ratings report, separate file |
| Date column | `Date`, `YYYY-MM-DD` | refuses outright if absent |
| Package id | unknown to this repo | `package_names_verbatim` |
| A weekly-distinct column | **none exists** | if one *does* appear, that is news and changes §4.3 — report it, do not map it silently |

The last row is the one to read twice. The whole asymmetry argument rests on
Play publishing no weekly-distinct figure. If a real report contradicts that,
the finding is more valuable than the convenience.

### 4.7 Status

- **Importer: built and tested** (`scripts/lib/play-report.mjs`, 15 tests in
  `scripts/tests/play-report.test.mjs` plus 4 end-to-end in
  `metrics-import.test.mjs`). `--source play` lands a manifest entry with a
  derived `lag_days`.
- **Service account: not created. Secret: not bound.** Both need founder Play
  Console access — §4.1 steps 1–4. This is the only thing left, and no agent
  can do it.
- **No real report has landed**, so every mapping is still `confirmed: false`
  and nothing has been imported into `data/metrics/manifest.jsonl` from this
  source. The synthetic fixtures were run against a scratch data root on
  purpose; putting a synthetic reading in the real manifest would be the exact
  error the `*-SYNTHETIC` naming exists to prevent.
- `teleport` is **internal-track only** (`store_item_status: internal_track`),
  so its bulk reports may be empty or absent even after the grant. An absent
  report must read `missing`, never `0` — §7.

---

## 5. Gumroad

Already solved; no change. `GUMROAD_ACCESS_TOKEN` stays a Worker secret.
`echokit` revenue reaches the P&L through the ingest job.

---

## 6. Lag is measured, never assumed

Every import records:

- `as_of` — the date **the export itself carries**, read out of the export's
  own date column. `as_of_source` records which column, for audit. An export
  with no date column is **refused**, not dated by assumption.
- `exported_at` — when the export was pulled.
- `lag_days` — **derived** from those two, by calendar-day arithmetic.

A supplied `lag_days` is ignored in favour of the derived value, and there is a
test that proves it. No dashboard-refresh delay is configured anywhere.
Hardcoded lag numbers become folklore and are wrong by a day forever.

Calendar days, not elapsed hours: data through the 27th pulled at 00:05 on the
28th is **one** day of lag, and elapsed-hours division would call it zero.

---

## 7. Staleness is loud

> "A skipped export must surface as a red flag, never as last week's number
> presented as current. If it silently serves stale data, the whole §22.1
> control is worse than nothing."

The rules, all enforced in `scripts/lib/metrics-freshness.mjs`:

- Age is measured from **`as_of`**, never from `exported_at` or `recorded_at`.
  Re-importing a three-week-old export today does **not** make the metric look
  fresh.
- `newestFor` picks by `as_of`, not by insertion order, so backfilling an old
  export cannot become the newest reading.
- Past `max_age_days`, the metric is **`stale`** and **`value` is `null`**. The
  number is moved to `withheld_value`, where it reads as withheld rather than
  as the current figure. There is no code path that returns a value without
  also returning its freshness status.
- A metric with **no declared `max_age_days`** is `no_contract`, not `fresh`.
  Serving it would be an assumption.
- A metric never imported is **`missing`**, not `0`.
- A **derived** metric inherits the **worst** freshness of its `inputs`. A
  ratio computed from a three-week-old numerator is three weeks old however
  recent the denominator is.
- Any non-fresh input makes every rule requiring it **`undecidable`**, and the
  product verdict is **`insufficient_data` naming the stale inputs**.
- `scripts/metrics-status.mjs` **exits 1** when anything is stale or missing. A
  skipped export fails the command; it is not a warning buried in output.

### Demonstration

```
$ node scripts/metrics-import.mjs --source cws --item json-workbench \
    --file scripts/tests/fixtures/cws-export-SYNTHETIC.csv \
    --data-root "$D" --exported-at 2026-09-28T10:00:00Z
  as_of       2026-09-27   (from column "Date")
  lag_days    1   (derived, not configured)

$ node scripts/metrics-status.mjs --item json-workbench --data-root "$D" \
    --now 2026-09-29T00:00:00Z
  OK    cws_installs               = 12  age 2d / max 14d

# Nothing re-imported. Only the clock moved.
$ node scripts/metrics-status.mjs --item json-workbench --data-root "$D" \
    --now 2026-10-20T00:00:00Z
  STALE  cws_installs               (no value served)  age 23d / max 14d
         newest import for `cws_installs` is as_of 2026-09-27, 23d old,
         past its max_age_days of 14 — value withheld

  insufficient_data: cws_impressions, cws_installs, cws_listing_page_views, ...
  Every rule requiring these inputs is undecidable. No stale value was served.
$ echo $?
1
```

### What has actually landed

One real import is in `data/metrics/manifest.jsonl`: `cws_public_listing` /
`json-workbench`, `as_of` 2026-09-29, checksum
`04c8d1ff…36422e5`, giving `cws_rating_average = 5` and `cws_rating_count = 1`.

It arrived as an **attested extract**, not as page bytes. This runtime has no
automation channel to a browser (QA established that on APP-54: no Playwright,
npm egress 403, no browser tool, Brave running without a debugging port), so
the agent that can fetch a listing is not the agent that can parse one. The
extract therefore carries the **upstream** sha256 — the hash of the bytes QA
actually received — together with who captured it and where the raw artifact
lives, and sets `raw_artifact_present: false` so the manifest never implies
this repo can reproduce those bytes. Reconstructing a page locally and hashing
that would have put a checksum in the manifest attesting to a file nobody ever
fetched.

Staleness is demonstrated against that real import, not only against a
fixture:

```
$ node scripts/metrics-status.mjs --now 2026-10-30T00:00:00Z
  STALE  cws_rating_average  (no value served)  age 31d / max 30d
         newest import ... is as_of 2026-09-29, 31d old, past its
         max_age_days of 30 — value withheld
  insufficient_data: ..., cws_rating_average, cws_rating_count, ...
$ echo $?
1
```

Nothing was re-imported; only the clock moved, and the value stopped being
served.

---

---

## 8. Two definitions not to get wrong

**CWS "weekly users" is not §18b's WAU.** §18b defines WAU as distinct
`install_id` with ≥1 telemetry event in 7 days — a measure of **use**. Google's
own documentation is blunt about the store figure: *"The Users stats only
captures installations; it doesn't monitor whether users are active or not."*
Activity is not measured loosely — it is **not measured at all**. Separate
columns; `assertNotAliased` refuses the substitution.

The figure is installation-based and weekly-bucketed — neither weekly-active
nor cumulative-ever-installs (confidence medium-high; the verbatim header
closes it).

**Do not feed the public listing's "users" figure into `cws_weekly_users`.**
Different surface, different reading — 3 vs 5 on consecutive days for
json-workbench.

### The 5→3 gap carries no signal

APP-58 ruling, reaffirmed by Analyst's own retraction on 2026-09-29: the 5→3
drop was cited as evidence that the figure is weekly-active ("a cumulative
counter cannot decrease"). That inference is **circular** — nobody recorded
which dashboard page the `5` came from — and Google's wording contradicts it
outright, since a point-in-time installed count falls through uninstalls
without measuring activity at all. It may not be reinstated anywhere.
`scripts/lib/cws-export.mjs` derives nothing from the magnitude or direction of
any value, and there is a test that a falling series parses identically to a
rising one.

---

## 9. Files

| Path | Role |
|---|---|
| `scripts/lib/metrics-manifest.mjs` | manifest records, checksums, derived `lag_days` |
| `scripts/lib/metrics-freshness.mjs` | the freshness contract; alias bans; derived-metric resolution |
| `scripts/lib/cws-export.mjs` | CWS CSV parser; verbatim header capture |
| `scripts/lib/cws-listing.mjs` | public-listing reader (rating fields, APP-163); attested-extract path |
| `scripts/metrics-import.mjs` | import CLI |
| `scripts/metrics-status.mjs` | `appforge metrics` reader; exits 1 on stale |
| `scripts/tests/fixtures/` | **synthetic** fixtures — not real exports |

Run the tests: `cd scripts && npm test`
