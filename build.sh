#!/usr/bin/env bash
#
# Tmux Desk 一键构建脚本
# 用法:
#   ./build.sh            # 为当前 Mac 架构构建（Apple Silicon 出 arm64，Intel 出 x64）
#   ./build.sh arm64      # 强制 Apple Silicon
#   ./build.sh intel      # 强制 Intel (x64)
#   ./build.sh universal  # 通用二进制 (arm64 + x64，体积更大)
#   ./build.sh all        # 同时出 arm64 和 x64 两份
#
# 产物在 dist/ 下：Tmux Desk-<版本>-<arch>.dmg 和同名 .zip
#
set -euo pipefail

cd "$(dirname "$0")"

info()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 0. 前置检查 --------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "只能在 macOS 上打包 .app / .dmg。"

command -v node >/dev/null 2>&1 || die "未找到 Node.js。请先安装 Node 18+（推荐 20/22）：https://nodejs.org 或 'brew install node'。"
command -v npm  >/dev/null 2>&1 || die "未找到 npm（通常随 Node.js 一起安装）。"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本过低（当前 $(node -v)），需要 18 及以上。"

# 原生模块 node-pty 需要 Xcode Command Line Tools 才能编译
if ! xcode-select -p >/dev/null 2>&1; then
  warn "未检测到 Xcode Command Line Tools，node-pty 可能无法编译。"
  warn "请先运行：xcode-select --install  然后重跑本脚本。"
fi

ok "Node $(node -v) · npm $(npm -v)"

# ---- 0.5 国内镜像加速 ---------------------------------------------------------
# electron-builder 打包时要从 GitHub 拉 Electron 本体(~116M)和 dmgbuild 二进制(~22M)，
# 国内直连很慢，表现为长时间卡在 "packaging platform=darwin"。这里默认走 npmmirror。
# 如在海外/公司网络无需镜像，用 NO_MIRROR=1 ./build.sh 关闭。
if [ "${NO_MIRROR:-0}" != "1" ]; then
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
  NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
  info "已启用国内镜像加速（npmmirror）；如需关闭：NO_MIRROR=1 ./build.sh"
else
  NPM_REGISTRY=""
fi

# ---- 1. 选择目标架构 ----------------------------------------------------------
TARGET="${1:-host}"
if [ "$TARGET" = "host" ]; then
  case "$(uname -m)" in
    arm64) TARGET="arm64" ;;
    x86_64) TARGET="intel" ;;
    *) die "未知的 CPU 架构：$(uname -m)" ;;
  esac
fi

# ---- 2. 安装依赖（会顺带为 Electron 重建 node-pty 原生模块）-------------------
info "安装依赖（首次会下载 Electron，需要联网，请耐心等待）…"
NPM_REG_ARGS=()
[ -n "${NPM_REGISTRY:-}" ] && NPM_REG_ARGS=(--registry "$NPM_REGISTRY")
if [ -f package-lock.json ]; then
  npm ci ${NPM_REG_ARGS[@]+"${NPM_REG_ARGS[@]}"}
else
  npm install ${NPM_REG_ARGS[@]+"${NPM_REG_ARGS[@]}"}
fi
ok "依赖安装完成"

# ---- 3. 打包（未签名，无需开发者证书）----------------------------------------
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 不做代码签名/公证，避免证书报错

case "$TARGET" in
  arm64)     info "构建 Apple Silicon (arm64)…"; npm run package:mac ;;
  intel|x64) info "构建 Intel (x64)…";           npm run package:mac:x64 ;;
  universal) info "构建 Universal (arm64+x64)…"; npm run package:mac:universal ;;
  all)       info "构建 arm64 + x64 两份…";      npm run package:mac && npm run package:mac:x64 ;;
  *)         die "未知目标：$TARGET（可选 arm64 / intel / universal / all）" ;;
esac

# ---- 4. 收尾提示 --------------------------------------------------------------
echo
ok "构建完成，产物在 dist/："
ls -1 dist/*.dmg dist/*.zip 2>/dev/null | sed 's/^/   /'
echo
info "分发给别人：请发 dist/ 里的 .dmg（不要发裸 .app —— 经微信/邮件拷贝的 .app 里的软链接会坏，导致“已损坏”）。"
warn "App 已 ad-hoc 签名但未公证，首次打开仍会被 Gatekeeper 拦（提示“无法验证开发者”）。二选一："
echo "   • 在“应用程序”里右键该 App → 打开 → 再点“打开”；或"
echo "   • 终端执行：xattr -cr \"/Applications/Tmux Desk.app\""
echo
info "提示：Tmux Desk 需要本机安装 tmux（brew install tmux）。"
