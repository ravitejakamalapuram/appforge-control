# Fixtures

`cws-export-SYNTHETIC.csv` is **NOT a real Chrome Web Store export.** No real
export has ever reached this repository. It is a hand-written file with the
column names we *expect*, used to exercise the parser and to demonstrate the
staleness contract.

Do not cite its headers as the answer to the weekly-vs-cumulative question
(APP-54 deliverable 1). Only a genuine dashboard export closes that, and
`HEADER_MAP` in `scripts/lib/cws-export.mjs` carries `confirmed: false` on
every row until one lands.

## `ga4-runreport-*-SYNTHETIC.json`

**Not real GA4 responses.** No Chrome Web Store GA4 property exists yet — the
Store-listing opt-in has not been clicked (APP-215) — so no `runReport` has
ever been run against one and nothing here is evidence about the real shape.
Every mapping in `EVENT_MAP` (`scripts/lib/ga4-report.mjs`) carries
`confirmed: false` until a real response lands.

Four files, because the interesting cases are the empty ones:

| File | What it exercises |
|---|---|
| `ga4-runreport-SYNTHETIC.json` | the ordinary case; daily installs 4, 6, 3 so a test can assert the `as_of` row is 3 and not the sum 13 |
| `ga4-runreport-withheld-SYNTHETIC.json` | the `as_of` day has a `page_view` row but **no** `install` row — de-identification. The metric must land `missing`, **never 0** |
| `ga4-runreport-zero-SYNTHETIC.json` | GA4 explicitly returned `"0"` — that **is** a reading and must land as `0` |
| `ga4-runreport-empty-SYNTHETIC.json` | no `rows` key at all. Nothing may be written: no manifest entry means `missing`, which is true |

The timezone in `metadata` is `America/Los_Angeles` because that is a plausible
store default, **not** because we know what the real property will report.

`play-installs-SYNTHETIC.csv` and `play-installs-utf16le-SYNTHETIC.csv` are
**NOT real Google Play statistics reports.** No real Play report has reached
this repository either. Their column names are Analyst's second-hand reading
of Play's documentation — and Analyst has no store access by design, so that
reading has never been checked against real bytes. Every row of `HEADER_MAP`
in `scripts/lib/play-report.mjs` carries `confirmed: false` until one lands
(APP-210).

The `utf16le` variant is the same content with a UTF-16LE byte-order mark. It
exists to exercise `decodeReport`, not to assert that Play's encoding *is*
UTF-16 — the parser detects that from the bytes and records which branch it
took.

The package name in both is suffixed `.SYNTHETIC` so it cannot be mistaken for
the real InvTrack application id, which this repo does not yet know.

## `play-vitals-SYNTHETIC.json`

**Not a real Play Developer Reporting API pull.** It has the shape that
`scripts/play-vitals.mjs` writes. Its rates are made up. The ANR series ends
on the same day as the crash series but starts one day later, and one ANR
value is an explicit `0`. So a test can check two things: `as_of` is the
newest day both rates carry, and a real zero is recorded as `0`. APP-283.

## `pr-queue-SYNTHETIC.json`

**Hand-written, not a recorded API response.** Field names match the real
GitHub REST payloads (`/pulls`, `/pulls/{n}`, `/pulls/{n}/files`,
`/commits/{sha}/check-runs`) as read on 2026-10-01 for APP-323; every value is
invented. One entry per queue state (ready, needs-rebase, red-ci, waiting,
draft) plus `stacked`, whose base branch is the `ready` PR's head branch.
