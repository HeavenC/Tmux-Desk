# Tmux Desk 桌面终端管理器设计

## 目标

在 macOS 上提供一个纯本地的 tmux 桌面管理器。应用采用 Codex 风格工作台布局，让用户在同一窗口内搜索、创建、连接、收藏、重命名和关闭 tmux 会话，并直接操作真实终端。第一版不包含登录、网络服务、云同步或插件集成。

## 产品边界

- 首发平台仅 macOS，支持 Apple Silicon，工程结构保留 x64 打包能力。
- 默认亮色主题，同时提供暗色和跟随系统主题。
- 只调用本机 tmux 与本机文件系统；不会上传命令、终端输出或偏好。
- 首发交付为本地 DMG/应用包。未来 App Store 版本需要单独评估 App Sandbox 对 tmux socket 和外部进程的限制，不能承诺与非沙盒版能力完全一致。
- 不实现 SSH 连接管理、AI、插件、账号、跨设备同步、终端录屏和会话共享。

## 用户体验

### 主布局

窗口使用 macOS 隐藏式标题栏。左侧是窄功能栏，中间是会话侧栏，右侧是终端工作区：

- 功能栏提供工作台、收藏筛选、设置和主题切换。
- 会话侧栏提供新建、刷新和搜索；收藏会话置顶。每行显示会话名称、状态、窗口/面板数量与当前目录。
- 主工作区顶部标签对应当前 tmux 会话的窗口；点击标签选择窗口。面板菜单列出 pane，并显示当前目录与前台命令。
- 主体是完整 `xterm.js` 终端。tmux 自己负责分屏布局，应用不重新模拟 pane 分割。
- 无选中会话、tmux 未安装、没有会话和会话被外部关闭时使用专门空状态。

### 核心操作

- 新建会话：名称、工作目录、可选启动命令；成功后立即连接。
- 会话菜单：连接、收藏/取消收藏、重命名、复制名称、关闭。
- 关闭会话始终二次确认，确认文案包含会话名称和正在运行的 pane 数。
- `⌘K` 打开命令面板；`⌘N` 新建、`⌘F` 搜索、`⌘R` 刷新、`⌘1…9` 选择窗口。
- 亮色、暗色和跟随系统三种主题立即生效，首次启动默认亮色。

## 技术方案

采用 Electron、`@xterm/xterm`、`@xterm/addon-fit`、`node-pty` 和原生 JavaScript。渲染进程使用 esbuild 打包，不引入前端框架。测试使用 Node 内置测试运行器，避免额外测试框架。

### 进程与模块边界

- Electron 主进程负责窗口生命周期、tmux 命令、PTY、偏好文件和 IPC。
- preload 只暴露白名单 API，不提供任意 shell 或文件系统访问。
- renderer 只负责状态、DOM、快捷键、主题和 xterm 渲染。
- tmux 控制命令全部使用 `execFile` 参数数组，禁止拼接 shell 字符串。
- 启动命令通过 `tmux send-keys -l` 写入，再单独发送 Enter，避免将命令插入控制命令的 shell。

### 文件职责

- `src/main/tmux-service.js`：定位 tmux、执行结构化命令、解析会话/窗口/pane、创建/重命名/关闭/选择。
- `src/main/terminal-manager.js`：维护当前 BrowserWindow 对应的单个 tmux attach PTY，转发输入、输出和 resize。
- `src/main/preferences-store.js`：原子读写本地 JSON，保存主题、收藏和窗口尺寸。
- `src/main/ipc.js`：注册严格校验的 IPC handlers。
- `src/main/main.js`：创建窗口、应用菜单、生命周期和模块装配。
- `src/preload.js`：公开 `tmuxDesk` API。
- `src/renderer/`：页面模板、样式、应用状态、终端视图、命令面板和对话框。

## 数据流

### 启动与刷新

