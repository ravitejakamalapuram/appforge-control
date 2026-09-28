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
| `APPFORGE_AGENT_REPOS=none` | **Cooperative at the API level, partly enforced at the env level.** `agent-launch.sh` really does scrub `GH_TOKEN`/`GITHUB_TOKEN` and reset git's credential helpers — but see `WHAT THIS DOES NOT CLOSE` in that script: the App private key, `~/.ssh`, and `gh auth git-credential` all remain reachable at this uid. |
| Per-run cross-issue write cap (`cross_issue_influence_cap_exceeded`) | **Credentialed writes only.** Never evaluated for an actor presenting no credential. |
| `issue_write_actor_class_excluded`, responsible-user ceiling, assignee run lock | **Credentialed writes only**, same reason. Real features; not containment. |
| Run-attribution audit trail | **Advisory.** An unattributed write is possible, so the trail cannot be relied on to name every actor. Knowingly accepted, not an oversight. |

The mechanisms in the bottom three rows are documented in `docs/paperclip-run-binding.md`. All of
them are reached only *after* credential verification — see that doc's
"What this table does not bind".

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
