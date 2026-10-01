# Flow verification: a flow is done when its outcome has been read back (APP-290)

Founder requirement (2026-10-01): every new flow verifies its own real outcome. For example, when
store listings are uploaded, they must then be checked and verified.

A **flow** is anything that changes state outside the repo and that we rely on later. Examples:
a store upload, a listing sync, a promote, a scheduled job, a sync of instructions into Paperclip,
or an agent run that claims it produced an artefact.

## 1. Definition of done

A flow is **done** only when a **separate step** has done all of the following:

1. Read the real outcome back from the **source of truth**.
2. Compared it with the **intended end state**.
3. Made any mismatch **loud**.

"The API returned 200" is not a read-back. Neither is "the script exited 0". InvTrack's
red-loss screenshots stayed live because nothing ever read the listing back.

Every flow states these six things in its doc or PR:

| # | Item | Means | Store-listing sync example |
|---|---|---|---|
| 1 | **Intended end state** | What must be true afterwards, as data that can be compared. | The bundle's `listing.json`: per-locale text, plus the ordered sha256 list per image type. |
| 2 | **Source of truth** | The system that is authoritative. Not our log or our cache. | Google Play: a fresh read-only edit, `edits.listings.get` and `edits.images.list`. |
| 3 | **Read-back method** | The code that reads (2) and diffs it against (1). It must not reuse the code that made the change. | `play.mjs verify-listing`: its own edit (never committed) and its own `diffListing`. |
| 4 | **When** | **Immediately** after the change, **again** when a delayed effect lands (store review, rollout, propagation), and **on a schedule** to catch drift (someone changing it by hand). | Immediate: a step after the sync. Drift: daily `verify_only` run. After review: a check of the public store page once the 7-day review SLA has passed. |
| 5 | **Who is told on a mismatch** | (a) The run fails. (b) **One** de-duplicated issue is opened and assigned to the owner. (c) ntfy, if a person must act today. Silent "warning" output does not count. | A failing `listing` run and **one** `listing-verify` issue per package. The issue closes itself when the next read-back matches. |
| 6 | **Mutation test** | A test that breaks the intended state (or the store state) and asserts that the verifier reports MISMATCH. A verifier that cannot fail is not a verifier. | `release-platform/tests/listing-verify.test.mjs`: 7 mutations, plus a fake store that accepts writes and keeps nothing. |

Rules that follow from the table:

- **No verifier result is not a pass.** If the verifier crashes or is skipped, report it as
  `broken`, just as loudly as a mismatch.
- **"Unchanged" is a claim too.** Run the read-back even when the flow thinks there was nothing
  to do.
- **Read-only by construction.** The verifier cannot change the thing it checks. For example,
  the Play read-back edit is always deleted and never committed.
- **One issue per drift, not one per run.** Use a marker in the issue body (for example
  `<!-- listing-verify: <package> -->`). Comment on the open issue instead of opening a duplicate.
  Close the issue when the state matches again.
- **Some things cannot be read back.** Chrome Web Store listing text and Play images on the
  public page are examples. Write down that limit, and read back the strongest proxy that exists
  (public page description hash and screenshot count). Never mark such a flow "verified" on a
  human's say-so alone.

## 2. PR convention: a mandatory `## Verification` section

Every PR that adds or changes a flow (CTO or Builder) carries this section in its description.
A PR that touches no flow writes `## Verification` followed by `N/A: no flow (docs/tests only)`.

```markdown
## Verification
- Intended end state: <what must be true, as comparable data>
- Source of truth + read-back: <system; script/step that reads it back; read-only how>
- When: immediate <step> / after review or rollout <step or N/A + why> / drift <schedule or N/A + why>
- On mismatch: <failing run? which issue (label, de-dup marker), assigned to whom? ntfy?>
- Mutation test: <test file::name> (breaks <what>, asserts MISMATCH)
- Not verifiable: <what cannot be read back, and the proxy used instead>
```

## 3. Reviewer checklist (CTO as Reviewer, QA at G5)

Request changes if any box is unchecked:

- [ ] The PR has a `## Verification` section, or it says `N/A` with a reason that holds (no external state changes).
- [ ] The read-back reads the **source of truth**, not our own log, output or cache.
- [ ] The read-back is a **separate** code path. It does not re-use the writer's comparison to "verify" itself.
- [ ] The read-back is **read-only**. It cannot change what it checks.
- [ ] It runs **immediately**. A delayed effect (store review, rollout) has a **second** check. If a hand edit is possible, a **scheduled drift** check exists.
- [ ] A mismatch **fails the run** and opens **one** de-duplicated issue with an owner. If a person must act the same day, ntfy is sent.
- [ ] A verifier that did not run or crashed is reported as **broken**, never as a pass.
- [ ] There is a **mutation test**. I can name the line which, if deleted, makes that test fail.
- [ ] Limits are written down (what cannot be read back, and which proxy is used).

## 4. Retrofit audit: existing flows (2026-10-01)

Status: **Yes** = a separate read-back with a loud mismatch and a mutation test. **Partial** = some
detection, but not all of the definition of done. **No** = nothing reads the outcome back.

