#!/usr/bin/env bash
# Notarize + staple already-built DMG/zip artifacts.
# Run standalone when Apple's notary service is back up, or when the
# inline notarization in release-mac.sh timed out.
#
# Usage: scripts/notarize-mac.sh [arm64|x64|universal]   (default: arm64)
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"

# --- Notarization credentials -------------------------------------------------
APPLE_API_KEY="${APPLE_API_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_687H76CDXR.p8}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-687H76CDXR}"
APPLE_API_ISSUER="${APPLE_API_ISSUER:-9010e018-efeb-4531-80f6-40d2e999e38a}"

# --- Preflight ----------------------------------------------------------------
if [ ! -f "$APPLE_API_KEY" ]; then
  echo "✗ App Store Connect API key not found at: $APPLE_API_KEY" >&2
  exit 1
fi

APP_NAME="Tmux Desk"
VERSION=$(node -p "require('./package.json').version")
DMG="dist/${APP_NAME}-${VERSION}-${ARCH}.dmg"
ZIP="dist/${APP_NAME}-${VERSION}-${ARCH}.zip"

if [ ! -f "$DMG" ] && [ ! -f "$ZIP" ]; then
  echo "✗ No artifacts found at dist/ for v${VERSION} arch=${ARCH}" >&2
  echo "  Run 'npm run release:mac' first." >&2
  exit 1
fi

# --- Proxy workaround ---------------------------------------------------------
# notarytool uses NSURLSession which respects macOS system proxy settings.
# If a local proxy (e.g. Clash/V2Ray on 127.0.0.1:7897) is active, notarytool
# can't reach Apple's servers.  We temporarily disable system proxies, do the
# notarization, then restore them.
save_proxy() {
  SOCKS_STATE=$(networksetup -getsocksfirewallproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")
  HTTP_STATE=$(networksetup -getwebproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")
  HTTPS_STATE=$(networksetup -getsecurewebproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")
}

disable_proxy() {
  networksetup -setsocksfirewallproxystate Wi-Fi off 2>/dev/null || true
  networksetup -setwebproxystate Wi-Fi off 2>/dev/null || true
  networksetup -setsecurewebproxystate Wi-Fi off 2>/dev/null || true
}

restore_proxy() {
  [ "$SOCKS_STATE" = "Yes" ] && networksetup -setsocksfirewallproxystate Wi-Fi on 2>/dev/null || true
  [ "$HTTP_STATE"  = "Yes" ] && networksetup -setwebproxystate Wi-Fi on 2>/dev/null || true
  [ "$HTTPS_STATE" = "Yes" ] && networksetup -setsecurewebproxystate Wi-Fi on 2>/dev/null || true
}

notarize_and_staple() {
  local artifact="$1"
  echo "→ Submitting $(basename "$artifact") for notarization …"
  env -u http_proxy -u https_proxy -u all_proxy \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    xcrun notarytool submit "$artifact" \
      --key "$APPLE_API_KEY" \
      --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER" \
      --wait

  echo "→ Stapling $(basename "$artifact") …"
  xcrun stapler staple "$artifact"
  echo "✓ Notarized + stapled: $artifact"
}

# --- Main ---------------------------------------------------------------------
save_proxy
trap restore_proxy EXIT

echo "→ Temporarily disabling system proxy for notarization …"
disable_proxy

for artifact in "$DMG" "$ZIP"; do
  if [ -f "$artifact" ]; then
    notarize_and_staple "$artifact"
  fi
done

echo "✓ Done. Verify with:  spctl -a -vvv --type install \"$DMG\""
