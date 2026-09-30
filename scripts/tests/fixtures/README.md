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
