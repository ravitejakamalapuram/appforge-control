# facts-used.md: <product> <artefact> (<issue id>)

Fetched at / sha: `<repo>` fetched `<UTC time>`, origin/main = `<sha>` (and `appforge-brain` fetched `<UTC time>`, `<sha>` if product-facts.yaml was used). A failed `git fetch origin` stops the work (SKILL.md §1); never fill this from a cached ref.
Sources pinned at: `<repo>@<commit sha>` (and `appforge-brain@<sha>` if product-facts.yaml was used). Must equal the fetched sha above.
product-facts.yaml exists for this product: yes / no (if no, README/policy citations below are the trace).

| # | On-screen / copy text (verbatim) | Source (`file:line` or `[fact:key]`) | Exact source wording |
|---|---|---|---|
| 1 | "<text>" | `README.md:12` | "<quote>" |
| 2 | "<text>" | `[fact:offline_sync]` | "<quote>" |

## Screens used
| Scene | Image | Origin | Demo data only? | Brands/negatives removed? |
|---|---|---|---|---|
| 1 | `store_04_investments_list.png` | `integration_test/flows/store_screenshots_test.dart` @ `<sha>` | yes | yes |

## Deliberately not claimed
- <e.g. "data stays on device": app syncs via Firebase, so not supported>
- <e.g. price / free, ratings, downloads>

## Reviewer check
- [ ] every row's quote matches the source at the pinned commit
- [ ] no number that is not UI inside a demo screenshot
- [ ] no privacy wording wider than the privacy policy
