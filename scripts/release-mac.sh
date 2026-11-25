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

# On GitHub Actions, failures are also emitted as annotations: those show on
# the run page and through the public API without signing in, unlike the logs.
fail() {
  echo "✗ $1" >&2
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=release-mac.sh::$1"
  exit 1
}
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  trap 'echo "::error title=release-mac.sh::line $LINENO failed (exit $?): $BASH_COMMAND"' ERR
fi

# --- Notarization credentials (App Store Connect API key) --------------------
export APPLE_API_KEY="${APPLE_API_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_687H76CDXR.p8}"
export APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-687H76CDXR}"
export APPLE_API_ISSUER="${APPLE_API_ISSUER:-9010e018-efeb-4531-80f6-40d2e999e38a}"
TEAM_ID="${TEAM_ID:-D2U492GTU7}"

# --- Preflight ---------------------------------------------------------------
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  # Without -v, find-identity also lists identities it rejects, with the reason
  # (expired, untrusted chain, missing private key, …).
  fail "No valid 'Developer ID Application' identity in the keychain. All identities: $(security find-identity -p codesigning 2>&1 | tr '\n' ' ')"
fi
if [ ! -f "$APPLE_API_KEY" ] && [ "${SKIP_NOTARIZE:-}" != "true" ]; then
  fail "App Store Connect API key not found at: $APPLE_API_KEY"
fi

echo "→ Building Developer ID release for arch=$ARCH, team=$TEAM_ID"

# --- Bundled tmux ------------------------------------------------------------
# Intel Macs can no longer count on Homebrew, so the x64 build carries its own
# tmux (the app only falls back to it when the machine has none). A universal
# build merges an x64 and an arm64 app, so both slices need one.
case "$ARCH" in
  x64)       scripts/build-tmux.sh x64 ;;
  universal) scripts/build-tmux.sh x64 && scripts/build-tmux.sh arm64 ;;
esac

# --- Package (signing skipped — afterPack handles it in one deep-sign) --------
export CSC_IDENTITY_AUTO_DISCOVERY=false
export APPLE_TEAM_ID="$TEAM_ID"
# Unless notarization is explicitly skipped, require a real Developer ID in the
# afterPack hook — an ad-hoc fallback would only fail later as an "Invalid"
# notarization after a long wait (see scripts/afterpack-adhoc.js).
if [ "${SKIP_NOTARIZE:-}" != "true" ]; then
  export REQUIRE_DEVELOPER_ID=true
fi
npx electron-builder --mac "--$ARCH"

# Catch a missing or unsigned bundled tmux here, not as an "Invalid" verdict
# after a long notarization wait.
case "$ARCH" in
  x64)       APP_OUT_DIR=dist/mac ;;
  universal) APP_OUT_DIR=dist/mac-universal ;;
  *)         APP_OUT_DIR= ;;
esac
if [ -n "$APP_OUT_DIR" ]; then
  BUNDLED_TMUX="$APP_OUT_DIR/Tmux Desk.app/Contents/Resources/bin/tmux"
  [ -x "$BUNDLED_TMUX" ] || fail "bundled tmux missing: $BUNDLED_TMUX"
  codesign --verify --strict "$BUNDLED_TMUX"
  if ! codesign -dv "$BUNDLED_TMUX" 2>&1 | grep -q 'flags=.*runtime'; then
    fail "bundled tmux is not signed with the hardened runtime"
  fi
  echo "✓ bundled tmux: $(lipo -archs "$BUNDLED_TMUX"), signed"
fi

# --- Notarize & staple -------------------------------------------------------
APP_NAME="Tmux Desk"
VERSION=$(node -p "require('./package.json').version")
DMG="dist/${APP_NAME}-${VERSION}-${ARCH}.dmg"
ZIP="dist/${APP_NAME}-${VERSION}-${ARCH}.zip"

if [ "${SKIP_NOTARIZE:-}" = "true" ]; then
  echo "→ ⏭  SKIP_NOTARIZE set — skipping notarization"
  echo "  Run later:  bash scripts/notarize-mac.sh $ARCH"
  echo "  Signed artifacts: $DMG / $ZIP"
  exit 0
