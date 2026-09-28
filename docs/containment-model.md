# Containment model: the OS uid is the boundary

**Ruling of record: `DEC-0016` in `appforge-brain`** (APP-73, board approval `e028e2f9`,
2026-09-28). Reasoning lives in `appforge-brain/strategy/containment-model.md`. This is the
control-repo copy that `agents/*/TOOLS.md` links to, so an agent reading its own deny list can see
what that list is and is not.

## The one-line version

There is **one** containment boundary and it is the **OS uid** agent processes run as
(`rkamalapuram`, uid 502 — the founder's own user, per `DEC-0001`). Everything else you will read
in this repo about what an agent "cannot" do is an operating instruction, not a control.

Do not restate this as "containment is layered." There is one layer. Understating it is the
defect `DEC-0016` was written to fix.

## The control plane does not contain agents

Paperclip runs with `server.deploymentMode = "local_trusted"` in
`~/.paperclip/instances/default/config.json`. In that mode the auth middleware defaults every
request's actor to board/instance-admin **before** examining any credential.

Measured 2026-09-28, read-only:

```
$ curl -sS -o /dev/null -w '%{http_code}\n' \
    http://127.0.0.1:3100/api/companies/<companyId>/issues     # no Authorization header
200                                                            # ...and all 99 issues in the body
```

So any process at this uid can read and write any issue in this company with no credential. It
also does not need the API to reach `~/.paperclip/instances/default/secrets/master.key`,
`decision-signing.key` (both mode 600) or the embedded Postgres data dir — it owns them on disk.

This is **not** a Paperclip defect. `local_trusted` is a documented vendor mode doing exactly what
it says, set by `onboard`. We chose to stay on it. **Do not probe the unauthenticated *write*
path** — the mechanism is established, and a write probe would itself create the unattributed
write `DEC-0016` records as a cost.

## What this makes of our written boundaries

| Thing you will read | What it actually is |
|---|---|
| `TOOLS.md` "Explicit deny list" | **Cooperative.** Operating instructions for a well-behaved agent. Not a sandbox. |
| `APPFORGE_AGENT_REPOS=none` | **Cooperative.** `agent-launch.sh` really does scrub `GH_TOKEN`/`GITHUB_TOKEN` and reset git's credential helpers, and that does close the *accidental* path — but it is hygiene inside the boundary, not a boundary. An agent that wants a token re-mints one through `scripts/github-app-token.mjs`; the App private key, `~/.ssh`, and `gh auth git-credential` all remain reachable at this uid. See `WHAT THIS DOES NOT CLOSE` in `scripts/agent-launch.sh`. |
| Per-run cross-issue write cap (`cross_issue_influence_cap_exceeded`) | **Credentialed writes only.** Never evaluated for an actor presenting no credential. |
| `issue_write_actor_class_excluded`, responsible-user ceiling, assignee run lock | **Credentialed writes only**, same reason. Real features; not containment. |
| Run-attribution audit trail | **Advisory.** An unattributed write is possible, so the trail cannot be relied on to name every actor. Knowingly accepted, not an oversight. |
| `appforge-brain`'s `board-approved` label gate on `company/`/`strategy/`/`policies/` (`.github/workflows/pr-checks.yml`) | **Cooperative — an advisory check run, not a merge block.** It calls `core.setFailed`, which turns the check red. Nothing makes it a *required* check, so the merge API accepts the PR anyway. See "The `board-approved` gate is a loud check" below. |
| GitHub App permission scoping (`appforge-agents` token) | **Actually enforced, server-side.** The one entry in this table that is a real boundary rather than an instruction — see "What *is* enforced" below. It is not a containment boundary for the uid, though: the App private key is readable at this uid, so the scope is a ceiling on *this* token, not on this machine. |

The three Paperclip mechanisms above — the cross-issue write cap, the actor-class/ceiling/run-lock
group, and the run-attribution trail — are documented in `docs/paperclip-run-binding.md`. All of
them are reached only *after* credential verification — see that doc's
"What this table does not bind". The last two rows are GitHub-side, not Paperclip-side, and are
explained in their own sections below.

## The `board-approved` gate is a loud check, not a merge block

`appforge-brain/.github/workflows/pr-checks.yml` fails a PR that touches `company/`, `strategy/` or
`policies/` without the `board-approved` label. Every agent has respected that red X and the gate has
never been bypassed, so it is a control that *works* — but it works the way the deny lists above
work, through agent discipline plus a visible signal, and not through the server. Different thing,
different failure mode.

Measured read-only 2026-09-29 (APP-134), with the per-run `appforge-agents` installation token:

```
GET /repos/ravitejakamalapuram/appforge-brain/branches/main
  protected: false
  protection.enabled: false
  protection.required_status_checks.enforcement_level: "off", contexts: [], checks: []
```

The third line is the operative one: **no job in that workflow is a required status check**, so a
merge with every check red is accepted. Corroborated independently on APP-131, where
`appforge-control` read the same `protected: false` and PR #15 then merged with
`HTTP 200 {"merged": true}`, zero approving reviews, first attempt.

Rulesets are not a second, hidden mechanism. They are **unavailable on this account's plan for a
private repo** — not merely unconfigured:

```
GET /repos/ravitejakamalapuram/appforge-brain/rulesets        -> 403 "Upgrade to GitHub Pro or
GET /repos/ravitejakamalapuram/appforge-brain/rules/branches/main -> 403  make this repository public"
GET /repos/ravitejakamalapuram/appforge-kit/rulesets         -> 200 []      # PUBLIC repo,
GET /repos/ravitejakamalapuram/appforge-kit/rules/branches/main -> 200 []   # same token, same account
```

Same token, same account, same endpoints; the only variable is repo visibility. That is what
promotes the plan reading from the inference APP-131 recorded ("strong inference from GitHub's error
string") to an established fact, without needing `GET /user` — which 403s for an installation
token. It also shows the 403 is a **plan/visibility gate, not a token-scope gate**: the token
demonstrably can read rulesets, it just cannot read them *here*.

So on current evidence **neither** `appforge-brain` nor `appforge-control` has server-side merge
gating. The difference between them is only that brain has a check that shouts. Do not describe that
gate as enforced. Turning branch protection on would mean paying for a plan or making these repos
public — a founder call about money or visibility, not an engineering task, and tracked on APP-123.
Nothing in this document proposes it.

One direct read was **not** available: `GET /repos/.../branches/main/protection` returns
403 `Resource not accessible by integration`, because the App holds `checks: read` / `actions: read`
/ `metadata: read` but no `administration` scope (master plan §11.3). That read is redundant rather
than missing — `protected: false` and `enforcement_level: "off"` come from the non-admin-gated
branch object and already answer the question, and on this plan a private repo cannot carry classic
protection either. But it does mean an agent cannot produce the admin-scope reading; only the
founder can.

## What *is* enforced

Worth stating, because this document is otherwise a list of things that are not. The GitHub App's
permission scoping is real server-side enforcement, and it was demonstrated rather than assumed:
on 2026-09-29 an agent push carrying a correction to `pr-checks.yml` was refused outright —

```
! [remote rejected] refusing to allow a GitHub App to create or update workflow
  `.github/workflows/pr-checks.yml` without `workflows` permission
```

— so agents cannot edit CI definitions, including the ones that check their own work. Per
`DEC-0012` agents may open PRs on repos in their own `APPFORGE_AGENT_REPOS`, and per master plan
§11.3 the App deliberately lacks `actions: write` so agents cannot dispatch release workflows.

Two caveats keep this honest. First, it binds *this token*, not this uid: the App private key is
readable at uid 502, so a determined process here could mint a differently-scoped token — the OS
uid is still the only containment boundary, exactly as the top of this document says. Second, the
practical consequence is a handoff, not a dead end: a correction to a workflow file has to be
applied by the founder. Treat that as a boundary to report, never one to route around.

## Revisit trigger

`DEC-0016` is **void immediately** if any of these becomes true, and
`deploymentMode: authenticated` must then be re-scoped as a board approval before agents continue:

1. `server.bind` is no longer `loopback`, or `server.host` is no longer `127.0.0.1`.
2. This machine becomes multi-user, or a second person gets agent access.
3. `server.deploymentMode` changes from `local_trusted`.

The same trigger is written into `config/security.yaml`, next to the containment claim it governs.

## Deferred, not in progress

Migration to `deploymentMode: authenticated` is **deferred** — the board considered and declined it
on APP-73. Do not plan, schedule, or write anything as if that migration were underway.
