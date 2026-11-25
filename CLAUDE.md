# CLAUDE.md — tmux-desk

Electron + xterm.js@6 的 tmux 图形前端。桌面端 renderer 在 `src/renderer/`，手机 web 端在 `src/webapp/`（经 `src/server/` 的 WebSocket 复用同一个 `TerminalManager`）。测试 `npm test`（node --test），构建 `npm run build`，部署 `./scripts/deploy.sh`（本机）/ `./scripts/deploy-host.sh`（推到 `host` 远端那台部署机再部署）。本机开发环境相关的私有说明在 `CLAUDE.local.md`（不进 git）。

## Apple 系统风格改造（2026-07-25）

参考技能 `~/.claude/skills/apple-design`（emilkowalski/skills，Apple WWDC《Designing Fluid Interfaces》等讲座的 Web 译本）。

### 共享 token 层
- `src/shared/apple-tokens.css`：系统色（`--sys-*`）、填充（`--fill-*`）、材质（`--material-*` + `--blur-*` + `--glass-edge`）、同心圆角（`--r-xs..--r-pill`）、弹簧化缓动（`--ease-standard/snappy/decel/bounce/inverse` + `--response-*`）、按字号分级的 tracking（`--track-display/title/body/caption`）。两端各自的 `styles.css` 只做**语义映射**（`--accent: var(--sys-blue)` 等），不再写死颜色。
- 两个 build 脚本都把它拷进产物，`index.html` 在自己的 `styles.css` **之前** link，所以各端可覆盖任意 token。
- 三个 a11y 降级都在 token 层：`prefers-reduced-motion`（保留透明度/颜色反馈，去掉位移与过冲）、`prefers-reduced-transparency`（材质变实色 + 各端关掉元素级 `backdrop-filter`）、`prefers-contrast`（hairline 加深）。

### 桌面端：原生 vibrancy 分区
- `main.js` 仅 darwin 加 `vibrancy: 'sidebar'` + `visualEffectState: 'followWindow'` + `backgroundColor: '#00000000'`；非 mac 保持不透明底色。CSS 侧 `body`/`.app-shell` 透明，**rail + session-sidebar = 半透明 chrome（`--rail-wash`/`--sidebar-wash`），workspace + terminal = 不透明内容区**，与 macOS 的分区一致。
- **坑：vibrancy 的明暗来自 `nativeTheme`，不是 renderer 的 `data-theme`** —— 不设 `nativeTheme.themeSource` 时，app 内选亮色而系统是暗色会得到"亮界面 + 暗材质"。已在 `main.js` 启动和 `ipc.js` 的 `preferences:save`（`'theme' in validated`）两处同步；`ipc.js` 在非 Electron 环境里 `require('electron')` 拿不到 `nativeTheme`，故带判空。
- **坑：wash 太淡会让 chrome 文字直接死在壁纸上**。第一版用 `rgba(0,0,0,.03)` / `rgba(255,255,255,.18)`，在模拟壁纸下二级文字几乎不可读 —— 现在 rail/sidebar 是**实质材质**（.38~.62 alpha），并按技能 §12 把 `--text-secondary/tertiary` 提亮、sidebar 文字加 `font-weight: 450` + 微正 tracking。
- 选中态改 macOS 语义：sidebar 会话行 = **accent 填充胶囊 + 内容整体反白**（含 state dot / meta / more 按钮）；菜单项与命令面板结果 hover/selected 也是 accent 填充反白（注意这些反白规则必须**写在**各自 `.danger`/`svg`/`.menu-check` 颜色规则**之后**才能赢层叠）。
- 菜单/popover/命令面板/toast = 玻璃（`--glass-raised` + `blur-thick` + `materialize` 关键帧：blur 与 scale 同时到位，不是纯淡入）；modal sheet 保持**不透明**并从顶边 `transform-origin: top center` 展开（macOS sheet 语义）。玻璃面板内部的控件一律实色 —— **不叠两层半透明**。
- **验证坑：CDP `Page.captureScreenshot` 抓透明窗口会得到预乘 alpha 的糊字**（看起来像"深色文字压深色背景"），会误判成对比度 bug。用 `Emulation.setDefaultBackgroundColorOverride` 塞一个不透明底色再截图，才等价于 vibrancy 提供的背衬。本机 Claude 进程没有「屏幕录制」权限，`screencapture` 一律失败，**真机 vibrancy 效果只能人眼确认**。

### 手势物理（`src/shared/spring.js`，测试 `test/spring.test.js`）
- CSS 表达不了「可中断 + 带速度」的动效，所以 JS 侧有 `createSpring`（Apple 的两个旋钮：damping ratio + response，`target()` 从**当前值和当前速度**重新瞄准，天然可中断反向）、`project()`（iOS 指数衰减的动量投射 `(v/1000)·d/(1−d)`，**不是**教科书的 `v²/2a`）、`rubberband()`（越界渐进阻尼）、`createVelocityTracker`（近 100ms 采样，避免整段手势平均掉甩动速度）。
- 已接入手机端悬浮球：按下即 `stop()` 抓住飞行中的球（可中途反向）、拖动 1:1 且越界橡皮筋、松手按**投射落点**而非松手点选左右边缘、X/Y 各一条弹簧并交接释放速度（单条 2D 弹簧在两轴速度不同时会失步）。CSS 里悬浮球**不能**给 left/top 加 transition，否则和弹簧打架。

### 手机端 iOS 化
- 分组列表语义：页面底色 `#f2f2f7`/`#000`，卡片是抬起层，nav/filter/copy chrome 半透明 + `backdrop-filter`（内容从下面滚过去）。筛选 chip 选中 = accent 实心胶囊；`.icon-btn` 用 accent 色；按下即 `scale()` 反馈（`--response-instant`）。
- 底部 sheet 大圆角 + 从下边缘 `translateY(100%)` 进入，`.closing` 用 `--ease-inverse` 反向播放**同一条路径**（进出路径对称）。toast 变胶囊玻璃，从底边升起。
- **坑（顺手修的真 bug）：`.workspace-filters { display: flex }` 会盖掉 UA 的 `[hidden] { display: none }`**，所以单主机时被 `hidden` 的 `#host-filters` 仍占满 58px，标题下方一直有条空白带。补了 `.workspace-filters[hidden] { display: none }`。

### 顶栏按钮点不到 = 页面被缩放到 50%（真凶），安全区只是顺带补的
- 现象：加到主屏幕（standalone）后，终端页左上角返回键、右上角主题键"经常点不到"。
- **先走过一次弯路**：以为是缺 `env(safe-area-inset-left/right)`。那确实是个真 bug（见下），但**不是这个症状的原因** —— 竖屏下左右 inset 是 0，补了等于没补。教训：改之前先从截图**量**，别照着假设改。
- 量法（可复用）：`sips -s format bmp` 把截图转成 BMP，用 python 直接读像素（不依赖 PIL），拿**已知尺寸的元素**当标尺 —— 顶栏 4 个 `.icon-btn` 的中心间距 CSS 上恒为 48px（44 宽 + 4 gap）。截图里量到只有 **56.3 px**，而 iPhone 15 Pro 的截图缩放是 2.348 px/pt，本该是 112.7 px → **1 CSS px 只覆盖 0.5pt，布局视口 ≈ 787 CSS px（正常 393）**。
- 交叉验证全对得上：终端顶栏总高量得 109 CSS px = `padding-top 59 + 按钮 44 + padding-bottom 6`，所以 **`env(safe-area-inset-top)` 一直是正确报了 59 的**；但 59 CSS px 在半缩放下只占 **29.5pt**，状态栏有 59pt → 按钮（物理 29.5..51.5pt）**整个埋在状态栏里**被系统吃掉点击，而且实际只有 22pt 大（Apple 最小 44pt）。终端能显示 100+ 列也是同一个证据。
- 根因：iOS 会**记住**这个 web app 被捏合缩小后的比例，重启也保留。CSS 里没有任何东西能感知到它。
- 修复：`.topbar` / `.term-topbar` 加 `zoom: var(--chrome-scale, 1)`，`applyChromeScale()` 用 `max(innerW,innerH) / max(screen.w,screen.h)`（iOS 的 `screen.*` 不随旋转交换，所以比长边）算出缩放比，>1.05 才补偿、上限 3。zoom 会把 padding、`env()` inset、按钮尺寸一起乘回去 → 顶栏恢复设计时的**物理**尺寸，而终端保留用户要的高密度。不去强行禁用缩放：100 列很可能是用户故意捏出来的。
- 顺带修的真 bug（横屏才犯）：`styles.css` 只用了 `env(safe-area-inset-top/bottom)`，**从来没有 left/right**。standalone + `viewport-fit=cover` 是全出血 webview，横屏刘海侧 inset 59px、Home 指示条侧 21px，而 `.term-topbar` 左右 padding 只有 8px → 返回键整个压在刘海下面。现所有触边 chrome 一律 `max(env(safe-area-inset-left/right), <底线>)`：`.topbar`/`.term-topbar` 16px、`.workspace-filters`/`.list-content` 12px、`.terminal-container` 4px、`.banner`/`.sheet-panel`/`.copy-*` 16px。
- **坑：`--safe-left: env(safe-area-inset-left)` 这种自定义属性，JS 读回来是未替换的 `env(...)` 词元串**（自定义属性不做 env 替换，只在真正用于某个属性时才解析），`parseFloat` 直接 NaN。悬浮球是 JS 定位的、必须拿到数值 → 加了零尺寸的 `#safe-probe`，把四个 inset 塞进它的 `padding`，`getComputedStyle(probe).paddingLeft` 才是解析后的 px。`ballBounds()/loadBallPosition()/positionQuickPanel()` 都改用它，否则球能停到刘海底下。
- 验证：sed 把产物 CSS 里的 `env(safe-area-inset-*)` 替换成 iPhone 15 Pro 实测值，静态 harness 里画红色遮挡带模拟刘海，`--headless=new --screenshot` 前后对比（横屏：改前返回键完全在红带内，改后 x=81 起）；缩放补偿则是 `--window-size=786,1704` + 注入 `Object.defineProperty(window.screen,'width',{get:()=>393})` 伪装设备宽度，量 `getBoundingClientRect`（按钮从 59..103 → **112..195 CSS px**）。**注意 `env(x, 0px)`（带 fallback）不会被匹配 `env(x)` 的 sed 命中**，探针那条规则要单独替换。

