#!/usr/bin/env bash
# One-time setup for in-app updates. Run it from the repository root on your own machine:
#
#   scripts/setup-updater-key.sh
#
# 1. creates the updater signing key in ~/.tauri/zwotrainer.key (kept outside the repo)
# 2. writes its public key into src-tauri/tauri.conf.json (plugins.updater.pubkey)
# 3. stores the private key and its password as GitHub repository secrets
#    (TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD) with the gh CLI
#
# Back up ~/.tauri/zwotrainer.key and its password (e.g. in your password manager). Without
# them no update can ever reach the apps that are already installed.
set -euo pipefail

KEY="${HOME}/.tauri/zwotrainer.key"
CONF="src-tauri/tauri.conf.json"
REPO="${REPO:-steffenr/zwo-trainer}"

[ -f "$CONF" ] || { echo "Run this from the zwoTrainer repository root." >&2; exit 1; }
command -v cargo >/dev/null || { echo "cargo is missing (install Rust with rustup)." >&2; exit 1; }
command -v node >/dev/null || { echo "node is missing (needed to edit tauri.conf.json)." >&2; exit 1; }
cargo tauri --version >/dev/null 2>&1 || { echo "Install the Tauri CLI first: cargo install tauri-cli --version \"^2\" --locked" >&2; exit 1; }

if [ -f "$KEY" ]; then
  echo "Using the existing key $KEY"
  read -r -s -p "Its password (empty if none): " PASSWORD; echo
else
  read -r -s -p "Password for the new key (recommended; empty for none): " PASSWORD; echo
  read -r -s -p "Repeat the password: " AGAIN; echo
  [ "$PASSWORD" = "$AGAIN" ] || { echo "The passwords don't match." >&2; exit 1; }
  mkdir -p "$(dirname "$KEY")"
  if [ -n "$PASSWORD" ]; then
    cargo tauri signer generate -w "$KEY" -p "$PASSWORD" >/dev/null
  else
    cargo tauri signer generate -w "$KEY" --ci >/dev/null
  fi
  chmod 600 "$KEY"
  echo "Created $KEY (and $KEY.pub). Back up the key and its password now."
fi

PUB="$(cat "$KEY.pub")"
PUB="$PUB" CONF="$CONF" node -e '
  const fs = require("fs");
  const path = process.env.CONF;
  const conf = JSON.parse(fs.readFileSync(path, "utf8"));
  conf.plugins.updater.pubkey = process.env.PUB.trim();
  fs.writeFileSync(path, JSON.stringify(conf, null, 2) + "\n");
'
echo "Wrote the public key into $CONF."

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$KEY"
  printf '%s' "$PASSWORD" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$REPO"
  echo "Stored TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD in $REPO."
else
  echo
  echo "gh isn't installed or signed in. Add these repository secrets by hand"
  echo "(GitHub → Settings → Secrets and variables → Actions → New repository secret):"
  echo "  TAURI_SIGNING_PRIVATE_KEY           the contents of $KEY"
  echo "  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  the password (leave the secret out if there is none)"
fi

echo
echo "Next: commit $CONF and release as usual. Apps from that release on update themselves."
