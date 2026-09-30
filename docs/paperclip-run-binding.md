# Paperclip run binding: why agent writes 403, and what to do about it

Investigated 2026-09-28 for [APP-64](/APP/issues/APP-64) (escalation of
[APP-53](/APP/issues/APP-53)). Measured against the local instance,
`paperclipai` v2026.916.1, API at `http://127.0.0.1:3100`.

Read this before filing another "my comments silently disappeared" issue.

## The one-line version

Every agent write to an issue is attributed to a **heartbeat run**. The run is
named by the `run_id` claim inside `PAPERCLIP_API_KEY` (which is a JWT), and
optionally echoed in the `X-Paperclip-Run-Id` header. If the server cannot
resolve that pair to a live run, it refuses **every** comment and every status
write in the run — not just cross-issue ones. `PAPERCLIP_TASK_ID` has nothing
to do with it.

## How run attribution actually works

`PAPERCLIP_API_KEY` is not an opaque key. It is a JWT whose payload carries,
among other claims:

```
sub                  the agent id
company_id           the company
adapter_type         e.g. claude_local
run_id               the heartbeat run this token was minted for
responsible_user_id  the human whose authority the agent rides
iat / exp            issued-at and expiry (observed: exp = iat + 48h)
```

The server resolves the acting run in this order:

1. If `X-Paperclip-Run-Id` is present, it must **equal** the token's `run_id`
   claim. A mismatch is rejected before anything else happens.
2. If the header is absent, the `run_id` claim alone is used.
3. If the resolved run cannot be attributed to a live heartbeat, the write is
   refused.

Verified on a live run (`9a29a3a7-…`):

| Request | Result |
|---|---|
| `PATCH /api/issues/:id`, header matches the JWT claim | `200` |
| `PATCH /api/issues/:id`, **no** `X-Paperclip-Run-Id` header at all | `200` — the claim alone is enough |
| `PATCH /api/issues/:id`, header = a *previous* run's id (`18c8eeb6-…`) | `422 agent_jwt_run_id_mismatch`, with `claimRunId` and `headerRunId` echoed |
| `PATCH /api/issues/:id`, header = a syntactically valid but unknown UUID | `422 agent_jwt_run_id_mismatch` |

**The token's `run_id` claim is the authority. The header is a cross-check, not
the source of truth.** Sending the header is still required by the Paperclip
skill and is good practice — it is what turns a stale-credential bug into a
loud `422` instead of a silent misattribution — but adding the header cannot
rescue a token that is bound to the wrong run.

## Decoding the 403 you actually hit

`cross_issue_influence_run_context_required` is badly named. Its own copy, in
Paperclip's `packages/shared/src/issue-write-denial.ts`, reads:

> Every agent comment and task update is attributed to a heartbeat run so the
> cross-issue cap can be counted and the audit trail can name who acted for
> whom. **This request arrived without a valid run**, so it could not be
> contained.
>
> Try this: Send the `X-Paperclip-Run-Id` header with your current run
> (`$PAPERCLIP_RUN_ID`) and retry.

The boundary that fired is `Heartbeat run context`, not issue containment. It
fires on writes to *your own checked-out issue* exactly as readily as on
cross-issue writes, because the check runs before any issue-scope logic. The
error name describes the feature the check protects (the per-run cross-issue
cap), not the condition that tripped it.

### The full issue-write denial code space

The eight `issue_write_*` / `cross_issue_influence_*` codes below come from
`@paperclipai/shared`'s `issue-write-denial` module; `agent_jwt_run_id_mismatch`
is emitted earlier, by `@paperclipai/server`'s auth middleware. Together they
are the full space you can hit on a write:

| Code | HTTP | What actually fired |
|---|---|---|
| `cross_issue_influence_run_context_required` | 403 | **The run could not be resolved. Nothing in this run can write.** |
| `agent_jwt_run_id_mismatch` | 422 | Header run id ≠ token's `run_id` claim |
| `issue_write_not_visible` | 403 | The issue is outside the actor's visibility |
| `issue_write_actor_class_excluded` | 403 | Low-trust / skill-test / task-bridge scope |
| `issue_write_responsible_user_ceiling` | 403 | The human you act for is not authorized |
| `issue_write_responsible_user_unavailable` | 403 | No active responsible user |
| `issue_write_assignee_run_lock` | 409 | Another agent's run holds the checkout |
| `cross_issue_influence_cap_exceeded` | 429 | Per-run cap (default 20 cross-issue writes) — a rate backstop, resets next run |
| `issue_write_attribution_spoof_rejected` | 422 | `onBehalfOfUserId` was set in the body; it is server-derived |

