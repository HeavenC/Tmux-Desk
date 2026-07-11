# Tmux Desk

Tmux Desk 是一个本地优先的 macOS tmux 桌面管理器。它采用类似 Codex 的工作台布局，把本机 tmux 会话、窗口、pane 和真实终端集中到一个桌面窗口中，并可按需开启手机 Web 接入。

## 功能

- 查看、搜索、创建、连接、收藏、重命名和关闭本机 tmux 会话
- 为一个会话分配多个本地 **Tag**，并从左侧功能栏按 Tag 进入独立工作区
- 左侧 Tag 区铺满可用高度并按最近使用排序；可展开整列查看完整名称，新建和刚打开的 Tag 自动置顶
- Tag 与收藏工作区会收起中间会话栏，把同组会话聚合成一排浏览器式页签；同一 Tag 内不会重复
- “全部”视图的会话侧栏可拖动调宽，双击分隔条恢复默认；Tag/收藏紧凑视图仍会完整收起它
- **复制会话**（类似 `git checkout -b`）：按现有会话的窗口与目录派生一个副本，原会话保持不变
- **右侧文件浏览器**（`⌘B` 收起/展开）：按当前会话目录浏览文件树，支持默认应用打开、“打开方式…”选择其他 App、在访达中显示、复制路径
- 工作区右上角面板菜单快速定位 pane，`⌘1…9` 继续切换当前会话的 tmux window
- 基于 xterm.js + node-pty 的完整交互终端，支持颜色、鼠标和全屏终端程序
- `⌘K` 命令面板与常用 macOS 快捷键
- 亮色、暗色和跟随系统主题；首次启动默认亮色
- 设置面板限制在视口内，Tag 较多时中央内容独立滚动，标题和完成按钮始终可见
- 外部 Terminal 中创建或关闭会话后自动刷新
- 不含登录、遥测、云同步或插件；手机 Web 服务默认关闭，仅在用户主动启动后监听网络

## 使用 Tag

1. 点击左侧功能栏 Tag 区域下方的 `+` 新建 Tag。
2. 在任一会话右侧 `…` 菜单中选择“管理 Tag…”，可同时勾选多个 Tag。
3. 点击左侧 Tag 后，中间会话列表会收起；该 Tag 下的会话显示为终端上方的一排页签。
4. 点击展开按钮可显示完整 Tag 名称；最近打开的 Tag 会移到最上方，并在重启后保持。
5. 点击“全部会话”恢复完整会话列表。设置页可新建、重命名和删除 Tag；删除 Tag 不会关闭 tmux 会话。

Tag、收藏、主题和窗口尺寸都只保存在本机。复制会话会继承源会话的 Tag；重命名会话时 Tag 关联会同步迁移。

## 环境要求

- macOS（首版支持 Apple Silicon，工程保留 x64/universal 打包脚本）
- Node.js 22+
- Xcode Command Line Tools
- tmux：

```bash
brew install tmux
```

应用会依次检测**自带 tmux**（`.app` 内 `Contents/Resources/bin/tmux`）、`/opt/homebrew/bin/tmux`、`/usr/local/bin/tmux`、`/usr/bin/tmux` 和 PATH。

> **给没装 tmux 的用户预打包 tmux**：把一个可执行的 tmux 二进制放到 `vendor/bin/tmux` 再打包，应用即自带 tmux、开箱即用（详见 `vendor/README.md`）。默认 `vendor/bin` 为空，应用回退到本机 tmux。

> **从访达/程序坞启动也能正常读取会话**：应用会为 tmux 子进程强制 UTF-8 locale（`LANG`/`LC_ALL`）。否则从 Finder 启动时进程不继承 shell 的 `LANG`，tmux 会退回 C locale 并把制表符分隔和中文/emoji 会话名替换成 `_`，导致会话名为空、窗口数为 0、报“会话名称无效/tmux 目标无效”。

## 本地运行

```bash
cd terminal-cli
npm install
npm start
```

`npm install` 会使用 Electron Builder 为当前 Electron 版本重建 `node-pty` 原生模块。

## 手机 / Web 版（远程访问）

手机浏览器即可操作本机全部 tmux 会话（建议配合 Tailscale 在外网访问，传输安全由其 WireGuard 隧道保证，服务本身不做 TLS）。两种启动方式：

- **桌面 App 内**：左侧功能栏的手机图标（或命令面板「手机访问」）→「启动 Web 服务」，弹窗展示 Tailscale 与局域网两个二维码，手机扫码直达。App 退出时服务随之停止。
- **命令行守护进程**（不开 App 也可用）：

```bash
npm run serve:web     # 构建手机页面并启动，默认端口 8790
```

启动后会打印各网卡的访问 URL（含随机 token，持久化在 `~/.config/tmux-desk/web-token`）。手机打开 `http://<Tailscale IP>:8790/?token=<token>`，可加到主屏幕当 App 用。命令行已启动时，App 内入口会识别为「由外部进程启动」并直接展示二维码。

- 会话列表 → 点击进入全屏终端（xterm.js），底部有 Esc / Tab / Ctrl（粘滞）/ ⌃B / 方向键辅助键
- 列表顶部可在“全部 / 收藏 / 各 Tag”之间横向切换；同一 Tag 内按会话名去重，会话卡展示多个 Tag，并可从手机底部面板修改关联
- 手机页支持独立亮/暗主题（本设备持久化）、终端触摸滚屏、刘海安全区、横竖屏和虚拟键盘动态高度
- 终端顶部只保留一个 tmux window 选择器，不再叠加 `2: claude / 3: server` 式第二排页签
- 手机 attach 的是**会话组派生会话**（`_web_*`），与桌面端内容同步但当前窗口、尺寸互不干扰；断开自动清理
- 桌面内启动的 Web 服务直接复用桌面偏好存储；命令行守护进程默认读取同一个平台目录，可用 `TMUX_DESK_PREFERENCES_FILE` 显式覆盖
- 环境变量：`TMUX_DESK_WEB_PORT`、`TMUX_DESK_WEB_HOST`、`TMUX_DESK_WEB_TOKEN`、`TMUX_DESK_PREFERENCES_FILE`

