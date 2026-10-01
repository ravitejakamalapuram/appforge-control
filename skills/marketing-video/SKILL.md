---
name: marketing-video
description: Make a short (15-25s) product launch/marketing video, or any marketing artefact with on-screen claims (store captions, share copy), for an AppForge product using only ffmpeg + node/python already on this Mac. Use when an issue asks for a "marketing video", "launch video", "promo", "reel/short", or store/share captions. Every claim must be traced in facts-used.md.
---

# marketing-video

Adapted from `brag-slim` in [latent-spaces/brag](https://github.com/latent-spaces/brag)
(MIT, (c) 2026 Shunit Haviv Hakimi), commit `d06a77f`. The story shape, creative laws and
render checks below are theirs; the asset sources, the claims rule and the host constraints are
ours. Do **not** install the brag plugin: full `brag` needs `npx hyperframes`, and the npm
registry is blocked on this Mac (see TOOLS.md "Host constraints"). brag-slim needs nothing
beyond what is already here.

Origin: APP-285 / APP-287. The first InvTrack video was made outside Paperclip because no agent
had this procedure. This file is that procedure.

## 0. Before you start

- **Claim it.** Comment on the issue `CLAIM: <agent> producing <artefact> into <path>` before
  any work, and read the thread first: if someone else (another agent, or the board's assistant)
  already posted a claim or an artefact, stop and say so instead of producing a second copy.
- **Tools present:** `ffmpeg`/`ffprobe` (`/opt/homebrew/bin`), `node` (no npm installs),
  `python3` (stdlib only). Check with `command -v ffmpeg ffprobe node python3`. If one is
  missing, set the issue `blocked` and name it. Do not install anything.
- **Work dir:** `$PAPERCLIP_RUN_SCRATCH_DIR/video/` (deleted when the run ends), with `work/`
  for intermediates. Never commit renders or binaries to a repo. Deliver by attaching the
  files to the issue (see section 5) before the run ends.
- **Nothing is published.** Output is a draft for review. Posting anywhere (store, social,
  YouTube) needs board approval (Growth AGENTS.md, Forbidden).

## 1. Material: where it may come from

| Material | Source (in this order) |
|---|---|
| Facts / claims | `appforge-brain/products/<slug>/product-facts.yaml` at `origin/main`; else the product repo's `README.md`, store-listing text (`fastlane/metadata/...`, `CHROMEWEBSTORE.md`, `store.config.json`) and `PRIVACY.md` / privacy policy, read at `origin/main` in your own worktree |
| Screens | Curated demo-data screenshots generated from the repo (Flutter apps: `skills/store-screenshots/SKILL.md`; extensions: `store-assets/` / `chrome-store/` in the repo); else the images already public on the Play/CWS listing page (download, never log in) |
| Colours, fonts, icon | The repo: theme files, `assets/fonts/`, `assets/icons/`, extension `icons/` |
| Store link | Package id from `release.yaml` / `build.gradle(.kts)` / extension id from `apps.yaml`: `https://play.google.com/store/apps/details?id=<package>` or `https://chromewebstore.google.com/detail/<id>` |
| Music / SFX | Synthesise with ffmpeg `lavfi` (`aevalsrc`, `sine`, `anoisesrc`). No downloaded audio, so nothing has an unknown licence |

Never show real user data, account names, emails or credentials. Demo data only.

## 2. Claims rule (non-negotiable)

1. Every word on screen and in the share copy that states a capability, a number or a property
   gets a row in `facts-used.md` (template: `skills/marketing-video/facts-used.template.md`)
   pointing at `file:line` at a pinned commit, or at a `[fact:x]` key in `product-facts.yaml`.
   No row, no claim: cut it.
2. Never invent numbers: no user counts, ratings, downloads, savings, returns, "X% faster".
   Numbers visible inside demo-data screenshots are allowed, but only as UI, never as a claim.
3. Privacy: say nothing broader than the privacy policy says. "Private", "on-device", "no
   tracking", "secure", "encrypted" need the exact policy sentence in `facts-used.md`. If the
   app syncs to a cloud (e.g. Firebase), "data never leaves your device" is false. Do not
   write it.
4. No outcome promises ("grow your wealth", "never lose money"). Finance apps: a frame showing
   returns gets a small "Sample data" caption.
5. Demo data must not show real third-party brands (banks, lenders, funds, developers). They read
   as affiliation or endorsement. Use generic labels ("Bank FD 7.25%", "P2P Lending A").
   Government instruments by their generic name are fine.
6. No "free" unless the store listing says free and there are no in-app purchases.
7. If there is no `product-facts.yaml` for the product, say so in your comment. `facts-used.md`
   with README/policy citations is the trace for this draft, and the reviewer checks it.
   Recommend that CPO create `product-facts.yaml` (do not create it yourself unless the issue
   asks).

## 3. Plan (`brag-plan.md`)

Answer first: what is it (one sentence), who is it for, what sets it apart, the strongest
*traceable* claim, the visual hook, which real screens to show, the tone, the one-line caption.

Shape: Hook (2-3s) -> Reveal (2-4s) -> 2-3 highlights -> Outro with name + how to get it
(2-4s). 18-22s total. Default format **vertical 1080x1920 @30fps** (Shorts/Reels/X); landscape
1920x1080 only if the issue asks for it. Write the storyboard with durations that sum to the
target, and the `facts-used.md` row for each line of text.

Creative laws (from brag-slim): short; clear to a stranger after one viewing; the hook decides
everything; **show the real product** (its screens, fonts, colours), never abstract filler;
specific to this product (no "streamline your workflow"); readable (a line stays fully on
screen ~0.3s per word, counted once it has settled); alive (things enter one by one, swipes,
taps); every frame postable.

## 4. Build, check, render (ffmpeg only)

Proven recipe (InvTrack v2, 2026-10-01). Write it as one small `build.py`/`build.mjs` so it can
be re-run:

1. **Background:** `ffmpeg -f lavfi -i color=c=0x0C0A09:s=1080x1920 -vf "geq=..." -frames:v 1 bg.png`
   (a soft radial glow from the product's accent colour).
2. **Phone cards:** `scale=700:-1,format=rgba,geq=...a='255*lt(hypot(...),40)'` gives rounded
   corners. Crop away floating buttons and any "Behind"/negative widgets.
3. **Scenes:** one ffmpeg call per scene: `-loop 1 -t <dur>` inputs, `overlay` with an eased
   `y` expression for slide-in, `drawtext` with `fontfile=` (the app's own font from the repo)
   and `textfile=` (avoid escaping), alpha ramp `clip((t-t0)/0.3,0,1)`, `fade` in/out 0.2s.
   Encode `libx264 -crf 16 -pix_fmt yuv420p -r 30`. Concat with the concat demuxer.
4. **Audio:** synthesise a pad + soft pulse with `aevalsrc`; SFX the same key, low in the mix;
   `loudnorm=I=-16:TP=-1.5` then `alimiter`. Mux AAC 192k.
5. **Check before you deliver** (brag-slim): extract stills from every scene **and**
   mid-transition (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 still_<t>.png`) and look at them
   (Read tool). Fix text overflow, collisions, low contrast, muddy cross-fades (stagger:
   old out, then new in). Verify: `ffprobe` duration 15-25s, 1080x1920, 30fps; loudness with
   `ffmpeg -i out.mp4 -af ebur128 -f null -` (about -16 LUFS, no clipping).
6. **Poster:** the strongest settled frame as `poster.jpg`, also baked in as frame 0
   (replace, do not add, so the audio stays in sync).

## 5. Deliver

Attach to the issue (`POST /api/companies/{companyId}/issues/{issueId}/attachments`,
multipart `file`): the mp4, `poster.jpg`, `brag-plan.md`, `facts-used.md`, `share-copy.md`
(1-3 factual captions, no "excited to share"). Then end with the handoff comment:

```
HANDOFF: <artefact> draft (NOT published). Files: <attachment links>.
Claims: N on screen, all in facts-used.md (product-facts.yaml: yes/no).
Checks: <duration>s, 1080x1920, <LUFS>, stills reviewed.
Open questions: <format, where to post, anything cut and why>.
```

Set `in_review` and assign the reviewer (CEO for publish approval). Before ending: no
`ffmpeg`, emulator or other process left running (TOOLS.md, "Finish every run cleanly").

## Smaller jobs (captions, listing copy)

Same claims rule, no video: write `facts-used.md`, then the copy, and post both as an issue
document or comment. Respect store limits (Play title 30, short 80, full 4000 chars; CWS short
132).