fi

# notarytool uses NSURLSession which respects macOS system proxy settings.
# We temporarily disable system proxies so notarytool can reach Apple.
SOCKS_STATE=$(networksetup -getsocksfirewallproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")
HTTP_STATE=$(networksetup -getwebproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")
HTTPS_STATE=$(networksetup -getsecurewebproxy Wi-Fi 2>/dev/null | grep "^Enabled:" | awk '{print $2}' || echo "No")

restore_proxy() {
  [ "$SOCKS_STATE" = "Yes" ] && networksetup -setsocksfirewallproxystate Wi-Fi on 2>/dev/null || true
  [ "$HTTP_STATE"  = "Yes" ] && networksetup -setwebproxystate Wi-Fi on 2>/dev/null || true
  [ "$HTTPS_STATE" = "Yes" ] && networksetup -setsecurewebproxystate Wi-Fi on 2>/dev/null || true
}
trap restore_proxy EXIT

networksetup -setsocksfirewallproxystate Wi-Fi off 2>/dev/null || true
networksetup -setwebproxystate Wi-Fi off 2>/dev/null || true
networksetup -setsecurewebproxystate Wi-Fi off 2>/dev/null || true
echo "→ System proxy temporarily disabled for notarization"

# Notarization is per app-bundle cdhash, NOT per container: the DMG and the ZIP
# wrap the SAME signed .app, so ONE submission covers both. We submit the DMG
# once (halving the wait against an already-slow Apple notary service) and then
# staple every artifact that exists. --timeout caps the --wait so the job fails
# fast with a clear error instead of hanging up to GitHub's 6h limit if Apple is
# backed up.
SUBMIT_TARGET=""
[ -f "$DMG" ] && SUBMIT_TARGET="$DMG"
[ -z "$SUBMIT_TARGET" ] && [ -f "$ZIP" ] && SUBMIT_TARGET="$ZIP"
if [ -z "$SUBMIT_TARGET" ]; then
  fail "Neither DMG nor ZIP found to notarize ($DMG / $ZIP)"
fi

echo "→ Submitting $(basename "$SUBMIT_TARGET") for notarization (covers DMG+ZIP, same cdhash) …"
# The DMG/ZIP already exist at this point and look final. If notarization does
# not come back Accepted, rename them so nobody ships them: on other Macs an
# unnotarized build is blocked until the user overrides it in Privacy & Security.
# (A lapsed Apple Developer agreement fails here with HTTP 403 "A required
# agreement is missing or has expired" — the account holder must accept it at
# developer.apple.com/account.)
NOTARY_OUT="$(mktemp -t tmux-desk-notary)"
if ! env -u http_proxy -u https_proxy -u all_proxy \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  xcrun notarytool submit "$SUBMIT_TARGET" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait --timeout 30m 2>&1 | tee "$NOTARY_OUT" \
  || ! grep -q 'status: Accepted' "$NOTARY_OUT"; then
  for artifact in "$DMG" "$ZIP"; do
    [ -f "$artifact" ] && mv -f "$artifact" "${artifact%.*}-UNNOTARIZED.${artifact##*.}"
  done
  fail "Notarization did not succeed; artifacts renamed *-UNNOTARIZED. $(grep -m1 -iE 'error|status:' "$NOTARY_OUT" | tr -d '\n')"
fi

# Staple each artifact. A DMG staples directly; a ZIP cannot be stapled (staple
# the .app before re-zipping if offline stapling of the ZIP is needed).
for artifact in "$DMG" "$ZIP"; do
  [ -f "$artifact" ] || continue
  case "$artifact" in
    *.dmg)
      echo "→ Stapling $(basename "$artifact") …"
      xcrun stapler staple "$artifact"
      echo "✓ Notarized + stapled: $artifact" ;;
    *.zip)
      echo "✓ Notarized (ZIP shares the notarized cdhash; ZIP containers aren't stapled): $artifact" ;;
  esac
done

echo "✓ Done. Signed + notarized artifacts are in dist/"
echo "  Verify with:  spctl -a -vvv --type install \"$DMG\""