| Rank | Flow | Where | Verifier today | Gap | Status |
|---|---|---|---|---|---|
| 1 | Loud path from GitHub to the company | release-platform runs, `listing-verify` issues | A failing run and a GitHub issue in the **app** repo. No Paperclip issue and no ntfy. Nobody here is woken by a GitHub issue. | Without this, every release-platform verifier is "loud" only in a repo nobody watches. **Child issue APP-293.** | **No** |
| 2 | Schedules: did the job actually run? | launchd: `play-vitals`, `repo-refresh`, `backup`, `digest-gate`, `sync`, `lock-guard`, `quota-watchdog`. Paperclip routines. | `sync.sh` catches missed **Paperclip routine** fires. Nothing checks launchd jobs: a job that never fires (Mac asleep, plist unloaded, node path broken) is silent. The "Hourly platform integrity sweep" routine (lock and launcher drift) is **paused**, so that check is not running either. | **Built in APP-294:** a stamp per job (`state/heartbeats/`), `job-liveness` checker (never-ran / failed / overdue; one issue + ntfy; self-closing), 15 tests incl. mutation tests. Checker watched by the digest gate. See `infra/macos/README.md`. | **Yes** (once installed: `install-plists.sh job-liveness`) |
| 3 | Release, then Play track read-back | `release.yml` (`play.mjs upload`) | Trusts the commit response. Nothing re-reads the track to confirm that the versionCode is on the intended track with the intended status. | **Built in APP-295, waiting for a push** (branch `feat/APP-295-track-verify`): `play.mjs verify-track`, a fresh read-only edit after commit, asserting `{track, versionCodes, status, userFraction}`; a mismatch fails the run and blocks the tag. 18 mutation tests. The `release-verify` issue (branch `feat/APP-295-release-verify-issue`) needs callers to grant `issues: write` first. | **Yes** (once pushed) |
| 4 | Promote / rollout / halt / complete | `promote.yml` (`play.mjs promote`, `changeRollout`) | Same as rank 3. The commit response is trusted. | Same verifier as rank 3 (`verify-track` step in `promote.yml`; status and fraction from the inputs). Built in APP-295, waiting for a push. | **Yes** (once pushed) |
| 5 | Agent runs: does the artefact the agent claims exist? | every HANDOFF comment | Reviewer spot checks only. A HANDOFF can link a PR, branch, commit or file that does not exist (for example, a push that failed). | A `verify-handoff` check that resolves every PR, commit and path in a HANDOFF and fails `in_review` if one is missing. Next after the top 3. | **No** |
| 6 | Store listing post-review (public page) | Play public store page; Chrome detail page | None. | Design in APP-290 (c): check the public page after the 7-day SLA (title, description hash, screenshot count). For Chrome, a human closing the checklist means "submitted", and the bot reopens the issue if the public page still differs. | **No** |
| 7 | Instruction sync drift | `scripts/sync-agent-instructions.mjs` | It **is** a verifier (report mode exits 1 on drift), but nothing schedules it. It runs only when someone remembers. | Now run by `job-liveness` in report mode; exit 1 opens one issue (APP-294). | **Yes** (once installed) |
| 8 | Launcher drift | `scripts/detect-launcher-drift.mjs` | Good verifier with tests, but its only schedule (the integrity-sweep routine) is paused. | Now run by `job-liveness` on launchd every 10 min (APP-294). The paused routine stays paused; unpausing needs CTO/board sign-off. | **Yes** (once installed) |
| 9 | repo-refresh | `infra/macos/repo-refresh.sh` (hourly) | Logs per-repo fetch failures. Readers are told to "say so if the commit looks old". | Rank 2 (done) covers "did it run". Still needs a staleness check: the age of `origin/main` vs. GitHub's `pushed_at`. | **Partial** |
| 10 | play-vitals | `infra/macos/play-vitals.sh` (daily) | Good: exit 2 ("check failed") sends ntfy, so a broken check is never a quiet day. Not covered: a run that never starts. | Rank 2 (APP-294) now covers "did it run". | **Yes** (once installed) |
| 11 | Play listing sync | release-platform `listing.yml` | **Built in APP-290, waiting for a push:** an immediate read-back and a daily drift check, 16 tests including 8 mutation tests. | Rank 1 (bridge) and rank 6 (post-review). | **Yes** (once pushed) |
| 12 | Metrics import | `scripts/metrics-import.mjs` + `metrics-freshness.mjs` | Freshness is read back and stale data is flagged. | None found. | **Yes** |

## 5. Known limits

- **Agents cannot push to `release-platform`.** `config/github-apps.yaml` excludes it on
  purpose (see `docs/capabilities.md`), pending a locked-down `appforge-release` App. So the
  release-platform half of this work exists as a local branch that the founder pushes. The same
  applies to the rank 3 and rank 4 verifiers.
- **A reusable workflow cannot gain a permission silently.** GitHub rejects the whole run at
  startup when a nested job asks for a permission (for example `issues: write`) that the caller
  did not grant. Adding an issue job to a `@v2` workflow breaks every caller. Ship it as a new
  major, or update the callers first (APP-295).
- **Play edits show what Play accepted, not what is public.** An edit's view after commit
  includes changes that are still in review. That is why the post-review check (rank 6) exists
  as a separate step.
