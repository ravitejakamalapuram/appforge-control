# Session Transfer - Chrome Web Store baseline (attested, read 2026-10-01)

Item: fnfmlchbfofjdfeibgdkcibfjjlfcefc (published build 1.2.0.0; v1.2.2 pending review).
Source: Chrome Web Store developer dashboard, Analytics pages (Users, Installs and uninstalls,
Impressions), read in the founder's signed-in Brave session on 2026-10-01 by an agent.
Date range shown: "Last 30 days" = 31 Aug 2026 to 28 Sep 2026. The dashboard warned
"data is currently delayed and may not be up to date".

| Figure (30-day window) | Value |
|---|---|
| Average weekly users (dashboard headline) | 3 |
| Weekly users, last daily points (24-28 Sep) | 1, 2, 4, 4, 5 (0 on every day before 24 Sep) |
| Installs | 17 |
| Uninstalls | 2 |
| Listing page views (the "Impressions" page shows only page views; no separate impressions count) | 7 (sources: chatgpt.com 75%, ext_sidebar 25%) |

Weekly-users export (CSV, only headers "Date,Weekly users", plus a title line) was downloaded
but does NOT match the importer's expected cws columns (Installs, Uninstalls, Impressions), so
the importer was not run and nothing was loaded into the manifest.

IMPORTANT: cws_weekly_users is NOT the same quantity as true_wau. It is "the approximate number
of Chrome browsers that loaded the item in the past seven days" (enabled, disabled and unknown),
a store-side count of browsers, not a count of people actively using the product. Do not
compare or substitute one for the other.

Note: some installs may be the team's own testing; not verified.

Lead (UNVERIFIED, do not record as a fact): weekly users were 0 on every day before 24 Sep 2026, so the item probably went public on or shortly before 2026-09-24. Confirm from the dashboard before filling `first_published` in Session Transfer's product.yaml, which would start the day-30/60/90 clock (docs/metrics-ingest.md).
