#!/usr/bin/env bash
#
# deploy.sh — 快速部署 Tmux Desk 到 /Applications
#
# 用法:
#   ./scripts/deploy.sh          # 增量部署：仅 src/ 有变更时才重新构建
#   ./scripts/deploy.sh --force  # 强制重新构建并部署
#
# 流程:
#   1. npm run build（编译 renderer + webapp）
#   2. 退出正在运行的 Tmux Desk
#   3. 提取 app.asar → 替换构建物 → 重新打包 → 重签名
#   4. 重新打开 Tmux Desk
#   5. 打印手机访问地址（端口 8790）
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="/Applications/Tmux Desk.app"
ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
STAMP_FILE="$PROJECT_DIR/.deploy-stamp"
SRC_DIR="$PROJECT_DIR/src"
FORCE="${1:-}"
MOBILE_PORT=8790

cd "$PROJECT_DIR"

# ---- 变更检测 ----------------------------------------------------------------
if [ "$FORCE" != "--force" ] && [ -f "$STAMP_FILE" ]; then
  CHANGED=$(find "$SRC_DIR" -newer "$STAMP_FILE" -type f 2>/dev/null | head -1)
  if [ -z "$CHANGED" ]; then
    echo "⏭ No source changes since last deploy. Use --force to skip this check."
    exit 0
  fi
  echo "📝 Changes detected in src/"
fi

# ---- 1. 构建 -----------------------------------------------------------------
echo ""
echo "=== [1/5] Building ==="
npm run build
echo "✓ Build complete"

# ---- 2. 终止 Tmux Desk -------------------------------------------------------
echo ""
echo "=== [2/5] Stopping Tmux Desk ==="
# 先用 AppleScript 优雅退出
osascript -e 'quit app "Tmux Desk"' 2>/dev/null || true
sleep 1
# 兜底：如果还在运行就强杀
pkill -f "Tmux Desk.app" 2>/dev/null || true
sleep 1
echo "✓ Tmux Desk stopped"

# ---- 3. 更新 app.asar + 重签名 -----------------------------------------------
echo ""
echo "=== [3/5] Updating app bundle ==="

if [ ! -f "$ASAR_PATH" ]; then
  echo "✗ app.asar not found at $ASAR_PATH"
  echo "  Is Tmux Desk installed? Run: ./build.sh && cp -R dist/mac-arm64/Tmux\\ Desk.app /Applications/"
  exit 1
fi

TMPDIR=$(mktemp -d)
ASAR_CLI="$PROJECT_DIR/node_modules/@electron/asar/bin/asar.js"

echo "  Extracting app.asar..."
node "$ASAR_CLI" extract "$ASAR_PATH" "$TMPDIR"

echo "  Syncing missing runtime dependencies..."
node "$PROJECT_DIR/scripts/sync-runtime-dependencies.js" "$PROJECT_DIR" "$TMPDIR"

echo "  Copying renderer-dist..."
rm -rf "$TMPDIR/renderer-dist"
cp -R "$PROJECT_DIR/renderer-dist" "$TMPDIR/"

echo "  Copying webapp-dist..."
rm -rf "$TMPDIR/webapp-dist"
cp -R "$PROJECT_DIR/webapp-dist" "$TMPDIR/"

echo "  Copying src/ (main process)..."
rm -rf "$TMPDIR/src"
cp -R "$PROJECT_DIR/src" "$TMPDIR/"

echo "  Copying package.json..."
cp "$PROJECT_DIR/package.json" "$TMPDIR/"

echo "  Repacking app.asar..."
node "$ASAR_CLI" pack "$TMPDIR" "$ASAR_PATH"
rm -rf "$TMPDIR"

# 修改 asar 后签名已失效，必须重新 ad-hoc 签名，否则 macOS 拒绝启动
echo "  Re-signing app bundle..."
codesign --force --deep --sign - "$APP_PATH"
echo "✓ app.asar updated & re-signed"

# ---- 4. 重新打开 -------------------------------------------------------------
echo ""
echo "=== [4/5] Opening Tmux Desk ==="
open "$APP_PATH"
echo "✓ Tmux Desk launched"

# ---- 5. 手机访问端口 ---------------------------------------------------------
echo ""
echo "=== [5/5] Mobile access ==="
sleep 2

# 读取 token，尝试探测服务是否已就绪
TOKEN_FILE="$HOME/.config/tmux-desk/web-token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(head -1 "$TOKEN_FILE")
  # 等待服务就绪（最多 5 秒）
  for i in $(seq 1 10); do
    if curl -s "http://127.0.0.1:${MOBILE_PORT}/api/sessions?token=$TOKEN" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  # 局域网 IP
  LAN_IP=$(ifconfig | awk '/^[[:space:]]*inet / && !/127\.0\.0\.1/ {print $2; exit}')
  if [ -n "$LAN_IP" ]; then
    echo "📱 Mobile: http://${LAN_IP}:${MOBILE_PORT}/?token=${TOKEN}"
  fi
  # Tailscale IP（如果有的话）
  TS_IP=$(ifconfig | awk '/^[[:space:]]*inet / && $2 ~ /^100\./ {print $2; exit}')
  if [ -n "$TS_IP" ]; then
    echo "🔐 Tailscale: http://${TS_IP}:${MOBILE_PORT}/?token=${TOKEN}"
  fi
else
  echo "⚠ Token file not found; the app will generate one on first launch."
fi

# ---- 标记部署时间戳 ----------------------------------------------------------
touch "$STAMP_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Deploy complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
