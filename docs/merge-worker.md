# Merge worker

The merge worker (APP-310) merges a low-risk pull request after the CEO approves it in Paperclip, with no human step.
Code: `scripts/merge-worker.mjs`, `scripts/lib/merge-worker.mjs`. Policy: `config/merge-policy.yaml`.
It runs every 5 minutes through `infra/macos/merge-worker.sh`.

## What it does

1. Reads the CEO's Paperclip comments for approval lines.
2. Checks the pull request against the policy.
3. Squash-merges it (`merge_method: squash`).
4. Reads the merge back from GitHub, then posts the result on the issue.

Only comments written by the CEO agent (`approver_agent_id` in the policy) count. A decision line from anyone else is ignored.

## The approval line

The CEO writes one line on the issue:

```
DECISION: approve merge of https://github.com/ravitejakamalapuram/<repo>/pull/<n> at <40-char head sha>
```

Copy the URL and the full 40-character SHA from the author's HANDOFF (`PR:` and `HEAD:` lines). Read the SHA with `gh pr view <n> --json headRefOid`.
A CEO line that starts like a decision but is malformed (short SHA, no SHA, other owner) is refused, never merged.

## What must be true to merge

- The repo is listed under `repos:` in the policy (today `appforge-control` and `session-transfer`).
- The PR is open, not a draft, targets the repo's base branch (`main`), and is not from a fork.
- The PR author is `appforge-agents[bot]`.
- The approved SHA equals the current head. A push after the decision invalidates it; the CEO must approve the new head.
- Every required check is green on that SHA (`node-test` for `appforge-control`; `ci / Validate and test` for `session-transfer`).
- The PR has no merge conflicts.
- Every changed file (and the old path of a rename) matches the allow list and no deny glob.

If a check is still running, the worker waits and tries again on the next pass. If it is still not ready long after the decision, it refuses (2 hours after the decision).

## Allow list and deny list

Allow (every changed file must match one):

- `product-facts.yaml` (repo root only)
- `data/**/*.yaml`
- `docs/**/*.md` (markdown only)

Deny (any match refuses, even if the file is allowed above):

- `.github/**`, `**/release.yaml`
- `config/**`, `**/config/**` (so no PR can widen this policy)
- `agents/**`, `**/agents/**`
- `**/src/**`, `scripts/tests/**`
- `**/*secret*`, `**/*.pem`, `**/store/**`
- Agent-read docs: `docs/containment-model.md`, `docs/capabilities.md`, `docs/agent-repo-scope.md`, `docs/merge-gate.md`, `docs/git-credentials-in-agent-runs.md`, `docs/paperclip-run-binding.md`, `docs/runtime-launcher.md`, `docs/metrics-ingest.md`, `docs/store-listing-sync.md`

`config/merge-policy.yaml` is the source of truth; if this summary and the file differ, the file wins.

## Reading the result

The worker comments on the issue that holds the decision.

- `MERGED <url> as <commit>`: merged and read back as present on the base branch.
- `REFUSED <url>: <reason>`: not merged. The reason names the failed rule. Fix the cause (for example, ask the CEO to approve the new head SHA) or ask the board's assistant to merge by hand.
- `MERGE UNVERIFIED <url>: <reason>`: the merge call succeeded but the read-back failed. Check the PR by hand.

## Dry run

```
infra/macos/merge-worker.sh --dry-run
```

This prints each decision (would merge, wait, or refuse). It does not merge, comment, or write state. It needs `scripts/node_modules` and the App key in `secrets/`, and it reads the policy from `origin/main`, not from your checkout.
