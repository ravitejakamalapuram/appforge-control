# Fixtures

`cws-export-SYNTHETIC.csv` is **NOT a real Chrome Web Store export.** No real
export has ever reached this repository. It is a hand-written file with the
column names we *expect*, used to exercise the parser and to demonstrate the
staleness contract.

Do not cite its headers as the answer to the weekly-vs-cumulative question
(APP-54 deliverable 1). Only a genuine dashboard export closes that, and
`HEADER_MAP` in `scripts/lib/cws-export.mjs` carries `confirmed: false` on
every row until one lands.