Only the first one means *the whole run is dead*. The rest are per-request.

### What this table does not bind: uncredentialed writes

Everything above — including `issue_write_actor_class_excluded`, the
responsible-user ceiling, the assignee run lock, and the per-run cross-issue cap
— is evaluated **after** credential verification. An actor that presents **no
credential at all** is never measured against any of it.

That is not hypothetical here. This instance runs with
`server.deploymentMode = "local_trusted"`, in which the auth middleware defaults
every request's actor to board/instance-admin before examining any credential.
Measured read-only 2026-09-28: `GET /api/companies/<id>/issues` with no
`Authorization` header returned `200` and every issue in the company.

So read this whole document narrowly. It is an accurate map of **why your
credentialed agent writes fail and how to fix them** — which is what it was
written for. It is **not** evidence that these codes contain agents:

- The per-run cross-issue cap is a rate backstop **for credentialed writes**. It
  counts what it can see.
- The run-attribution audit trail is **advisory**. An unattributed write is
  possible, so the trail cannot be relied on to name every actor.
- The denial copy quoted above says an invalid-run request "could not be
  contained". Read that as the middleware declining to attribute the request,
  not as a statement that unattributed writes are prevented.

The actual containment boundary is the OS uid. Ruling: `DEC-0016` (APP-73).
Full model: `docs/containment-model.md`. **Do not probe the unauthenticated
write path** — the mechanism is established, and a write probe would itself
create the unattributed write `DEC-0016` records as an accepted cost.

## Task binding is a second, separate binding — and an unbound run can still take a lock

Added 2026-09-30 for [APP-224](/APP/issues/APP-224), measured on the same instance.

Everything above is about **run binding**: whether the server can resolve the
token's `run_id` to a live heartbeat. There is a second, independent binding —
whether the run is bound to an **issue** — and it decides different things:

| | run binding | task binding |
|---|---|---|
| Carried by | `run_id` claim in `PAPERCLIP_API_KEY` | `PAPERCLIP_TASK_ID`; on the API, `run.contextSnapshot.taskId` / `.issueId` |
| Failure code | `403 cross_issue_influence_run_context_required` | the same 403, on writes to the issue the run locked |
| Scope of failure | every write in the run | the write, while `POST /checkout` still returns **200** |

The consequence is the APP-224 defect: **a task-unbound run can take an issue's
checkout lock it can never write to.** `POST /api/issues/{id}/checkout` returns
200 and sets `in_progress`; every subsequent `PATCH` and comment on that issue
403s. The lock is useless to the only run holding it.

**It does not follow that nobody can write.** An earlier revision of this
section claimed the assignee's own task-bound run is also locked out with `409
issue_write_assignee_run_lock`, making the needed status write unissuable by
anyone. That is wrong, and the source says so — see the anchors below. The 409
branch is keyed on **assignee mismatch**, so a run of the assignee agent never
takes it. On APP-217 both the unbound holder and the later bound run were the
same agent, which is precisely how APP-217 closed itself while still locked.

What the unbound checkout does cost other actors is narrower: it sets
`in_progress`, which arms that assignee-mismatch 409 against every *non*-assignee
agent without a checkout-management override, for the unbound run's lifetime. So the grant buys its holder nothing and
costs third parties a write window they would otherwise have had.

### The discriminator is `contextSnapshot.taskId`, not `invocationSource`

`GET /api/heartbeat-runs/{runId}` exposes both. Only one of them is the answer:

- `contextSnapshot.taskId` / `.issueId` — **this is the binding.** Set on a
  task-bound run, absent entirely on an unbound one.
- `invocationSource` — only ever `assignment` or `automation` here (200 runs
  sampled), and it does **not** track task binding. 53 agent comments in this
  company were written successfully by `automation` runs, because those runs were
  task-bound. Classifying on `invocationSource` would be wrong.

### What was actually measured on APP-217 — and what the first reading got wrong

| run | invocationSource | `contextSnapshot.taskId` | held APP-217's lock | outcome |
|---|---|---|---|---|
| `a520f601` | automation | absent (**unbound**) | — | failed; wake was a watchdog quota-resume |
| `47c79a69` | automation | absent (**unbound**) | 00:03:42 → 00:17:26 | could not write; wrote its verdict to an issue *document* instead |
| `e3b51905` | automation | `b126c0ef…` = **APP-217** | 00:17:27 → 00:23:55 | **closed APP-217** at 00:22:58 |

Three corrections to how this first looked from inside the 409:

1. **It is a bounded starvation window, not a permanent livelock.** The lock was
   not passed hand-to-hand between unbound runs. Only the *first* holder was
   unbound; the second was APP-217's own task-bound run, which closed the issue
   five minutes later, with `assigneeAgentId` intact. The window equals the
   unbound run's lifetime — here 13m44s.
2. **A 409 seen from a bound run on a *different* issue is not proof of the
   defect.** `issue_write_assignee_run_lock` is the documented, correct answer
   when another run legitimately holds the checkout. Confirm the holder's binding
   before calling it starvation.
3. **No retry dropped a binding.** APP-224 read this as a continuation retry
   losing a binding its predecessor had, and [APP-229](/APP/issues/APP-229) was
   opened to report that. The run records refute it. `a520f601`'s own
   `contextSnapshot` has no `taskId` and no `issueId` either: its wake was a
   board-triggered watchdog quota-resume (`triggeredBy: "board"`, `actorId:
   "local-board"`, `wakeReason: "resuming after provider_quota reset
   (watchdog)…"`), which is **agent-scoped, not issue-scoped**, and so is unbound
   by design. `47c79a69` (`retryOfRunId: a520f601`, `retryReason:
   "max_turns_continuation"`) faithfully inherited that unbound state. Nothing was
   lost. The two snapshot shapes are disjoint: a bound run carries `taskId`,
   `issueId`, `taskKey`, `source`, `paperclipIssue`, `paperclipTaskMarkdown`,
   `paperclipHarnessCheckedOut`; these two carried none of them, and instead
   carried `actorId`, `triggeredBy`, `originIdentityContextId`,
   `forceFreshSession`.

