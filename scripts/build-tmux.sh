#!/usr/bin/env bash
# Build a self-contained tmux to ship inside the macOS app
# (vendor/bin/<arch>/tmux → Contents/Resources/bin/tmux).
#
# Homebrew no longer treats Intel Macs as a supported platform, so those users
# often cannot install tmux at all. The app therefore carries its own.
# libevent, ncurses and utf8proc are linked statically; the binary only depends
# on dylibs under /usr/lib, so it runs on a Mac with nothing installed.
#
# Usage: scripts/build-tmux.sh <x64|arm64> [--force]
#   Skips the build when vendor/bin/<arch>/tmux was produced by this exact
#   script and still passes verification. --force rebuilds anyway.
#   Works as a cross-compile too (x64 from an Apple Silicon Mac); the runtime
#   smoke test then only runs when the target arch can execute here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="$ROOT/scripts/build-tmux.sh"

ARCH="${1:-}"
FORCE="${2:-}"
case "$ARCH" in
  x64)   CLANG_ARCH=x86_64; HOST_TRIPLE=x86_64-apple-darwin ;;
  arm64) CLANG_ARCH=arm64;  HOST_TRIPLE=aarch64-apple-darwin ;;
  *) echo "usage: scripts/build-tmux.sh <x64|arm64> [--force]" >&2; exit 2 ;;
esac

# Pinned sources. Bumping a version means updating its checksum too: the
# download is refused when the bytes do not match.
TMUX_VERSION=3.7b
TMUX_URLS="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
TMUX_SHA256=87f2e99e3b685973f2ca002ffd6ed7e51a5744f7009daae5a15670b6d532db96

# The release asset (not the git archive) because it ships a generated
# `configure`, so the build needs no autotools.
LIBEVENT_VERSION=2.1.13-stable
LIBEVENT_URLS="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz"
LIBEVENT_SHA256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c

NCURSES_VERSION=6.6
NCURSES_URLS="https://ftpmirror.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz https://ftp.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz https://invisible-mirror.net/archives/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"
NCURSES_SHA256=355b4cbbed880b0381a04c46617b7656e362585d52e9cf84a67e2009b749ff11

UTF8PROC_VERSION=2.11.3
UTF8PROC_URLS="https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v${UTF8PROC_VERSION}.tar.gz"
UTF8PROC_SHA256=abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78

# Lower than any macOS the app itself can run on, so tmux is never the reason
# a machine is turned away.
MIN_MACOS="${TMUX_MIN_MACOS:-11.0}"

WORK_DIR="$ROOT/.tmux-build"
SRC_CACHE="$WORK_DIR/src"
BUILD_DIR="$WORK_DIR/$ARCH"
DEPS="$BUILD_DIR/deps"
OUT_DIR="$ROOT/vendor/bin/$ARCH"
OUT="$OUT_DIR/tmux"
STAMP="$OUT_DIR/.tmux-build-stamp"