### 左上角返回键点不到（第二次，这回是 iOS 自己盖上去的，2026-08-30）
- 现象：加到主屏幕的 web app 里，终端页左上角**看不到返回箭头**，那个位置是一个淡灰色的「•••」，点它弹出的是系统菜单。
- **不是上面那个缩放 bug**（那次是按钮尺寸只有 22pt）。这次先从用户截图**量**：标题 "cds" 的中心恰好落在图片正中 ⇒ 左侧那个 44px 的按钮槽位还在、宽度也对（若 `#back-btn` 被 `hidden`，标题会左移约 22px）；而整张截图里**除了右上角月亮没有任何蓝色像素**，说明我们那个 `--accent` 蓝色的 `‹`（U+2039）**根本没被画出来**。同一份 `webapp-dist` 的 CSS 在本机 headless Chrome 里渲染出来是 10×11px 的蓝色尖角，和截图里那三个直径 5px 的中性灰圆点（(157,157,157)）完全不是一回事。
- 根因：**iOS 主屏 web app 会由系统在页面左上角画一个半透明的「•••」菜单**，它在 web 内容**之上**、且不在我们的 stacking context 里 —— 任何 z-index 都赢不了，点击也被它吃掉。
- 修复：把左上角**让出来**。`applyWebAppChrome()` 用 `navigator.standalone === true`（iOS 独有）给 `<html>` 打上 `data-ios-webapp`，CSS 里 `.topbar`/`.term-topbar` 的 `padding-left` 加一个 `--ios-corner-gutter: 56px`。56px 是从截图量出来的：控件墨迹到 image x≈109、按 751px 宽 / 393pt 换算 ≈ 57 CSS px，加内边距约 63px，让到 72px 起。**这条 `padding-left` 必须写在两个 topbar 的 `padding` 简写之后**（`.term-topbar` 的简写在文件靠后），否则被简写盖掉。
- 和 `--chrome-scale` 的 `zoom` 天然兼容：页面被捏小时 zoom 会把 gutter 一起乘回去，而系统控件是固定物理尺寸 —— 两个补偿方向一致。
- 顺手加了**左边缘滑动返回**（`setupEdgeSwipeBack()`，挂在 `#view-terminal` 的 capture 阶段）：手指必须**从 ≤24px 的边缘起手**、横向走够 70px 且 `|dy| < |dx|/2` 才触发，免得终端里的拖动误触；共享链接模式下 `#back-btn` 是 hidden，用它当开关直接跳过。这样以后任何系统在角落画东西都困不住会话。
- 量图方法沿用上一节：`sips -s format bmp` 转 BMP + python 直接读像素（不依赖 PIL）。**注意用户发来的截图可能被放大过** —— 这张 751×1488 的图相邻两行像素完全相同，说明纵向是 2× 最近邻放大，按物理像素去推 pt 会全错，只能用「元素占宽度的比例」来换算。

### 手机相册贴图（相当于 PC 上复制图片后 ⌃V）
- 终端里没有任何转义序列能携带图片字节，所以做法只能复刻桌面：**把图片放到"跑这个会话的那台机器"的系统剪贴板，再发 `\x16`（⌃V）**，前台应用（Claude Code）自己去读剪贴板。
- 链路：快捷面板「图片」→ 隐藏的 `<input type="file" accept="image/*">`（iOS 弹照片图库/拍照）→ canvas 压到长边 1568（Claude 自己的上限）→ **PNG 源保持 PNG**（截图里的小字被 JPEG 毁掉）、其余转 JPEG q0.82 → base64 → `POST /api/paste-image {session,mime,data}` → 服务端 `putImageOnClipboard()`（`src/main/clipboard-image.js`：写临时文件，非 PNG 先 `sips -s format png`，再 `osascript` `set the clipboard to (read (POSIX file …) as «class PNGf»)`）→ 成功后客户端走**普通输入通道**发 `\x16`。
- 远程/中继会话：要设的是**上游那台机器**的剪贴板，所以 `parseTarget` 判到 `kind==='remote'` 时把整个 body 转发给上游的 `/api/paste-image`（`upstreamRequest` 因此加了 `timeout` 参数，默认 4s 对几 MB 的图不够，这条走 30s）。`readJsonBody` 也加了 `limit` 参数（默认仍 64KB，这条放到 ~17MB）。
- `«class PNGf»` 是各家都认的剪贴板图片类型，别直接塞 JPEG 字节。验证：`osascript -e 'clipboard info'` 应列出 `«class PNGf», <字节数>`。
- **路径兜底**：图片一律先落到 `~/Library/Caches/tmux-desk/pasted-images/`（保留 24h，每次写入时按 mtime 清理），剪贴板这步失败或非 macOS 时返回 `{clipboard:false, path}`，客户端改为把**绝对路径**打进输入框——agent 读图片路径同样有效。所以返回体是 `{ok,path,clipboard}`，中继会把上游的这两个字段透传回来（路径本就属于会话所在的那台机器）。
- **坑（第一版直接炸了）：`scripts/deploy.sh` 里写了 `TMPDIR=$(mktemp -d)` ... `rm -rf "$TMPDIR"`**。`TMPDIR` 在 macOS 上是**已导出的标准变量**，赋值即覆盖导出值，而 `open "$APP_PATH"` 会把这份环境交给 app —— 于是部署完的 app 进程里 `os.tmpdir()` 指向一个**已被删除**的目录，第一次 `mkdtemp` 就 `ENOENT`。已改名 `STAGE_DIR`；同时贴图模块**不再用 `os.tmpdir()`**，改用自己从 `os.homedir()` 推出来的目录，免得被拉起它的环境毒化。复现/回归方式：`DEAD=$(mktemp -d); rmdir $DEAD; TMPDIR=$DEAD node src/server/index.js`。

### 任意文件上传 + `@绝对路径` 引用（2026-09-12）
- 快捷面板那个按钮从「图片」改成 **「文件」**（`#file-btn` / `#file-input`，去掉 `accept`、加 `multiple`）。去掉 accept 后 iOS 的选择器反而更全：照片图库 / 拍照 / 浏览三选一，一个入口覆盖图片和文档。
- **按类型分流，不是一刀切**：图片仍走原来的剪贴板链路（`/api/paste-image` + `\x16`，agent 要的是"看见"这张图）；其余文件走新的 `POST /api/upload-file {session,name,data}`，落到 `~/Library/Caches/tmux-desk/uploads/`（`src/main/upload-file.js`，保留 7 天 —— 比贴图的 24h 长，因为提示词里的路径引用可能隔几天还要用），客户端再把 **`@<绝对路径> `** 打进输入框。图片剪贴板失败时的兜底路径现在也带 `@`。
- **文件名必须能当 `@token` 用**：空格 → `_`，非「字母/数字/`.`/`-`/`_`」一律丢（`\p{L}` 是 unicode 的，中文名完整保留），只取 basename 所以 `../` 穿不出去，再补 6 位随机后缀防止重名覆盖掉别人还在引用的那个文件。`path.extname('...')` 会返回 `'.'`，得单独判掉，否则生成 `file.` 这种名字。
- 中继/远程会话同 paste-image：`parseTarget` 判到 `kind==='remote'` 就整体转发给上游（路径只在跑会话的那台机器上有意义），回包原样透传 `path`/`name`。上限 32MB（`MAX_UPLOAD_BYTES`），客户端先按 `file.size` 挡一次，免得 base64 完才失败。
- **PC 浏览器可以直接拖文件进来**（`setupFileDrop()`，挂在 `#view-terminal`）：浏览器拿不到本地真实路径，所以拖拽和选择器走完全同一条上传链路。`dragenter`/`dragleave` 会因为经过每个子元素而反复 fire，**必须用计数器**否则蒙层一路闪；`dragover` 不 `preventDefault` 的话浏览器直接导航到那个文件、整个页面就没了。拖到窗口外结束时不会 fire `drop`，所以 `dragend`/`blur` 也要复位。触屏端不产生 drag 事件，天然不受影响。
- 多选/多文件拖拽**串行上传**：每个文件各自往输入框打一条 `@path`，并发会把引用洗牌。多文件时不走剪贴板（系统剪贴板只装得下一张图）。
- **蒙层别做成毛玻璃**：第一版 `backdrop-filter: blur(14px)` + 16% 的色罩把终端糊成一片，什么都看不见。现在是 8% 的 accent 淡色 + `inset` 描边 + 一颗实心胶囊提示，终端内容全程可读。
- **桌面端（Electron）也能拖**（`setupTerminalFileDrop()` 挂在 `#terminalStage`），但**逻辑和浏览器端相反**：本机会话直接用文件**自己的真实路径**，不复制也不上传（Electron 32 起 `File.path` 没了，靠 preload 的 `webUtils.getPathForFile`，只能在 preload 里调）；**远程接管的会话必须上传**（agent 在对面那台机器上，本地路径对它没意义）→ `RemoteApi.uploadFile()`，打进去的是**上游返回的路径**。顺手在 `window` 上拦了 dragover/drop，否则往非终端区域丢文件，Chromium 会直接导航到 `file://` 把整个 app 顶掉。
- **路径必须转义**（`src/shared/terminal-path.js`）：`@/tmp/my notes.md` 到 agent 那儿是「`/tmp/my` + 一个多余的词」，**错得很安静**。所以按终端拖文件的惯例给空格和 shell 元字符加反斜杠。上传的文件名虽然已经清洗过，但本地拖拽拿到的是用户自己的命名、上层目录（`~/My Drive`）更管不着。
- **跨版本中继的坑（用户实际遇到的）**：Windows 浏览器上报「上传失败：未知接口」。不是前端问题 —— 那个会话是**从别的主机中继过来的**，中继会把请求转发给上游，而上游那台还跑着旧版、没有 `/api/upload-file` → 404 的 `未知接口` 被原样透传回来。现在中继遇到 404 会换成「远程主机「X」版本较旧，不支持文件上传」。**排查口诀：先 `curl 上游/api/upload-file` 看是不是 404，再看 `/api/sessions` 里有没有 `r:` 前缀的会话**。
- 验证：`test/manual/file-drop-e2e.js`（真起 Electron，不在 `npm test` 里）。CDP 的 **`Input.dispatchDragEvent` 能带真实文件名**（`data.files`），合成 `DragEvent` 不行 —— 后者 `getPathForFile` 返回空串，本机路径那半根本测不到。断言两段：本机拖 → pane 里是 `@<转义后的真实路径>` 且**没有** `/uploads/`；切到远程源再拖 → pane 里是 `@<.../uploads/xxx-6位hex.txt>` 且字节一致。**capture-pane 要加 `-J`**，长路径会被 tmux 折行，不 join 永远匹配不上。


