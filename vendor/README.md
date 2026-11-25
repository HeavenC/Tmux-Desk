# vendor/bin — 随 app 发布的 tmux

Tmux Desk 是 tmux 的图形前端，运行时需要 tmux。Homebrew 已不再把 Intel Mac 当作正式支持的平台，
Intel 用户往往装不上 tmux，所以 **x64 安装包自带一份 tmux**，用户什么都不用装。

## 目录结构

```
vendor/bin/x64/tmux     ← scripts/build-tmux.sh x64 生成（不进 git）
vendor/bin/arm64/tmux   ← scripts/build-tmux.sh arm64 生成（不进 git，目前不随包发布）
```

打包时 `package.json` 的 `build.extraResources` 按架构取 `vendor/bin/${arch}/tmux`，
放到 `.app/Contents/Resources/bin/tmux`。目录里没有 tmux 时就什么都不放，app 照常依赖本机 tmux。

`npm run release:mac:x64` / `release:mac:universal`（以及对应的 `package:mac:*`）会自动先跑构建脚本；
脚本带构建戳，产物没变就直接跳过。

## app 怎么用它

查找顺序（`TmuxService.resolveTmuxPath`）：

1. `/opt/homebrew/bin/tmux`、`/usr/local/bin/tmux`、`/opt/local/bin/tmux`（MacPorts）、`/usr/bin/tmux`
2. 自带的 tmux（仅当上面都没有时才启用）
3. `which tmux`

**本机装了 tmux 就用本机的**：这样 app 里外是同一个 tmux，用户自己的终端连上来不会遇到版本不一致。

自带的 tmux **不在 `.app` 里原地运行**，启动时拷到偏好文件旁边的 `bin/tmux`
（`~/Library/Application Support/<app>/bin/tmux`）再用（`src/main/bundled-tmux.js`）。
tmux server 会常驻，原地运行的话，从 DMG 里直接打开 app 就会让 DMG 推不出来，强行推出会把所有会话一起带走。
更新时先写临时文件再 rename 覆盖，已经在跑的 server 继续用旧的 inode，不受影响。

## 构建（scripts/build-tmux.sh）

- libevent / ncurses / utf8proc 全部**静态链接**，产物只依赖 `/usr/lib` 下的系统库；脚本会用 `otool -L` 检查。
- 源码版本和 sha256 都写死在脚本里，校验不过就拒绝构建。
- ncurses 直接读系统的 `/usr/share/terminfo`（macOS 用十六进制目录名，所以要加 `--disable-mixed-case`）。
- 默认 TERM 是 `screen-256color`：`tmux-256color` 从 Sonoma 起才进系统 terminfo，旧系统上 pane 里的程序会报
  unknown terminal。用户自己配置的 `default-terminal` 仍然优先。
- 支持交叉编译（在 Apple Silicon 上编 x64）。能运行目标架构时会跑冒烟测试：版本号、中文宽度、
  attach 时读 terminfo。