log() { printf '→ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

can_run_target() {
  [ "$(uname -m)" = "$CLANG_ARCH" ] && return 0
  # An x86_64 binary also runs on Apple Silicon when Rosetta is installed.
  [ "$CLANG_ARCH" = x86_64 ] && arch -x86_64 /usr/bin/true >/dev/null 2>&1
}

# Static checks that hold for every build, plus a live smoke test when this
# machine can execute the target arch. Exits non-zero on the first failure.
verify() {
  local bin="$1"
  [ -x "$bin" ] || die "$bin is missing or not executable"

  local archs
  archs="$(lipo -archs "$bin")"
  [ "$archs" = "$CLANG_ARCH" ] || die "$bin is built for '$archs', expected '$CLANG_ARCH'"

  # Anything outside /usr/lib would be a dylib the user's Mac does not have.
  local foreign
  foreign="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -v '^/usr/lib/' || true)"
  [ -z "$foreign" ] || die "$bin links non-system libraries: $foreign"

  local minos
  minos="$(otool -l "$bin" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
  [ "$minos" = "$MIN_MACOS" ] || die "$bin targets macOS $minos, expected $MIN_MACOS"

  if ! can_run_target; then
    log "cannot execute $CLANG_ARCH here — skipped the runtime smoke test"
    return 0
  fi

  local version
  version="$("$bin" -V)"
  [ "$version" = "tmux $TMUX_VERSION" ] || die "unexpected version: $version"

  # A private socket and no config file, so this never touches real sessions.
  local sock="tmux-build-smoke-$$"
  local width
  "$bin" -L "$sock" -f /dev/null new-session -d -s smoke 'sleep 30'
  # Width of two CJK characters must be 4: proves utf8proc is in use rather
  # than macOS wcwidth(3).
  "$bin" -L "$sock" set -g @probe '中文'
  width="$(LC_ALL=en_US.UTF-8 "$bin" -L "$sock" display-message -p '#{w:@probe}')"
  "$bin" -L "$sock" kill-server 2>/dev/null || true
  [ "$width" = "4" ] || die "CJK width check failed (got '$width', expected 4)"

  # An attached client looks its TERM up in the system terminfo database, which
  # the statically linked ncurses must be able to read. A detached session
  # never does, so attach for real inside a pty that `script` provides; the
  # pane's command exits at once and takes the client with it.
  local attach_out
  attach_out="$(TERM=xterm-256color script -q /dev/null \
    "$bin" -L "$sock" -f /dev/null new-session 'exit 0' </dev/null 2>&1 || true)"
  "$bin" -L "$sock" kill-server 2>/dev/null || true
  case "$attach_out" in
    *"unsuitable terminal"*|*"open terminal failed"*|*"can't find terminal"*)
      die "tmux cannot read the system terminfo: $attach_out" ;;
  esac
  log "smoke test passed ($version, CJK width 4, terminfo ok)"
}

script_hash() { shasum -a 256 "$SCRIPT_PATH" | awk '{print $1}'; }