### 跨设备文件传输：文件面板 + 浏览器「会话文件」（2026-11-17）
- **起因（真 bug）**：远程源下右侧文件面板一直走本机 IPC，拿远程 pane 的路径去列**本机**同名目录——两台机器路径恰好一样时看起来"正常"，其实全是本机文件。`syncFileBrowser` 的去重键因此改成「源 + 会话 + 目录」（`fileContext().key`），切源时同路径也会重新列。
- **服务端** `src/main/file-transfer.js`，web-server 挂 `GET /api/files/list`、`GET|HEAD /api/files/download`、`POST /api/files/upload?dir=&name=`（**原始字节体，不是 base64 JSON**）。双向都是流：下载 `createReadStream → res`，上传 `req → 隐藏的 .xxx.tmux-desk-part → 完整后 rename`，中断不留半截文件。上限 4GB（只防把磁盘写满，不占内存）。
- **路径限定**：只允许会话各 pane 的 cwd 之内（`sessionRoots`，活动窗口的活动 pane 排第一 = 默认根）；在 tmux 的 POSIX 命名空间里判包含，最后一步才 `toBrowsablePath`（Windows/WSL）。这不是比终端更强的边界（有 shell 的人本来就能读），只是别让传输接口比旁边的终端开得更大。
- **单会话分享链接也能用**：走 `requireScopedTarget`，只认被分享的会话（及其 grouped id），请求别的会话 403；`r:` 中继会话对分享链接一律 403。测试覆盖了 list/download/upload 三个动作的放行与拒绝。
- **重名**：上传 / 下载 / 本机拷贝都不覆盖，`name (1).ext` 递增；占名用 `open(..., 'wx')` / `mkdir` 原子创建再 rename 过去，不会和并发上传撞名。
- **`r:` 中继**：`relayFilesRequest` 用 `streamRequest`（http/https 原生请求，空闲 30s 超时）把字节原样转给上游。上游没有这些接口时回 404 `未知接口` → 统一改写成「远程主机版本较旧，不支持文件传输」。
- **桌面端**：远程源下列目录走 `RemoteApi.listSessionFiles`；**下载/上传在主进程**（`src/main/transfer-bridge.js`，IPC `files:remote-download|remote-upload|copy-into|cancel-transfer`）——renderer 只传 connectionId + 会话路径，token 不出主进程、没有 CORS 问题、大文件不过 renderer 内存。进度经 `files:transfer-progress` 推回，面板底部是传输列表（下载完成点一下 = 在访达中显示；失败的行保留到手动移除）。点远程文件 = 下载到「下载」并打开；右键有只下载 / 另存为 / `@路径` 引用 / 复制路径。拖到文件夹行 = 传进那个文件夹，拖到空白处 = 当前根目录；**本机源下拖入是 `fs.cp` 拷贝**。`TMUX_DESK_DOWNLOADS_DIR` 可覆盖下载目录（e2e 用）。
- **手机/浏览器端**：终端顶栏文件夹按钮 → `#files-modal` sheet，逐层进入（不是树），默认隐藏点文件（底部「显示 N 个隐藏项目」，localStorage 记住）。上传用 XHR（要 `upload.onprogress`，fetch 拿不到上传进度）。
- **坑：下载前必须先 `HEAD`**。`<a download>` 碰到错误响应时浏览器会把错误 JSON **当成那个文件保存下来**；所以先 HEAD，失败再 GET 一次读出错误文案 toast。
- **坑：`fs.cp` 往自己刚 `mkdir` 占好的空目录里拷要 `errorOnExist: false`**，否则直接 `ERR_FS_CP_EEXIST`（目录是我们自己的空占位，不存在覆盖风险）。
- **坑：主进程抛的错误类不要改 `name`**。Electron 把 IPC 异常序列化成 `<name>: <message>`，renderer 的 `friendlyError` 只剥 `Error:` 前缀，`TransferError: 已取消` 会原样显示。
- 下载文件名用 RFC 5987（`filename*=UTF-8''…`）带原名，另给 ASCII 兜底；下载响应一律 `attachment` + `CSP: sandbox` + `nosniff`，HTML/SVG 不给真实 MIME——文件是从 app 自己的 origin 发出去的，能执行的类型绝不能被渲染。
- 顺手修：文件面板路径标签是 `direction: rtl`（为了从左边截断），开头的 `~/` 会被排到末尾（显示成 `Documents/…/terminal-cli/~`）；文本前加一个 U+200E（LRM）即可。浏览器端 `.files-path` 同理。
- 验证：`test/file-transfer.test.js`（单元 + 两台真 web-server 串成中继 + 桌面 bridge 两跳）；手动 e2e `test/manual/remote-files-e2e.js`（真 Electron，17 项）、`test/manual/webapp-files-e2e.js`（headless Chrome 手机尺寸，含分享链接，16 项）。**坑：开发 checkout 里 node-pty 的 `prebuilds/darwin-*/spawn-helper` 可能没有可执行位**，终端 attach 报 `posix_spawnp failed`（桌面和 web 端都会）；webapp e2e 遇到时会把「引用到终端」一步标成 skipped，不算失败。

### 验证手段（本次沙箱）
- 桌面：`tmux -L applesk -f /dev/null new-session -d -s keepalive` 起干净 socket（`-f /dev/null` 防 continuum 把真实会话恢复进来），再 `TMUX_DESK_SOCKET=applesk TMUX_DESK_PREFERENCES_FILE=<临时> npx electron . --remote-debugging-port=9223`，用 CDP `Runtime.evaluate` 点按钮 + `Page.captureScreenshot`（配 `SHOT_BG` 底色覆盖）截明暗两套。
- 手机端：沙箱 web server（`TMUX_DESK_WEB_TOKEN=... TMUX_DESK_WEB_PORT=8899 node src/server/index.js`）+ `Google Chrome --headless=new --window-size=390,844 --screenshot`。**注意 `--force-device-scale-factor=2` 会把 CSS 视口砍半**，截出来的溢出是假象，别照着改布局。

## 终端体验的关键决策与踩坑（2026-07 对齐 iTerm 专项）

### 剪贴板（选中复制）链路
- tmux 侧：`TerminalManager.attach()` 用 **`tmux -T clipboard,RGB attach-session`** 声明客户端支持 OSC52（配合用户全局 `set-clipboard external`）；tmux 复制（鼠标拖选松开 / `set-buffer -w`）才会向该客户端发 OSC52。
- xterm 侧：`@xterm/addon-clipboard` 负责接收 OSC52。**坑：tmux 发的 OSC52 selection 参数是空串（`\e]52;;base64`），addon 默认的 BrowserClipboardProvider 只认 `c`，会静默丢弃** —— 必须传自定义 provider 接受空串（见 `terminal-view.js` 的 `TmuxClipboardProvider` 和 `webapp/app.js` 的内联 provider）。
- 辅助路径：`onSelectionChange` 防抖后自动复制本地选区（iTerm 式选中即复制）；`document` 的 `copy` 事件把 xterm 选区喂给 Cmd+C（xterm 选区不是 DOM selection，Electron 的 role:copy 默认拿不到）；`macOptionClickForcesSelection: true` 让 Option+拖选绕过 tmux 鼠标模式产生本地选区。

### 窗口拖动（无边框 hiddenInset 标题栏）
- `main.js` 用 `titleBarStyle: 'hiddenInset'`（无原生标题栏），窗口靠 `styles.css` 的 `.drag-region`（顶部 48px、`position:fixed; z-index:50; -webkit-app-region: drag`）来拖。
- **坑：`.drag-region` 曾带 `pointer-events: none`，Chromium 下这会静默让 `-webkit-app-region: drag` 失效**，结果整个窗口无法拖动（只能拖边框间接移动）。去掉 `pointer-events:none` 即恢复拖动。
- 代价：拖动条会盖住顶部 48px 内的交互控件。此区唯一的交互元素是侧栏「源切换」下拉（`.source-bar`），给它 `position:relative; z-index:51`（>50）抬到拖动条之上，`no-drag` 才生效、点击才透得过去。rail 按钮从 `padding-top:52px` 起、workspace-header 内容 bottom-align 在 88px 里（约 y60+），都在 48px 之下，不受影响。

### 中文/全角字符宽度
- 历史坑一：字体栈里的 `SFMono-Regular` 是 PostScript 名，**Chromium 解析不到，拉丁字符实际一直是 Menlo**。
- 历史坑二：**Menlo 自带全角标点（）。「」的半宽字形**，DOM 渲染器会给它们垫 ~9px letter-spacing 凑成两格，视觉上"标点特别宽"。
- 方案：`styles.css` 定义合成字体 **"Tmux Desk Mono"**（`@font-face` + `unicode-range`：宽 CJK 区间走 PingFang SC，其余 local("Menlo-Regular")）。**local() 在 Chromium 只匹配 PostScript 名**（webapp 里两种名字都写，兼容 iOS WebKit）。unicode-range 刻意不含歧义宽度字符（如 “”·），它们在终端里占 1 格。
- **坑三：Chromium 的 DOM 布局路径不遵守 local()+unicode-range 的 face 选择（canvas 路径遵守）** —— 所以桌面端必须用 `@xterm/addon-webgl`（canvas 光栅化），DOM 渲染器下这套合成字体不生效。另有 `document.fonts.load(...)` 预热，防止 xterm 在字体就绪前缓存字宽（WidthCache/glyph atlas 永久缓存首测值）。

### 长会话里中文变成"乱码"（WebGL 字形图集串页，2026-08-01）
- 现象：跑了几小时的会话里，某一行中文渲染成**另一些不相干的字**，还混进别处的颜色（用户截图里"问题"两字成了橙色方块 —— 那是上面 `⚠ MCP` 那行琥珀色文字的像素）。字宽/排版正常，只有字形是错的；不会自愈，切主题或重启才恢复。
- **先确认是不是显示问题**：`tmux capture-pane -p -t <pane> | grep <原文>`。这次 tmux 里的字节完全正确 ⇒ 纯渲染层，不用去查编码/PTY。
- 根因（上游 `@xterm/addon-webgl` 0.19）：字形图集分成最多 `MAX_TEXTURE_IMAGE_UNITS`（本机 16）个 page，`GlyphRenderer.render()` 靠 **`pages[i].version !== _atlasTextures[i].version`** 决定要不要重传纹理单元 i —— 这是个**按下标**的比较。而 `AtlasPage.version` 每加一个字形就 +1，于是所有装满的 512×512 page 的 version 都挤在同一个窄区间（中文场景 ~1540）。图集满了会把 4 个 page 合并成 1 个并 `splice` 掉，后面的 page 整体前移；**移进下标 i 的那个 page 的 version 极易正好等于该单元已记录的值** → 跳过上传 → 所有 `texturePage === i` 的字形去采样**上一个 page** 的像素。实测：单元 12 上 page.version 与 tex.version 同为 3 却是两个不同对象，6169 个字形受影响，持续 3219 帧。
- 修复（`terminal-view.js`）：`_mergePages` 是唯一会 fire `onRemoveTextureAtlasCanvas` 的地方，所以它就是"下标刚被打乱"的精确信号 —— 在这里整个换掉图集。
- **坑：不能用 `clearTextureAtlas()`**。它转到 `TextureAtlas.clearTexture()`，开头有 `if (pages[0].currentRow.x === 0 && y === 0) return;`，而合并页的 `currentRow` 恰恰是重置过的 `0,0` → **在最需要它的状态下是个静默空操作**（实测调用 65 次，15 个 page 和 4643 个坏帧纹丝不动）。改成把 `fontFamily` 来回切一次（`monospace` → 原值），让 `configEquals()` 失配，渲染器就会 `acquireTextureAtlas` 一个全新图集（15 页 → 1 页），`setAtlas()` 顺带把所有纹理单元 version 置 -1 全部重传。切回原值后 cell 尺寸不变（实测前后都是 15×36、cols/rows 不变）⇒ 不 reflow、tmux 不会收到 resize。这和下面字体加载后丢弃 WidthCache 用的是同一个惯用法。
- 必须**延后到微任务**：事件是在 `getRasterizedGlyph` 分配字形的过程中 fire 的，同步换图集会把正在分配的那个字形悬空。代价是已经画出去的那一帧，下一帧自愈。
- 验证（可复用）：CDP 里包住 `GlyphRenderer._bindAtlasPageTexture` 记录"每个纹理单元上次真正上传的是哪个 page 对象"，再包住 `render()`，每帧统计 `uploaded[i] !== atlas.pages[i]` 的下标数 —— 这就是"陈旧纹理帧"。用随机 CJK（`0x4e00+rand`）× 256 色前景/背景灌 4000 行制造图集churn。修前 4643 坏帧 / 4001 帧、page 涨到 15；修后 **8 帧**、page 稳定在 8。
  - **测量坑一**：探针里的 LCG 若写成 `seed*1103515245` 会超 2^53 精度退化，随机性塌掉、图集根本撑不大（卡在 8~10 页），要用 `Math.imul`。
  - **测量坑二**：换图集有可能连 `GlyphRenderer` 实例一起换掉，那挂在旧实例上的钩子会**静默失效**、坏帧数看着就"变好了"。探针要每帧自检重挂，并把 `grInstances`/`framesChecked` 一起报出来（本次 `grInstances` 全程为 1，说明数据可信）。
  - 换图集只 fire `onChangeTextureAtlas`，不 fire `onRemoveTextureAtlasCanvas`，所以这个修复**不会自触发递归**。
