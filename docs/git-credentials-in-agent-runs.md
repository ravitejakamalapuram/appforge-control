# How git authenticates inside an agent run

Short version: **your run's GitHub credential is already configured. Do not
configure it again.** Run `git fetch` / `git push` plainly, with no `-c
http.*.extraheader=...` and no `git config` credential setup of your own.

This document exists because APP-190 lost time to the opposite assumption, and
APP-197 was filed on a misreading of where the credential lives.

## Where the credential actually lives

`scripts/agent-launch.sh` mints a per-run GitHub App installation token and
exports it through git's environment-variable config, not through any file:

```
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=credential.helper          GIT_CONFIG_VALUE_0=""
GIT_CONFIG_KEY_1=http.https://github.com/.extraheader
                                            GIT_CONFIG_VALUE_1="AUTHORIZATION: basic <b64 of x-access-token:ghs_...>"
```

`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` apply to **this process tree only**. Nothing
is written to `.git/config`, to `~/.gitconfig`, or to the AppForge global config
at `~/.appforge/.gitconfig-appforge`. When the run's process tree exits, the
credential is gone with it — which is exactly the containment property the
per-run mint exists to provide.

You can confirm the scope yourself; `git config` reports it as `command`, never
`local` or `global`:

```
$ git config --list --show-origin --show-scope | grep extraheader
command   command line:   http.https://github.com/.extraheader=AUTHORIZATION: basic ...
```

`APPFORGE_GIT_CREDENTIAL` tells you which path your run took: `app` (a token was
minted) or `none` (the credential-free path — `APPFORGE_AGENT_REPOS=none`, or the
degraded path after a mint failure). On `none`, https to github.com is *meant* to
fail closed. That is not a bug to route around.

## The failure this prevents

If you helpfully pass the credential again on the command line, git sends the
header twice and GitHub rejects the request:

```
$ git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(...)" ls-remote origin
remote: Duplicate header: "Authorization"
fatal: unable to access 'https://github.com/...': The requested URL returned error: 400
```

The message is misleading in a specific way: it reads like a bad or expired
token, when in fact both headers were valid. Resist the two wrong inferences it
invites — that the ambient credential is some other run's leftover, and that the
remedy is to go find a different credential. The ambient one **is** your run's
own token, scoped to the repos in your `APPFORGE_AGENT_REPOS`. Drop your `-c`
flag and the same command succeeds.

## Do not persist a credential into a shared checkout

`~/git-personal/appforge-brain` and `~/git-personal/appforge-control` are single
working copies shared by every agent (see the worktree convention in
`docs/paperclip-run-binding.md` and APP-33 / APP-49). Running `git config --local
http.https://github.com/.extraheader=...` there would write your short-lived
token into state the next agent inherits — turning a per-run credential into an
ambient one that `agent-launch.sh` never granted them, and leaving a confusing
hard failure behind once it expires. Never do it. There is no case where you need
to: env config already covers every git invocation in your run.

As of the APP-197 sweep (2026-09-29) no persisted `extraheader` exists in any
`.git/config` under `~/git-personal` or the run scratch dirs, and none is written
by any script in this repo. If you ever find one, treat it as a live credential
leak: report it, and do not remove it unilaterally — another agent's in-flight
run may be relying on it.

## What is still not closed

This is hygiene inside the uid, not isolation. The limits are enumerated in the
`WHAT THIS DOES NOT CLOSE` block at the top of `scripts/agent-launch.sh` — the
App private key is readable, `~/.ssh` is reachable, `gh auth git-credential`
still returns a founder token from the OS keyring, and the Paperclip control
plane is not contained by any of this. The uid is the boundary. Do not use any of
those paths to get around a credential that failed closed.
