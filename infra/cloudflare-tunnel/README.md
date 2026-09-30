# infra/cloudflare-tunnel — P1-03 webhook ingress (master plan §4.4)

Lets GitHub Actions (running in product repos) notify the locally-running Paperclip instance
(`http://127.0.0.1:3100`) when something happens in CI — without a public IP or open port on the
founder's Mac. §4.4's original default was GitHub Actions → Tailscale → localhost; the founder
chose the **Cloudflare Tunnel fallback** instead (settled — not revisited here).

## What's already done

- `cloudflared` installed (`brew install cloudflared`, v2026.9.3).
- Investigated this Cloudflare account (id `e08ac904468d19ea525b3005cc54888b`, via the Tunnel API
  with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_R2_API_TOKEN` from `~/git-personal/.envrc`): one zone
  exists, `echo-kit.com`, but this tunnel deliberately does **not** use a subdomain of it —
  Paperclip is shared control-plane infra for every product repo, not part of any one app, so it
  gets no dependency on another app's domain (same principle as
  `confirm-architecture-extensible`: no app should depend on another app's repo or credentials).
  It was set up to use the tunnel's own default `<tunnel-id>.cfargotunnel.com` hostname instead —
  **this turned out not to work for public HTTP ingress; see the status section below**, which is
  where that got discovered and where the resulting decision is pending.
- Neither `CLOUDFLARE_API_TOKEN` nor `CLOUDFLARE_R2_API_TOKEN` has the `Cloudflare Tunnel: Edit`
  permission (confirmed: both can `GET /accounts/{id}/cfd_tunnel` (200, empty list) but `POST` to
  create one 403s with `{"code":10000,"message":"Authentication error"}` on both tokens) — so the
  tunnel cannot be created purely via the REST API with credentials already in this environment.
- `config.yml` — the ingress config, scoped to **only** the one Paperclip webhook path
  (`/api/routine-triggers/public/9dabc06113842e4b28185b1d/fire`); everything else 404s at the
  tunnel, never reaching Paperclip's dashboard or general API.
- `setup.sh` — creates the tunnel, fills in `config.yml`, installs it as a founder-user LaunchAgent
  (`ing.paperclip.appforge-tunnel`, same pattern as `infra/macos/`), and records the public webhook
  URL. Fully idempotent; safe to re-run.
- The Paperclip side is fully wired and tested (see "What's tested" below): a routine + a
  `github_hmac` webhook trigger exist in the live company, assigned to CTO for the json-workbench
  project.
- `appforge-kit/.github/workflows/notify-paperclip.yml` — the reusable GitHub Actions workflow
  product repos call. HMAC-signs the payload, sets an idempotency key, POSTs to the tunnel.
- The webhook secret is recorded in `appforge-control/secrets/notify-paperclip.webhook-secret.json`
  (gitignored).

## Status as of 2026-09-28: login done, tunnel is up, public DNS is the remaining blocker

`cloudflared tunnel login` is **done** — the founder completed it and `~/.cloudflared/cert.pem`
exists. `./setup.sh` has been run: tunnel `appforge-webhook` (id `ed7c0616-e8d8-4729-81e5-1f9eeaead9e0`)
is created, `config.generated.yml` validates, and it's running as the `ing.paperclip.appforge-tunnel`
LaunchAgent (`launchctl list | grep appforge-tunnel` shows it up; its log shows 4 registered edge
connections over `http2`, degraded from `quic` because outbound UDP/7844 is restricted on this
network — functionally fine, just not the fastest transport).

**New blocker found while wiring this up, not present when this doc was first written:** the plan
above (this tunnel's default `<tunnel-id>.cfargotunnel.com` hostname, deliberately *not* a
subdomain of the account's one zone `echo-kit.com`, to avoid coupling shared Paperclip infra to
EchoKit's domain) does not actually work for public HTTP ingress. Per Cloudflare's own docs
(Cloudflare One → Cloudflare Tunnel → Published applications → DNS records): `<UUID>.cfargotunnel.com`
is only ever a **CNAME target** — Cloudflare's edge only proxies HTTP(S) traffic for a hostname that
has an actual DNS record (in a zone in this account) pointed at it via `cloudflared tunnel route dns`
or the dashboard. Visiting the bare UUID hostname directly does not resolve (confirmed: no A/AAAA
from 1.1.1.1 or 8.8.8.8, and hitting Cloudflare's edge IPs directly with that SNI/Host returns an
empty connection, not even a 404). So as configured, nothing external can reach this tunnel yet —
only `cloudflared tunnel run` itself, which authenticates outbound to Cloudflare's edge, is up.

Fixing this needs a hostname in a zone this Cloudflare account actually owns, and the account has
exactly one: `echo-kit.com` (confirmed live via the Zones API, 2026-09-28). Per this repo's own
`confirm-architecture-extensible` rule, that's a real architectural fork, not a one-line fix to make
unilaterally — **needs the founder's call** among (at least):

1. **Subdomain of `echo-kit.com`** (e.g. `paperclip-webhook.echo-kit.com`), CNAME'd to the tunnel via
   `cloudflared tunnel route dns appforge-webhook paperclip-webhook.echo-kit.com`. Free, zero new
   accounts, ~2 minutes. Trade-off: the shared control-plane's public hostname lives in EchoKit's DNS
   zone — no credential/repo coupling (this is just a DNS record, not shared secrets), but it does
   mean anyone inspecting EchoKit's DNS sees a Paperclip-related subdomain next to it.
2. **A new, dedicated domain for shared appforge infra** (e.g. something in the `appforge-*` /
   `paperclip-*` family), added as its own zone in this same Cloudflare account. Keeps the "no app
   depends on another app's domain" principle intact fully. Trade-off: costs money (~$10-15/yr) and
   is one more thing to renew/maintain.
3. **A Cloudflare Worker on the free `workers.dev` subdomain acting as a thin reverse proxy** into
   this tunnel (Worker → Tunnel via `cloudflared`'s connector, or Worker calls out over the existing
   tunnel's private hostname). Free and domain-neutral like option 1's goal, but adds a second moving
   part (a Worker to write, deploy, and keep in sync) for what is otherwise a one-path proxy.
4. Reopen the Tailscale option the master plan's §4.4 originally defaulted to before the Cloudflare
   fallback was chosen — listed only for completeness; §4.4 calls that a settled decision not to
   revisit, so this isn't recommended without the founder explicitly reopening it.

None of these need re-running `setup.sh`'s tunnel-creation step — only `cloudflared tunnel route dns`
(or the dashboard equivalent) once a hostname is chosen, then updating `config.generated.yml`'s
`hostname:` field (or re-running `setup.sh` after templating that choice into `config.yml`) and
restarting the LaunchAgent (`launchctl kickstart -k gui/$(id -u)/ing.paperclip.appforge-tunnel`).

### Decision, 2026-09-30: use a subdomain of `echo-kit.com`

The founder chose the faster route (option 1) so shipping is not blocked on buying a domain.
`hooks.echo-kit.com` is a DNS record only, with no shared credentials or repos, and the hostname is a
single setting, so moving to a dedicated domain later (option 2) is a re-run, not a redesign:

```
TUNNEL_HOSTNAME=hooks.echo-kit.com ./setup.sh     # creates the DNS route, regenerates config, restarts
```

### After a hostname is chosen, wire up each product repo (starting with json-workbench)

1. In the repo's GitHub settings → Secrets and variables → Actions, add:
   - `PAPERCLIP_WEBHOOK_URL` — `https://<chosen-hostname>/api/routine-triggers/public/9dabc06113842e4b28185b1d/fire`.
   - `PAPERCLIP_WEBHOOK_SECRET` — the `webhookSecret` value from
     `appforge-control/secrets/notify-paperclip.webhook-secret.json`.
2. Add a job that calls the reusable workflow (see
   `appforge-kit/.github/workflows/notify-paperclip.yml`'s own header comment for the exact
   `uses:`/`with:`/`secrets:` block). **Correction (2026-09-28): json-workbench's CI does NOT have
   this wired yet** — checked `json-workbench/.github/workflows/ci.yml` directly, no
   `notify-paperclip` reference exists. That's still open, and blocked on the same hostname decision
   (no point wiring a CI secret to a URL that isn't final).

## What's tested (without the tunnel — see above for why)

The full Paperclip-side chain was verified directly against `127.0.0.1:3100` (bypassing the
not-yet-created tunnel, since only the last mile — internet → tunnel → localhost — is blocked, not
the receiving side):

1. Created routine `4cb1f35d-d7c6-4767-8ac5-3f92a2ddea6b` ("GitHub CI/PR notifications
   (json-workbench)") in the live company (`18b2b6ef-fbaa-48d1-acf4-168841c269ae`), assigned to CTO
   (`3cba1fb3-21e1-4851-832b-95de5247bff1`), project `json-workbench`
   (`6e0bb173-df1b-421c-82b5-6c2073caf93b`).
2. Added a `webhook` trigger with `signingMode: "github_hmac"`
   (`76b5e6af-d7b3-4e75-9a8a-201c6b457ecf`, publicId `9dabc06113842e4b28185b1d`).
3. Sent a signed POST (HMAC-SHA256 of the raw body, `X-Hub-Signature-256: sha256=<hex>`, matching
   exactly what `notify-paperclip.yml` sends) directly to
   `http://127.0.0.1:3100/api/routine-triggers/public/9dabc06113842e4b28185b1d/fire` — got HTTP 202
   with `"status":"issue_created"`.
4. Confirmed via `paperclipai issue list`: issue **APP-44** was created, assigned to CTO, and CTO
   had already picked it up (`status: in_progress`) — proving the whole chain (webhook → routine
   run → issue → agent wake) works.
5. Closed APP-44 immediately with a comment marking it a synthetic wiring test (fake PR #9999, no
   real repo activity) so CTO didn't spend real budget chasing a nonexistent PR.

The tunnel itself is now up (see status section above) and its outbound leg to Cloudflare's edge is
confirmed live (4 registered connections in `logs/cloudflare-tunnel.log`). What's still not done is
the inbound leg — a real `git push`/PR event through `notify-paperclip.yml` from json-workbench,
over the actual public hostname, confirming the last mile. That's the one part of P1-03's "test it
end-to-end" requirement not yet done, and it's blocked on the hostname decision above (there is no
publicly reachable URL to send that event to yet).

## Rotating the secret

```
paperclipai routine trigger:rotate-secret 76b5e6af-d7b3-4e75-9a8a-201c6b457ecf
```

invalidates the old secret immediately. Update
`appforge-control/secrets/notify-paperclip.webhook-secret.json` and every caller repo's
`PAPERCLIP_WEBHOOK_SECRET` Actions secret with the new value at the same time.