- 手机端 webapp 没加载 WebglAddon（走 DOM 渲染器），不受此 bug 影响。

### 滚轮/滚动到底（agent 终端"滑不到底"）
- 现象：Claude Code / codebuddy 等 TUI agent 在 app 里跑，经常滚不到会话最底部。
- **关键前提：tmux attach 时发 `\e[?1049h` 让外层终端进 alternate screen**，所以 **xterm 全程在 alternate 缓冲区**，自身没有 scrollback 可滚（`scrollLines` 无效）。历史坑：曾用 `setupLocalWheelScroll()` 判 `buffer.active.type !== 'alternate'` 去驱动 xterm 本地 scrollback——tmux 下该判定恒 alternate，整个处理器是**死代码**，等于没修。
- 真根因：tmux 下滚动只能走 tmux copy-mode + history（`history-limit 50000`）。`mouse on` 时 xterm 把滚轮当鼠标事件转发给 tmux，但**前台 agent 若自己开了 mouse reporting，tmux 会把滚轮透传给 agent**，agent 不处理 → 完全滚不动；即便进 copy-mode，往回滚也常回不到实时底行。
- 方案（现行）：`terminal-view.js` 的 `setupLocalWheelScroll()` capture 阶段拦 `wheel`，累积成行数后经 `api.scrollTerminal({sessionId,lines})`（去抖 ~16ms、不重叠）→ IPC `terminal:scroll` → `TmuxService.scrollSession()`。`scrollSession` 先 `display-message -p` 探测 pane 状态（`pane_in_mode/alternate_on/mouse_any_flag/pane_width/pane_height`），按状态分流：① 已在 copy-mode → 继续驱动 copy-mode；② **alt-screen + 应用自己开了 mouse reporting（Claude Code：`alternate_on=1 mouse_all=1 sgr=1`）→ 注入 SGR 滚轮序列 `\e[<64/65;x;yM`（pane 中心坐标，每行一个事件、单次 ≤30）让应用滚自己的视口** —— 对这种 pane 走 copy-mode 完全无效（alt screen 不积累 history，`hist≈0`），这是「iTerm 能上翻、app 不能」的根因；③ alt-screen 无鼠标（pager）→ `send-keys -N n Up/Down` 方向键仿真（同 tmux 内建 wheel 回退）；④ 普通屏 → `lines<0` 上滚 = `copy-mode -e -t $sess ; send-keys -X -N n scroll-up`（一次 tmux 调用，`;` 分隔命令）；`lines>0` 下滚 = `send-keys -X -N n scroll-down`（不在 copy-mode 时报错吞掉即可）。命令通道绕过「抢了 mouse 但不处理滚动」的 agent；`copy-mode -e` 保证滚到最新行下方自动退出回实时屏，底部永远可达。`stopPropagation` 防 xterm 再把滚轮转成鼠标事件重复发给 tmux。
- 仅当 `api.scrollTerminal` 存在且已知 `sessionId` 时接管；否则放行走 xterm 默认。dispose 里清 `scrollTimer`、移除 capture 监听。
- **远程接管的滚动（现已打通）**：`RemoteApi.scrollTerminal({lines})` 经 takeover WS 发 `{type:'scroll',lines}`；web-server WS 收到后 `service.scrollSession(groupedId,...)` —— 注意目标是**该客户端 attach 时新建的 grouped 会话**（`_web_*`），不是源会话，copy-mode 是 pane 级、grouped 与源共享 pane 所以对源同样生效。再分享中继（`proxyRemoteWs`）**原样透传** downstream 帧，故 scroll 自动多跳可达（B→C、乃至 A→B→A 回环拓扑都验证过：grouped 进 copy-mode、下滚 `pane_in_mode` 归 0 回实时屏）。RemoteApi 侧忽略 `sessionId`（WS 已绑定会话），只用 `lines`。
- **坑（远程会话"整个坏掉"的真凶）：`RemoteApi.writeTerminal/resizeTerminal/scrollTerminal/detachTerminal` 曾返回裸 `boolean`**，但 `terminal-view.js` 对本地 IPC 桥（`window.tmuxDesk.*` 返回 `ipcRenderer.invoke` 的 Promise）的返回值链了 `.catch()`（写回 xterm 的 DA/颜色/焦点应答、resize）。裸 boolean 上 `.catch` → `TypeError: ….catch is not a function`，且抛在 **xterm 解析器内**（`h.parse`→`triggerDataEvent`），把远程会话的数据/重绘流打断——表现就是"远程终端卡住/滚不动/不刷新"。**修复：这些方法一律 `async`（boolean 自动包成 resolved Promise），与本地桥同形状**。排查手段：`open -a "Tmux Desk" --args --remote-debugging-port=9222` 起 CDP，patch `WebSocket.prototype.send` 记录出帧、`Runtime.exceptionThrown` 抓这类异常（见本次 scratchpad `cdp-flow.js`）。
- **坑（"滑不到最底端"的另一真凶：grid 行随内容跑飞）**：`.app-shell` 原来只写了 `grid-template-columns`，唯一的隐式行按内容 auto 计算。一旦某次 `fit()` 用了错误的 cell 高度（字体未就绪时量出 ~8px，879px 容器算出 109 行），xterm 渲染 109 行 × 真实 18px ≈ 2000px → 把隐式行撑到 2100px+（`body overflow:hidden` 静默裁剪、无滚动条）→ 之后每次 fit 量到的容器就是被撑大的那个 → **锁死在错误平衡点**，提示符永远被裁在窗口之下，怎么滚都"到不了底"（滚动走 tmux copy-mode，动不了 DOM 裁剪）。修复：`.app-shell` 加 `grid-template-rows: minmax(0, 1fr)` 锁行高到视口 + `.workspace` 加 `min-height: 0`，坏的 fit 会在下一帧自愈。诊断特征：`.xterm-screen` rect 高度远大于 `window.innerHeight`、`getComputedStyle(shell).gridTemplateRows` 是内容高而非视口高。
- **调试坑：改 `src/renderer/*` 后必须 `npm run build:renderer`** —— `main.js` loadFile 的是 `renderer-dist/`（构建产物），dev 实例（`npx electron .`）改源码不生效；且 Electron 对 file:// CSS 有缓存，验证时用 CDP `Page.reload {ignoreCache:true}` 硬重载。

### 鼠标归前端（localMouse）与"滚完打不了字"（2026-08-30）
用户反馈两条：①「双击选中单词并复制」不像 iTerm；②「点了会话只能滚动、按 Esc 才能输入」，而在 Claude Code 里没人敢随手按 Esc。两条同一个根：**tmux 抢走了鼠标，滚动又只能靠 copy-mode**。

- **实测（node-pty 抓 attach 后客户端收到的 DECSET）**：`mouse on` 时 tmux **一 attach 就无条件**给客户端开 `?1000h ?1002h ?1006h`，与 pane 里跑什么无关 → xterm.js 的 `SelectionService._enabled` 全程 false，双击选词/三击选行/拖选**全部禁用**（`SelectionService.ts:437` 在 mac 上只认 ⌥ 强制选中）。`mouse off` 时 tmux 自己不开，**只在 pane 里的应用开启鼠标上报时转发**（app 开 `1002/1006`、关掉，客户端都如实收到）——这正是 iTerm 的语义：鼠标归不归应用，只由前台程序说了算。
- **方案**：新增 tmux 设置项 **`localMouse`（默认开）**。它不是全局开关，只对**桌面端 attach 的那个会话**下 `set-option -t $sess mouse off`；`set -g mouse on` 保持不动，所以**手机端不受影响**（web 客户端 attach 的是 grouped `_web_*` 会话，继承全局）。e2e 已验证两个客户端各拿各的：桌面 DECSET 里没有 `?1000h`，grouped 客户端有。
- **坑：`mouse off` 是会话级，而每次写 profile 都以 `set -u -t <sess>` 开头**（清历史遗留的会话级覆盖）→ 覆盖必须**排在 unset 之后**重新下发。`buildTmuxSettingCommands(target, settings, { localMouse })` 因此把它放在返回数组末尾；`applySettingsToAllSessions` 也要知道「桌面端当前 attach 的是哪个会话」（`terminalManager.attachedSessionId()`），否则在设置页存一次偏好就把覆盖洗掉了。
- **mouse off 丢掉的两件 tmux 鼠标能力，由客户端补**（`app.js` 的 `setupPaneMouse`）：点击别的分屏 → `panes:select`；拖分屏边框 → 新增 `panes:resize` → `resize-pane -t %id -x/-y`。命中判定用已有的 pane 单元格几何（和 × 关闭按钮同一套 `getGridMetrics()`）。**两个监听都必须挂 capture 阶段** —— xterm.js 在格子里吃掉指针事件，冒泡阶段的 mousemove 根本收不到，悬停时的 `col-resize` 光标不会出现。
- **「滚完打不了字」的真凶是我们自己的滚轮实现**：普通屏 pane 走 `copy-mode -e` + `scroll-up`。实测 copy-mode 里的按键行为：**逐个可打印键全部被吞、模式不退**（`e`/`c`/`h`/`o`/空格/`A`/`x`/`1` 都是 mode 仍为 1、pane 收不到）；**只有 Escape 能退出，且这个 Escape 也被吃掉**；成串快打时更糟——模式会在半途掉出去，**前缀被吞、后半截却送进了 shell**（实测 `echo trapped` 变成把 `trapped` 当命令跑），也就是说不修的话不只是"没反应"，还会**乱执行**。
- **修法**：`scrollSession` 现在把 `#{pane_in_mode}` 的探测**拼在同一次 tmux 调用里**（`;` 分隔，不多一次往返）并返回 `{ inCopyMode }`；`terminal-view.js` 的 `sendInput()` 在滚动后的**第一个按键**之前先走命令通道 `send-keys -X cancel`（这条**不会进入 pane**，所以不存在"误触中断 agent"），并把随后的按键排在这个 promise 后面，防止它们抢跑又被当成 copy-mode 命令。队列排空后恢复直发。A/B 实测：不修时 `echo RAW_LINE` 整行丢失，修后 `echo FIXED_LINE` 完整执行。
- 远程接管（RemoteApi/web 中继）**暂未接这条**：那边 scroll 走 WS 单向帧、拿不到回执，`scrollTerminal` 返回裸 boolean，客户端识别出「不是对象」就不动 copyModeActive，行为与改动前一致。
- **验证脚本 `test/manual/local-mouse-e2e.js`**（不在 `npm test` 里，会真起 Electron）：起 `-L deskui` 沙箱 tmux（带一个左右分屏）+ 临时 `TMUX_DESK_PREFERENCES_FILE`，CDP 点开会话后：双击左屏的 `UNIQUEWORD12345` → **`pbpaste` 拿到整词**且 tmux `pane_in_mode` 仍为 0（证明 tmux 全程没看见鼠标）；点右屏 → active pane 变 `%1`；拖边框 → 宽度 60/59 → 40/79。
- **坑：CDP 的 `Input.dispatchMouseEvent` 发 `mouseMoved` 时必须带 `button: 'none'`**，写成 `button:'left', buttons:0` 时点击/拖拽都正常、**唯独悬停不触发**，会让人以为是自己的 hover 代码坏了（第一次就照着这个假象去改了 capture 阶段——那个改动本身是对的，但不是这个现象的原因）。

### 跨会话全局搜索 ⌘F（2026-08-30）
用户明确要求「⌘F 不做成 iTerm 那样的单 pane 查找，要更高级 —— 全会话搜索」。终端模拟器只能搜自己显示的内容，而 **tmux 手里有每个 pane 的完整 scrollback**，所以这件事恰好是这个架构能做、iTerm 反而做不到的（iTerm 的 ⌘F 只搜当前 session）。

