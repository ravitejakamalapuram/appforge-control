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

### 3.7 Status — what is done and what is not

The read path is **documented and decided**. It is **not provisioned**:

- the Store-listing **"Opt in to Google Analytics"** has not been clicked, so
  the GA4 property does not exist yet and has no numeric property id;
- no OAuth client exists, no consent has been given, no secret is bound.

Both need founder Developer Dashboard / Google account access.
`scripts/metrics-import.mjs` therefore refuses `--source ga4` by name, with the
reason, rather than writing a half-formed manifest entry. `ga4_install_events`
and `ga4_listing_page_views` are declared in `config/portfolio.yaml` with
`available_today: false` so the ban is in force before the first row arrives.

Marking `install` as a key event is a Marketer capability and is presumably why
CWS grants that role — but it is **not required** for this read path. Querying
`eventCount` by `eventName` needs no conversion configuration, so the founder's
only dashboard action is the opt-in itself.

### 3.8 Confidence, stated honestly

- **Service account closed: HIGH.** Two verbatim documentation statements that
  compose deterministically. No live test could make Marketer able to manage
  users.
- **OAuth user-credential path succeeds end to end: MEDIUM-HIGH.** Each link is
  documented, but no property exists yet, so `runReport` has never been run
  against a CWS-managed one. A store-managed property could in principle carry a
  restriction not in the docs.
- **First live attempt settles the remainder**, and it is one call. Whoever runs
  it records the answer here either way — including a failure. That is the
  lesson A8 cost us.

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

### 4.4 Status

The path is documented. **The service account has not been created and no
secret has been bound** — both need founder Play Console access.
`scripts/metrics-import.mjs` therefore refuses `--source play` with a loud
error rather than writing a half-formed manifest entry.

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
