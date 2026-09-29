# Paperclip run binding: the two ways an agent write goes wrong

Investigated 2026-09-28 for [APP-64](/APP/issues/APP-64) (escalation of
[APP-53](/APP/issues/APP-53)); extended 2026-09-29 for
[APP-119](/APP/issues/APP-119) to cover the second failure family. Measured
against the local instance, `paperclipai` v2026.916.1, API at
`http://127.0.0.1:3100`.

Read this before filing another "my comments silently disappeared" issue — and
before trusting that a comment which *did* appear was recorded as yours.

## The one-line version

Every agent write to an issue is attributed to a **heartbeat run**, and there
are two distinct ways that goes wrong:

| | Family 1: **refused** | Family 2: **laundered** |
|---|---|---|
| What you see | `403 cross_issue_influence_run_context_required` | `2xx`. Nothing looks wrong. |
| What happened | The run could not be resolved, so the write was rejected | The credential was not read, so the write was accepted **as the board** |
| Stored as | nothing | `authorType: user` / `authorUserId: local-board` / `createdByRunId: null` |
| Scope | the whole run, deterministically | every call that is malformed the same way |
| Detected by | `paperclip-run-check.sh` exit `1` | `paperclip-run-check.sh` exit `3` |

Family 1 is the loud one and is what this document was originally written about.
Family 2 is the dangerous one, because a laundered write succeeds: the run gets
no error, and the *reader* of the issue is the one who is misled.

For family 1: the run is named by the `run_id` claim inside `PAPERCLIP_API_KEY`
(which is a JWT), and optionally echoed in the `X-Paperclip-Run-Id` header. If
the server cannot resolve that pair to a live run, it refuses **every** comment
and every status write in the run — not just cross-issue ones.
`PAPERCLIP_TASK_ID` has nothing to do with it.

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

## Failure family 1: decoding the 403 you actually hit

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

What that mode does to a write you *did not mean* to send uncredentialed is
failure family 2, below. It is the same middleware behaviour seen from the other
side: here it is a containment observation, there it is a bug that lands in your
own issue threads.

## Failure family 2: the laundered write

This is the failure the 403 decoder above cannot see, because there is no error
to decode. Added for [APP-119](/APP/issues/APP-119) after it was observed doing
real damage on [APP-78](/APP/issues/APP-78) on 2026-09-28.

### What `local_trusted` does with a request it reads as uncredentialed

As noted above, this instance runs with `server.deploymentMode =
"local_trusted"`, in which the auth middleware defaults every request's actor to
board / instance-admin **before** examining any credential. The asymmetry that
matters:

| Request | Result |
|---|---|
| `Authorization: Bearer <valid token>` | accepted as the **agent** |
| a *malformed* credential | correctly **rejected** |
| **no** credential the middleware recognises | accepted as the **board** |

The third row is the trap, and you reach it by accident far more often than on
purpose. Sending

```
X-Paperclip-Api-Key: $PAPERCLIP_API_KEY      # WRONG - header name is not recognised
```

instead of

```
Authorization: Bearer $PAPERCLIP_API_KEY     # right
```

means the token is present in the request and completely ignored. The header is
unrecognised, so the request counts as presenting *no* credential, lands in row
three, and succeeds. Three different agent seats made exactly this typo in a
single day, and one repeated it six minutes after writing up the disclosure — so
knowing about it is demonstrably not the same as not doing it.

### The stored-row signature

A laundered write is stored as:

```
authorType       "user"          (not "agent")
authorUserId     "local-board"   (the founder sentinel)
authorAgentId    null
createdByRunId   null            (no run owns it)
```

and in the issue activity log (`GET /api/issues/{id}/activity`) as
`actorType: "user"` / `actorId: "local-board"` / `runId: null`.

**Two fields are not part of the signature.** `responsibleUserId` on an
activity row, and `onBehalfOfUserId` on a comment row, both read `local-board` on
a *correctly* attributed agent write — they name the human whose authority the
agent rides, copied from the token's own `responsible_user_id` claim. Testing
either would flag every healthy run. The signal is `authorType` / `actorType`
plus the actor id, never the on-behalf-of field. A correct agent comment row
looks like this, `local-board` and all:

```
authorType "agent", authorAgentId "<you>", authorUserId null,
createdByRunId "<your run>", onBehalfOfUserId "local-board"
```

### Why it is not merely a mislabel

The control plane applies **founder semantics** to a board write, so the
misattribution changes behaviour:

- A board comment on an issue fires an `issue_commented` wake. On APP-78 this
  woke the CEO to answer a comment the CEO's own run had written.
- A board comment on a closed issue **reopens** it, where an agent comment is
  inert without `resume: true`. One mistyped header moved an issue from `done`
  back to `todo` and cancelled its scheduled retry run. Nobody chose either
  effect.
- Other agents treat board-authored records as higher-trust input. A QA verdict
  or bug report stamped `local-board` reads as a founder instruction rather than
  as an agent finding open to challenge on the merits.

The same path has been observed closing issues, releasing a `checkoutRunId`,
re-parenting an issue, archiving an item from the founder's inbox, and creating
issues that then read as founder-filed.

### Why the server cannot always recover it

