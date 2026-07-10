// The copyable "how to get sessions into Tmux Desk" guide, written for an LLM
// agent (Claude Code etc.). Tmux Desk just reads the default tmux server, so the
// whole "API" is a handful of plain tmux commands — documented here as Markdown.
function sessionApiMarkdown({ tmuxPath = 'tmux' } = {}) {
  const detected = tmuxPath || 'tmux';
  return `# 把会话导入 Tmux Desk（给 AI Agent 的指南）

Tmux Desk 直接读取本机**默认 tmux 服务器**上的会话。你（AI agent）只要在本机用 tmux
建好会话，Tmux Desk 会在约 2 秒内自动显示（或点右上角刷新）。没有额外的 API / 端口 / 鉴权。

## 快速开始：在当前项目目录建一个会话

在你的工作目录里执行：

\`\`\`bash
tmux new-session -d -s "my-project" -c "$(pwd)"
\`\`\`

- \`-d\` 后台创建（不 attach）；在 Tmux Desk 里点击该会话即可连接。
- \`-s\` 会话名；\`-c\` 工作目录，**必须是绝对路径**。

## 会话命名规则

- 1–80 个字符，首尾空格会被去除。
- **不能包含** \`.\`（点）、\`:\`（冒号）或控制字符（否则在 App 内重命名会被拒绝）。
- 可以包含中文、emoji、\`/\`、空格，例如 \`channel-biz (DMS渠道)\`。

## 加窗口 / 设置启动命令

\`\`\`bash
# 在会话里再开一个命名窗口，并指定它的工作目录
tmux new-window -t "my-project" -c "$(pwd)/subdir" -n "server"

# 在会话里执行一条启动命令（先按字面输入文本，再单独发一个回车）
tmux send-keys -t "my-project" -l -- "npm run dev"
tmux send-keys -t "my-project" Enter
\`\`\`

## 基于当前工作目录一键建/复用会话（幂等）

把这段直接丢给 shell 执行即可：

\`\`\`bash
name="$(basename "$(pwd)")"            # 用当前目录名作为会话名
tmux has-session -t "$name" 2>/dev/null \\
  || tmux new-session -d -s "$name" -c "$(pwd)"
echo "会话 \\"$name\\" 已就绪，打开 Tmux Desk 即可连接。"
\`\`\`

## 说明

- Tmux Desk 使用**默认 tmux socket**（等同于直接敲 \`tmux\`），与你在终端里的 \`tmux\` 是同一台服务器。
- 本机检测到的 tmux 可执行文件：\`${detected}\`
- 关闭 Tmux Desk 窗口只会断开 attach，**不会杀掉会话**；只有在 App 里明确「关闭会话」才会 \`kill-session\`。
`;
}

module.exports = { sessionApiMarkdown };
