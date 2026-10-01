# Which repos your run can push to, and why the obvious check lies

Short version: **run `scripts/repo-scope-check.sh` before you implement
anything.** It reads two environment variables, makes no network call, and
tells you in milliseconds whether `git push` can possibly succeed for the repo
your task is about.

This document exists because APP-251 was filed on a measurement that looked
authoritative and was not, and because APP-249 spent three runs — two of them
to the turn limit — implementing a correct 21-line change that could never be
published.

## The two different lists

There are two repo lists in this system and they are routinely confused. They
are set in different places, by different people, and only one of them is why
your push failed.

| | What it is | Where it is set | Who changes it |
|---|---|---|---|
| **Installation selection** | The repos the `appforge-agents` App is installed on, account-wide | GitHub App settings on the `ravitejakamalapuram` account | Founder, by hand, in GitHub's web UI |
| **Your run's token scope** | The subset of those repos *your* token was minted for | `APPFORGE_AGENT_REPOS`, per-agent, in the Paperclip adapter config | A permission change — founder/board call |

`scripts/agent-launch.sh` mints your token with
`github-app-token.mjs --repos "$APPFORGE_AGENT_REPOS"`. So your reach is the
**second** list, and it is **per-agent**: CTO's list and Builder's list are
different, and neither is the installation.

That asymmetry is what makes this easy to misdiagnose. A repo can be reachable
from every session that goes looking for it and still be unreachable from the
agent that was assigned the work.

## The trap: `GET /installation/repositories` does not tell you the installation

This is the load-bearing correction, and it is the one that produced a wrong
bug report.

`GET /installation/repositories` is authenticated **with an installation
token**, and it returns the repositories **that token carries** — not the
repositories the installation is selected for. When your token was minted with
`--repos a,b,c`, that endpoint returns exactly `a,b,c`. It will confirm
whatever your scope already is, with an official-looking `total_count`, and it
is no evidence about the installation at all.

So this chain of reasoning is invalid, even though every step of it returns a
real result:

```
git push               -> remote: Repository not found.
GET /repos/<owner>/X   -> 404
GET /installation/repositories -> [9 repos, X not among them]
∴ the App is not installed on X          <-- DOES NOT FOLLOW
```

All three observations are equally explained by "X is not in *my token's*
scope", which is the far likelier cause and the cheaper one to check.

**To actually read the installation selection** you need the App JWT, not an
installation token — mint a token with *no* `repositories` field and list from
that, or read `repository_selection` from `GET /app/installations`. Both need
the App private key. This is a CTO-level check, not something to do mid-task:
if your repo is out of scope, escalate, and let it be checked once.

Measured this way on 2026-09-30 (APP-251), the installation selection is
**12 repos** and includes `appforge-control`, `appforge-brain` and `InvTrack`.
`config/github-apps.yaml` records 11 under `installed_on`.
On 2026-10-01 the founder added `release-platform` to the installation
(branches and draft PRs only; see `config/github-apps.yaml`). That was not
re-measured with the App JWT.

## What the failure actually looks like

```
$ git push origin my-branch
remote: Repository not found.
fatal: repository 'https://github.com/ravitejakamalapuram/<repo>/' not found
```

Read this as **"my token does not cover this repo"**, not as "the repo is
missing", "the token expired" or "the credential is broken". A token that is
scoped away from a private repo cannot distinguish it from a nonexistent one,
and GitHub deliberately returns 404 rather than 403 so that private repo names
do not leak. The message is working as designed; it just cannot say the useful
thing.

Two wrong moves this invites, both of which have been made here:

- **Going to find a different credential.** `gh auth git-credential`, `~/.ssh`
  and the App private key are all reachable at this uid. Using any of them to
  get around a scope that failed closed is the `DEC-0013` containment gap, and
  it is forbidden. The scope failing is the system working.
- **Re-passing your own token on the command line.** That sends the header
  twice and GitHub answers `400 Duplicate header: "Authorization"`, which reads
  like a bad token and is not. See `docs/git-credentials-in-agent-runs.md`.

## What to do when you are out of scope

At turn one, before implementing:

1. Say so on the issue, naming the repo and quoting your
   `APPFORGE_AGENT_REPOS`.
2. Escalate to your manager to have the task **re-routed** to an agent whose
   scope covers it, or to have your scope **widened**. Widening is a permission
   change: it is not in any agent's authority, including the CTO's, and it goes
   to the founder.
3. Then decide whether any part of the task is still worth doing in this run.
   Often the design work is, and only the push is blocked — but decide it
   deliberately, at the start, rather than discovering it at the end.

What you must not do is implement first and discover the wall at push time.
The work is not wasted because the scope is narrow; it is wasted because the
scope was checked last instead of first.

## Standing policy: CTO and Builder cover every repo

Since 2026-10-01 the founder has set CTO's and Builder's
`APPFORGE_AGENT_REPOS` to every company repo, `appforge-control`,
`InvTrack` and `release-platform` included (DEC-0022, which supersedes
DEC-0021's "`appforge-control` is CTO/CEO-only"). Builder implements
control-repo work assigned to it. Wider scope does not change the rest:
draft PRs only, no merge, `.github/workflows/**` through the board's
assistant. Other agents keep narrower lists, so the turn-one check above
still applies to them.

## Related

- `docs/git-credentials-in-agent-runs.md` — where the credential lives and how
  it is injected.
- `docs/containment-model.md` — why none of this is a containment boundary; the
  uid is.
- `docs/capabilities.md` — what the `repo:*` capability strings mean, and the
  `config/github-apps.yaml` exclusions.