Web 服务使用 URL 中的随机 token 鉴权，但自身不提供 TLS。建议只通过 Tailscale 使用；局域网 URL 只适合可信 Wi-Fi，**不要把 8790 端口直接暴露到公网**。带 token 的完整 URL 等同访问凭据，不要转发给无关人员。

## 测试

```bash
npm test
npm run test:integration
npm run build
```

集成测试使用独立的 `tmux -L tmux-desk-test-*` socket，不会连接、修改或关闭用户现有 tmux 会话。

## 打包 / 出 DMG

### 最简单：一键脚本（推荐给不熟悉构建的人）

在 macOS 上，拿到源码后只需：

```bash
cd terminal-cli
./build.sh            # 为当前 Mac 架构出 DMG（Apple Silicon→arm64，Intel→x64）
```

脚本会自动检查环境、安装依赖（含为 Electron 重建 `node-pty`）、打包，最后在 `dist/` 生成
`Tmux Desk-<版本>-<arch>.dmg` 和 `.zip`。其它目标：

```bash
./build.sh intel      # 强制 Intel (x64)
./build.sh universal  # 通用二进制（arm64+x64，体积更大）
./build.sh all        # 同时出 arm64 和 x64
```

**前置条件**（脚本会检测并提示）：
- macOS（打 `.app`/`.dmg` 只能在 mac 上）
- Node.js 18+（推荐 20/22）：官网或 `brew install node`
- Xcode Command Line Tools（编译 `node-pty` 原生模块用）：`xcode-select --install`
- 首次构建需联网（会下载 Electron 运行时）

产物已 **ad-hoc 签名**（`codesign --sign -`，见 `scripts/afterpack-adhoc.js`）但**未公证**。这一步很关键：
Apple Silicon 会拒绝运行没有有效签名的 bundle，一旦经传输被打上隔离标记，就会报 **“已损坏，无法打开”**。
ad-hoc 签名后，接收方首次打开只会遇到普通的“无法验证开发者”，**右键该 App → 打开**，或
`xattr -cr "/Applications/Tmux Desk.app"` 即可。运行还需本机装有 tmux（`brew install tmux`）。

> **分发务必发 `.dmg`**，不要把裸 `.app` 通过微信/邮件发出去 —— 这类通道会破坏 Electron 框架里的软链接，
> 同样导致“已损坏”。DMG 会完整保留 bundle。
>
> **同事已经拿到的旧版报“已损坏”怎么救**（那份是未 ad-hoc 签名的旧包）：让他在本机执行
> ```bash
> xattr -cr "/Applications/Tmux Desk.app"
> codesign --force --deep --sign - "/Applications/Tmux Desk.app"
> ```
> 或者直接换用重新构建出的、已 ad-hoc 签名的新 DMG（推荐）。

### 手动等价命令

```bash
npm install                                        # 装依赖 + 重建 node-pty
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac          # arm64 DMG + zip
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac:x64      # Intel
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac:universal # Universal
```

正式发布时请通过 Electron Builder 环境变量配置 Developer ID 签名和 Apple 公证，不要将证书或凭据写入仓库。

## 快捷键

| 快捷键 | 操作 |
|---|---|
| `⌘K` | 打开命令面板 |
| `⌘N` | 新建会话 |
| `⌘F` | 搜索会话 |
| `⌘R` | 刷新会话 |
| `⌘B` | 收起/展开文件浏览器 |
| `⌘⇧T` | 在亮色、暗色、跟随系统之间切换 |
| `⌘1…9` | 切换当前会话的 tmux window |
| `Esc` | 关闭菜单或对话框 |

## 本地数据与隐私

桌面模式不会把终端输入、输出或 tmux 会话数据发送到网络。主动启用手机 Web 服务后，终端数据会在这台 Mac 与持有 token 的访问设备之间实时传输，但不会落盘；传输加密由 Tailscale 等外层网络负责。主题、收藏、Tag、Tag 栏展开状态、会话关联、上次会话、侧栏宽度和窗口尺寸保存在：

```text
~/Library/Application Support/tmux-desk/preferences.json
```

应用的渲染进程没有 Node.js 权限，只能通过白名单 IPC 调用 tmux 与终端操作；控制命令使用 `execFile` 参数数组，不拼接 shell 命令。

## 常见问题

### 应用提示未找到 tmux

运行 `brew install tmux` 后重启应用或点击“重新检测”。Apple Silicon Homebrew 默认路径是 `/opt/homebrew/bin/tmux`。

### node-pty ABI 错误

依赖可能是由另一 Node/Electron 版本构建的，重新运行：

```bash
npm run postinstall
```

### 切换会话会不会杀掉任务？

不会。切换时只关闭当前应用窗口对应的 `tmux attach` 客户端，tmux server 和会话内进程继续运行。只有明确选择“关闭会话”并二次确认后，才会执行 `tmux kill-session`。

### App Store 计划

当前版本面向本地 DMG/zip 分发。Mac App Store 强制 App Sandbox，而沙盒会限制外部 tmux 进程和用户既有 tmux socket 的访问。未来 MAS 版本需要独立验证 entitlements、tmux 分发方式和 socket 策略，不能保证与非沙盒版本能力完全一致。
