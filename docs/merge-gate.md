# Pre-merge gate: `scripts/merge-gate.mjs`

**Run this before every `gh pr merge` on `appforge-control`.**

```sh
node scripts/merge-gate.mjs --pr <number> && gh pr merge <number> --squash
```

Silence and exit 0 means the `node-test` check succeeded on that PR's current
head commit. Any other exit prints one line saying why and means do not merge.

## Why it exists

The board ruled on APP-225 that `node-test` stays **advisory**: this repo is
private on the GitHub Free plan, where branch protection and rulesets are
unavailable, and the ruling was advisory at $0. That is the right call and is
not being relitigated.

What it leaves is a rule — "do not merge a red PR" — with no mechanism. The
thing it guards against is not a hostile agent but an agent not looking, which
is exactly how APP-217 happened: `main` was red for a week because nobody read
it. An advisory red X that nobody reads reproduces that failure one level up.
This gate turns "look at the check" into a command that fails.

It only ever **refuses**. It does not merge, does not wait, does not retry, and
never calls branch protection (plan-gated, not permission-gated). Per DEC-0016
every agent-facing deny list here is cooperative anyway — the goal is to make
the check impossible to *overlook*, not to contain anyone.

## Exit codes

| Exit | Meaning | What to do |
|---|---|---|
| 0 | green on this exact head SHA | merge |
| 1 | check completed and did not succeed (incl. `skipped`, `cancelled`, `neutral`) | fix the branch |
| 2 | the gate could not answer: bad usage, no token, API error | fix the gate's inputs — **this is not a pass** |
| 3 | no such check run on this head SHA | find out why Actions never ran |
| 4 | `queued` / `in_progress` | wait, then re-run the gate |

`3` is deliberately distinct from `1`. Before the `node-test` workflow lands,
no run exists at all, and a gate that passes on an absent check is worse than
no gate — it teaches the caller the gate works while it is inert.

## What it actually checks

It resolves the PR's **current** head SHA from the API and asks only about that
SHA, then re-verifies `head_sha` on the run it found. A green on an ancestor
commit lands in exit 3, never exit 0 — a stale green is the failure mode most
worth catching. If a re-run is in flight alongside an older green on the same
SHA, the in-flight run wins and the gate refuses.

## Auth

`GH_TOKEN` / `GITHUB_TOKEN`, which `agent-launch.sh` already injects as the
per-run `appforge-agents` installation token. Both endpoints it reads
(`GET …/pulls/{n}` and `GET …/commits/{sha}/check-runs`) return 200 under the
App's existing `pull_requests` + `checks:read` grants — verified live on
2026-09-30. **No new App permission is needed and none may be requested for
this.** In particular the `workflows` grant was rejected on the merits: it is
App-wide across 11 repos including product repos whose `release.yml` dispatches
`release-platform` with OIDC.

Filed under APP-234, from the APP-225 board decision.