So "preserve task binding across retries" has no defect behind it on this
evidence. The retry was bound exactly like the run it retried. The thing to fix
is that an agent-scoped run can take an issue lock at all.

### Where this lives in the server, and why the denial is a category error

Anchored in the installed dist, `@paperclipai/server@2026.916.1` — read
`node_modules/@paperclipai/server/dist/`:

| Site | What it does |
|---|---|
| `routes/issues.js:10660` — `POST /issues/:id/checkout` | Requires a **run** (`requireAgentRunId`, `:10691`). Never calls `assertCrossIssueInfluenceWithinRunCap`. Task binding is not consulted. |
| `routes/issues.js:2454` — `assertCrossIssueInfluenceWithinRunCap` | The guard that *does* consult it. Applied to update (`:6260`, `:9124`), comment (`:9127`, `:12476`), interaction resolution (`:3698`) — **not** checkout. |
| `services/cross-issue-influence-limit.js:69-71` | `readRunSourceIssueId(run.contextSnapshot)` reads `issueId ?? taskId`; null ⇒ `throw crossIssueInfluenceRunContextError()`. This is the 403. |
| `services/cross-issue-influence-limit.js:72-75` | Same-issue writes are **exempt** — `return null`, allowed and uncounted. |
| `routes/issues.js:3438-3449` | The `409 issue_write_assignee_run_lock` branch: `issue.assigneeAgentId !== actorAgentId && issue.status === "in_progress"`, unless the actor holds a checkout-management override (`:3439`). Assignee mismatch, not lock holder. |

The 403 is a category error. The function's entire job is counting **cross**-issue
writes, and three lines below the branch that denies, a same-issue write is
exempted outright. An unbound run writing to the issue it holds the checkout on
*is* a same-issue write — but it is refused before the exemption can be reached,
because the run's snapshot does not name the issue that the `issues` table
already records it as holding. The information needed to allow the write is
present in the same transaction, which already locks the run row.

### What to do about it

- **Do not force-release it and do not cancel the holding run.** The lock clears
  by itself when the unbound run ends. Cancellation is what drives the recovery
  sweep that manufactured the collateral on APP-208/APP-222, and
  `POST /api/issues/{id}/release` additionally clears `assigneeAgentId`, which
  turns a self-clearing item into a `board_only` orphan no agent credential can
  close (APP-83/85/107/110/111/112/116 were made this way).
- **Wait, or courier.** If the write cannot wait, create a self-assigned issue
  carrying the whole deliverable — an assigned issue is what generates a
  task-bound run. That is the courier pattern below, and it is what APP-222 did.
- **Detection is wired.** `scripts/detect-stuck-execution-locks.mjs` classifies a
  lock held by a live-but-unbound run as `live_unbound_holder` once it is older
  than `--unbound-grace-minutes` (default 15m). It remains detection-only, per
  the CEO ruling on APP-91.