- **链路**：`⌘F` → `#globalSearch` 面板（复用命令面板的外壳）→ `search:sessions` IPC → `TmuxService.searchSessions()`：`list-panes -a` 拿全部 pane，逐个 `capture-pane -p -S -20000` 抓文本，`src/shared/session-search.js` 的 `scanPaneCapture()` 纯函数扫描（默认不区分大小写、每 pane 最多 20 条、总量 200 条封顶）。**实测 3 个 pane / 各 2 万行 = 14~24ms**，所以顺序抓即可，不值得并发。
- **回车跳转**：`search:reveal` → `revealMatch()` = `select-window` + `select-pane` + `copy-mode -e` + `goto-line`，客户端再 `selectSession()` 挂上去。跳过去之后 pane 停在 copy-mode，所以顺手 `terminalView.setCopyModeActive(true)`，下一次按键会先取消 copy-mode（复用上一节的通道）。
- **坑一：`goto-line N` 是「从实时底部往上数 N 行」**，不是行号。而且**必须从 capture 的开头算**：`gotoLine = history_size + pane_height - 1 - (capturedStart + index)`，`capturedStart = max(0, history_size - 请求行数)`。用 `capture 数组长度` 反推会**恒定差 1 行**（capture-pane 会吃掉最后一个空行）。实测：`L42` 在 capture 索引 44、history 95 + height 10 → goto-line 60 命中；用长度算得 59，落到隔壁行。
- **坑二：几何必须和 capture 在同一条 tmux 调用里取**。tmux 执行命令列表期间不处理 pane 输出，所以 `capture-pane ... ; display-message -p '<marker>#{history_size}\t#{pane_height}'` 是原子的；分两次调用的话，正在刷屏的 pane 会在两次之间长出几百行，**所有匹配都会定位到错误的行**（第一版就是这么错的）。marker 用 `\x01…\x01`，纯文本 capture 里不可能出现。
- **坑三：pane 撞到 `history-limit` 之后 `history_size` 不再增长**，所以「捕获后又打印了多少行」没法用 history_size 差值算全。补法是三段式：① 按差值修正 goto-line；② 用**匹配行的原文**再 `search-backward-text` 一次 snap（漂移永远是往上，所以落点一定在目标行下方）；③ 再 `search-forward-text` 搜**查询词**——前向搜索从光标位置起，会停在同一行上，顺便把 tmux 的 `pane_search_string` 设成查询词，**匹配高亮就免费有了**（实测高亮在 goto-line 之后依然保留）。最后回读 `#{copy_cursor_line}` 校验，不含查询词就退回「从底部找最近的匹配」并 toast 提示。
- **坑四：`capture-pane` 绝对不能加 `-J`**。合并折行会破坏「一行 = 一个 grid row」的映射，goto-line 立刻错位。
- **坑五：`execFile` 默认 `maxBuffer` 只有 1 MiB**，2 万行 ≈ 1.6MB，跨会话搜索必 ENOBUFS。`TmuxService` 的默认 execFile 已放到 64MB。
- **坑六：goto-line 上不去比 scrollback 更早的位置**（最多 `history_size`），所以一个 pane 最老的一屏行只能大致定位——靠上面的 snap 兜底。
- **`⌘G / ⌘⇧G`** 在当前 pane 内步进（`TmuxService.findInSession`，`search-again` / 反向）。**坑：反向的第一步是空转** —— 后向搜索把光标停在匹配的**开头**、前向停在**结尾**，所以掉头的第一步只是在同一个匹配上挪了个位置。实测掉头恰好多花一步，于是 `flip` 时把命令发两遍（客户端记着上一次方向）。
- **远程会话不支持全局搜索**（要上游服务器暴露搜索端点），`isRemoteActive()` 时 ⌘F 退回会话列表搜索。
- 验证：`test/manual/global-search-e2e.js`（真起 Electron）—— 挂在 `first` 会话上，搜只存在于 `second` 里的 `PARITY_MARKER_42`，回车后 attach 切到 `second`、tmux `#{copy_cursor_line}` 正是那一行、随后一次按键把 `pane_in_mode` 打回 0。

### ⌘K 清屏 / 右键菜单 / ⌥←→ / 复制去尾随空白（2026-08-30）
- **⌥←/⌥→ 之前是坏的**：xterm.js 发 `\e[1;3D/C`，zsh/bash 默认不绑，按词移动毫无反应。改成 iTerm「Natural Text Editing」的做法，在 `attachCustomKeyEventHandler` 里发 `\eb`/`\ef`（readline/zle 都认）。⌥⌫ 本来就是好的，没动。
- **⌘K = 清屏 + 清空回滚**（`TmuxService.clearPane`）。**顺序很关键**：先 `send-keys C-l` 让前台程序自己重绘（zsh 会保留半截命令行、TUI 会重画），**再** `clear-history`。反过来的话重绘产生的那一屏会留在 history 里（实测 185 → 19 行，正确顺序是 0 行）。中间等 120ms 给程序重绘的时间。进 clearPane 前先取消 copy-mode，否则 C-l 会被当成 copy-mode 按键。
- **命令面板从 ⌘K 挪到 ⌘⇧P**（同时保留 ⌘⇧K），顶栏 hint 一起改。
- **终端右键菜单**（`openTerminalContextMenu`）：复制选中 / 粘贴 / 全局搜索 / 垂直·水平分屏 / 关闭分屏 / 清屏；复用已有的 `menuButton` + `placePopoverAt`。粘贴走 `terminal.paste()` 而不是直接写 pty —— xterm 会按 bracketed paste 包好，多行粘贴才不会被 shell 逐行执行。
- **复制去掉行尾空白**（`trimTrailingSpaces`）：tmux 把每行补满到 pane 宽度，直接 `getSelection()` 会把一大串尾随空格带进剪贴板。选中即复制、⌘C 的 copy 事件、以及喂给搜索框的选中文本都过这个函数（只削右边，缩进是内容）。

### 与 iTerm2 的逐条对照 & 后续待办
完整对照表在 **`docs/iterm-parity.md`**（子代理调研，402 行，10 个功能域 + 优先级 A/B/C/D 分档）。⚠️ 它被全局 `~/.gitignore_global` 的 `/docs/` 规则挡着，**不进 git**，要留就 `git add -f`。

已完成（对照表 A 档）：① ⌥←/→ 按词移动 ② ⌘K 清屏（面板挪 ⌘⇧P）③ ⌘F —— 没有照抄 iTerm 的单 pane 查找，做成了**跨会话全局搜索** ④ 终端右键菜单 ⑤ 复制去尾随空白。外加本轮更早做的 localMouse（本地选中/双击选词/点击切 pane/拖边框）和 copy-mode 卡输入的修复。

**第二批（2026-08-30，已完成，详见下一节）**：`-T` 特性名单扩展、OSC 8 超链接、⇧PageUp/PageDown、字体设置、分屏最大化 / ⌘⌥切 pane / Broadcast Input、粘贴保护。

**下一批（B 档里最值的）**：提示符跳转 ⌘⇧↑/↓（tmux 3.7 原生 `next-prompt`/`previous-prompt`，依赖 shell 发 OSC 133）、非活动 pane 变暗、会话通知（`monitor-activity`）。

### 第二批 iTerm 对齐（2026-08-30）

**attach 的 `-T` 特性名单**（`terminal-manager.js` 的 `TERMINAL_FEATURES`）扩到 12 项：
`clipboard,RGB,extkeys,sync,usstyle,strikethrough,overline,hyperlinks,osc7,focus,cstyle,ccolour`。
逐项对着 `@xterm/xterm` 6.0.0 的 bundle 核过实现（2026 同步输出 / SGR 58 下划线色 / SGR 9 / SGR 53 /
OSC 8 / DECSET 1004 / DECSCUSR / OSC 12 全都在）。tmux 只对**声明了该特性的客户端**开对应能力，
xterm.js 报的 `xterm-256color` 一个都不声明，所以不写 `-T` 等于全关。
e2e 用 `list-clients -F '#{client_termfeatures}'` 回读验证（tmux 会额外补上 `bpaste,title`）。

**OSC 8 超链接**：`terminal-view.js` 的 `Terminal` options 里加了 `linkHandler`
（`allowNonHttpProtocols: false`，xterm 先过一道），activate **要求 ⌘+左键**（和已有的文件引用一致 ——
远端打印的文本不该裸点就能唤起 OS）。链路 `onOpenUrl` → app.js `openTerminalUrl` → **`localApi`**
（不是 `sessionApi()`：浏览器必须开在人正看着的这台机器上，不是远程接管的上游）→ IPC `files:open-url`
→ `validateExternalUrl` 只放 http/https/mailto → `shell.openExternal`。

**⇧PageUp/PageDown**：走 `attachCustomKeyEventHandler`，一页 = `rows - 1`，喂给新的
`scrollByLines()`（和滚轮共用 `pendingScrollLines` 去抖队列，长按不会打出一串 tmux 调用）。

**字体/字号/行距**（`src/shared/terminal-appearance.js`，测试 `test/terminal-appearance.test.js`）：
偏好 `terminalAppearance {fontFamily,fontSize,lineHeight,letterSpacing}`，设置页「终端字体」区。
- **自定义字体是 prepend 到 `BASE_FONT_STACK`，不是替换**。`"Tmux Desk Mono"` 那层合成 face 是中文标点
  占两格的唯一保障（见上面的字体那节），换掉就退回「标点特别宽」的老 bug。
- `fontFamily` 会被原样插进 CSS 属性，所以只允许 `[A-Za-z0-9 ,._'"-]`，其余一律丢弃回默认。
- `setAppearance()` **最后**才改 `fontFamily`，而且是 `monospace` → 目标值来回一次：xterm 只在
  fontFamily 真的变了时才丢 WidthCache / 重建 WebGL 图集，只改字号会拿旧字宽重绘。改完必须
  `scheduleFit()`，否则 tmux 还按旧 cols/rows 排版（就是上面「滑不到最底端」那类症状）。

**分屏最大化 / 切 pane / Broadcast Input**：`tmux-service` 加 `toggleZoom` / `navigatePane` /
`setSynchronizePanes`，三个都在**同一次 tmux 调用**里 `; display-message -p` 回读状态。
`getSessionDetail` 的 list-windows 多取 `#{window_zoomed_flag}` 和 `#{?pane_synchronized,1,0}`。
- **⌘⇧↩ 最大化的坑（踩了一次）**：Enter 是 xterm **即使按着 ⌘ 也会当成 CR** 的键，它会
  `preventDefault + stopPropagation`，所以 `window` 上的 `handleKeyboard` **永远收不到**。实测探针：
  document capture 阶段能看到，window bubble 阶段没有。修法是在 `attachCustomKeyEventHandler` 里
  对 ⌘⇧Enter **`return false`（且不要自己 stopPropagation）** —— xterm 的 `_keyDown` 开头就是
  `if (customKeyEventHandler(e) === false) return false`，在任何 cancel 之前退出，事件照常冒泡。
  ⌘⌥方向键不需要这招（xterm 不吃带 ⌘ 的方向键），别以为所有 ⌘ 组合都要处理。
- Broadcast Input 是**窗口级且会一直开着**，终端里没有任何视觉痕迹 → workspace 顶栏加了一个常驻的
  橙色 `.pane-flag` 徽章，点一下即关。深色文字压 `--sys-orange`（白字在 #ff9500 上对比度不够）。

