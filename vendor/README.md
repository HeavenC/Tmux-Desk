# vendor/bin — 可选的自带 tmux

Tmux Desk 是 tmux 的图形前端，运行时**依赖本机的 tmux**（它通过命令行驱动 tmux，
并用 node-pty attach 到会话）。默认情况下应用按以下顺序查找 tmux：

1. `Contents/Resources/bin/tmux`（本目录打包进 `.app` 后的位置）—— **如果存在就优先用它**
2. `/opt/homebrew/bin/tmux`、`/usr/local/bin/tmux`、`/usr/bin/tmux`
3. `which tmux`（PATH）

所以对于**没装 tmux 的用户**，只要把一个可执行的 tmux 二进制放到 `vendor/bin/tmux`，
再打包（`npm run package:mac`），应用就会自带 tmux、开箱即用，无需用户 `brew install tmux`。

## 放置一个自带 tmux

把二进制放到 `vendor/bin/tmux` 并确保可执行：

```bash
cp /path/to/tmux vendor/bin/tmux
chmod +x vendor/bin/tmux
```

注意：
- 需要与目标架构匹配（arm64 包放 arm64 的 tmux，x64 包放 x64 的）。
- **建议使用静态链接的 tmux**（自带 libevent / ncurses），否则运行时会缺 dylib。
  Homebrew 的 tmux 依赖 `/opt/homebrew` 下的 dylib，直接拷进来在别人机器上会跑不起来。
  可用 `dylibbundler` 把依赖一起搬进来并改写 rpath，或自行编译一个静态版本。
- 打包配置见根 `package.json` 的 `build.extraResources`（本目录会被复制为 `Resources/bin`）。

`vendor/bin/.gitkeep` 只是为了让空目录存在、让打包配置始终有效；不放二进制时应用会自动回退到本机 tmux。