if [ "$FORCE" != "--force" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(script_hash)" ]; then
  if (verify "$OUT"); then
    log "vendor/bin/$ARCH/tmux is up to date"
    exit 0
  fi
  log "existing build failed verification — rebuilding"
fi

fetch() {
  local name="$1" sha="$2"; shift 2
  local file="$SRC_CACHE/$name"
  mkdir -p "$SRC_CACHE"
  if [ -f "$file" ] && echo "$sha  $file" | shasum -a 256 -c --status; then
    return 0
  fi
  rm -f "$file"
  local url
  for url in "$@"; do
    log "downloading $url"
    if curl -fsSL --retry 3 --connect-timeout 20 -o "$file.part" "$url"; then
      if echo "$sha  $file.part" | shasum -a 256 -c --status; then
        mv "$file.part" "$file"
        return 0
      fi
      echo "  checksum mismatch, trying the next mirror" >&2
    fi
    rm -f "$file.part"
  done
  die "could not download $name with sha256 $sha"
}

unpack() {
  local archive="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$SRC_CACHE/$archive" -C "$dest" --strip-components 1
}

# shellcheck disable=SC2086
fetch "tmux-$TMUX_VERSION.tar.gz" "$TMUX_SHA256" $TMUX_URLS
# shellcheck disable=SC2086
fetch "libevent-$LIBEVENT_VERSION.tar.gz" "$LIBEVENT_SHA256" $LIBEVENT_URLS
# shellcheck disable=SC2086
fetch "ncurses-$NCURSES_VERSION.tar.gz" "$NCURSES_SHA256" $NCURSES_URLS
# shellcheck disable=SC2086
fetch "utf8proc-$UTF8PROC_VERSION.tar.gz" "$UTF8PROC_SHA256" $UTF8PROC_URLS

# Keep the build hermetic: whatever Homebrew/MacPorts left in the environment
# (or in /usr/local on Intel runners) must not leak in.
unset PKG_CONFIG_PATH LIBRARY_PATH CPATH C_INCLUDE_PATH CPPFLAGS LDFLAGS CFLAGS
export PKG_CONFIG_LIBDIR="$DEPS/lib/pkgconfig"
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
SDK="$(xcrun --show-sdk-path)"
CC="$(xcrun -f clang) -arch $CLANG_ARCH -isysroot $SDK"
BASE_CFLAGS="-O2 -mmacosx-version-min=$MIN_MACOS"
JOBS="$(sysctl -n hw.ncpu)"

rm -rf "$BUILD_DIR"
mkdir -p "$DEPS/include" "$DEPS/lib"

log "libevent $LIBEVENT_VERSION ($CLANG_ARCH)"
unpack "libevent-$LIBEVENT_VERSION.tar.gz" "$BUILD_DIR/libevent"
(
  cd "$BUILD_DIR/libevent"
  CC="$CC" CFLAGS="$BASE_CFLAGS" ./configure --host="$HOST_TRIPLE" --prefix="$DEPS" \
    --disable-shared --enable-static --disable-openssl --disable-mbedtls \
    --disable-samples --disable-libevent-regress --disable-debug-mode \
    --disable-dependency-tracking >configure.log
  make -j"$JOBS" >make.log
  make install >install.log
)

log "ncurses $NCURSES_VERSION ($CLANG_ARCH)"
unpack "ncurses-$NCURSES_VERSION.tar.gz" "$BUILD_DIR/ncurses"
(
  cd "$BUILD_DIR/ncurses"
  # Read the system terminfo database instead of shipping one. macOS stores it
  # under hex-named directories (/usr/share/terminfo/78/xterm-256color), which
  # is what --disable-mixed-case selects.
  CC="$CC" CFLAGS="$BASE_CFLAGS" BUILD_CC=cc ./configure --host="$HOST_TRIPLE" --prefix="$DEPS" \
    --without-shared --with-normal --without-debug --without-ada \
    --without-cxx --without-cxx-binding --without-manpages --without-progs \
    --without-tests --enable-widec --disable-db-install --disable-pc-files \
    --disable-mixed-case \
    --with-terminfo-dirs=/usr/share/terminfo \
    --with-default-terminfo-dir=/usr/share/terminfo >configure.log
  make -j"$JOBS" libs >make.log
  make install.libs install.includes >install.log
)

log "utf8proc $UTF8PROC_VERSION ($CLANG_ARCH)"
unpack "utf8proc-$UTF8PROC_VERSION.tar.gz" "$BUILD_DIR/utf8proc"
(
  cd "$BUILD_DIR/utf8proc"
  make libutf8proc.a CC="$CC" CFLAGS="$BASE_CFLAGS" >make.log
  cp utf8proc.h "$DEPS/include/"
  cp libutf8proc.a "$DEPS/lib/"
)

log "tmux $TMUX_VERSION ($CLANG_ARCH)"
unpack "tmux-$TMUX_VERSION.tar.gz" "$BUILD_DIR/tmux"
(
  cd "$BUILD_DIR/tmux"
  # Each library is named by its .a path through the *_CFLAGS/*_LIBS variables,
  # which tmux's configure takes in place of asking pkg-config. That avoids
  # needing pkg-config at all, and the linker can never pick up a same-named
  # dylib from /usr/local/lib.
  #
  # --with-TERM=screen-256color: tmux-256color is only in the macOS terminfo
  # database from Sonoma on, and programs inside panes use the system ncurses.
  # Older Intel Macs would otherwise get "unknown terminal type" everywhere.
  # A user's own `default-terminal` setting still wins.
  CC="$CC" CFLAGS="$BASE_CFLAGS" \
  LIBEVENT_CORE_CFLAGS="-I$DEPS/include" \
  LIBEVENT_CORE_LIBS="$DEPS/lib/libevent_core.a" \
  LIBTINFOW_CFLAGS="-I$DEPS/include/ncursesw -I$DEPS/include" \
  LIBTINFOW_LIBS="$DEPS/lib/libncursesw.a" \
  LIBUTF8PROC_CFLAGS="-I$DEPS/include" \
  LIBUTF8PROC_LIBS="$DEPS/lib/libutf8proc.a" \
  ./configure --host="$HOST_TRIPLE" --prefix=/usr/local --sysconfdir=/etc \
    --enable-utf8proc --enable-sixel --with-TERM=screen-256color \
    --disable-dependency-tracking >configure.log
  make -j"$JOBS" >make.log
  strip tmux
)

mkdir -p "$OUT_DIR"
# Replace by rename so a tmux server already running from the old file keeps
# its (now unlinked) binary intact.
cp "$BUILD_DIR/tmux/tmux" "$OUT.new"
chmod 755 "$OUT.new"
mv -f "$OUT.new" "$OUT"
verify "$OUT"
script_hash >"$STAMP"
log "built vendor/bin/$ARCH/tmux ($(du -h "$OUT" | awk '{print $1}'))"
