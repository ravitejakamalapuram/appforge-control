#!/bin/bash
# setup.sh — one-time creation of the appforge-webhook Cloudflare Tunnel (P1-03, master plan §4.4).
#
# What this does, once its one precondition is met:
#   1. Creates the named tunnel `appforge-webhook` (idempotent — reuses it if it already exists),
#      via the origin cert `cloudflared tunnel login` writes to ~/.cloudflared/cert.pem.
#   2. Fills in config.yml's placeholders (tunnel id, credentials file path, and the tunnel's
#      default <tunnel-id>.cfargotunnel.com hostname — see config.yml's own header comment for why
#      cfargotunnel.com and not a subdomain of an existing zone in this account).
#   3. Validates the ingress config.
#   4. Installs and starts a LaunchAgent (ing.paperclip.appforge-tunnel) that runs
#      `cloudflared tunnel run` with this config, matching the existing pattern in
#      infra/macos/ (Paperclip's own service, appforge-sync, appforge-backup — all founder-user
#      LaunchAgents, no separate macOS user, no sudo).
#   5. Records the final public webhook URL into
#      appforge-control/secrets/notify-paperclip.webhook-secret.json.
#
# PRECONDITION this script cannot satisfy itself: ~/.cloudflared/cert.pem must already exist,
# which only `cloudflared tunnel login` can create — that command opens an interactive browser
# window for the Cloudflare account owner to approve. Per this repo's standing rule (README.md in
# this directory), that is a founder action, not something automated here. Run it once:
#
#   cloudflared tunnel login
#
# then re-run this script.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUNNEL_NAME="appforge-webhook"
CERT_PATH="${HOME}/.cloudflared/cert.pem"
CREDS_PATH="${HOME}/.cloudflared/${TUNNEL_NAME}.json"
PLIST_LABEL="ing.paperclip.appforge-tunnel"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="${HERE}/../../logs"
SECRET_RECORD="${HERE}/../../secrets/notify-paperclip.webhook-secret.json"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found — install it first: brew install cloudflared" >&2
  exit 1
fi

if [ ! -f "$CERT_PATH" ]; then
  echo "Missing $CERT_PATH." >&2
  echo "This is the one step that needs the founder's own browser: run 'cloudflared tunnel login'," >&2
  echo "approve the appforge-webhook.ing (or whichever) zone/account in the browser it opens, then re-run this script." >&2
  exit 1
fi

# --- 1. Create (or reuse) the tunnel -----------------------------------------------------------
if cloudflared tunnel --origincert "$CERT_PATH" list --output json 2>/dev/null | \
   python3 -c "import json,sys; data=json.load(sys.stdin); sys.exit(0 if any(t['name']=='$TUNNEL_NAME' for t in data) else 1)"; then
  echo "Tunnel '$TUNNEL_NAME' already exists — reusing it."
else
  echo "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel --origincert "$CERT_PATH" create --credentials-file "$CREDS_PATH" "$TUNNEL_NAME"
fi

TUNNEL_ID=$(cloudflared tunnel --origincert "$CERT_PATH" list --output json | \
  python3 -c "import json,sys; data=json.load(sys.stdin); print(next(t['id'] for t in data if t['name']=='$TUNNEL_NAME'))")

if [ ! -f "$CREDS_PATH" ]; then
  # Tunnel pre-existed from a prior run under a different credentials path — fetch a fresh token.
  echo "Fetching credentials for existing tunnel $TUNNEL_ID..."
  cloudflared tunnel --origincert "$CERT_PATH" token --cred-file "$CREDS_PATH" "$TUNNEL_ID" >/dev/null
fi

TUNNEL_HOSTNAME="${TUNNEL_ID}.cfargotunnel.com"
echo "Tunnel ID: $TUNNEL_ID"
echo "Public hostname: $TUNNEL_HOSTNAME"

# --- 2. Fill in config.yml ----------------------------------------------------------------------
CONFIG_PATH="${HERE}/config.yml"
sed -e "s#__TUNNEL_ID__#${TUNNEL_ID}#" \
    -e "s#__CREDENTIALS_FILE__#${CREDS_PATH}#" \
    -e "s#__TUNNEL_HOSTNAME__#${TUNNEL_HOSTNAME}#" \
    "${HERE}/config.yml" > "${HERE}/config.generated.yml"

# --- 3. Validate ----------------------------------------------------------------------------------
# NOTE: cloudflared's flag parser wants --config on `tunnel`, not on the `ingress validate`
# subcommand (`cloudflared tunnel --config FILEPATH ingress validate`) — passing it after
# `ingress validate` is silently accepted by urfave/cli as an "Incorrect Usage" print but still
# exits 0, so a naive `--config` placement here would look like it validated when it never did.
cloudflared tunnel --origincert "$CERT_PATH" --config "${HERE}/config.generated.yml" ingress validate

# --- 4. Install the LaunchAgent -------------------------------------------------------------------
mkdir -p "$LOG_DIR"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${PLIST_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(command -v cloudflared)</string>
		<string>tunnel</string>
		<string>--config</string>
		<string>${HERE}/config.generated.yml</string>
		<string>run</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${HERE}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${LOG_DIR}/cloudflare-tunnel.log</string>
	<key>StandardErrorPath</key>
	<string>${LOG_DIR}/cloudflare-tunnel.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/${PLIST_LABEL}"

echo "LaunchAgent ${PLIST_LABEL} installed and started."

# --- 5. Record the public webhook URL --------------------------------------------------------
PUBLIC_URL="https://${TUNNEL_HOSTNAME}/api/routine-triggers/public/9dabc06113842e4b28185b1d/fire"
python3 - "$SECRET_RECORD" "$PUBLIC_URL" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["publicWebhookUrl"] = url
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo ""
echo "Done. Public webhook URL: $PUBLIC_URL"
echo "Next: set this as the PAPERCLIP_WEBHOOK_URL GitHub Actions secret (and the existing"
echo "webhookSecret field as PAPERCLIP_WEBHOOK_SECRET) in every caller repo — see"
echo "infra/cloudflare-tunnel/README.md."
