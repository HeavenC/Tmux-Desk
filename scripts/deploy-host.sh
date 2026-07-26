#!/usr/bin/env bash
#
# deploy-host.sh — 在 VM 上收尾：提交当前分支 → 推到宿主机 → 在宿主机同分支上部署
#
# 背景：真正跑 Tmux Desk 的是物理 Mac（ssh 别名 host），VM 只是开发环境。
# 所以本地 deploy.sh 部署出来的 app 没人用，收尾应该把代码送到 host 再在那边部署。
#
# 流程:
#   1. 工作区有改动 → git add -A && git commit（无改动则跳过）
#   2. git push host <当前分支>；host 侧 receive.denyCurrentBranch=updateInstead，
#      若 host 正停在同一分支且工作区干净，push 完工作区自动就位
#   3. ssh host：切到同一分支（若不在）→ 校验 HEAD 与 VM 一致 → 跑 scripts/deploy.sh
#
# 用法:
#   ./scripts/deploy-host.sh          # 增量（透传给 host 的 deploy.sh）
#   ./scripts/deploy-host.sh --force  # 强制重建
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST_ALIAS="${TMUX_DESK_DEPLOY_HOST:-host}"
FORCE="${1:-}"

cd "$PROJECT_DIR"

# host 远端是这套流程的前提；没配就退回本机部署，别把收尾直接失败掉。
if ! git remote get-url "$HOST_ALIAS" >/dev/null 2>&1; then
  echo "⚠ 未配置 '$HOST_ALIAS' 远端，回退为本机部署"
  exec "$PROJECT_DIR/scripts/deploy.sh" ${FORCE:+"$FORCE"}
fi

# host 远端的 URL 形如 host:/Users/liwei/Documents/tools/terminal-cli —— 冒号后就是
# 宿主机上的仓库路径，直接复用，不另外写死一份。
HOST_URL="$(git remote get-url "$HOST_ALIAS")"
HOST_REPO="${HOST_URL#*:}"
BRANCH="$(git symbolic-ref --short HEAD)"

# ---- 1. 提交 ----------------------------------------------------------------
echo "=== [1/3] Committing on $BRANCH ==="
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "chore: 自动提交并部署到宿主机"
  echo "✓ $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
else
  echo "⏭ 工作区干净，无需提交"
fi
SHA="$(git rev-parse HEAD)"

# ---- 2. 推送 ----------------------------------------------------------------
# post-commit 钩子也会在后台推同一个 ref，两边撞上时 git 会报 ref 加锁失败 —— 重试即可。
echo ""
echo "=== [2/3] Pushing to $HOST_ALIAS ==="
pushed=0
for attempt in 1 2 3; do
  if out=$(git push "$HOST_ALIAS" "$BRANCH" 2>&1); then
    pushed=1
    break
  fi
  echo "$out" | tail -3
  sleep 2
done
if [ "$pushed" != 1 ]; then
  echo "✗ push 失败（分叉或宿主机工作区不干净），请手动处理后重试" >&2
  exit 1
fi
echo "✓ $BRANCH → $HOST_ALIAS"

# ---- 3. 宿主机部署 -----------------------------------------------------------
echo ""
echo "=== [3/3] Deploying on $HOST_ALIAS ==="
# ssh 是非交互 shell，PATH 里没有 nvm 装的 node/npm，deploy.sh 的 npm run build 会直接
# command not found —— 所以进去先 source nvm.sh。
ssh -o BatchMode=yes "$HOST_ALIAS" \
  "REPO='$HOST_REPO' BRANCH='$BRANCH' SHA='$SHA' FORCE='$FORCE' bash -s" <<'REMOTE'
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
cd "$REPO"

current=$(git symbolic-ref --short HEAD)
if [ "$current" != "$BRANCH" ]; then
  echo "  宿主机在 $current，切到 $BRANCH"
  git checkout "$BRANCH"
fi

# push 时宿主机若不在该分支，updateInstead 不会动工作区，ref 已更新但工作树是旧的；
# 上面的 checkout 补上。到这里 HEAD 必须与 VM 一致，否则部署的是旧代码。
head=$(git rev-parse HEAD)
if [ "$head" != "$SHA" ]; then
  echo "✗ 宿主机 HEAD ($(git rev-parse --short HEAD)) 与 VM ($(echo "$SHA" | cut -c1-7)) 不一致" >&2
  git status --short | head -10 >&2
  exit 1
fi

exec ./scripts/deploy.sh ${FORCE:+"$FORCE"}
REMOTE