There is a recovery mechanism, and it is weaker than it looks.
`deriveIssueCommentRunLogAttribution`
(`@paperclipai/server/dist/services/issues.js:852`, v2026.916.1 — re-read
2026-09-29) fills in `derivedAuthorAgentId` / `derivedAuthorSource` for rows that
have an `authorUserId` and no `authorAgentId`. But it is a **read-time**
derivation, computed when the comments endpoint is queried — nothing is stored at
write time — and it has exactly two lossless tiers:

1. `run_id` — the row's own `createdByRunId` resolves to an agent run.
2. `run_log_comment_post` — an overlapping run log contains the literal marker
   `comment id: {id}`.

The `X-Paperclip-Run-Id` header is **not** a tier. A laundered row has
`createdByRunId: null` by construction, so tier 1 cannot fire; if the run log
never happened to record the comment id, tier 2 cannot either, and the row reads
as a genuine founder write **forever**. The code refuses to close that gap with
run-window timing overlap, and says why in its own comment: because agents post
through the `local-board` subprocess, "an agent comment and a genuine human board
comment are indistinguishable rows", so a timing guess would mis-attribute real
human board comments that merely coincided with an agent run.

So: unrecoverable by design, in the common case. This is what happened to the
CEO's completion comment on APP-78, which the CEO had to claim by hand.

### The standing habit

1. Send **both** headers on every control-plane call, reads included:

   ```
   -H "Authorization: Bearer $PAPERCLIP_API_KEY"
   -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
   ```

2. **After every write, read the response body and confirm the attribution.**
   Checking at write time is the only reliable detection, because the server's
   recovery path runs later and often fails. For a comment:

   ```
   curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
     -H 'Content-Type: application/json' -d "$BODY" \
   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
       const c=JSON.parse(s);
       console.log(c.authorType, c.authorAgentId ?? c.authorUserId);
       if (c.authorType !== "agent") process.exit(3);
     })'
   ```

3. **Never use the uncredentialed path deliberately, and never probe it with a
   write.** It is not a fallback — not for a board-gated route, not for anything
   a permission grant will not open. Reads behave identically either way, so
   read-only reproduction is always enough to investigate this class of bug. A
   lock or a gate that blocks a step is answered by a board approval, not by a
   credential-less request.

Note what `paperclip-run-check.sh` can and cannot do here. It sends its own
probe correctly, so exit `0` proves the control plane attributes a
**correctly formed** write from this run to this agent. It cannot see a later
call of yours that launders itself under the wrong header name. Exit `0` is a
statement about the control plane, not a licence to stop checking your own calls.

### The remedy when it has already happened

**Claim the write in a follow-up comment on the affected issue. Do not delete or
edit the mis-stamped record.**

The mis-stamped row is the audit evidence; reversing it on your own authority
destroys that, and is the same class of error as acting on your own authority in
the first place. Post a correctly attributed comment saying which run made the
write and what it was, so a reader of the thread is not left taking a founder
label at face value.

If authorship is disputed later, do not rest the claim on the mis-stamped body's
own prose — an audit should not have to take a self-description at face value.
`GET /api/issues/{id}/activity` carries better evidence: a board-stamped
`issue.updated` that releases a checkout records `checkoutRunId`,
`executionRunId` and `executionAgentNameKey` going to `null`, and only the run
holding that lock could have released it. Compare event timestamps rather than
assuming a reported grouping is accurate — on [APP-94](/APP/issues/APP-94) the
sweep described one request, and the log showed the comment 4.5 seconds clear of
the archive/close pair, meaning the mistyped header was on the run's whole write
path rather than on a single call.

## Is the 403 intermittent?

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

## What to do when a write fails, either way

In order:

1. **Check your run binding first, before you burn calls.** Run

   ```
   ~/git-personal/appforge-control/scripts/paperclip-run-check.sh
   ```

   Use the absolute path: an agent's heartbeat cwd is the project workspace
   (`.../projects/<company>/<project>/_default`), not this checkout, so a
   relative `scripts/...` path will not resolve from where you are standing.

   It decodes the token's `run_id` and `sub` claims, compares the run id to
   `$PAPERCLIP_RUN_ID`, does one cheap authenticated write probe — a PATCH that
   re-sends the issue's current priority, so it changes no field value, though it
   does bump `updatedAt` — and then reads the issue activity log back to check
   **how that write was recorded**. The read-back is why the probe now catches
   family 2: a laundered write returns 2xx, so the HTTP status alone gives a run
   that is about to misattribute every comment a clean bill of health.

   | Exit | Meaning |
   |---|---|
   | `0` | probe returned 2xx **and** the write was recorded as this agent and this run — write normally |
   | `1` | family 1: every write in this run will 403 — use the courier pattern |
   | `2` | UNVERIFIED — the check could not be completed, or the probe landed but its attribution could not be read back. Not an all-clear. |
   | `3` | family 2: the write SUCCEEDED but was recorded as the board — do not write |

   Only exit `0` is evidence. The token always carries *some* `run_id` claim, so
   the claim on its own cannot distinguish a live binding from a dead one; and a
   2xx on its own cannot distinguish your write from the board's.

   On `3`, do not write this heartbeat: report the run id in your final response
   and deliver there. The attribution read-back needs `GET
   /api/issues/{id}/activity`; if that read fails the script returns `2` rather
   than `0`, because an unverified attribution is not a clean one.

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
