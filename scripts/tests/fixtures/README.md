# Fixtures

`cws-export-SYNTHETIC.csv` is **NOT a real Chrome Web Store export.** No real
export has ever reached this repository. It is a hand-written file with the
column names we *expect*, used to exercise the parser and to demonstrate the
staleness contract.

Do not cite its headers as the answer to the weekly-vs-cumulative question
(APP-54 deliverable 1). Only a genuine dashboard export closes that, and
`HEADER_MAP` in `scripts/lib/cws-export.mjs` carries `confirmed: false` on
every row until one lands.

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