**粘贴保护**（`src/shared/paste-guard.js`，测试 `test/paste-guard.test.js`）：偏好
`pasteProtection {confirmMultiline, confirmChars, slow}`，设置页「粘贴保护」区。
- **拦截点在 container 的 capture 阶段 `paste` 事件**，不是 xterm 的 textarea：DOM 规范里
  *在事件目标元素本身*，capture 和 bubble 监听器按**注册顺序**触发，挂在 textarea 上会输给 xterm。
- 「多行」判定**忽略结尾的单个换行** —— 所有「复制这条命令」按钮都带一个，为它弹窗会训练用户瞎点确认。
- 确认框**要显示内容预览**：「12 行」什么都说明不了，前几行原文一眼就能认出粘错了。
- `closeModal()` 里对这个弹窗补了 `settlePasteConfirm(false)`：取消按钮和 Esc 都走 closeModal，
  不接的话 promise 永远悬着。`settlePasteConfirm` 自己**不能**调 `closeModal`（会递归）。
- 慢速粘贴**不能**走 `terminal.paste()` 分块 —— xterm 会给每块都包一对 `\e[200~/\e[201~`，shell 读到
  第二个起始标记就把转义当字面文本了。所以 bracket 由 `deliverPaste` 自己写一次，中间 dribble；
  分块按**码点**切（`chunkPaste`），切在代理对中间等于给 pty 送半个 emoji。

### 手动 e2e 脚本（`test/manual/`，不在 `npm test` 里）
`cdp-harness.js` 提供沙箱 tmux + 真起 Electron + CDP 客户端；`local-mouse-e2e.js` 验鼠标三件套，`global-search-e2e.js` 验全局搜索 + ⌘K + 右键菜单，`parity-batch-e2e.js` 验第二批（19 项，全绿）。
- **坑：脚本里不能用 `session.0` 这种 pane 索引**。app 一 attach 就把 profile 里的 `pane-base-index 1` 应用上去，`parity.0` 立刻 `can't find pane: 0`。一开始就取 `#{pane_id}`（`%0`）拿稳定目标。
- **坑：CDP 发 `mouseMoved` 必须带 `button: 'none'`** —— 写成 `button:'left', buttons:0` 时点击/拖拽都正常、**唯独 hover 不触发**，会让人误以为自己的 hover 代码坏了。
- **坑：`TMUX_DESK_PREFERENCES_FILE` 要指向一个全新目录**。`session-snapshot.json` 是写在偏好文件**旁边**的，共用 `os.tmpdir()` 会让上一轮 e2e 的快照被恢复进这一轮的沙箱 —— 凭空多出几个会话，"已搜 N 个 pane" 之类的断言全错（实测多出 2 个 pane）。

