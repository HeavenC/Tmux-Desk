#!/usr/bin/env bash
# Build a Developer ID–signed, notarized, stapled Tmux Desk DMG/zip for direct
# distribution (NOT the Mac App Store — a terminal front-end cannot run sandboxed).
#
# Prereqs (one-time):
#   • A "Developer ID Application" certificate in the login keychain
#     (check: security find-identity -v -p codesigning | grep "Developer ID Application")
#   • The App Store Connect API key .p8 at the path below (used by notarytool).
#
# Usage: scripts/release-mac.sh [arm64|x64|universal]   (default: arm64)
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"

# --- Notarization credentials (App Store Connect API key) --------------------
export APPLE_API_KEY="${APPLE_API_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_687H76CDXR.p8}"
export APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-687H76CDXR}"
export APPLE_API_ISSUER="${APPLE_API_ISSUER:-9010e018-efeb-4531-80f6-40d2e999e38a}"
TEAM_ID="${TEAM_ID:-D2U492GTU7}"

# --- Preflight ---------------------------------------------------------------
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No 'Developer ID Application' certificate found in the keychain." >&2
  echo "  Create one (Xcode → Settings → Accounts → Manage Certificates → +," >&2
  echo "  or the Apple Developer portal) before running a release build." >&2
  exit 1
fi
if [ ! -f "$APPLE_API_KEY" ]; then
  echo "✗ App Store Connect API key not found at: $APPLE_API_KEY" >&2
  exit 1
fi

echo "→ Building Developer ID release for arch=$ARCH, team=$TEAM_ID"

# electron-builder auto-discovers the Developer ID Application identity.
# --config.mac.notarize.teamId turns on notarytool notarization (+ auto-staple)
# using the APPLE_API_* env vars above; it stays OFF for plain `package:mac`.
npx electron-builder --mac "--$ARCH" \
  --config.mac.notarize.teamId="$TEAM_ID"

echo "✓ Done. Signed + notarized + stapled artifacts are in dist/"
echo "  Verify with:  spctl -a -vvv --type install dist/mac*/Tmux\\ Desk.app  (or the .dmg)"
