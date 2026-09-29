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
| GA4 opt-in (Store listing tab) | **Partially open.** Emits `page_view` and a custom `install` event into a store-managed GA4 property, readable through the service-account-capable Data API. Tracked as **APP-157**. |
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

Two constraints on the GA4 path that must not be lost (APP-157):

1. **GA4 retention is 2 months** with de-identification on. That can never
   satisfy `min_history_weeks: 12` on `wau_growth_monthly` / `wau_flat_60d`.
   GA4 is a *current-period* source; our ingest must accumulate its own history.
2. **GA4 `install` is a different instrument** from the dashboard's "Installs."
   Two columns, never one.

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

## 3. Google Play — read-only service account

Play is **fully delegable**: the founder does this once and then permanently
exits the loop. Two Google surfaces are involved.

### 3.1 The reports bucket (installs, uninstalls, 30-day active devices)

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

### 3.2 Play Developer Reporting API (crash rate, ANR rate)

Same service account, plus the `playdeveloperreporting.googleapis.com` API
enabled on the project. Feeds `play_crash_rate` and `play_anr_rate`.

### 3.3 The asymmetry that must not be smoothed over

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

### 3.4 Status

The path is documented. **The service account has not been created and no
secret has been bound** — both need founder Play Console access.
`scripts/metrics-import.mjs` therefore refuses `--source play` with a loud
error rather than writing a half-formed manifest entry.

---

## 4. Gumroad

Already solved; no change. `GUMROAD_ACCESS_TOKEN` stays a Worker secret.
`echokit` revenue reaches the P&L through the ingest job.

---

## 5. Lag is measured, never assumed

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

## 6. Staleness is loud

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

---

## 7. Two definitions not to get wrong

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

## 8. Files

| Path | Role |
|---|---|
| `scripts/lib/metrics-manifest.mjs` | manifest records, checksums, derived `lag_days` |
| `scripts/lib/metrics-freshness.mjs` | the freshness contract; alias bans; derived-metric resolution |
| `scripts/lib/cws-export.mjs` | CWS CSV parser; verbatim header capture |
| `scripts/metrics-import.mjs` | import CLI |
| `scripts/metrics-status.mjs` | `appforge metrics` reader; exits 1 on stale |
| `scripts/tests/fixtures/` | **synthetic** fixtures — not real exports |

Run the tests: `cd scripts && npm test`