1. 主进程按 `/opt/homebrew/bin/tmux`、`/usr/local/bin/tmux`、`/usr/bin/tmux` 和 PATH 顺序定位二进制。
2. renderer 请求 `system:get-status` 与 `sessions:list`。
3. `TmuxService` 用制表符格式输出读取 session/window/pane，并转换为稳定对象。
4. renderer 每两秒轮询一次元数据；窗口失焦或隐藏时暂停，重新聚焦后立即刷新。

### 连接终端

1. 用户选择会话，renderer 调用 `terminal:attach(sessionId, cols, rows)`。
2. `TerminalManager` 先关闭旧 attach 客户端，再用 `node-pty` 启动 `tmux attach-session -t <id>`；不会关闭 tmux 会话。
3. PTY 输出通过带 terminal id 的事件发送给 renderer；renderer 只接收当前 id 的输出。
4. 键盘输入和 xterm resize 经白名单 IPC 回到 PTY。
5. 用户切换 tmux 窗口或 pane 后，控制层执行 `select-window` / `select-pane` 并刷新元数据。

## 本地状态

偏好保存到 Electron `userData/preferences.json`，在 macOS 通常位于 `~/Library/Application Support/Tmux Desk/`。结构包括：

- `theme`: `light | dark | system`，默认 `light`。
- `favorites`: tmux session 名称数组；会话重命名时同步更新。
- `lastSession`: 上次选中的会话名称。
- `windowBounds`: 主窗口位置与尺寸。

写入采用同目录临时文件加 rename，损坏 JSON 自动回退默认值并保留应用可用性。

## 异常与恢复

- tmux 不存在：显示安装说明和“重新检测”，不启动 PTY。
- tmux server 尚未运行：按“暂无会话”处理；新建会话会自动启动 server。
- attach 目标在操作期间消失：结束当前 terminal id，刷新列表并展示非阻断提示。
- 控制命令失败：使用 tmux stderr 生成简短中文错误；renderer 不显示堆栈。
- PTY 意外退出：保留终端历史，显示可重新连接的状态条。
- 外部 tmux 客户端改动会话：两秒轮询修正 UI；收藏按名称匹配，失效项保留到用户取消或同名会话重新出现。

## 安全与隐私

- `contextIsolation: true`、`nodeIntegration: false`、启用 sandbox 的 renderer。
- CSP 只允许本地脚本和样式；应用没有网络请求能力。
- IPC 校验字符串长度、会话 id、数字范围和工作目录。
- 不记录终端输入与输出。错误日志仅写到标准 Electron 日志，且不包含命令内容。

## 测试与验收

### 自动化测试

- tmux 输出解析、名称/路径校验、错误映射。
- 偏好默认值、损坏文件回退、原子保存、收藏和重命名迁移。
- PTY 单实例切换、输入、resize、退出事件和清理。
- 命令面板过滤、会话排序与主题解析。
- 使用独立 `tmux -L <test-socket>` 的集成测试验证创建、列出、重命名、窗口/pane 查询和关闭，不触碰用户现有会话。

### 手工验收

- 启动后看到现有本地 tmux 会话，默认亮色。
- 能创建会话并在应用内运行交互命令、彩色输出和全屏程序。
- 会话、窗口和 pane 切换正常，终端 resize 不破版。
- 搜索、收藏、重命名、关闭与快捷键正常。
- 在系统 Terminal 中外部创建/删除会话，应用能自动刷新。
- 重启应用后主题、收藏、窗口尺寸和上次会话恢复。
- `npm test`、`npm run build` 和 macOS 应用打包均成功。

## 发布说明

首版使用 Electron Builder 生成 arm64 DMG 与 zip，保留 universal/x64 脚本。签名和公证参数通过环境变量注入，不写入仓库。Mac App Store 作为后续独立里程碑：届时验证 MAS target、entitlements、App Sandbox、tmux 可执行文件分发方式和 socket 访问策略。
