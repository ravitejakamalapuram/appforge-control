# Store listing assets: how they reach the stores (APP-287)

Agents hold no store credentials (§6.1 rule 4) and must not drive the Play Console or the
Chrome Web Store dashboard. In APP-285 the board's assistant replaced InvTrack's Play
screenshots by hand in a browser session. This page describes the credential-clean path.

## What already exists (release-platform, merged in #4, #7, #8, #9)

- `release.yaml` target key `listing:`. For Android it points at a fastlane-style directory
  (`<locale>/title.txt`, `short_description.txt`, `full_description.txt`,
  `images/{phoneScreenshots,sevenInchScreenshots,tenInchScreenshots,featureGraphic,icon}/`).
  For Chrome it points at `chrome-store/store.config.json`.
- PR checks (`app-ci.yml` -> `scripts/listing.mjs check`) enforce Play/CWS rules: text
  lengths, 2-8 phone screenshots, sides 320-3840 px, long side <= 2x short side, no alpha.
- `listing.yml` (reusable, called via `templates/listing-caller.yml`, `workflow_dispatch`):
  - **Play:** `scripts/play.mjs syncListing` opens one edit, updates text only if it differs,
    and replaces an image type only when the ordered SHA-256 list differs
    (`edits.images.deleteall` + `edits.images.upload`), then commits. Auth is keyless:
    GitHub OIDC -> Workload Identity Federation -> `release-bot@rk-release-platform`. No key
    exists anywhere. Only the Play job gets `id-token`; it runs platform scripts on a bundle
    built by a job with no store access.
  - **CWS:** the API cannot edit listings, so it opens a `store-listing` issue with the files
    and dashboard steps for a person.
  - `dry_run: true` reports the diff without writing. It shares the release lock with
    `release.yml`.

## Who does what

| Step | Owner | Credential used |
|---|---|---|
| Generate images (`skills/store-screenshots/SKILL.md`) and copy (claims rule, `skills/marketing-video/SKILL.md`) | Builder (images), Growth (copy) | none |
| PR to the product repo adding/updating the listing dir (+ `listing:` key and caller workflow the first time) | Builder | `appforge-agents` App (contents/PR only) |
| Review + merge | CTO review, board merge (Level 2) | founder |
| Dispatch `listing` with `dry_run: true`, read the diff, then dispatch for real | founder (agents have no `actions:write`) | GitHub OIDC -> release-bot |

Dispatch is the gate: the `appforge-agents` App has no `actions:write`, so no agent can push
a listing. This is the same gate as a production release.

## Per-product status

| Product | `listing:` key | listing in repo | caller workflow |
|---|---|---|---|
| InvTrack (`com.invtracker.inv_tracker`) | InvTrack#728 (draft) | text reseeded from live + 5 phone screenshots | maintainer adds (see below) |
| Session Transfer (CWS) | session-transfer#13 (draft) | `chrome-store/store.config.json` seeded from live | maintainer adds (see below) |
| TeluguPanchangam (CWS) | yes | yes | no `listing.yml` yet |

## Pitfalls found during adoption (APP-287)

- **Seed from live, not from the repo.** InvTrack's `full_description.txt` had drifted from
  what was live, and so had Session Transfer's `app-metadata.json`. A first sync from a stale
  repo copy silently rewrites live text. Read the public store page first and diff it.
- **The `workflows` permission.** The `appforge-agents` App cannot create or change files under
  `.github/workflows/`, so the push is rejected. An agent's adoption PR carries everything
  except `listing.yml`. A maintainer copies `release-platform/templates/listing-caller.yml`
  verbatim. This is a deliberate gate, not a bug to work around.
- **Alpha channels.** Emulator captures are RGBA. The check rejects them. Convert with
  `ffmpeg -i in.png -pix_fmt rgb24 out.png` after you confirm the alpha is fully opaque.
- **Generated manifests.** The CWS `name` check is skipped when `manifest.config.*` (@crxjs)
  generates the manifest. Compare `name` with that file by hand.

## Open design item

Auto-triggering `listing` when files under a listing folder change on `main` is proposed on
APP-287 for review. It is not built.
