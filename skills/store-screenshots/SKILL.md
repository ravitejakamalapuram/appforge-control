---
name: store-screenshots
description: Generate curated, demo-data-only store screenshots for a Flutter product (InvTrack first) on the local Pixel_7 emulator, pad them to Play's aspect rule, and clean up. Use when an issue asks for store/listing screenshots, or when a video needs real product screens.
---

# store-screenshots

Origin: APP-285 / APP-287. InvTrack's Play listing showed red losses (XIRR -51.7%) although the
repo has had a curated, all-positive generator since POR-98 that nobody had run:
`integration_test/flows/store_screenshots_test.dart` + `test_driver/store_screenshots_driver.dart`.
This is the runnable procedure. It is for **Builder** (needs the product repo and Flutter);
Growth reviews the result against the claims rule in `skills/marketing-video/SKILL.md`.

Uploading to a store is **not** part of this skill. Agents hold no store credentials. Commit
the images to the repo's listing directory by PR. The release-platform `listing` workflow
pushes them to Play, and a person dispatches it (see `docs/store-listing-sync.md`).

## Preconditions (check, do not install)

```bash
SDK=~/Library/Android/sdk
command -v flutter adb ffmpeg ffprobe            # all four must resolve
$SDK/emulator/emulator -list-avds | grep -x Pixel_7
adb devices | grep -c emulator-                  # must be 0: someone else's emulator is running
```

If an emulator is already running, it belongs to another run. **Do not kill it.** Set your
issue `blocked` ("emulator busy") and exit. If `Pixel_7` is missing, block on the board; do not
create AVDs.

## 1. Worktree (never the shared checkout)

```bash
WT="$PAPERCLIP_RUN_SCRATCH_DIR/InvTrack-<issue>"
git -C ~/git-personal/InvTrack fetch origin
git -C ~/git-personal/InvTrack worktree add --detach "$WT" origin/main
cd "$WT" && flutter pub get && flutter gen-l10n   # a fresh worktree has no generated l10n
```

## 2. Review the demo data before you render

Read `integration_test/flows/store_screenshots_test.dart`. It must hold:
- only open-and-growing or closed-with-profit positions (no negative XIRR, no "Behind" goals
  in frame);
- no real third-party brand names (banks, P2P platforms, funds, developers). If they are there,
  change them to generic labels in the same PR ("Bank FD 7.25%", "P2P Lending A",
  "Index Fund SIP", "2BHK Flat") and say so in the PR.

## 3. Boot the emulator headless (foreground-bounded)

```bash
LOG="$PAPERCLIP_RUN_SCRATCH_DIR/emulator.log"
nohup $SDK/emulator/emulator -avd Pixel_7 -no-window -no-audio -no-boot-anim \
  -no-snapshot-save -gpu swiftshader_indirect >"$LOG" 2>&1 &
echo $! > "$PAPERCLIP_RUN_SCRATCH_DIR/emulator.pid"
# macOS has no `timeout`; bound the wait yourself (max ~5 min)
for i in $(seq 1 100); do
  [ "$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 3
done
[ "$i" = 100 ] && echo "emulator did not boot - go to step 6, then block" 
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
```

The emulator is the one allowed background process, and **step 6 must run on every path**,
including failure. Put the cleanup in a `trap` if you script this.

## 4. Capture

```bash
OUT="$PAPERCLIP_RUN_SCRATCH_DIR/shots/raw"; mkdir -p "$OUT"
# Bash tool timeout caps one call at 10 min. The first profile build can take longer,
# so build first in its own call: (cd android && ./gradlew --version) && flutter build apk --profile
SCREENSHOT_OUTPUT_DIR="$OUT" flutter drive --profile -d emulator-5554 \
  --driver=test_driver/store_screenshots_driver.dart \
  --target=integration_test/flows/store_screenshots_test.dart
ls "$OUT"   # store_01_overview.png ... store_06_investment_detail.png, 1080x2400 each
```

`--profile` is required: debug builds draw the red DEBUG ribbon. Look at every PNG (Read tool)
before going on: no red/negative figures, no overlapping UI, no real names.

## 5. Make them Play-valid (aspect <= 2:1, 24-bit, no alpha)

Pixel 7 output is 1080x2400 (2.22:1). Play rejects anything whose long side is more than 2x the
short side (`PLAY_RULES` in release-platform `scripts/listing.mjs`). Pad to 9:16 1080x1920,
centred on the app's own background colour (InvTrack light: `0xFAFAF9`,
`lib/core/theme/app_colors.dart`), and drop alpha:

```bash
mkdir -p "$PAPERCLIP_RUN_SCRATCH_DIR/shots/play"
for f in "$OUT"/*.png; do
  ffmpeg -v error -y -i "$f" \
    -vf "scale=-2:1920,pad=1080:1920:(ow-iw)/2:0:color=<app-bg-hex>,format=rgb24" \
    "$PAPERCLIP_RUN_SCRATCH_DIR/shots/play/$(basename "$f")"
done
ffprobe -v error -show_entries stream=width,height,pix_fmt -of csv=p=0 \
  "$PAPERCLIP_RUN_SCRATCH_DIR"/shots/play/*.png   # every line: 1080,1920,rgb24
```

Play limits: 2-8 phone screenshots; the same set is valid for the 7-inch and 10-inch sections.
Drop shots that undersell the product (e.g. FIRE "Behind Schedule").

## 6. Cleanup (always)

```bash
adb -s emulator-5554 emu kill || kill "$(cat "$PAPERCLIP_RUN_SCRATCH_DIR/emulator.pid")"
(cd "$WT/android" && ./gradlew --stop) || true
pgrep -fl 'qemu-system|emulator -avd' && echo "STILL RUNNING - kill it before ending the run"
```

Then `git worktree remove --force "$WT"` after you have pushed.

## 7. Deliver

- **Listing images:** commit the padded PNGs to the repo's listing directory
  (`android/fastlane/metadata/android/en-US/images/phoneScreenshots/1_<name>.png`, and the same
  under `sevenInchScreenshots/` and `tenInchScreenshots/` if wanted) in a **draft PR**. Its
  CI (`app-ci.yml`) runs `listing.mjs check` once the target has a `listing:` key.
- **For a video:** attach the raw 1080x2400 set to the issue instead; the video crops them.
- Comment `HANDOFF:` with the PR link, the file list, and "emulator killed, gradle stopped".