### 输入法（IME）
- xterm 默认把预编辑文本画成不透明的 `.composition-view` 黑块，直接盖住光标后内容。桌面端 `terminal-view.js` 的 `setupCompositionShift()` 把它隐藏（保留定位职责：候选窗锚点），用自绘 `.composition-shift` 浮层显示带下划线的预编辑文本 + 把光标后同行内容右移（复刻 iTerm 的"向后挤压"）。浮层位置直接镜像 `.composition-view` 的 left/top。
- **踩坑（2026-11-03，不是 app 的 bug）：鼠须管在 Tmux Desk 里只出英文字母、没候选，终端里正常。**
  - 现象：输入源确认是 `im.rime.inputmethod.Squirrel.Hans`，但 textarea 收到的 keydown 是真实 keyCode（65/78…）而不是 229，没有任何 composition 事件；同一个 textarea 换 macOS 自带简体拼音完全正常。按 Control+` 弹出的鼠须管方案选单显示当前是「西文」。
  - 原因：CapsLock 被两边同时绑定——macOS「用大写锁定键切换 ABC」负责切输入源，Rime `ascii_composer/switch_key/Caps_Lock: commit_code` 同时把鼠须管切成西文。用 CapsLock 离开鼠须管时它看见了这一下并改成西文；切回来那一下 ABC 在前台，鼠须管看不到，所以改不回中文。Electron 整个 app 生命周期只有一个输入上下文，鼠须管给它的 Rime 会话从 app 启动起一直不重建（重新聚焦时 Rime 日志里没有 `starting engine`），这个西文状态就一直粘着；别的 app 的会话频繁重建，新会话默认中文，所以看不出来。
  - 修复：`~/Library/Rime/default.custom.yaml` 里改成 `Caps_Lock: noop`，再 `Squirrel --reload`。临时恢复：Control+` → 选「中文」，或者重启 app。
  - 判别方法：xterm textarea 的 keydown `keyCode===229` 说明 IME 接手了；是真实 keyCode 就说明 IME 把这个键放行了（西文模式），或者根本没经过 IME。再用 Control+` 方案选单看是否西文，就能区分这两种情况。

### 手机端快捷栏的自定义组合键（2026-07）
- 快捷栏条目除 `preset`（固定按键）/`text`（发文本）外，新增 **`combo`**：`{type:'combo', key, ctrl?, alt?, shift?, meta?}`，key 是**单个可打印字符**或命名键（`up/f5/tab/pageup/...`）。编码器 `src/shared/quick-key.js`（webapp 与主进程 preferences-store 共用，测试 `test/quick-key.test.js`），存的是语义而非字节，发送时才 `comboSequence()` 编码。
- 编码取舍：能用传统编码就用传统编码（`⌃C`→`\x03`、`⌥Z`→`\x1bz`、`⇧⇥`→`\x1b[Z`、方向/功能键→`\e[1;5A` 这种带参 CSI）；传统编码表达不了的（**任何 ⌘、`⌃⇧x`、`⌃⏎` 等**）退回 **CSI u**（`\e[<code>;<mask+1>u`，mask = shift1|alt2|ctrl4|super8）。tmux（`extended-keys on` + 客户端 `-T ...,extkeys`）会解析 CSI u，再按前台应用协商到的格式重发，应用没开扩展按键时自动降级 —— 所以不用自己判断对端能力。
- **实测坑（tmux 3.7）：tmux 的按键模型里没有 Super/⌘，会把它折算成 M-（⌥）**。probe（`\e[>4;2m` modifyOtherKeys）验证：`⌘C`/`⌥C` 都到达 `ESC[27;3;99~`，`⌘↑`→`ESC[1;3A`；而 `⌃⇧C`→`ESC[27;6;99~`、`⇧⇥`→`ESC[27;2;9~` 都完整保留。故 UI 在勾选 ⌘ 时明确提示"会被当作 ⌥"，别承诺 ⌘ 组合能透传。
- 编辑器 UI（`index.html` 的 `#qk-add-combo`）：⌃/⌥/⇧/⌘ chip + 单字符输入框 + 特殊键下拉 + 实时预览（`⌥⌘C → \e[99;11u`）。输入框的 `keydown` 是**录制**通道（接实体键盘时按下组合即填充），只在「带修饰键」或「命名键」时接管并 `preventDefault`，普通字符仍走 `input` 事件，保证手机软键盘可用。
- 验证方式（可复用）：`TMUX_DESK_SOCKET=... TMUX_DESK_PREFERENCES_FILE=<临时文件> TMUX_DESK_WEB_TOKEN=... TMUX_DESK_WEB_PORT=8899 node src/server/index.js` 起沙箱 web 端，浏览器点按钮，pane 里跑一个 raw-mode node 脚本打印收到的字节。

### 页签（紧凑视图 tab）
- 顺序只由手动决定：`preferences.tabOrders[viewKey]`（viewKey = `favorites` 或 tag id，值为会话名数组），`sessionsForView` 按它排序，不在列表的新会话按 zh-CN 名称序追加，**不再按 activity 排序**。拖拽重排持久化；`⌘←/→` 切换相邻 tab（终端跟随），`⌘⇧←/→` 移动当前 tab 位置（`app.js` 的键位判定是 `metaKey && !altKey`，**不是** ⌘⌥）。

### 分屏（split）与关闭分屏（还原）
- 分屏由 `tmux split-window -h/-v` 实现（`⌘D`/`⌘⇧D`），tmux 嵌套 pane 反复细分。**关闭/还原**：`tmux-service.killPane()`（`kill-pane`）经 `panes:kill` IPC 暴露；关到只剩 1 个 pane 即还原为未分屏。
- 每个分屏右上角的 **× 叠加按钮**：`getSessionDetail` 的 list-panes 额外取 `#{pane_left/top/width/height}`（单元格坐标）；`app.js` 的 `renderPaneCloseButtons()` 用 `terminal-view.js` 的 `getGridMetrics()`（`.xterm-screen` rect ÷ cols/rows = 每格像素）把 pane 单元格坐标映射到像素，在 `#paneCloseLayer`（`pointer-events:none`，仅按钮 `auto`）里绝对定位。仅当活动 window 的 pane 数 ≥2 时渲染。
- 同步时机：`renderDetail`（随 `refreshDetail`，2s 轮询 + 每次操作后都会调），及终端 resize（`TerminalView` 新增 `onResize` 回调 → `onTerminalResize()` 立即重排 + 200ms 去抖 `refreshDetail` 取新单元格）。命令面板另有「关闭当前分屏」入口（关活动 pane）。

### 多客户端宽度争用（web 接管时右侧死区）
- 现象：PC 浏览器接管会话时终端右侧出现空白/点填充死区（diff 大色块时尤其明显）。根因与悬浮球无关：桌面客户端与 web 分组会话同时观看同一 window，`window-size latest` 下 window 跟随**最后活动**的客户端，被动观看的一侧就多出死区。
- 方案：焦点即活动。webapp 在 window `focus`/页面回前台时发 `{type:'focus'}`（`notifyClientFocus()`），web-server 往 pty 写 `\x1b[I`（focus-in 报告）；桌面端 `terminal-view.js` 在 window focus 时经 `terminal:write` 写同样序列。tmux 把发出者标为 latest，window 立刻切到该客户端全宽。
- 实测（node-pty 双客户端 + `cat -v` 验证）：按键/attach/resize/`\x1b[I` 都会更新 latest；`refresh-client` 不会；`focus-events off` 时 `\x1b[I` 依然生效且被 tmux 完全吞掉，不会泄漏进 pane 应用。
- 附带：桌面浏览器（`(any-pointer: fine)`）不渲染 quickball 悬浮球，且 xterm textarea 永不 readonly（否则 IME 被禁用——拉丁键仍走 keydown 所以只坏中文）。

### App 接管的 tmux 体验基线（2026-07）
- attach 时按会话应用 `preferences.tmuxDefaults` 五开关（`TmuxService.applySessionDefaults`）：mouse on / history-limit 50000 / detach-on-destroy off / base-index 1 + renumber-windows on / extended-keys on（唯一的 server 级选项，仅对声明了 extkeys 的客户端生效）。开关关闭 = `set -u -t` 撤回会话级覆盖、回落用户全局配置。入口：ipc `terminal:attach` 与 web-server ws attach，均 fire-and-forget（tmux 选项热生效，晚于 attach 落地也没关系）。设置页「终端体验」区可逐项开关。
- **坑：tmux 全局选项表始终填满默认值**，`show -g mouse` 无法区分“未配置”与“显式 off”——所以接管只做会话级（会话级才有“未设置”状态），永远别 `set -g`。
- attach 客户端声明升级为 `-T clipboard,RGB,extkeys`。
- **PATH 注入**（`platform.withTmuxDirOnPath`）：Dock 启动的 app PATH 不含 homebrew，由 app 拉起（daemonize）的 tmux server 会继承这个残缺 PATH，插件（tmux-resurrect/continuum）里的裸 `tmux` 直接 command not found、快照/恢复静默失败 → `TmuxService.execTmux` 与 `TerminalManager.attach` 都把解析到的 tmux 所在目录前置进 PATH。
- main.js 启动时发一次 `start-server`（对已运行 server 幂等；空 server 无恢复插件会自行退出）：电脑重启后打开 app 即触发 tmux-continuum 自动恢复，无需先手动建会话。
- **集成测试坑**：新 socket 上的新 server 照样读用户 `~/.tmux.conf`，装了 continuum 的开发者机器上会把真实会话快照恢复进测试 socket、破坏计数断言——必须先用 `-f /dev/null` + keepalive 会话引导 server（见 `test/integration/tmux-integration.test.js`）。

### 自带会话快照与恢复（2026-07-30，`src/main/session-snapshot.js`）
起因是两个用户反馈：① **重启后会话全没了、只剩 Tag**（Tag 在 preferences.json 里所以幸存，会话随 tmux server 一起死）；② **重启后会话目录从工作目录变成了 `~`**。根因是同一个：app 之前**完全依赖用户自己装 tmux-resurrect/continuum**，没装 = 无恢复，装了但插件恢复不出 pane cwd = 全掉进 `~`。现在 app 自己存快照。

- **存什么**：会话名 / session_path / 每个 window 的 index+name+active+`window_layout` / 每个 pane 的 index+active+`pane_current_path`+command。三条 tmux 命令（`list-sessions`、`list-windows -a`、`list-panes -a`）。写到 `<preferences.json 同目录>/session-snapshot.json`，另留一份 `.prev.json`。
- **什么时候存**：启动、每 N 分钟（默认 3）、会话增删改/分屏（ipc 里 `touchSnapshot()` 去抖 2.5s）、`powerMonitor` 的 suspend/shutdown、before-quit。**首次启动没有旧快照时也要先存一份**——否则新装用户在第一次定时器触发前是裸奔的。
- **绝不用空快照覆盖非空快照**：tmux 临时没起来时 capture 会返回 0 个会话，这时跳过写入并记 `lastSaveSkipped='empty'`。这是这个功能唯一可能造成破坏的地方。
- **什么时候恢复**：`runStartupRecovery()` 先 `waitForServerToSettle()`（轮询到会话数不再变，最多 6s）等外部恢复插件跑完，再比 `#{pid}` 与快照里的 `serverPid`：**pid 变了（= server 重启过/开机）才补建缺失会话；pid 没变 = 用户自己关的，绝不重建**。
- **恢复怎么建**：`new-session -d -c <window1 的 pane1 目录>` → `move-window` 对齐 index → 其余 window `new-window -t '$id:<index>'`（index 被占用则退回追加）→ 每多一个 pane 一次 `split-window -c <该 pane 目录>` → `select-layout <保存的 layout 串>`（实测：**外来 layout 串能应用到 pane id 完全不同的新 window，tmux 按位置重排**）→ `select-window`/`select-pane` 还原焦点。
- **坑：开窗目录必须取 pane 1 的目录，不是 active pane 的**。`new-window` 只开一个 pane，其余是 split 出来的；用 active pane 会让每个 window 的第一个 pane 拿到「快照时恰好聚焦的那个目录」。e2e 才暴露出来（分屏后新 pane 是 active 的，所以 build 窗口第一个 pane 拿到了父目录）。
- **坑：`rename-window` 会把该 window 的 `automatic-rename` 关掉**。所以 capture 时一并读 `#{automatic-rename}`，值为 1 的 window **不存名字也不恢复名字**，让 tmux 继续自动命名。
- **坑：grouped 会话与源会话共享 window id**。web 端派生的 `_web_*` 会话被按名字过滤掉了，但它的 pane 行仍然会被 `windows.get(windowId)` 命中并挂到真会话上，导致每个 pane 存两遍 → window map 必须用 `session_id + window_id` 作键。
- **目录漂移的修复**：`findCwdDrift()` 只认两种「恢复把目录弄丢了」的形状——live 路径**恰好等于 `/`** 或**恰好等于 $HOME**（用户自己 cd 到别处不算漂移）。修法是往 pane 里 `send-keys` 一条 `cd -- '<路径>'`，**只对 `pane_current_command` 是 shell 的 pane 做**（跑着 vim/agent/cat 的 pane 永远不碰）。默认开，可在设置里关。

#### 现场复盘（2026-07-30 用户实机，三个真 bug）
第一版上线后用户重启，会话目录**依旧不对**。从 `session-snapshot.log` + 实机取证查出来的：
- **漂移值是 `/` 不是 `~`**。`/` 是 tmux server 自己的 cwd，一个「没能拿到目录」的 pane 就落在这儿。第一版只认 `$HOME`，现场 5 个停在 `/` 的会话**一个都没匹配上**。
- **快照会自我毒化**：坏恢复把 pane 丢到 `/` → 3 分钟后定时快照如实记下 `/` → **真目录永久丢失**（用户那次就是这样没的，`.prev.json` 也一起被覆盖）。修法：每个 pane 带一个 `lastGoodPath`，`/` **永远不覆盖**已知的好路径（`carryLastGoodPaths`），恢复和修复都用 `targetDir(pane) = lastGoodPath || path`。`$HOME` 不做这个保护——真有人在 `~` 里干活。
- **启动检查一失败就永久放弃**：重启后 tmux server 边起边被 continuum 灌会话，那个窗口里读会话会报 `no current target`；第一版 `catch` 完直接 `return null`，于是**恢复和目录修复整轮都没跑**。现在 `liveSessionNames()` 用 `null` 表示「读不到」（区别于 `[]`「没有会话」），settle 窗口放宽到 10s，读不到就 5s 后重试、最多 4 次。
- **`send-keys` 前必须先 `C-u`**：提示符上残留的半截命令会被拼到前面（实测 `cd cd -- '/x'` → `cd: too many arguments`，第一次手工修 dms 就栽在这）。这些 pane 都是刚恢复的 shell，C-u 只可能丢掉过期的残留文本。
- **发完 `cd` 要回读验证**（`verifyRepaired`）：`send-keys` 只是「请求」，shell 忙着就不生效。回读 `#{pane_current_path}`，没落地的记 `cd-failed` 并在面板里提示，不许算成已修复。
- **「是不是磁盘权限问题」的判法**：`lsof -a -p <pane_pid> -d cwd -Fn` 拿 shell 进程的**真实 cwd**，和 `#{pane_current_path}` 对比。两者都是 `/` ⇒ 进程真在 `/`，与 TCC/权限无关；只有 tmux 报 `/` 而进程在别处才是读取权限问题。这次实测两者一致，且目录 `-d` 存在、`ls` 可读 ⇒ **不是权限问题**，别去引导用户开「完全磁盘访问权限」。真遇到目录存在但进不去（EACCES/EPERM）时才走 `blockedBy:'denied'` → 面板里单列一条 error 并给出授权指引。
- **旧数据能救**：tmux-resurrect 存档 `~/.local/share/tmux/resurrect/*.txt` 的 pane 行里，字段 7 是 **pane_title**、字段 8 才是 `pane_current_path`。zsh 会把 cwd 写进标题，所以**标题里常常留着真目录**（跑过程序的 pane 除外，标题会被程序覆盖）。这次 5 个里靠它救回 3 个。
- **坑：window/pane index 匹配会被 base-index 差异整个打偏**（外来插件恢复出来的编号可能从 0 起，而 app 的 profile 是 1）。所以匹配策略**按会话整体二选一**：index 全对得上就用 index，否则在**数量完全相同**时退回位置匹配——两种混用会把多个快照 pane 映射到同一个 live pane。
- **报错出口（用户可回收的日志）**：`session-snapshot.log`（同目录，512KB 轮转一次），每次保存/恢复/修复/失败都写一行。`health()` 把状态汇总成 `issues[]`，每条自带文案 key + 修复动作。UI：**workspace 顶栏右上角的感叹号按钮**（只在 warn/error 时出现，`level` 决定黄/红）→ 「会话快照」面板，列出问题、修复建议、`立即备份 / 从快照恢复 / 修正工作目录 / 打开日志目录`，并把**快照与日志的绝对路径**摆出来（带「复制路径」）。设置页「会话快照与恢复」区常驻状态与三个开关 + 间隔。
- **验证方式（可复用）**：`scratchpad/e2e-snapshot.js` 用真 tmux（`-L snapdemo`）建带分屏的会话 → save → `kill-server` → `runStartupRecovery` → 逐个 pane 比对目录；`scratchpad/e2e-repair.js` 把会话重建在 `$HOME` 模拟外来插件，验证 `cd` 真的落到 zsh 里（路径里故意带单引号），并确认跑着 `cat` 的 pane 不被打扰。
- **e2e 坑（踩了两次）**：`tmux -L x -f /dev/null start-server` 起的空 server **会立刻自己退出**，紧接着的 `new-session`（没带 `-f /dev/null`）就会起一个**读 ~/.tmux.conf 的新 server**，continuum 把开发机的真实会话全恢复进测试 socket。**每一条可能起 server 的命令都要带 `-f /dev/null`**，或者先建 keepalive 会话再动别的。

### 跨设备会话共享 / 远程接管（2026-07）
目标：任意网络互通的设备间共享会话（Termius 式：本地 shell + 远程主机），且被分享方可再级联分享。三层：

- **桌面端远程接管（RemoteApi）**：`TerminalView` 不直连 IPC，消费一个注入的 `api`（`attach/write/resize/detach/onTerminalData/onTerminalExit` + `listSessions/getSessionDetail/selectWindow`）。`src/renderer/remote-api.js` 用 fetch+WebSocket 说 web-server 那套协议、实现同形状接口；`app.js` 的「源切换栏」在本机(`localApi`=window.tmuxDesk) 与各远程之间切 `sessionApi()`，`TerminalView.setApi()` 热切数据通道。远程为**只读接管**（新建/删/改/分屏被 `requireLocal()` 拦）。
- **坑（必看）：主进程 CSP `connect-src` 原为 `'none'`**（`main.js` 的 `CSP`），会**静默拦掉渲染进程所有 fetch/WebSocket**——远程接管点「添加」报“无法连接远程主机”但浏览器能开，就是这个。已放开为 `connect-src 'self' http: https: ws: wss:`（`script-src` 仍 `'self'`，无远程代码面）。改 `main.js` 不进 renderer bundle，须**重启 app 进程**才生效。
- **远程连接存主进程 preferences**（不是渲染端 localStorage）：因为 web-server 中继要读上游 token。`preferences.remoteConnections[{id,base,token,label,reshare}]`，经 `remotes:add/remove/set-reshare` IPC；**不在 `publicPreferences` 白名单**，token 不泄露给 web 客户端。旧版 localStorage 数据由 `remote-connections.js` 一次性迁移。
- **再分享中继（web-server 聚合+代理）**：设备 B 的 web-server 把 `reshare:true` 的远程会话并入 `/api/sessions`（id 加源前缀 `r:<connId>:$n` 防撞车，见 `src/shared/remote-connection.js` 的 `qualifyTarget/parseTarget`），`/api/session-detail`、`/ws` 流、`/api/select-window` 对远程 target 透明代理到上游（用上游 token）。**WS 代理只改写 `ready` 的 grouped id 为 `r:connId:$n`**，好让后续 select-window 路由回该上游；其余帧原样透传。**仅 full-token（scope=null）可见远程，单会话 share 永远只本地**。B→C 因此只需浏览器。reshare 每连接一个开关、默认关（源切换弹窗里的 ↗ 按钮）。REST 中继有测试 `test/remote-relay.test.js`（mock 上游）；WS 代理未做自动化测试，需实机验证。
- **已知限制**：webapp 会话去重按 `source+name`（`mobile-session-model.js`），但 `sessionsForView` 的收藏/标签视图仍按 name 去重，跨源同名会话在收藏/标签视图可能折叠（'all' 视图不受影响）。
- **已知限制（webapp 中继）**：web 端聚合进来的 `r:` 远程会话，Tag/收藏筛选用的仍是**本机**的 tag 配置（`aggregateRemoteSessions` 只取上游的 sessions，没取上游的 preferences），所以上游打的 tag 在中继列表里筛不出来。要修得让中继把上游 tag 一起带回来、并决定多台主机的 tag 怎么在一排 chip 里合并。

#### 远程源下点 Tag 筛不出会话（2026-11-10）
- 现象：本机切 Tag 正常；把另一台机器添加为远程源、切过去后，点任何 Tag 都是空列表。
- 原因：Tag 栏、`compactSessions()`、会话行上的 tag 标记、收藏分组读的一直是 `state.preferences`（**本机**的 tags/sessionTags/favorites/tabOrders）。sessionTags 按**本机会话名**做键，远程主机的会话名基本对不上 → `sessionsForView` 恒为空。远程会话是在远程那台机器上打的 tag，存在**它自己**的 preferences 里。
- 修复：远程主机的 `/api/sessions` 本来就带 `preferences`（webapp 用的同一份 `publicPreferences`）。`RemoteApi.listSessionsWithPreferences()` 一并取回，经 `normalizeViewPreferences()`（复用 `tag-model` 的 `normalizeTags`/`normalizeSessionTags`：对方可能是旧版本，tag color 会进 CSS 自定义属性）存到 `state.remotePrefs`。app.js 里所有**读** tag 状态的地方改走 `viewPrefs()`（远程源 → `state.remotePrefs`，本机 → `state.preferences`）；切源时 `remotePrefs` 清空，正在看的 tag 在远程被删掉则回落「全部」。
- **写操作在远程源下一律挡掉**（远程接管本来就是只读）：点 tag 不做 recency 提升（`api.touchTag`）、置顶 tag 不可拖、tag 右键菜单只留「打开」、会话 Tag 管理弹窗 / 侧栏「新建 Tag」/ tab 拖拽排序走 `requireLocal()`。否则会把远程的 tag id / 会话名写进本机 preferences。设置页的 Tag 管理照旧管本机。
- 验证：`test/manual/remote-tag-view-e2e.js`（真起 Electron + 一个沙箱 web server 充当远程，7 项）；A/B 过，旧 renderer 在「远程源 Tag 栏换成远程的 tag」一步就挂。
- **坑：9223 可能已被别的进程占着**（比如 ssh 隧道，`lsof -iTCP:9223` 查），harness 默认端口起不来 CDP、`/json` 还会返回隧道对面的列表 → 报「renderer page never appeared」。新脚本用 9241；`launchApp` 也加了 `preferences` 参数用来预置偏好文件。

### Web 端会话搜索框（2026-11-10）
- 列表页顶栏下一行 `#session-search`。匹配逻辑抽成 `session-model.js` 的 `sessionMatchesQuery()`（名称/目录/当前命令，大小写不敏感的子串匹配），桌面侧栏的 `filterAndGroupSessions` 和 web 的 `currentListSessions()` 共用这一个函数，有单测保证两边结果一致。
- 与主机/Tag chip **叠加**筛选；chip 上的计数保持总数不随搜索变（和桌面侧栏一致）。分享链接模式隐藏。
- 键位：Esc 先清空再失焦；回车只收起键盘（列表已实时过滤）；列表页按 `/` 聚焦（⌘F/Ctrl+F 留给浏览器自己的查找）。自绘清除按钮（`bindTap`，按下不抢焦点、键盘不收），原生 `::-webkit-search-cancel-button` 隐藏 —— 不是每个引擎都画。
- 输入框 `font-size: 16px` 是硬性的：iOS 对 <16px 的输入框聚焦时会自动放大页面。
- **webapp 主机筛选**：webapp 顶部 `#host-filters` chip 行（复用 `.workspace-filter` 样式，`.host-filters` 更紧凑），在 all/收藏/tag 行之上，按会话的 `source` 客户端侧过滤（`state.hostFilter`：`null`=全部 / `'local'`=本机 / 某 `source.id`）。`hostFilteredSessions()` 先按主机过滤，再喂给 `mobileSessionsForView`，workspace filter 计数也随之只统计该主机。**仅当聚合列表跨 ≥2 个主机时才显示**（`availableHosts()` 数 distinct host），单主机/share 模式隐藏；主机掉线由 `ensureHostFilter()` 回落到「全部」。桌面端是「源切换」下拉（切 API），webapp 因 server 已聚合各源，只需客户端 chip 过滤。
- **启动自动开启共享**：偏好 `autoShare`（默认关，设置页「共享」区开关）。`main.js` 启动时 `if (autoShare) webControl.start()`（fire-and-forget，端口被外部 daemon 占用等失败不阻塞开窗）。设置页开关持久化偏好即"下次启动生效"，并顺手立即 `api.webStart()` 一次让开关有可见反馈；关掉不主动停服（实时启停仍走共享面板）。`autoShare` 不在 `publicPreferences` 白名单，走 `preferences:save` 的 allow-list + 布尔校验。

#### 「切换主机」很慢的真凶：RemoteApi 没有超时（2026-08-30）
- 现象：点左上角源切换、选一台远程主机后，很久才有反应。
- 根因：`RemoteApi.request()` 的 `fetch` **没有任何 deadline**。一台地址过期的主机（对方换了网段、睡眠、防火墙丢 SYN）既不回包也不 RST，于是要等满 **macOS 的 TCP 超时（~75s）**。对照组：`web-server.js` 的 `upstreamRequest` 早就有 `AbortController` + 4s，只有桌面端这条漏了。而且 2s 轮询会一直往这个黑洞里打。
- 修复（`src/renderer/remote-api.js`）：`request` 走 `AbortController`，`REQUEST_TIMEOUT_MS=5000`、探测 `PROBE_TIMEOUT_MS=2000`、WS 握手 `ATTACH_TIMEOUT_MS=8000`（黑洞主机的 WebSocket 握手同样会一直挂着）。`signal.aborted` 用来区分「超时」和「连不上」——文案不一样，用户据此判断是地址错了还是主机没开。
- 体验层（`app.js`）：新增 `probeRemoteHosts()`，**打开弹层（以及 hover 源按钮预热）时并行探测所有已存主机**，行内显示 `● 在线 3 ms` / `● 连不上`，弹层本身仍然是同步渲染、35ms 就开（实测）。探测结果缓存 `PROBE_FRESH_MS=8000`。切换时会话列表立刻显示「正在载入远程会话…」，失败后显示「连不上这台主机…」。
- **探测结果只是提示，不能当否决**：探测的 2s 比真实切换的 5s 更紧，慢速 WAN 主机可能被误判为离线 —— 所以离线的行**照样可点**，只把错误挂在 `title` 上。
- 离线时 2s 轮询退避到 10s（`lastOfflinePoll`），否则每一拍都在等一个 5s 超时。
- `ensureRemoteApi()` 现在会比对 `base`/`token`：连接被改过（IP 变了/换 token）时丢掉旧实例重建，否则会一直对着死地址说话。
- 回归测试 `test/remote-api.test.js`：用一个 accept 后**永不回包**的 http server 模拟黑洞，断言 request 在自己的 deadline 内 reject、`probe()` 返回 `{ok:false}` 而不是抛。

#### 切换主机后回到上次所在的会话（2026-11-25）
- 现象：本机 ↔ 远程主机来回切，选中的会话被重置 —— 远程永远落在列表第一个，偶尔切完**什么都没选中**。
- 原因一：切源后的自动选中只认 `preferences.lastSession`，而它只记**本机**的会话名；到了远程要么找不到（落到第一个），要么撞上一个同名的远程会话。
- 原因二（"什么都没选中"）：`refreshSessions` 用全局 `state.refreshing` 防并发，切源时若上一个源的刷新还在路上（黑洞主机会挂满 5s 请求超时），**切源自己那次 initial 刷新被直接丢掉**；之后的轮询不是 initial，不会自动选中。
- 修复：① 新偏好 `remoteLastSessions: {[connectionId]: {id, name}}`（`preferences:save` 白名单，`publicPreferences` 不暴露）；归一化时只保留仍存在的连接 id，**删主机不需要额外清理**。远程按「id+name → name → id」匹配：开了再分享的主机可能列出两个同名会话（本机的和 `r:` 中继的），id 又能找回改过名的会话。本机仍用 `lastSession`（按名字，tmux server 重启后 id 会复用）。② 防并发改成按源：`refreshingToken === sourceToken` 才拦，上一个源的刷新结果本来就会被 token 校验丢弃；它的 catch 也先比 token，免得把新源标成离线。③ `state.restorePending`：切源置位、任何一次选中清零 —— 切过去时主机还连不上、后面某次轮询才连上，也会自动回到上次的会话。
- 记录选中改成不阻塞 attach（`rememberSelection` 不 await、失败静默）：之前本机的 `savePreferences` 失败会让整次 attach 走进报错分支。
- 验证：`test/manual/source-session-restore-e2e.js`（真 Electron + 沙箱远程 web server + 一个只 accept 不回包的黑洞端口 + 一个中途才启动的 web server，13 项，含重启后恢复）。A/B：旧 renderer 挂 5 项（回到远程落在 `vm-1`、离开黑洞主机后 3s 仍未选中等）。

### Tag 导入导出（2026-07）
设置页 Tag 区「导入/导出」→ `tags:export/import` IPC（`main.js` 的 `tagFileIO` 走 save/open 对话框）。导出 JSON `{type:'tmux-desk-tags',version,tags,sessionTags,favorites}`；导入是**合并式**（`PreferencesStore.importTagConfig`）：同名标签复用现有 id、导入 id 安全重映射、未知 id 丢弃、favorites/分配 union、可重复导入不重复。

### 调试手段
- 带 CDP 起调试实例：`npx electron . --remote-debugging-port=9223`（无单实例锁，可与正式实例并存；**注意它会按 lastSession 自动 attach，可能连到用户正在用的会话——测试前必须先切到专用测试会话**，双客户端 attach 还会把会话 resize 到最小客户端）。
- **不重启就探查正在运行的正式实例**（fuse `EnableNodeCliInspectArguments` 是开的）：`kill -USR1 <主进程pid>` → 主进程在 `127.0.0.1:9229` 开 Node inspector；通过 `/json/list` 拿 ws 地址，`Runtime.evaluate`（加 `includeCommandLineAPI:true` 才能用 `require`）执行 `require('electron').webContents.fromId(1).executeJavaScript(...)`，就能读 renderer 状态或挂事件记录器。在主进程里 `execFile osascript -l JavaScript`（`TISCopyCurrentKeyboardInputSource`）可以拿到当前输入源（ssh 会话里直接跑拿不到）。查完用 `process._debugEnd()` 关掉端口（`inspector.close()` 关不掉）。
- IME 可用 CDP `Input.imeSetComposition` + `Input.insertText` 模拟；tmux 侧行为可用 node-pty 模拟客户端隔离验证（repo 依赖里有 node-pty）。
