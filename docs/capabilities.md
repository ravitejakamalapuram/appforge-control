# Capability strings — what each grant in `config/agents.yaml` actually buys

Every agent row in `config/agents.yaml` carries a `capabilities:` list. Until
APP-194 those strings were **granted in one place and defined in none**: no
schema validates them, no script reads them, and no document said what any of
them meant. They are declarations read by humans and by agents deciding how to
route work — which makes an undefined string an active hazard rather than a
cosmetic gap, because routing decisions get made on a guess at what it covers.

This file is the definition. A capability string that does not appear here is
not defined, and work must not be routed on it.

## How to read a definition

Each entry states **what it covers**, **what it does not cover**, and **the
evidence that it works**. The "does not cover" half is the load-bearing half:
APP-54 was routed to QA on `browser:e2e` for a task that `browser:e2e` has
never been able to do, and sat blocked for a day as a result. A capability
whose boundary is unwritten will be over-read.

---

## `browser:e2e` — QA

**Covers.** Launching a clean, throwaway headless Chromium under Playwright,
side-loading a built MV3 extension into it via `--load-extension` on a
persistent context, and running assertions against the resulting pages and
service worker (including forced service-worker restart via CDP). The
implementation is `@appforge/e2e` in `appforge-kit` (`packages/e2e`), landed as
`c128399` "P1-11: Playwright e2e harness (@appforge/e2e) + appforge test --e2e",
and the operator entrypoint is `appforge test --e2e`.

**Does not cover.** Anything involving a browser that a human is logged into.
Specifically, `browser:e2e` gives **no** ability to:

- drive, attach to, or read the founder's live Brave/Chrome session;
- reach any site behind an authenticated session, including the Chrome Web
  Store Developer Dashboard, Play Console, Gumroad or Cloudflare;
- fetch arbitrary pages from the public web as a scraping channel.

The browser it launches starts from an empty temp profile that is deleted when
the run ends. It has no cookies, no logins, and no relationship to any browser
the founder uses. Attaching to the founder's session is a separate, unbuilt
capability; it was weighed on APP-54 and **withdrawn** — reinstating it is a
containment question for the board, not a tooling change.

**The distinction that keeps being collapsed.** "QA can drive a browser" is
false. "QA can run a disposable browser against a build artifact" is true.
Capture work against a logged-in dashboard is a founder-session manual step and
must be routed as one, regardless of who holds `browser:e2e`.

**Evidence it works (verified 2026-09-29, APP-194).** Playwright 1.63.0 is
installed in `appforge-kit` and its Chromium binaries are present in the local
Playwright cache. `packages/e2e`'s own suite runs 10/10 green against a real
browser — loading the `chrome-vanilla` template, discovering its extension id,
tracking the service worker to `activated`, and surviving a forced restart with
`chrome.storage.local` state intact. End to end,
`appforge test --e2e --dir templates/chrome-vanilla --dist <abs>/dist` returns
`ok: true` with both checks passing.

**Known sharp edge.** `appforge test --e2e` builds the product before testing
it, and that build shells out to `pnpm`, which is **not on `PATH` in the agent
runtime** — the command fails with `spawnSync pnpm ENOENT` before the browser
is ever launched. Pass `--dist` at an **absolute** path to a
previously-built extension directory to skip the build; `--dist` resolves
against the process cwd, not against `--dir`, so a relative path silently
resolves somewhere else. Tracked separately.

---

## `repo:*` — repository access

These describe the *shape* of repository write access. The actual repo list is
enforced elsewhere: `APPFORGE_AGENT_REPOS` scopes the per-run GitHub App
installation token minted by `scripts/agent-launch.sh`, and
`config/github-apps.yaml` records which repos the app is installed on. The
capability string is the intent; the token is the enforcement.

- **`repo:read`** — read any repo in the agent's `APPFORGE_AGENT_REPOS`. No
  write of any kind.
- **`repo:write:assigned`** (Builder) — write only within the repo and branch
  of the issue currently assigned to the agent.
- **`repo:write:platform`** / **`repo:write:products`** (CTO) — write to the
  platform repos and to product repos respectively. Note that the platform set
  the token actually reaches is `appforge-control` and `appforge-kit` only:
  `config/github-apps.yaml` **deliberately excludes** `release-platform` (it
  awaits a separate, more locked-down `appforge-release` App) and `InvTrack`
  (kept hands-off from agents per the founder's extra-care policy). The
  capability string does not override that exclusion.
- **`repo:tests-pr`** (QA) — open a PR that adds only files under `tests/`.
  Never modifies product code, including to "fix" a failing test.
- **`repo:review`** (CTO) — approve and request changes on others' PRs.

## `brain:pr` — `appforge-brain` via pull request

Propose changes to the knowledge repo as a PR, never as a direct push.
`~/git-personal/appforge-brain` is a single working copy shared by every agent;
work in a detached worktree under the run scratch dir (APP-72) rather than
switching branches in it.

## `ci:read` — read CI

Read workflow runs, job logs and check statuses. No dispatch, no re-run, no
secret access.

## `metrics:read` / `metrics:ingest:read-only`

- **`metrics:read`** — read the ingested store/revenue metrics under `data/`.
- **`metrics:ingest:read-only`** (Analyst) — additionally read the ingest
  pipeline's inputs and provenance records, without the ability to write or
  re-run an ingest. Analysis must not be able to move the numbers it reports.

## `release:staging` / `release:production:approval_gated` — CTO

- **`release:staging`** — dispatch a staging release: Play internal track, or a
  Chrome Web Store `STAGED_PUBLISH` dry-run.
- **`release:production:approval_gated`** — dispatch a production release
  **only** against a verified board approval id. The `approval_gated` suffix is
  the whole point of the string: the capability is the ability to *carry out* an
  approval, never to *supply* one. No agent may satisfy a gate that exists to
  check it.

## `web:research` — CPO

Read public web pages and search results for research. Not a browser session,
not authenticated, and not a substitute for `browser:e2e`.

## `repo:read:products` — Growth

Read product repositories at their latest known `origin/main`, through the shared local checkouts
(`git -C ~/git-personal/<repo> show origin/main:<path>`). It carries **no token**: the agent's GitHub token stays
scoped away from product repos, and the host keeps the refs fresh with `infra/macos/repo-refresh.sh` (hourly). An agent
with this capability never runs `git fetch` on those repos and never writes to them.

## `hubsite:pr` — Growth

Propose changes to the marketing hub site by PR.

## `paperclip:company` — CEO

Company-level control-plane administration: agent configuration, budgets,
routines. Note that this is an *authorization* statement about the CEO role,
not a licence to use the control plane's unauthenticated `local_trusted` path;
that path is never a fallback for anyone.

---

## Maintaining this file

When a capability is granted, defined or retired, change
`config/agents.yaml` and this file in the same PR. A grant whose definition is
missing here should be treated as a bug in the grant, and the first question is
always the one APP-194 turned on: does the runtime actually implement it, and
has anyone run it recently enough to say so?