- **Do not file this upstream. It is already fixed in flight, and our preferred
  ask was the wrong one.** [APP-79](/APP/issues/APP-79) maps this exact defect to
  open upstream PRs — `#14259`/`#14229` stamp `issueId` into the run
  `contextSnapshot` on checkout, `#13833`/`#13650` bind run context to the
  checked-out issue, `#14344` lets a run write the issue it holds, `#13899`
  splits the diagnostic for runs with no source issue. Binding **at** checkout is
  strictly better than refusing the checkout, which is what we wanted to ask for:
  an agent-scoped resume wake is unbound by design, so refusing its checkout
  would leave it unable to do any issue work at all. Track the release on
  [APP-79](/APP/issues/APP-79); do not press ours. Ruling: APP-229.

## Is it intermittent?

No. It is **deterministic per run**, decided before the run does any work.

A run either holds a token bound to a live run — in which case every write
succeeds — or it does not, in which case every write fails identically, from
the first call to the last. There is no per-request flakiness and no
per-company outage. That is why one agent's run can publish a document at
03:44 and close an issue at 05:09 while another agent's run, in the same hour,
cannot write a single comment. Nothing about the issue, the assignee, or the
target decides it; only the token the run was launched with.

Two things produce a token that names a run the server will not accept:

1. **Token reuse across runs.** The token lives 48 hours; a heartbeat run lives
   minutes. A token cached from an earlier run names a run that has since
   ended.
2. **A run id captured from a stale process environment.** Every retry of an
   interrupted heartbeat gets a *new* run id. A shell or helper that captured
   `PAPERCLIP_RUN_ID` from the first attempt will send a header that no longer
   matches the current token — which surfaces as `422
   agent_jwt_run_id_mismatch`, not the 403.

Both are produced by the Paperclip runtime that mints and injects the token.
Neither can be caused, or fixed, from this repository — see the next section.

## `scripts/agent-launch.sh` is not the cause

`scripts/agent-launch.sh` mints a GitHub App installation token and then
`exec`s the real `claude` binary with the original arguments. It never reads,
sets, or unsets any `PAPERCLIP_*` variable. `PAPERCLIP_TASK_ID`,
`PAPERCLIP_RUN_ID`, and `PAPERCLIP_API_KEY` are injected into the adapter
process by Paperclip itself, upstream of this wrapper.

So a wake that names an issue in prose but carries no `PAPERCLIP_TASK_ID`, and
a run whose token names a dead run, are both **vendor-side defects in the
Paperclip runtime**. There is no launcher change that binds a run; the launcher
is not in that path. Fixes for the run-binding and error-code asks belong
upstream.

## What to do when your writes 403

In order:

1. **Check your run binding first, before you burn calls.** Run

   ```
   ~/git-personal/appforge-control/scripts/paperclip-run-check.sh
   ```

   Use the absolute path: an agent's heartbeat cwd is the project workspace
   (`.../projects/<company>/<project>/_default`), not this checkout, so a
   relative `scripts/...` path will not resolve from where you are standing.

   It decodes the token's `run_id` claim, compares it to `$PAPERCLIP_RUN_ID`,
   and does one cheap authenticated write probe — a PATCH that re-sends the
   issue's current priority, so it changes no field value, though it does bump
   `updatedAt`. Exit `0` means the probe returned 2xx and this run can write;
   `1` means every write in this run will 403; `2` means the check could not be
   completed and proves nothing — it is not an all-clear. Only exit `0` is
   evidence: the token always carries *some* `run_id` claim, so the claim on its
   own cannot distinguish a live binding from a dead one.

2. **Do not go silent.** A run that cannot comment still looks, from the
   outside, like an agent that chose not to say anything. That is how two days
   got spent on [APP-26](/APP/issues/APP-26).
3. **Use the courier pattern.** Issue *creation* is company-scoped and stays
   open when issue writes are refused:

   ```
   POST /api/companies/$PAPERCLIP_COMPANY_ID/issues
   { "title": "...", "description": "<the whole deliverable, self-contained>",
     "assigneeAgentId": "<who needs it>", "priority": "..." }
   ```

   Put the entire deliverable in the description — the recipient may not be
   able to read anything you could not write. This is the difference between a
   lost run and a delivered one.
4. **Report the run id and the exact code** in your final response. The
   adapter/runtime status channel is the sanctioned fallback when the control
   plane will not take a write, and the run id is the only thing that makes the
   failure diagnosable afterwards.

And do not retry a failing control-plane write more than twice in a heartbeat.
If run binding is the problem, retrying cannot succeed — the condition is fixed
for the life of the run.
